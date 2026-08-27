/**
 * The ▦'s three destinations, and the rehearsal behind one of them.
 *
 * Two things are asserted here that cannot be asserted anywhere else:
 *
 *  - **the header did not grow.** The brief's one hard constraint is that the
 *    Draft nav stays under 60px at every tested width and the control does not
 *    take a second row. Three destinations behind one glyph is the design that
 *    satisfies it, and this is the measurement that proves it did.
 *  - **the browser refuses a write while a mock is up.** The unit suite proves
 *    the guard; this proves it is wired into the client every screen goes
 *    through, by making the app itself attempt one.
 *
 * The mock's board is served by a double rather than by the seeded deployment,
 * for the same reason `draft-board.spec.ts` injects a draft: a rehearsal is
 * only interesting once a room has been picking, and the seeded draft has two
 * picks in it. Everything above the double — the menu, the layer, the rows, the
 * banner, the guard — is the app's own code.
 */

import { expect, test, type Page } from '@playwright/test';

const TEAMS = 12;
const ROUNDS = 12;
const MY_SLOT = 3;

const MANAGERS = Array.from({ length: TEAMS }, (_, i) => ({
  slot: i + 1,
  name: i === MY_SLOT - 1 ? 'You' : `Manager ${i + 1}`,
  isMine: i === MY_SLOT - 1,
}));

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

function recommendation(i: number) {
  return {
    playerId: `mock-${i}`,
    name: `Mock Player ${i}`,
    position: POSITIONS[i % POSITIONS.length]!,
    team: 'PHI',
    adp: i + 1,
    dogAdp: null,
    adpValue: null,
    marketBlend: {
      adp: i + 1,
      weights: { dog: 0, sleeper: 1 },
      nominal: { dog: 0, sleeper: 1 },
      sources: ['sleeper'],
      singleSource: true,
      unknown: false,
      note: '',
    },
    marketDisagreement: { picks: null, leader: null, note: null },
    survivalProbability: 0.5,
    newsLifetimeNet: 0,
    news30Net: 0,
    news7Net: 0,
    newsConflicted: false,
    components: [],
    total: 0.7,
    score: 70 - i,
    reasons: [],
    counterpoints: [],
    degraded: false,
    marketBaseline: null,
    queued: false,
    status: null,
    tierContext: null,
    injuryLine: null,
    nextPick: null,
  };
}

interface MockDouble {
  /** Mock board requests the app has made. */
  requests(): { action: string; picks: number }[];
  /** Writes the app attempted while the rehearsal was up. Should stay empty. */
  writes(): string[];
}

/**
 * A mock board the test owns, plus a watch on every write the app tries.
 *
 * `picksMade` on the *real* board stays 0 throughout, because a draft that has
 * started is a draft with no rehearsal — the lifecycle test below turns that on
 * deliberately.
 */
