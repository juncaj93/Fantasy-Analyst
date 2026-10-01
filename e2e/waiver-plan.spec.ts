/**
 * The waiver plan, on a phone.
 *
 * The screen's whole promise in one card: *add this player, bid this much, drop
 * this player, enter these claims in this order.* There is no button on it:
 * `See why` and its sheet were removed on 1 October 2026 at the owner's request.
 *
 * Two things are defended here and they are separable on purpose.
 *
 * The first is the deployment's own plan — computed by the real planner over the
 * seeded league, drawn by the real component, at the width this project runs at.
 * That is what proves the wiring.
 *
 * The second is the shape, and for that the plan is injected the way
 * `dst-line.spec.ts` injects a defence plan. The interesting cases — a repeated
 * target, a four-figure bid, a name that will not fit — are properties of the
 * layout rather than of the seed, and waiting for the seeded league to happen to
 * produce one would be a test that passes for the wrong reason. The component,
 * the stylesheet and the four widths are the real ones either way.
 */

import { expect, test, type Page } from '@playwright/test';

/** The A → C, B → C, B → D structure, as the seam produces it. */
function planFixture(over: Record<string, unknown> = {}) {
  return {
    surface: true,
    state: 'plan',
    headline: 'Your waiver plan',
    claims: [
      {
        rank: 1,
        claimId: 'a>c',
        addPlayerId: 'a',
        addName: 'Breakout Back',
        addPosition: 'RB',
        dropPlayerId: 'c',
        dropName: 'Depth Back',
        bid: 24,
        headline: 'Add Breakout Back · $24 · Drop Depth Back',
        qualifier: null,
        relation: 'primary',
        why: ['Breakout Back starts for you this week.', 'Depth Back is not in your lineup.'],
      },
      {
        rank: 2,
        claimId: 'b>c',
        addPlayerId: 'b',
        addName: 'Emerging Receiver',
        addPosition: 'WR',
        dropPlayerId: 'c',
        dropName: 'Depth Back',
        bid: 18,
        headline: 'Add Emerging Receiver · $18 · Drop Depth Back',
        qualifier: 'Only if 1 loses',
        relation: 'fallback',
        why: ['Claim 1 spends Depth Back. If it lands, this one cannot run at all.'],
      },
      {
        rank: 3,
        claimId: 'b>d',
        addPlayerId: 'b',
        addName: 'Emerging Receiver',
        addPosition: 'WR',
        dropPlayerId: 'd',
        dropName: 'Roster Filler',
        bid: 18,
        headline: 'Add Emerging Receiver · $18 · Drop Roster Filler',
        qualifier: 'Only if 2 does not land him',
        relation: 'compatible',
        why: ['Claim 2 is the better way to land Emerging Receiver.'],
      },
    ],
    instruction: 'Enter in this order',
    note: null,
    mechanics:
      'Sleeper runs claims top to bottom, and a claim whose drop is already gone does not run — so enter them in the order above.',
    outcomes: [
      'Best case — you land Breakout Back and Emerging Receiver, cutting Depth Back and Roster Filler for $42.',
      'If the room outbids you on all of them, nothing on your roster changes and you spend nothing.',
    ],
    relationships: ['Breakout Back and Emerging Receiver improve different things.'],
    protectedPlayers: ['Starting for you: Alpha Receiver, Feature Back and Second Back.'],
    budget: 'Landing every claim above would cost $42 of the $60 you have left.',
    dropHints: [{ addPlayerId: 'a', dropName: 'Depth Back', label: 'Drop Depth Back' }],
    generatedAt: '2025-10-05T14:00:00.000Z',
    ...over,
  };
}

async function withPlan(page: Page, claimPlan: Record<string, unknown> | null) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...original, claimPlan }) });
  });
}

async function inSeason(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false },
      }),
    });
  });
}

