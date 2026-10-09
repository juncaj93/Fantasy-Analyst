/**
 * The waiver tiers, on a phone: Do this, Worth considering, Watch list, and
 * the drop-ready bench.
 *
 * Two halves, as in `waiver-plan.spec.ts`. The deployment's own tiers prove the
 * wiring: the real planner over the seeded league, the real components. An
 * injected payload proves the shape against the cases that break a layout (a
 * long name, a large bid, a row carrying alternatives and a shared spot), at
 * each of the four widths the projects run (360, 375, 390, 430).
 *
 * And the rule the whole screen keeps: no control on it offers a transaction.
 * Rows are buttons that open a sheet, so they say "in for X" and "$3 to win",
 * never "drop", "bid", "add" or "claim".
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason as rosterInSeason } from './helpers.ts';

/** The regular season, as the toolbar reads it, and Team's roster out of draft mode. */
async function inSeason(page: Page) {
  await rosterInSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false } }),
    });
  });
}

function move(over: Record<string, unknown>) {
  return {
    playerId: 'p',
    name: 'Player',
    position: 'RB',
    team: 'KC',
    tier: 'consider',
    reasonCode: 'upgrade',
    reason: 'Starts over Somebody, +2.0 pts in week 6',
    gain: 2.4,
    lineupGain: 2.2,
    insurance: 0.2,
    byWeek: [
      { week: 6, change: 2 },
      { week: 7, change: 0.4 },
      { week: 8, change: 0 },
    ],
    rate: 11,
    prefs: [],
    drop: { playerId: 'd1', name: 'Kendre Miller', position: 'RB' },
    dropCost: 0.05,
    competesWith: [],
    alternatives: [],
    alternativeTo: null,
    planExcluded: null,
    lastWeekPoints: 12.4,
    bid: { kind: 'free', recommended: null, low: null, high: null, reason: 'Free agent: first come, no bid', ceiling: null, overCeiling: false, likely: [], thin: null, until: null },
    ...over,
  };
}

const LONG = 'Christopher Montgomery-Wellington III';

function tiersFixture() {
  const doThis = move({
    playerId: 't1',
    name: LONG,
    position: 'QB',
    team: 'PIT',
    tier: 'do_this',
    reasonCode: 'hole_bye',
    reason: 'Your QB Joe Burrow is on bye in week 6',
    gain: 22.3,
    alternatives: ['C.J. Stroud', 'Jordan Love', 'Sam Darnold'],
    competesWith: ["De'Von Achane"],
  });
  const claim = move({
    playerId: 't2',
    name: 'Amon-Ra St. Brown-Jefferson',
    position: 'WR',
    team: 'DET',
    gain: 3.1,
    bid: {
      kind: 'claim',
      recommended: 100,
      low: 64,
      high: 100,
      reason: 'Scored 31.2 last week, which draws the chasers; a likely RonJonathan target (#2 on Sleeper’s adds), so bid $100.',
      ceiling: 100,
      overCeiling: false,
      likely: [
        { name: 'RonJonathan', chance: 0.62, style: 'savvy' },
        { name: 'jfletcher433', chance: 0.31, style: 'chases last week’s scorers' },
      ],
      thin: null,
      until: '2026-10-14T07:10:00.000Z',
    },
  });
  const stash = move({ playerId: 't3', name: "De'Von Achane", position: 'RB', team: 'MIA', reasonCode: 'ir_stash', reason: 'Out now, worth a starting spot when back; you have an open IR slot to hold him', gain: -0.6, competesWith: [LONG] });
  const watch = move({ playerId: 't4', name: 'Khalil Shakir', position: 'WR', team: 'BUF', tier: 'watch', gain: 1.2, reason: 'Starts over Emeka Egbuka, +1.1 pts in week 5' });
  return {
    doThis,
    consider: [claim, stash],
    watch: [watch],
    dropReady: [{ playerId: 'd1', name: 'Kendre Miller', position: 'RB', cost: 0.05, overReplacement: 0.2, reason: 'No start in weeks 5 to 7; barely better than a free agent' }],
    window: { weeks: [5, 6, 7], weights: [1, 1, 0.5] },
    thresholds: { doThis: 4, consider: 1.5, watch: 0.4 },
    valued: 44,
    unvalued: 10,
    lastWeek: { week: 4, known: true },
    freeAgentRule: 'In this league a dropped player is on waivers for 2 days, and a player whose game has started waits for the Wednesday run; anyone else is an instant add.',
    audit: [],
    profiles: [],
  };
}