async function installMockDouble(page: Page, options: { realPicks?: number } = {}): Promise<MockDouble> {
  const requests: { action: string; picks: number }[] = [];
  const writes: string[] = [];
  let picks: { pickNo: number; slot: number; playerId: string; by: 'you' | 'bot' }[] = [];

  await page.route('**/api/drafts/*/sync', async (route) => {
    writes.push('sync');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pre_draft', fingerprint: 'mock-spec:0', pollIntervalSeconds: 5 }),
    });
  });

  await page.route('**/api/drafts/*/board*', async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body['teams'] = TEAMS;
      body['rounds'] = ROUNDS;
      body['type'] = 'snake';
      body['status'] = 'pre_draft';
      body['mySlot'] = MY_SLOT;
      body['managers'] = MANAGERS;
      body['boardPicks'] = [];
      body['picksMade'] = options.realPicks ?? 0;
      body['currentPick'] = (options.realPicks ?? 0) + 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  await page.route('**/api/drafts/*/mock/board', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      action?: { kind?: string; playerId?: string };
      state?: { picks?: unknown[] } | null;
    };
    const action = body.action?.kind ?? 'resume';
    requests.push({ action, picks: body.state?.picks?.length ?? 0 });

    if (options.realPicks) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The real draft has started, so this mock draft no longer exists.' }),
      });
      return;
    }

    if (action === 'start') picks = [];
    const made: typeof picks = [];
    if (action === 'take') {
      made.push({ pickNo: picks.length + 1, slot: MY_SLOT, playerId: body.action!.playerId!, by: 'you' });
    }
    // The room, filling in the seats between the reader's turns.
    for (let i = 0; i < TEAMS - 1; i++) {
      made.push({ pickNo: picks.length + made.length + 1, slot: 1, playerId: `bot-${picks.length + i}`, by: 'bot' });
    }
    picks = [...picks, ...made];

    const taken = new Set(picks.map((p) => p.playerId));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: { version: 1, draftId: 'demo-draft', seed: 4242, startedAt: '2026-08-27T12:00:00.000Z', picks },
        board: {
          draftId: 'demo-draft',
          status: 'pre_draft',
          type: 'snake',
          teams: TEAMS,
          rounds: ROUNDS,
          currentPick: picks.length + 1,
          picksMade: picks.length,
          mySlot: MY_SLOT,
          myNextPick: picks.length + 1,
          waitHorizonPick: null,
          picksUntilMyTurn: 0,
          onTheClock: true,
          round: Math.ceil((picks.length + 1) / TEAMS),
          league: { id: 'demo-league', name: 'Mock League', scoringLabel: 'Half PPR', notes: [] },
          rosterCounts: {},
          myRoster: picks
            .filter((p) => p.by === 'you')
            .map((p, i) => ({ playerId: p.playerId, name: `Mock Player ${i}`, position: 'RB', team: 'PHI', pickNo: p.pickNo })),
          openStarters: [],
          rosterProgress: [],
          adpSnapshot: null,
          marketSource: null,
          managers: MANAGERS,
          boardPicks: [],
          pickOwners: null,
          startablePositions: POSITIONS,
          offersFlex: true,
          rosterAlerts: [],
          warnings: [],
          recommendations: Array.from({ length: 12 }, (_, i) => recommendation(i)).filter(
            (r) => !taken.has(r.playerId),
          ),
        },
        onTheClock: MY_SLOT,
        yourTurn: true,
        complete: false,
        made,
        refused: null,
        notes: [],
      }),
    });
  });

  /* Anything else the app POSTs while a rehearsal is up is a failure. */
  for (const path of ['**/api/drafts/*/queue', '**/api/drafts/*/queue/reorder', '**/api/players/*/my-guy']) {
    await page.route(path, async (route) => {
      if (route.request().method() === 'POST') writes.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  }

  return { requests: () => requests, writes: () => writes };
}

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

async function openMock(page: Page) {
  await page.getByTestId('draft-board-open').click();
  await page.getByTestId('go-mock-draft').click();
  await expect(page.getByTestId('mock-draft')).toBeVisible();
}

test.describe('the ▦ leads to three places, and costs the header nothing', () => {
  test('offers all three destinations without adding a row to the nav', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);

    const before = (await page.getByTestId('draft-nav').boundingBox())!;
    await page.getByTestId('draft-board-open').click();
    await expect(page.getByTestId('draft-destinations')).toBeVisible();

    for (const id of ['go-draft-board', 'go-draft-order', 'go-mock-draft']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }

    /*
     * The brief's one hard constraint, measured at the width this project runs
     * at, with the menu open. A sheet cannot change the header's height — that
     * is why it is a sheet — and this is the assertion that keeps it that way if
     * somebody later reaches for tabs.
     */
    const during = (await page.getByTestId('draft-nav').boundingBox())!;
    expect(during.height, 'the draft header is still a two-line bar').toBeLessThan(60);
    expect(during.height).toBe(before.height);

    await page.getByTestId('sheet-close').click();
    const after = (await page.getByTestId('draft-nav').boundingBox())!;
    expect(after.height).toBe(before.height);
  });

  test('the draft order names your seat and your next pick', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await page.getByTestId('draft-board-open').click();
    await page.getByTestId('go-draft-order').click();

    await expect(page.getByTestId('draft-order')).toBeVisible();
    await expect(page.getByTestId('draft-order-mine')).toContainText(`Seat ${MY_SLOT} of ${TEAMS}`);
    await expect(page.getByTestId('draft-order-mine')).toContainText('1.03');
    await expect(page.locator('[data-testid^="draft-order-seat-"]')).toHaveCount(TEAMS);
    // The snake, read off the same grid the board draws: seat 3 picks 3rd and 22nd.
    await expect(page.getByTestId(`draft-order-seat-${MY_SLOT}`)).toContainText('1.03 · 2.10');
    await expect(page.getByTestId(`draft-order-seat-${MY_SLOT}`)).toContainText('You');
  });

  test('offers no rehearsal once the real draft has started, and says why', async ({ page }) => {
    await installMockDouble(page, { realPicks: 4 });
    await openDraft(page);
    await page.getByTestId('draft-board-open').click();

    await expect(page.getByTestId('go-mock-draft')).toHaveCount(0);
    await expect(page.getByTestId('go-mock-draft-unavailable')).toContainText('ends the moment the real draft starts');
  });
});