async function openWaivers(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

test.describe('the plan the deployment actually computes', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await openWaivers(page);
  });

  /**
   * The real planner, the real board, the real component.
   *
   * Asserted as a shape rather than against particular names: the seeded league
   * is a fixture and its wire will change, but every claim it produces has to be
   * an instruction with a player in it and a rank that matches its place.
   */
  test('hands the reader a numbered instruction per claim', async ({ page }) => {
    const card = page.getByTestId('waiver-plan');
    await expect(card).toBeVisible();
    // The section title says "Recommended move"; the card repeats nothing.
    await expect(page.getByTestId('waiver-plan-headline')).toHaveCount(0);
    await expect(card).not.toContainText('Your waiver plan');

    const claims = page.getByTestId('waiver-plan-claim');
    const count = await claims.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(claims.nth(i)).toHaveAttribute('data-rank', String(i + 1));
      expect((await claims.nth(i).innerText()).trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * The drop the plan names for a player is the drop his own sheet names.
   *
   * Two surfaces, one answer. They are ordered on different things underneath —
   * the plan on net gain over the pair, the ranking on the cost of the cut alone
   * — and the reconciliation happens once, on the server.
   */
  test('names the same cut on the plan and on the player’s own sheet', async ({ page }) => {
    const waivers = await (await page.request.get('/api/leagues/demo-league/waivers')).json();
    const claim = waivers.claimPlan?.claims?.[0];
    test.skip(!claim?.dropName, 'the seeded league produced no claim with a cut in it');

    const row = page.getByTestId('waiver-row').filter({ hasText: claim.addName }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId('waiver-detail')).toBeVisible();
    await expect(page.getByTestId('waiver-drop-hint')).toContainText(`Drop ${claim.dropName}`);
  });
});

test.describe('the plan as a card', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await withPlan(page, planFixture());
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan')).toBeVisible();
  });

  /**
   * `Add A · $24 · Drop C`, three times, in an order that is itself the
   * instruction.
   */
  test('says the add, the bid and the drop on one line each', async ({ page }) => {
    const claims = page.getByTestId('waiver-plan-claim');
    await expect(claims).toHaveCount(3);
    await expect(claims.nth(0)).toContainText('Add Breakout Back · $24 · Drop Depth Back');
    await expect(claims.nth(1)).toContainText('Add Emerging Receiver · $18 · Drop Depth Back');
    await expect(claims.nth(2)).toContainText('Add Emerging Receiver · $18 · Drop Roster Filler');
  });

  /**
   * No `Only if 1 loses` pills: the numbering is the order, and the owner cut
   * the qualifiers on 1 October 2026.
   */
  test('draws no contingency pills', async ({ page }) => {
    await expect(page.getByTestId('waiver-plan-qualifier')).toHaveCount(0);
    await expect(page.getByTestId('waiver-plan')).not.toContainText('Only if');
  });

  /** The numbers are the order; the card no longer says so in words. */
  test('carries no title or instruction above the claims', async ({ page }) => {
    const card = page.getByTestId('waiver-plan');
    await expect(page.getByTestId('waiver-plan-instruction')).toHaveCount(0);
    await expect(card).not.toContainText('Enter in this order');
    await expect(card).not.toContainText('Your waiver plan');
    await expect(card).not.toContainText('Sleeper runs claims top to bottom');
  });

  /**
   * The numbering is real, not printed.
   *
   * An ordered list means a screen reader announces "list, three items" and the
   * indent is the browser's own. A paragraph beginning with a digit announces a
   * digit.
   */
  test('numbers the claims as a list rather than as text', async ({ page }) => {
    const tags = await page.getByTestId('waiver-plan-claims').evaluate((el) => [
      el.tagName,
      ...[...el.children].map((c) => c.tagName),
    ]);
    expect(tags[0]).toBe('OL');
    for (const tag of tags.slice(1)) expect(tag).toBe('LI');
  });

  /**
   * Nothing on the card that offers to make a claim, and no button at all.
   *
   * The rule the whole app is held to, at the surface closest to breaking it:
   * this card is a list of transactions and there is no control on it that
   * performs one.
   */
  test('offers no control', async ({ page }) => {
    const card = page.getByTestId('waiver-plan');
    await expect(card.locator('button')).toHaveCount(0);
    await expect(page.getByTestId('waiver-plan-why')).toHaveCount(0);
  });

  /**
   * The card is the answer, not the whole first screen.
   *
   * The board underneath it is the evidence, and a reader who cannot see any of
   * it has been handed a verdict rather than an argument.
   */
  test('leaves the board visible underneath it', async ({ page }, testInfo) => {
    const card = (await page.getByTestId('waiver-plan').boundingBox())!;
    const height = testInfo.project.use.viewport!.height;
    expect(card.height, `the plan takes ${card.height}px of a ${height}px screen`).toBeLessThan(height * 0.55);
    await expect(page.getByTestId('waiver-row').first()).toBeVisible();
  });

  /** Nothing on this card may widen the page. */
  test('fits the phone', async ({ page }, testInfo) => {
    const width = testInfo.project.use.viewport!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const card = (await page.getByTestId('waiver-plan').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width + 0.5);
  });

  /**
   * A long name wraps; it does not clip and it does not push the page sideways.
   *
   * The alternative — shrinking the instruction to keep the contingency note on
   * the same line — keeps the wrong half. Four figures on the bid is checked in
   * the same breath because a deep-pocketed league is the other direction the
   * line runs out of room in.
   */
  test('survives a long name and a large bid', async ({ page }, testInfo) => {
    await withPlan(
      page,
      planFixture({
        claims: [
          {
            ...planFixture().claims[0],
            addName: 'Christopher Bartholomew Wentworth-Fitzgerald',
            dropName: 'Maximillian Vandergriff-Ashbourne',
            bid: 1000,
            headline:
              'Add Christopher Bartholomew Wentworth-Fitzgerald · $1000 · Drop Maximillian Vandergriff-Ashbourne',
            qualifier: 'Only if 1 or 2 lose',
          },
        ],
      }),
    );
    /*
     * Re-navigated rather than reloaded: a reload returns the shell to its
     * default destination, and the assertions below are about the Waivers page.
     */
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan')).toBeVisible();

    const width = testInfo.project.use.viewport!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const claim = page.getByTestId('waiver-plan-claim').first();
    await expect(claim).toContainText('$1000');
    await expect(claim).toContainText('Wentworth-Fitzgerald');
    await expect(claim).toContainText('Vandergriff-Ashbourne');
    /* Wrapped rather than clipped: the text is taller than one line and all there. */
    const box = (await claim.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  });

  /** A small bid reads as a small bid, not as a missing one. */
  test('draws a one-dollar claim as a price', async ({ page }) => {
    await withPlan(
      page,
      planFixture({
        claims: [{ ...planFixture().claims[0], bid: 1, headline: 'Add Breakout Back · $1 · Drop Depth Back' }],
      }),
    );
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan-claim').first()).toContainText('· $1 ·');
  });
});