const CLAIM_PLAN = {
  surface: true,
  state: 'plan',
  headline: 'Do this',
  instruction: null,
  groups: [{ index: 1, drop: { playerId: 'd1', name: 'Kendre Miller' }, headline: 'Drop Kendre Miller', keep: [], keepNote: null, formNote: null, firstRank: 1, lastRank: 1 }],
  claims: [
    {
      rank: 1,
      claimId: 't1>d1',
      group: 1,
      addPlayerId: 't1',
      addName: LONG,
      addPosition: 'QB',
      addTeam: 'PIT',
      dropPlayerId: 'd1',
      dropName: 'Kendre Miller',
      bid: null,
      bidRange: null,
      headline: `Add ${LONG} · free agent`,
      detail: 'Your QB Joe Burrow is on bye in week 6 · +22.3 pts',
      qualifier: null,
      relation: 'primary',
      why: [],
      pickup: null,
    },
  ],
  note: null,
  mechanics: null,
  outcomes: [],
  relationships: [],
  protectedPlayers: [],
  budget: null,
  dropHints: [],
  generatedAt: '2026-10-08T18:00:00.000Z',
};

async function serve(page: Page, over: Record<string, unknown>) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...original, ...over }) });
  });
}

async function openWaivers(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** Every control on the screen, read for a transaction word. */
async function noTransactionControl(page: Page) {
  const texts = (await page.locator('button:visible').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase());
  for (const text of texts) {
    for (const word of ['add', 'drop', 'claim', 'bid', 'submit']) {
      expect(new RegExp(`\\b${word}\\b`).test(text), `a control reads "${word}": ${text}`).toBe(false);
    }
    expect(text).not.toMatch(/\b(added|dropped|claimed|submitted)\b|\bwill (add|drop|claim|bid)\b/);
  }
}

test.describe('the tiers the deployment computes', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await openWaivers(page);
  });

  test('open on "Do this", and every move says why in one line', async ({ page }) => {
    await expect(page.getByTestId('waivers-recommended-title')).toHaveText('Do this');
    const rows = page.getByTestId('waiver-tier-row');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      await expect(row.getByTestId('tier-reason')).toHaveCount(1);
      expect((await row.getByTestId('tier-reason').innerText()).trim().length).toBeGreaterThan(0);
      expect(await row.getByTestId('tier-gain').innerText()).toMatch(/^\+\d+\.\d pts$|^IR stash$/);
    }
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('opens a move into its lineup arithmetic, its spot and its price', async ({ page }) => {
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet).toBeVisible();
    for (const label of ['Why', 'Lineup', 'Your spot', 'Last week']) await expect(sheet).toContainText(label);
    await expect(sheet.getByTestId('tier-detail-weeks')).toContainText('Wk ');
    await expect(sheet.getByTestId('tier-detail-bid')).toBeVisible();
    await expect(sheet).toContainText('this app never makes a transaction');
  });

  test('draws the plan card with no control on it when there is a "Do this"', async ({ page }) => {
    const card = page.getByTestId('waiver-plan');
    if ((await card.count()) === 0) {
      await expect(page.getByTestId('waivers-no-move')).toBeVisible();
      return;
    }
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByTestId('waiver-plan-claim')).toHaveCount(1);
  });
});

