/**
 * The header menu's three destinations, and the rehearsal behind one of them.
 *
 * Two things are asserted here that cannot be asserted anywhere else:
 *
 *  - **the header did not grow.** The brief's one hard constraint is that the
 *    Draft nav stays under 60px at every tested width and the control does not
 *    take a second row. Three destinations behind one glyph is the design that
 *    satisfies it, and this is the measurement that proves it did — with the
 *    menu's own height measured beside it, so the popover cannot grow back into
 *    the sheet it replaced.
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
    /*
      The rest of the contract, because the rehearsal draws the real board's row
      now and the real board's row reads all of it.

      This double used to describe only what a simplified compact row looked at,
      which meant the fixture and `DraftRecommendation` had quietly drifted
      apart — and the first thing the shared row did was dereference a field
      that was not here. A double that is not the shape of the thing it stands
      in for is a test that cannot fail for the right reason.
    */
    tierCliff: {
      severity: 'none' as const,
      tierIndex: null,
      remainingInTier: 0,
      tierSize: 0,
      tierEndsAtCliff: false,
      tierEndsAtBoundary: false,
      tierGapBefore: null,
      gapToNextTier: null,
      survivingTierMates: 0,
      gapToNext: null,
      gapRatio: null,
      localMedianGap: null,
      positionMedianGap: null,
      score: 0,
      message: null,
    },
    marketHeadline: null,
    avoid: { active: false, lifetimeNet: 0, score: 0, message: '', trendNote: null },
    myGuy: { level: 0 as const, label: '', marks: '', score: 0 },
    wait: {
      state: 'unknown' as const,
      label: '',
      detail: '',
      survivalProbability: null,
    },
  };
}