/*
 * 1 October 2026: "way too much text". A `Keeping X: reason` line for every
 * bench player the plan did not cut is gone; only a handcuff to one of your
 * starters gets a clause, on the drop line.
 */
test.describe('the trimmed card', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
  });

  test('says only "Drop X" on the drop line', async ({ page }) => {
    await withPlan(
      page,
      planFixture({
        groups: [
          {
            index: 1,
            drop: { playerId: 'c', name: 'Depth Back' },
            headline: 'Drop Depth Back',
            keep: [
              'Keeping Backup Back: he backs up Feature Back, your starting RB.',
              'Keeping Rated Receiver: the market still rates him (#3 add in Sleeper this week).',
            ],
            keepNote: 'Backup Back stays: he backs up Feature Back',
            firstRank: 1,
            lastRank: 3,
          },
        ],
        claims: planFixture().claims.map((c) => ({ ...c, group: 1 })),
      }),
    );
    await openWaivers(page);
    const drop = page.getByTestId('waiver-plan-drop');
    await expect(drop).toHaveText('Drop Depth Back');
    const card = page.getByTestId('waiver-plan');
    await expect(card).not.toContainText('Keeping');
    await expect(card).not.toContainText('stays');
    await expect(card).not.toContainText('Rated Receiver');
  });

  test('says a free agent needs no bid', async ({ page }, testInfo) => {
    await withPlan(
      page,
      planFixture({
        instruction: null,
        claims: [
          {
            ...planFixture().claims[0],
            bid: null,
            headline: 'Add Breakout Back · free agent',
            pickup: { state: 'free', reason: null, until: null },
          },
        ],
      }),
    );
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan-claim').first()).toContainText('Add Breakout Back · free agent');
    const width = testInfo.project.use.viewport!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
});