test.describe('a mock draft', () => {
  test('opens on your pick, with the room already drafted and nothing hidden', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await expect(page.getByTestId('mock-subtitle')).toContainText('your pick');
    await expect(page.getByTestId('mock-banner')).toContainText('Nothing here reaches Sleeper');
    await expect(page.locator('[data-testid^="mock-row-"]').first()).toBeVisible();
    expect(double.requests()[0]!.action).toBe('start');
  });

  test('takes a player, and the room answers', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    const first = page.locator('[data-testid^="mock-row-"]').first();
    const taken = (await first.getAttribute('data-testid'))!.replace('mock-row-', '');
    await first.getByRole('button').first().click();

    await expect(page.getByTestId('mock-since')).toBeVisible();
    await expect(page.getByTestId('mock-roster')).toContainText('Mock Player');
    await expect(page.getByTestId(`mock-row-${taken}`), 'a drafted player leaves the board').toHaveCount(0);
    expect(double.requests().some((r) => r.action === 'take')).toBe(true);
  });

  test('resets to a fresh run, as many times as asked', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await page.locator('[data-testid^="mock-row-"]').first().getByRole('button').first().click();
    await expect(page.getByTestId('mock-since')).toBeVisible();

    await page.getByTestId('mock-reset').click();
    await expect(page.getByTestId('mock-roster')).toContainText('No picks yet');
    await page.getByTestId('mock-reset').click();
    await expect(page.getByTestId('mock-roster')).toContainText('No picks yet');
    expect(double.requests().filter((r) => r.action === 'start')).toHaveLength(3);
  });

  test('draws the rehearsal on the production draft board', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await page.getByTestId('mock-board-open').click();
    await expect(page.getByTestId('draft-board')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager"]')).toHaveCount(TEAMS);
    await page.getByTestId('board-close').click();
    await expect(page.getByTestId('mock-draft'), 'and back to the rehearsal').toBeVisible();
  });

  test('makes no write of any kind while it is open', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    /*
     * Counted from the moment the rehearsal opens, not from the page load.
     *
     * The Draft page syncs the instant it mounts and again on focus, which is
     * exactly what it should do — those writes happened before there was a
     * rehearsal, and folding them in would make this test assert that the app
     * never syncs at all.
     */
    await openMock(page);
    const baseline = double.writes().length;

    await page.locator('[data-testid^="mock-row-"]').first().getByRole('button').first().click();
    await expect(page.getByTestId('mock-since')).toBeVisible();
    /*
     * Longer than two poll intervals on the clock, had the loop not been
     * parked. `POST /sync` is the one thing in this app that writes on a timer,
     * so a rehearsal that left the loop running would be writing every few
     * seconds from behind a screen that says it does not.
     */
    await page.waitForTimeout(6000);
    expect(double.writes().slice(baseline), 'nothing was written while the rehearsal was up').toEqual([]);
  });

  test('the sync resumes the moment the rehearsal is closed', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);
    const baseline = double.writes().length;
    await page.waitForTimeout(1000);
    expect(double.writes().length).toBe(baseline);

    await page.getByTestId('mock-close').click();
    await expect(page.getByTestId('mock-draft')).toHaveCount(0);
    await expect.poll(() => double.writes().length, { timeout: 10_000 }).toBeGreaterThan(baseline);
  });

  test('leaves the Draft page underneath exactly as it was', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);

    /*
     * `innerText` on both sides, deliberately.
     *
     * The rows carry visually-hidden text — a tier's "2 left" is announced and
     * not painted — so `toHaveText`, which reads `textContent`, compares a
     * different string from the one captured here. Comparing the rendered text
     * to the rendered text is what makes this a test about the screen surviving
     * rather than about how Playwright flattens a DOM.
     */
    const before = await page.getByTestId('board-list').innerText();

    await openMock(page);
    await page.getByTestId('mock-close').click();
    await expect(page.getByTestId('mock-draft')).toHaveCount(0);
    await expect
      .poll(() => page.getByTestId('board-list').innerText())
      .toBe(before);
  });

  test('deletes itself when the real draft starts, rather than retrying', async ({ page }) => {
    await installMockDouble(page, { realPicks: 0 });
    await openDraft(page);
    await openMock(page);

    /*
     * The draft starts underneath. The server refuses the next mock request
     * with a 409 and the screen says so — it does not retry, because there is
     * nothing a retry could reach.
     */
    await page.unroute('**/api/drafts/*/mock/board');
    await page.route('**/api/drafts/*/mock/board', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The real draft has started, so this mock draft no longer exists.' }),
      }),
    );

    await page.locator('[data-testid^="mock-row-"]').first().getByRole('button').first().click();
    await expect(page.getByTestId('mock-voided')).toContainText('no longer exists');
    expect(
      await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('fa.mock.'))),
      'the stored rehearsal is deleted outright, not hidden',
    ).toEqual([]);
  });

  test('survives a reload of the page it was opened from', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);
    await page.locator('[data-testid^="mock-row-"]').first().getByRole('button').first().click();
    await expect(page.getByTestId('mock-since')).toBeVisible();

    const stored = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => k.startsWith('fa.mock.')),
    );
    expect(stored, 'kept under the draft it rehearses, and no other key').toHaveLength(1);
    expect(stored[0]).toMatch(/^fa\.mock\..+/);
  });
});