interface MockDouble {
  /** Mock board requests the app has made. */
  requests(): { action: string; picks: number; slot?: number | null; position?: string | null }[];
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
  const requests: { action: string; picks: number; slot?: number | null; position?: string | null }[] = [];
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
      action?: { kind?: string; playerId?: string; slot?: number | null };
      state?: { picks?: unknown[] } | null;
      position?: string | null;
    };
    const action = body.action?.kind ?? 'resume';
    requests.push({
      action,
      picks: body.state?.picks?.length ?? 0,
      ...(body.action?.slot === undefined ? {} : { slot: body.action.slot }),
      position: body.position ?? null,
    });

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
          /*
             The league's own slots, so the team sheet has something to allocate
             into. Half PPR with one flex and a two-deep bench — the shape the
             rest of this file's fixture describes.
           */
          rosterProgress: [
            { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
            { slot: 'RB', filled: 0, required: 2, accepts: ['RB'] },
            { slot: 'WR', filled: 0, required: 2, accepts: ['WR'] },
            { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
            { slot: 'FLEX', filled: 0, required: 1, accepts: ['RB', 'WR', 'TE'] },
            { slot: 'BN', filled: 0, required: 4, accepts: [], bench: true },
          ],
          adpSnapshot: null,
          marketSource: null,
          managers: MANAGERS,
          boardPicks: [],
          pickOwners: null,
          startablePositions: POSITIONS,
          offersFlex: true,
          rosterAlerts: [],
          warnings: [],
          /*
           * The chip is honoured here, because the real route honours it: the
           * mock board is built by `buildDraftBoard` with the same `position`
           * the live board sends, so a double that returned the whole board
           * whatever was asked for would let a screen that never sent the chip
           * pass. `tests/mock.board.test.ts` holds the server half.
           */
          recommendations: Array.from({ length: 12 }, (_, i) => recommendation(i))
            .filter((r) => !taken.has(r.playerId))
            .filter((r) => !body.position || r.position === body.position),
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

/**
 * The `+` on a row, which is how a pick is made in a rehearsal.
 *
 * The list draws the real Draft screen's cards now, so the row's own button
 * opens the card — tapping that is *reading about* a player, not taking him.
 * The action lives in the slot the star occupies on the live board.
 */
function pickControl(page: Page, playerId?: string) {
  const row = playerId
    ? page.getByTestId(`mock-row-${playerId}`)
    : page.locator('[data-testid^="mock-row-"]').first();
  return row.getByTestId('mock-pick-control');
}

async function openMock(page: Page, seat?: number) {
  await page.getByTestId('draft-board-open').click();
  await page.getByTestId('go-mock-draft').click();
  await expect(page.getByTestId('mock-draft')).toBeVisible();
  /*
   * Through the setup step, which is where a mock now begins.
   *
   * Starting without choosing a seat is the reader's own seat, and is what
   * every test below wants unless it says otherwise — so the helper takes the
   * default rather than each test learning that the step exists.
   */
  await expect(page.getByTestId('mock-setup')).toBeVisible();
  if (seat != null) await page.getByTestId(`mock-seat-${seat}`).click();
  await page.getByTestId('mock-start').click();
  /*
   * Open means "the room has answered", not "the layer is on screen".
   *
   * The layer paints immediately, in `loading`, while the first board request
   * is still in the air — so a test that acted the moment it appeared was
   * racing that request. On a slower runner the race is lost: WebKit at 360
   * swapped in a 409 route before the opening `start` had been served, the
   * rehearsal was voided by its own first request, no rows were ever drawn, and
   * the click that followed waited for a row that was never coming.
   *
   * Waiting on the phase rather than on a row is deliberate: it is the same
   * precondition for a board with players on it, a finished rehearsal with none,
   * and a voided one, so every test below gets it without knowing which it is.
   */
  await expect(page.getByTestId('mock-draft')).not.toHaveAttribute('data-phase', 'loading');
}

test.describe('the header menu leads to three places, and costs the header nothing', () => {
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
     * at, with the menu open. Nothing drawn until a tap cannot add height to a
     * header — that is why this is a popover and was a sheet — and this is the
     * assertion that keeps it that way if somebody later reaches for tabs.
     */
    const during = (await page.getByTestId('draft-nav').boundingBox())!;
    expect(during.height, 'the draft header is still a two-line bar').toBeLessThan(60);
    expect(during.height).toBe(before.height);

    /*
     * And the other half of the complaint that turned the sheet into a menu:
     * half the screen covered to offer three words. A popover is as tall as
     * what is in it, so this is the measurement that stops it growing back.
     */
    const menu = (await page.getByTestId('draft-destinations').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(menu.height, 'a three-item menu does not cover the screen').toBeLessThan(viewport.height * 0.4);
    expect(menu.y, 'and it hangs below the control that opened it').toBeGreaterThan(during.y);

    await page.getByTestId('draft-destinations-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('draft-destinations')).toHaveCount(0);
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

  /**
   * Twelve rows that were twelve of the same row.
   *
   * Reported from a real draft as "I can't find myself": every seat drew
   * identically and the reader's own was marked by three letters at the end of
   * a line, in a list where every line ends in numbers. Asserted on painted
   * colour rather than on a class, because a class that stops being drawn is
   * exactly the regression this is for.
   */
  test('the draft order stripes its rows and paints your own seat', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await page.getByTestId('draft-board-open').click();
    await page.getByTestId('go-draft-order').click();
    await expect(page.getByTestId('draft-order')).toBeVisible();

    const paint = (slot: number) =>
      page.evaluate((s) => {
        const row = document.querySelector(`[data-testid="draft-order-seat-${s}"]`)!;
        const style = getComputedStyle(row);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      }, slot);

    /* Seat 1 keeps the group's surface; seat 2 is striped. */
    const odd = await paint(1);
    const even = await paint(2);
    expect(even.background, 'alternating rows are drawn differently').not.toBe(odd.background);

    /* And the reader's seat is neither of them. */
    const mine = await paint(MY_SLOT);
    expect(mine.background).not.toBe(odd.background);
    expect(mine.background).not.toBe(even.background);
    expect(mine.shadow, 'an accent bar, not just a word').not.toBe('none');
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
    await pickControl(page).click();

    await expect(page.getByTestId('mock-since')).toBeVisible();
    await expect(page.getByTestId('mock-roster')).toContainText('Mock Player');
    await expect(page.getByTestId(`mock-row-${taken}`), 'a drafted player leaves the board').toHaveCount(0);
    expect(double.requests().some((r) => r.action === 'take')).toBe(true);
  });

  /**
   * Two taps in one frame make one pick, not two rooms.
   *
   * The bug this pins, reported from a real rehearsal as "picks that quietly do
   * nothing": `phase` is a render's opinion, so two clicks dispatched before
   * React re-rendered both passed the `thinking` check and both posted
   * `stateRef.current` as it was. The server answered each with a *different*
   * room built from the same starting state, the second answer overwrote the
   * first, and the reader's pick — plus the whole round of bot picks that came
   * with it — vanished with no error anywhere. Both requests were 200s; nothing
   * failed, so nothing said anything.
   *
   * Asserted on the requests rather than on the screen, because the screen after
   * the losing round looks exactly like the screen after one clean pick. The
   * only place the loss is visible is the wire.
   */
  test('a double tap posts one pick, not two rooms built from the same state', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await page.evaluate(() => {
      const picks = [...document.querySelectorAll('[data-testid="mock-pick-control"]')];
      // Same task, no await between them: the frame a thumb — or a browser that
      // fires click twice — can actually produce.
      for (const pick of picks.slice(0, 2)) {
        pick.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });

    await expect(page.getByTestId('mock-since')).toBeVisible();
    const takes = double.requests().filter((r) => r.action === 'take');
    expect(takes, 'the second tap is the no-op the dimmed list claims it is').toHaveLength(1);
    await expect(page.getByTestId('mock-draft')).toHaveAttribute('data-phase', 'ready');
  });

  /**
   * The reported defect, from the other side of the screen.
   *
   * "Couldn't save that yet" over a rehearsal, coming and going while the draft
   * went on progressing — a pick that did nothing until it was tapped again,
   * sometimes twice. The route was never what failed: the same request answered
   * 200 across twenty-two complete drafts over the real router. The trip failed,
   * and a lost trip cost the reader the pick they had just made.
   *
   * Retrying is safe here in a way it is almost nowhere else in this app: the
   * board route writes nothing and is a pure function of the state posted to it,
   * so a second attempt is not a second pick.
   */
  test('a dropped request costs the pick nothing — it is asked again', async ({ page }) => {
    const double = await installMockDouble(page);

    /*
     * Registered after the double, so it runs first and falls through to it.
     * Two dropped trips, which is what the owner saw before a pick landed.
     */
    let drop = 0;
    await page.route('**/mock/board', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { action?: { kind?: string } };
      if (body.action?.kind === 'take' && drop < 2) {
        drop += 1;
        await route.abort('failed');
        return;
      }
      await route.fallback();
    });

    await openDraft(page);
    await openMock(page);

    const first = page.locator('[data-testid^="mock-row-"]').first();
    const taken = (await first.getAttribute('data-testid'))!.replace('mock-row-', '');
    await pickControl(page).click();

    /* One tap, and the pick is on the board — the reader never sees the loss. */
    await expect(page.getByTestId('mock-since')).toBeVisible();
    await expect(page.getByTestId(`mock-row-${taken}`)).toHaveCount(0);
    await expect(page.getByTestId('mock-error')).toHaveCount(0);
    expect(drop, 'both trips really were dropped').toBe(2);
    expect(
      double.requests().filter((r) => r.action === 'take'),
      'the retries reached the server; the tap did not become three picks',
    ).toHaveLength(1);
  });

  test('offers the pick back when every attempt is lost', async ({ page }) => {
    await installMockDouble(page);

    let dropping = true;
    await page.route('**/mock/board', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { action?: { kind?: string } };
      if (body.action?.kind === 'take' && dropping) {
        await route.abort('failed');
        return;
      }
      await route.fallback();
    });

    await openDraft(page);
    await openMock(page);
    await pickControl(page).click();

    await expect(page.getByTestId('mock-error')).toContainText('Try again in a moment');
    /*
     * The control that makes the difference between a report and a recovery:
     * without it the reader's pick is gone and the only way back is to find the
     * row again and hope.
     */
    dropping = false;
    await page.getByTestId('mock-retry').click();
    await expect(page.getByTestId('mock-since')).toBeVisible();
    await expect(page.getByTestId('mock-error')).toHaveCount(0);
  });

  /**
   * The lockout, which the first fix caused.
   *
   * Retrying a lost pick was right; serialising three unbounded attempts behind
   * a guard that swallowed every tap was not. The owner reported having to wait
   * "roughly 10+ seconds" before the app would let him tap another player —
   * which is exactly three requests with no deadline, plus their backoffs, with
   * nothing on screen admitting it.
   *
   * Measured rather than reasoned about: a request that never answers at all is
   * the worst case, and the screen has to hand the decision back long before a
   * person would give up on it.
   */
  test('a request that never answers does not lock the screen', async ({ page }) => {
    await installMockDouble(page);

    /* Registered after the double, so it runs first: this take never answers. */
    let hang = true;
    await page.route('**/mock/board', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { action?: { kind?: string } };
      if (body.action?.kind === 'take' && hang) return; // never fulfilled, never aborted
      await route.fallback();
    });

    await openDraft(page);
    await openMock(page);

    const began = Date.now();
    await pickControl(page).click();

    /*
     * The reader is told, and given the control back. Seven seconds is the
     * assertion's headroom over a four-second deadline plus a budget that
     * cannot afford a second attempt after one; the lockout this replaces had
     * no ceiling at all.
     */
    await expect(page.getByTestId('mock-error')).toBeVisible({ timeout: 7_000 });
    expect(Date.now() - began, 'the screen came back well inside the old lockout').toBeLessThan(7_000);

    /* And the trace says what was lost, which is what makes it reportable. */
    await expect(page.getByTestId('mock-trace')).toContainText('timeout');

    /* The pick is still available, on a route that now answers. */
    hang = false;
    await page.getByTestId('mock-retry').click();
    await expect(page.getByTestId('mock-since')).toBeVisible();
  });

  /**
   * A tap is never swallowed for longer than a double-tap lasts.
   *
   * The other half of the lockout: while a slow request was in the air, every
   * tap was a silent no-op. Past the double-tap window a tap now cancels what
   * is in the air and takes its place, so the screen is always answering
   * somebody who is asking again.
   */
  test('tapping again during a slow pick takes over rather than doing nothing', async ({ page }) => {
    const double = await installMockDouble(page);

    let stall = true;
    await page.route('**/mock/board', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { action?: { kind?: string } };
      if (body.action?.kind === 'take' && stall) {
        stall = false; // only the first take stalls; the reader's second lands
        return;
      }
      await route.fallback();
    });

    await openDraft(page);
    await openMock(page);

    const rows = page.locator('[data-testid^="mock-row-"]');
    await pickControl(page).click();

    /* Past the double-tap window, and on a different player. */
    await page.waitForTimeout(900);
    const second = rows.nth(1);
    const wanted = (await second.getAttribute('data-testid'))!.replace('mock-row-', '');
    await second.getByTestId('mock-pick-control').click();

    /*
     * The player they asked for *second* is the one taken. A stalled first
     * request must not leave their later tap unanswered, and must not be
     * allowed to answer over it either.
     */
    await expect(page.getByTestId(`mock-row-${wanted}`), 'the second tap is the pick that lands')
      .toHaveCount(0, { timeout: 7_000 });
    await expect(page.getByTestId('mock-roster')).toContainText('Mock Player');
    /* Two takes were asked for; only one of them was ever answered. */
    expect(double.requests().filter((r) => r.action === 'take')).toHaveLength(1);
    await expect(page.getByTestId('mock-error'), 'and no failure is reported for the one abandoned')
      .toHaveCount(0);
  });

  test('resets to a fresh run, as many times as asked', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await pickControl(page).click();
    await expect(page.getByTestId('mock-since')).toBeVisible();

    /*
     * Reset goes back to the setup step rather than straight into a new run,
     * because setup is where the seat lives and there is nowhere else to
     * change it.
     */
    await page.getByTestId('mock-reset').click();
    await expect(page.getByTestId('mock-setup')).toBeVisible();
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-roster')).toContainText('No picks yet');
    await page.getByTestId('mock-reset').click();
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-roster')).toContainText('No picks yet');
    expect(double.requests().filter((r) => r.action === 'start')).toHaveLength(3);
  });

  /**
   * The step that did not exist, and the thing it decides.
   *
   * Opening a mock used to drop the reader into a running draft at whichever
   * seat the league gave them. The seat is the one input a rehearsal has that a
   * real draft does not offer, and practising the turn at seat 1 is not
   * practising the round-turn at seat 12.
   */
  test('asks where you are drafting from before the room exists', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await page.getByTestId('draft-board-open').click();
    await page.getByTestId('go-mock-draft').click();

    await expect(page.getByTestId('mock-setup')).toBeVisible();
    await expect(page.locator('[data-testid^="mock-seat-"]')).toHaveCount(TEAMS + 1); // seats + Random
    await expect(page.getByTestId(`mock-seat-${MY_SLOT}`), 'your own chair is marked').toContainText('yours');
    expect(double.requests(), 'nothing is asked of the server until you start').toHaveLength(0);

    await page.getByTestId('mock-seat-9').click();
    await page.getByTestId('mock-start').click();

    await expect(page.getByTestId('mock-draft')).not.toHaveAttribute('data-phase', 'loading');
    const start = double.requests().find((r) => r.action === 'start')!;
    expect(start.slot, 'the seat the reader chose is what is posted').toBe(9);
  });

  test('takes your own seat when you start without choosing one', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);
    const start = double.requests().find((r) => r.action === 'start')!;
    /*
     * The reader's own seat, named rather than left implicit. Starting without
     * touching anything is the behaviour every mock had before this step
     * existed; what changed is that the wire now says which chair that was.
     */
    expect(start.slot).toBe(MY_SLOT);
  });

  test('picks a seat at random when asked, and it is one of this league’s', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await page.getByTestId('draft-board-open').click();
    await page.getByTestId('go-mock-draft').click();
    await page.getByTestId('mock-seat-random').click();

    const chosen = await page.locator('[data-state="chosen"]').first().getAttribute('data-testid');
    expect(chosen).toMatch(/^mock-seat-\d+$/);
    const slot = Number(chosen!.replace('mock-seat-', ''));
    expect(slot).toBeGreaterThanOrEqual(1);
    expect(slot).toBeLessThanOrEqual(TEAMS);
  });

  /**
   * Your own team, in the slots it will be scored in.
   *
   * The list beside it is a ranking and says nothing about what you have built;
   * two receivers into a league that starts three is the fact that decides the
   * next pick, and a flat list of names cannot show it.
   */
  test('shows the team you are building, by roster slot', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await pickControl(page).click();
    await expect(page.getByTestId('mock-since')).toBeVisible();

    await page.getByTestId('mock-team-open').click();
    await expect(page.getByTestId('mock-team')).toBeVisible();
    for (const slot of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN']) {
      await expect(page.getByTestId(`mock-team-slot-${slot}`)).toBeVisible();
    }
    // The double's picks are all RBs, so the first one lands in an RB slot.
    await expect(page.getByTestId('mock-team-slot-RB')).toContainText('Mock Player');
    await expect(page.getByTestId('mock-team-slot-QB'), 'an empty starting slot still says so').toContainText(
      'still to fill',
    );
    await expect(page.getByTestId('mock-team-note')).toHaveCount(0);
  });

  /**
   * The rehearsal's list is the Draft screen's list.
   *
   * It used to be a compact row with three numbers on it: no expansion, no
   * Insight, no news, no outlook. A reader practising on that was practising
   * against a board they would not be looking at on the day, which is the one
   * thing this feature exists not to do. The rows are `RecommendationRow` now —
   * the live screen's own component, imported rather than reimplemented.
   */
  test('draws the real Draft card, and opens it the same way', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    const row = page.locator('[data-testid^="mock-row-"]').first();
    await expect(row.getByTestId('recommendation-row')).toBeVisible();
    await expect(page.getByTestId('player-detail')).toHaveCount(0);

    /* The row's own button opens the card — reading about him, not taking him. */
    await row.getByRole('button', { expanded: false }).first().click();
    await expect(page.getByTestId('player-detail')).toBeVisible();

    /* And opening a card is not a pick. */
    await expect(page.getByTestId('mock-roster')).toContainText('No picks yet');
  });

  /**
   * The star's slot, meaning the opposite thing.
   *
   * A bookmark is "remind me later" and there is no later in a rehearsal — the
   * reader is the one picking, now. So the slot carries a `+`, and the queue
   * control is not on this screen at all: a mock cannot write to the queue, and
   * offering a control that would be refused twice is offering nothing.
   */
  test('carries a + that drafts, and no star that queues', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    /* Scoped to the layer: the Draft page underneath still has its own stars. */
    await expect(
      page.getByTestId('mock-draft').getByTestId('queue-control'),
      'no bookmark in a rehearsal',
    ).toHaveCount(0);
    const first = page.locator('[data-testid^="mock-row-"]').first();
    const taken = (await first.getAttribute('data-testid'))!.replace('mock-row-', '');
    const control = first.getByTestId('mock-pick-control');
    await expect(control).toHaveAttribute('aria-label', /Draft .* in this mock draft/);

    await control.click();
    await expect(page.getByTestId(`mock-row-${taken}`), 'the + is the pick').toHaveCount(0);
    await expect(page.getByTestId('mock-roster')).toContainText('Mock Player');
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

    await pickControl(page).click();
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
     * A rehearsal genuinely under way, before the world changes under it.
     *
     * Named rather than left to `openMock`'s own wait, because it is this
     * test's whole premise: the reader is mid-mock with players on the board,
     * and *then* the real draft starts. A voided-on-arrival rehearsal would
     * pass the assertions below while testing nothing.
     */
    const row = page.locator('[data-testid^="mock-row-"]').first();
    await expect(row).toBeVisible();

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

    await row.getByTestId('mock-pick-control').click();
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
    await pickControl(page).click();
    await expect(page.getByTestId('mock-since')).toBeVisible();

    const stored = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => k.startsWith('fa.mock.')),
    );
    expect(stored, 'kept under the draft it rehearses, and no other key').toHaveLength(1);
    expect(stored[0]).toMatch(/^fa\.mock\..+/);
  });
});