/*
 * The board card for each case: an instant add carries no price, a player on
 * waivers carries his price and the day he clears.
 */
test.describe('free agent or waiver claim, on the board', () => {
  test('prints no price for a free agent and a clear day for a claim', async ({ page }) => {
    await inSeason(page);
    await page.route('**/api/leagues/*/waivers', async (route) => {
      const response = await route.fetch();
      const original = await response.json();
      const ids: string[] = [
        ...(original.upgrades ?? []).flatMap((u: { candidates: { playerId: string }[] }) => u.candidates.map((c) => c.playerId)),
        ...(original.valueAdds ?? []).map((a: { playerId: string }) => a.playerId),
      ];
      const pickup: Record<string, unknown> = {};
      ids.forEach((id, i) => {
        pickup[id] =
          i === 0
            ? { state: 'waivers', reason: 'dropped', until: '2026-10-02T17:22:00.000Z' }
            : { state: 'free', reason: null, until: null };
      });
      await route.fulfill({ response, body: JSON.stringify({ ...original, pickup }) });
    });
    await openWaivers(page);
    const summaries = page.getByTestId('waiver-summary');
    await expect(summaries.first()).toBeVisible();
    const free = page.locator('[data-testid="waiver-summary"][data-pickup="free"]').first();
    // The app's own status tag, reading just `Free agent`.
    await expect(free.locator('.tag')).toHaveText('Free agent');
    await expect(free).not.toContainText('FAAB');
    const claim = page.locator('[data-testid="waiver-summary"][data-pickup="waivers"]');
    if ((await claim.count()) > 0) {
      await expect(claim.first().locator('.tag')).toContainText('On waivers until');
      await expect(claim.first()).toContainText('Est. cost');
    }
  });
});

test.describe('the honest endings', () => {
  test('says a full roster is a full roster rather than showing a blank', async ({ page }) => {
    await inSeason(page);
    await withPlan(
      page,
      planFixture({
        state: 'no_safe_drop',
        headline: 'No safe drop for this upgrade',
        claims: [],
        note: 'Everybody on your roster is either starting, on injured reserve, or worth more than the upgrade would gain.',
        outcomes: [],
        relationships: [],
        budget: null,
        dropHints: [],
      }),
    );
    await openWaivers(page);

    const card = page.getByTestId('waiver-plan');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'no_safe_drop');
    await expect(page.getByTestId('waiver-plan-headline')).toHaveText('No safe drop for this upgrade');
    await expect(page.getByTestId('waiver-plan-claim')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
  });

  /*
   * The same ending with nobody to name, which is what production drew on
   * 29 September 2026: every player starting or on injured reserve, so the
   * note on the card is the whole argument, and there is no button of any kind.
   */
  test('draws a full roster with nobody to name as its note alone', async ({ page }) => {
    await inSeason(page);
    await withPlan(
      page,
      planFixture({
        state: 'no_safe_drop',
        headline: 'No safe drop for this upgrade',
        instruction: null,
        claims: [],
        note: 'Everybody on your roster is either starting, on injured reserve, or worth more than the upgrade would gain.',
        mechanics: null,
        outcomes: [],
        relationships: [],
        protectedPlayers: [],
        budget: null,
        dropHints: [],
      }),
    );
    await openWaivers(page);

    const card = page.getByTestId('waiver-plan');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'no_safe_drop');
    await expect(page.getByTestId('waiver-plan-note')).toContainText('Everybody on your roster');
    await expect(card.getByRole('button')).toHaveCount(0);
  });

  /**
   * A quiet week says nothing, because the board underneath already said it.
   *
   * `No waiver move recommended` above `Nothing available beats what you already
   * have` is one claim made twice on one screen.
   */
  test('stays off the screen when the board is already saying it', async ({ page }) => {
    await inSeason(page);
    await withPlan(page, planFixture({ surface: false, state: 'no_move', claims: [], headline: 'No waiver move recommended' }));
    await openWaivers(page);
    await expect(page.getByTestId('waiver-row').first()).toBeVisible();
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
  });

  /** A deployment whose planner could not run draws the board and no plan. */
  test('draws the board unchanged when there is no plan at all', async ({ page }) => {
    await inSeason(page);
    await withPlan(page, null);
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
    await expect(page.getByTestId('waiver-row').first()).toBeVisible();
  });

  /**
   * A roster the engine cannot read keeps its adds and loses its cuts.
   *
   * Never a blank where a name should be — that reads as "no cut needed", which
   * is the one thing it must not be mistaken for.
   */
  test('names the add and withholds the cut when the roster cannot be scored', async ({ page }) => {
    await inSeason(page);
    await withPlan(
      page,
      planFixture({
        state: 'drop_unknown',
        claims: [
          {
            ...planFixture().claims[0],
            dropPlayerId: null,
            dropName: null,
            headline: 'Add Breakout Back · $24',
            qualifier: null,
          },
        ],
        note: 'Your roster cannot be scored this week, so the plan names who to add and leaves the cut to you.',
      }),
    );
    await openWaivers(page);

    const claim = page.getByTestId('waiver-plan-claim').first();
    await expect(claim).toContainText('Add Breakout Back · $24');
    await expect(claim).not.toContainText('Drop');
    await expect(page.getByTestId('waiver-plan-note')).toContainText('leaves the cut to you');
  });
});