test.describe('the tiers as a layout', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await serve(page, { tiers: tiersFixture(), claimPlan: CLAIM_PLAN });
    await openWaivers(page);
  });

  test('keeps a long name, a $100 bid, alternatives and a shared spot on the phone', async ({ page }) => {
    const first = page.getByTestId('waiver-tier-row').first();
    await expect(first).toContainText(LONG);
    await expect(first.getByTestId('tier-extra')).toHaveText('Or C.J. Stroud, Jordan Love, Sam Darnold');
    /* The name is never the part that gives way: the badge shrinks first. */
    const name = (await first.locator('.player-name').boundingBox())!;
    expect(name.width).toBeGreaterThan(100);

    const claim = page.locator('[data-testid="waiver-tier-row"][data-player-id="t2"]');
    await expect(claim.getByTestId('tier-bid')).toHaveText('$100 to win');
    await expect(claim.getByTestId('tier-drop')).toContainText('in for Kendre Miller');
    const box = (await claim.boundingBox())!;
    expect(box.height, 'a row this tall is a paragraph, not a row').toBeLessThan(160);
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('says each tier under its own heading, in order', async ({ page }) => {
    const titles = ['waivers-recommended-title', 'tier-consider-title', 'tier-watch-title', 'drop-ready-title'];
    let last = -1;
    for (const id of titles) {
      const y = (await page.getByTestId(id).boundingBox())!.y;
      expect(y, `${id} is out of order`).toBeGreaterThan(last);
      last = y;
    }
    await expect(page.getByTestId('tier-consider-title')).toHaveText('Worth considering');
    await expect(page.getByTestId('tier-watch-title')).toHaveText('Watch list');
    await expect(page.locator('[data-player-id="t3"]').getByTestId('tier-gain')).toHaveText('IR stash');
    await expect(page.getByTestId('drop-ready-row')).toHaveText(/Kendre Miller.*No start in weeks 5 to 7/);
    await expect(page.getByTestId('drop-ready').getByRole('button')).toHaveCount(0);
  });

  test('puts the bid, its reason and the likely rivals in the sheet', async ({ page }) => {
    await page.locator('[data-testid="waiver-tier-row"][data-player-id="t2"]').click();
    const bid = page.getByTestId('tier-detail-bid');
    await expect(bid).toContainText('Bid $100 · likely $64–100');
    await expect(bid).toContainText('a likely RonJonathan target');
    await expect(page.getByTestId('tier-detail-rivals')).toHaveText('Likely rivals: RonJonathan 62%, jfletcher433 31%');
    await noSidewaysScroll(page);
  });

  test('says a free agent needs no bid, and the league rule once', async ({ page }) => {
    await expect(page.getByTestId('waiver-tier-row').first().getByTestId('tier-free')).toHaveText('Free agent');
    await expect(page.getByTestId('waivers-free-agent-rule')).toHaveCount(1);
  });
});

test.describe('a week with nothing to do', () => {
  test('says so where "Do this" would be, and still lists the drop-ready bench', async ({ page }) => {
    await inSeason(page);
    const empty = { ...tiersFixture(), doThis: null, consider: [], watch: [] };
    await serve(page, { tiers: empty, claimPlan: { ...CLAIM_PLAN, surface: false, state: 'no_targets', claims: [], groups: [] } });
    await openWaivers(page);
    await expect(page.getByTestId('waivers-no-move-headline')).toHaveText('No must-do move this week');
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
    await expect(page.getByTestId('drop-ready-row')).toHaveCount(1);
    await noSidewaysScroll(page);
  });
});

test.describe('Team, from the same answer', () => {
  test('draws at most two waiver moves, "Do this" first, with no transaction control', async ({ page }) => {
    await inSeason(page);
    await serve(page, { tiers: tiersFixture(), claimPlan: CLAIM_PLAN });
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    const card = page.getByTestId('waiver-card');
    await expect(card).toBeVisible();
    const rows = card.getByTestId('waiver-tier-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-tier', 'do_this');
    await rows.first().click();
    await expect(page.getByTestId('tier-detail')).toBeVisible();
    await noSidewaysScroll(page);
  });
});