/**
 * The Draft page's position filters, over a rehearsal.
 *
 * The rehearsal was the one board in this app with no way to ask "who is the
 * best receiver left". These are the live screen's own chips — the same
 * control, the same ordering, the same league-derived set — narrowing through
 * the same `position` parameter the live board sends, so the assertions here
 * are about the wire and the row treatment rather than about a second
 * implementation.
 */
test.describe('mock draft: position filters', () => {
  test('draws the league’s own chips, and not the star', async ({ page }) => {
    await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    const row = page.getByTestId('mock-filters');
    await expect(row).toBeVisible();
    const chips = await row.locator('button').allTextContents();
    /*
     * `ALL` then the league's positions then `FLX`, which is
     * `orderFilterChips` — the same order the live row draws and the players
     * list draws, from the same helper.
     */
    expect(chips).toEqual(['ALL', 'QB', 'RB', 'WR', 'TE', 'FLX']);
    /*
     * The one difference from the live row, and it is deliberate: a star is
     * "remind me later" and there is no later in a rehearsal — the star's slot
     * on these rows carries the `+` that takes the player.
     */
    expect(chips).not.toContain('★');
  });

  test('narrows the board through the same parameter the live board sends', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    // Unfiltered, the rehearsal asks for the whole board, exactly as before.
    expect(double.requests().every((r) => r.position == null)).toBe(true);
    const mixed = await page.locator('[data-testid^="mock-row-"]').count();
    expect(mixed).toBeGreaterThan(3);

    await page.getByTestId('mock-filter-RB').click();
    await expect
      .poll(() => double.requests().filter((r) => r.position === 'RB').length)
      .toBeGreaterThan(0);
    await expect(page.getByTestId('mock-filters').getByRole('button', { name: 'RB' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Only backs are left, and the list is genuinely shorter than the mixed one.
    await expect.poll(async () => page.locator('[data-testid^="mock-row-"]').count()).toBeLessThan(mixed);
    /*
     * The double's positions cycle `QB RB WR TE` over `mock-0…mock-11`, so the
     * backs are exactly the rows whose index is one more than a multiple of
     * four. Asserting the ids rather than the drawn glyph keeps this about what
     * the filter returned rather than about how a row draws a position.
     */
    const rows = await page.locator('[data-testid^="mock-row-"]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-testid')),
    );
    for (const id of rows) expect(Number(id!.replace('mock-row-mock-', '')) % 4).toBe(1);
  });

  test('the chip survives a pick, so a rehearsal can be run inside one position', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await page.getByTestId('mock-filter-WR').click();
    await expect.poll(() => double.requests().filter((r) => r.position === 'WR').length).toBeGreaterThan(0);

    await pickControl(page).click();
    await expect(page.getByTestId('mock-since')).toBeVisible();
    /*
     * The pick itself carried the chip. That is what stops the board coming
     * back mixed under a chip that still reads WR — and it is the same ref the
     * state travels in, for the same reason.
     */
    expect(double.requests().find((r) => r.action === 'take')?.position).toBe('WR');
    await expect(page.getByTestId('mock-filters').getByRole('button', { name: 'WR' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a reset opens the next rehearsal on the whole board again', async ({ page }) => {
    const double = await installMockDouble(page);
    await openDraft(page);
    await openMock(page);

    await page.getByTestId('mock-filter-QB').click();
    await expect.poll(() => double.requests().filter((r) => r.position === 'QB').length).toBeGreaterThan(0);

    await page.getByTestId('mock-reset').click();
    await expect(page.getByTestId('mock-setup')).toBeVisible();
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-list')).toBeVisible();

    const started = double.requests().filter((r) => r.action === 'start');
    expect(started[started.length - 1]!.position, 'a new rehearsal is not still wearing the last chip').toBeNull();
    await expect(page.getByTestId('mock-filters').getByRole('button', { name: 'ALL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