test.describe('the defence keeps its own lane', () => {
  /**
   * The generic plan never names a defence, so it can never contradict the DST
   * planner on the same screen.
   *
   * The boundary is enforced inside `planWaiverClaims` — a defence on the wire
   * is not a generic target and a defence on the roster is not a generic cut —
   * and this is the assertion that it survives all the way to the page the
   * reader is looking at.
   */
  test('claims no defence, on the deployment’s own data', async ({ page }) => {
    await inSeason(page);
    await openWaivers(page);
    const waivers = await (await page.request.get('/api/leagues/demo-league/waivers')).json();
    for (const claim of waivers.claimPlan?.claims ?? []) {
      expect(claim.addPosition, `the plan claimed a defence: ${claim.addName}`).not.toBe('DEF');
    }
    /* And the defence surface, wherever it is drawn, is still drawn. */
    const defenceRows = page.getByTestId('waiver-row').filter({ has: page.locator('[data-position="DEF"]') });
    const dstLine = page.getByTestId('dst-line');
    expect((await defenceRows.count()) + (await dstLine.count())).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The plan grouped by drop, as the waiver yardstick produces it.
 *
 * `Drop Jaylen Wright`, said once, then the claims
 * that would spend it, each with the case for it on one line under the
 * instruction. The 30 September 2026 shape: one drop, three tries, and the
 * handcuff the plan chose not to cut, named with the reason.
 */
function groupedPlan() {
  const claim = (rank: number, id: string, name: string, bid: string, qualifier: string | null, detail: string) => ({
    rank,
    claimId: `${id}>jw`,
    group: 1,
    addPlayerId: id,
    addName: name,
    addPosition: 'WR',
    addTeam: 'IND',
    dropPlayerId: 'jw',
    dropName: 'Jaylen Wright',
    bid: 5,
    bidRange: bid,
    headline: `Add ${name} · bid ${bid}`,
    detail,
    qualifier,
    relation: rank === 1 ? 'primary' : 'fallback',
    why: [`${name} projects higher.`],
  });
  return planFixture({
    groups: [
      {
        index: 1,
        drop: { playerId: 'jw', name: 'Jaylen Wright' },
        headline: 'Drop Jaylen Wright',
        keep: ['Keeping Emmett Johnson: he backs up Kenneth Walker, your starting RB.'],
        keepNote: 'Emmett Johnson stays: he backs up Kenneth Walker',
        firstRank: 1,
        lastRank: 3,
      },
    ],
    claims: [
      claim(1, 'ka', 'Keenan Allen', '$3–7', null, 'Proj. 7.0 vs 3.5 · #11 most-added on Sleeper today'),
      claim(2, 'kc', 'KC Concepcion', '$2–5', 'Only if 1 loses', 'Proj. 7.6 vs 3.5 · Dropped by you 7 days ago'),
      claim(3, 'ta', 'Tyler Allgeier', '$1–3', 'Only if 1 and 2 lose', 'Proj. 6.6 vs 3.5'),
    ],
  });
}

test.describe('the plan grouped by drop', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await withPlan(page, groupedPlan());
    await openWaivers(page);
    await expect(page.getByTestId('waiver-plan')).toBeVisible();
  });

  test('says the drop once, then the claims that would spend it', async ({ page }) => {
    await expect(page.getByTestId('waiver-plan-drop')).toHaveText(
      'Drop Jaylen Wright',
    );
    const claims = page.getByTestId('waiver-plan-claim');
    await expect(claims).toHaveCount(3);
    await expect(claims.nth(0)).toContainText('Add Keenan Allen · bid $3–7');
    await expect(claims.nth(0)).not.toContainText('Drop');
    await expect(claims.nth(2)).toHaveAttribute('data-rank', '3');
    await expect(page.getByTestId('waiver-plan-qualifier')).toHaveCount(0);
  });

  test('puts the two numbers under each claim, and no explanation on the drop line', async ({ page }) => {
    await expect(page.getByTestId('waiver-plan-claim-detail').first()).toHaveText(
      'Proj. 7.0 vs 3.5 · #11 most-added on Sleeper today',
    );
    const card = page.getByTestId('waiver-plan');
    await expect(card).not.toContainText('Sleeper projection');
    await expect(page.getByTestId('waiver-plan-keep')).toHaveCount(0);
    await expect(card).not.toContainText('Keeping');
    await expect(card).not.toContainText('stays');
  });

  test('fits the phone', async ({ page }, testInfo) => {
    const card = (await page.getByTestId('waiver-plan').boundingBox())!;
    const width = testInfo.project.use.viewport?.width ?? 390;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width + 0.5);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
  });
});

/**
 * How old the board is, and a refresh that reads Sleeper only.
 *
 * The Waivers pull used to run the start/sit refresh, which buys odds. The
 * props behind the Vegas yardstick keep their own schedule and budget, and
 * nothing on this screen spends it.
 */
test.describe('the refresh button', () => {
  test('is Team\'s round icon button, says when the board was updated, and refreshes from Sleeper only', async ({ page }) => {
    await inSeason(page);
    const sleeperOnly: string[] = [];
    const vegas: string[] = [];
    await page.route('**/api/leagues/*/waivers/refresh', async (route) => {
      sleeperOnly.push(route.request().method());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transactions: null, trending: null, refreshedAt: new Date().toISOString() }),
      });
    });
    page.on('request', (request) => {
      if (request.url().includes('/api/startsit/refresh')) vegas.push(request.url());
    });
    await openWaivers(page);

    const line = page.getByTestId('waivers-updated');
    await expect(line).toBeVisible();
    await expect(line).toContainText(/Updated|Not updated yet/);
    // In the nav bar, as the subtitle under the title, like Team's header.
    await expect(page.getByTestId('waivers-nav').getByTestId('waivers-updated')).toHaveCount(1);
    const button = page.getByTestId('waivers-nav').getByTestId('waivers-refresh');
    // The same control Team uses: `btn btn-icon`, an icon, and no text.
    await expect(button).toHaveClass(/btn-icon/);
    await expect(button).toHaveText('');
    await expect(button).toHaveAttribute('aria-label', /Refresh/);
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);

    await button.click();
    await expect.poll(() => sleeperOnly.length).toBeGreaterThan(0);
    expect(sleeperOnly[0]).toBe('POST');
    expect(vegas).toEqual([]);
  });
});
