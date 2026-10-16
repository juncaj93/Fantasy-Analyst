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
    /* The longest source label on the widest numbers, so the sheet is tested at its fullest. */
    weekNumbers: [
      { week: 6, points: 11, source: 'this_week' },
      { week: 7, points: 23.6, source: 'sleeper' },
      { week: 8, points: 11, source: 'current' },
    ],
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
      reason: 'Two or more other managers are likely to bid, so $100 to win about 1 time in 2.',
      ceiling: 100,
      overCeiling: false,
      likely: [
        { name: 'RonJonathan', chance: 0.62, style: 'savvy', why: 'often bids on WRs' },
        { name: 'jfletcher433', chance: 0.31, style: 'chases last week’s scorers', why: 'WR on bye in week 6, no healthy backup' },
      ],
      posture: 'consider',
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
      expect(await row.getByTestId('tier-gain').innerText()).toMatch(/^\+\d+\.\d pts$|^IR stash$|^Return unknown$/);
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

  test('says each week’s number and where it came from, inside the phone', async ({ page }) => {
    await page.getByTestId('waiver-tier-row').first().click();
    const numbers = page.getByTestId('tier-detail').getByTestId('tier-detail-numbers');
    /*
     * Three weeks, each with its number and its source. A Sleeper week has no
     * word since 16 October 2026: its number wears the fallback marker, and
     * the words are for a screen reader (they are in the text, not drawn).
     */
    const week = '\\d+\\.\\d(, Sleeper projection| this week| this week’s number)';
    await expect(numbers).toHaveText(new RegExp(`^His numbersWk \\d+ ${week}( · Wk \\d+ ${week}){2}$`));
    for (const marked of await numbers.locator('.num-sleeper').all()) {
      await expect(marked.locator('.sr-only')).toHaveText(', Sleeper projection');
      expect(await marked.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
    }
    const drawn = await numbers.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
      return copy.textContent ?? '';
    });
    expect(drawn, 'no "Sleeper" drawn beside a number').not.toMatch(/sleeper/i);
    const box = (await numbers.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await noSidewaysScroll(page);
  });

  test('draws the plan card with no control on it when there is a "Do this"', async ({ page }) => {
    const card = page.getByTestId('waiver-plan');
    if ((await card.count()) === 0) {
      await expect(page.getByTestId('waivers-no-move')).toBeVisible();
      return;
    }
    await expect(card.getByRole('button')).toHaveCount(0);
    /* One claim per "Do this" move: two holes are two claims, each under its own drop. */
    const doRows = await page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row').count();
    await expect(card.getByTestId('waiver-plan-claim')).toHaveCount(doRows);
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
    await expect(bid).toContainText('to win about 1 time in 2');
    const rivals = page.getByTestId('tier-detail-rival');
    await expect(rivals).toHaveText(['RonJonathan 62% · often bids on WRs', 'jfletcher433 31% · WR on bye in week 6, no healthy backup']);
    for (const line of await rivals.all()) {
      const box = (await line.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
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

/*
 * Round 2 (13 October 2026): two holes at once (Burrow and LaPorta on bye),
 * each its own "Do this" with its own drop; the drop says why; the plan says
 * who it is not cutting (handcuffs, a lineup back); rivals carry a percent and
 * a reason; a stash with no known return is on the Watch list, labelled.
 */
function round2Fixture() {
  const love = move({
    playerId: 'r1',
    name: 'Jordan Love',
    position: 'QB',
    team: 'GB',
    tier: 'do_this',
    reasonCode: 'hole_bye',
    reason: 'Your QB Joe Burrow is on bye in week 6',
    gain: 25.9,
    alternatives: ['C.J. Stroud', 'Sam Darnold'],
    drop: { playerId: 'd-ship', name: 'Will Shipley', position: 'RB', reason: 'out now, least points lately on your bench (2.3 a week), held 2 weeks', score: 3.1, handcuff: false },
    bid: {
      kind: 'claim',
      recommended: 9,
      low: 5,
      high: 14,
      reason: 'Two or more other managers are likely to bid, so $9 to win about 3 times in 4.',
      ceiling: 17,
      overCeiling: false,
      likely: [
        { name: 'jfletcher433', chance: 0.41, style: 'chases last week’s scorers', why: 'QB on bye in week 6, no backup' },
        { name: 'MattLee04', chance: 0.12, style: 'chases last week’s scorers', why: 'rarely bids' },
      ],
      posture: 'do_this',
      thin: null,
      until: '2026-10-14T07:10:00.000Z',
    },
  });
  const andrews = move({
    playerId: 'r2',
    name: 'Mark Andrews',
    position: 'TE',
    team: 'BAL',
    tier: 'do_this',
    reasonCode: 'hole_bye',
    reason: 'Your TE Sam LaPorta is on bye in week 6',
    gain: 10.9,
    drop: { playerId: 'd-egb', name: 'Emeka Egbuka', position: 'WR', reason: '55.0 pts this season, drafted', score: 9.2, handcuff: false },
    bid: { kind: 'claim', recommended: 1, low: 1, high: 3, reason: 'Nobody is likely chasing him, so $1 to win about 3 times in 4.', ceiling: 6, overCeiling: false, likely: [], posture: 'do_this', thin: null, until: '2026-10-14T07:10:00.000Z' },
  });
  const hurt = move({
    playerId: 'r3',
    name: 'Travis Etienne',
    position: 'RB',
    team: 'JAX',
    tier: 'watch',
    reasonCode: 'ir_stash',
    reason: 'Out now, return unknown; a name to watch, not a stash yet',
    stashLabel: 'return unknown',
    gain: 0,
    drop: { playerId: 'd-mc', name: 'Ladd McConkey', position: 'WR', reason: '52.0 pts this season, drafted', score: 9.9, handcuff: false },
    bid: { kind: 'claim', recommended: 0, low: 0, high: 1, reason: 'A stash, and nobody is likely to want him: $0 should do.', ceiling: null, overCeiling: false, likely: [], posture: 'stash', thin: null, until: null },
  });
  return {
    ...tiersFixture(),
    doThis: love,
    doThese: [love, andrews],
    consider: [],
    watch: [hurt],
    dropScores: [
      { playerId: 'd-ship', name: 'Will Shipley', score: 3.1, reason: 'out now', protectedAs: null },
      { playerId: 'd-ej', name: 'Emmett Johnson', score: 6.6, reason: 'handcuff to Kenneth Walker', protectedAs: 'handcuff' },
      { playerId: 'd-allen', name: 'Braelon Allen', score: 8.4, reason: 'in your Sleeper lineup', protectedAs: 'in your lineup' },
      { playerId: 'd-egb', name: 'Emeka Egbuka', score: 9.2, reason: 'drafted', protectedAs: null },
      { playerId: 'd-br', name: 'Brian Robinson', score: 10.4, reason: 'handcuff to Bijan Robinson', protectedAs: 'handcuff' },
    ],
  };
}

const ROUND2_PLAN = {
  ...CLAIM_PLAN,
  groups: [
    { index: 1, drop: { playerId: 'd-ship', name: 'Will Shipley' }, headline: 'Drop Will Shipley', keep: [], keepNote: null, formNote: null, firstRank: 1, lastRank: 1 },
    { index: 2, drop: { playerId: 'd-egb', name: 'Emeka Egbuka' }, headline: 'Drop Emeka Egbuka', keep: [], keepNote: null, formNote: null, firstRank: 2, lastRank: 2 },
  ],
  claims: [
    { ...CLAIM_PLAN.claims[0], rank: 1, claimId: 'r1>d-ship', group: 1, addPlayerId: 'r1', addName: 'Jordan Love', dropPlayerId: 'd-ship', dropName: 'Will Shipley', bid: 9, bidRange: '$5–14', headline: 'Add Jordan Love · bid $9' },
    { ...CLAIM_PLAN.claims[0], rank: 2, claimId: 'r2>d-egb', group: 2, addPlayerId: 'r2', addName: 'Mark Andrews', addPosition: 'TE', dropPlayerId: 'd-egb', dropName: 'Emeka Egbuka', bid: 1, bidRange: '$1–3', headline: 'Add Mark Andrews · bid $1', detail: 'Your TE Sam LaPorta is on bye in week 6 · +10.9 pts' },
  ],
};

test.describe('round 2: two holes, their own drops, and the reasons', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await serve(page, { tiers: round2Fixture(), claimPlan: ROUND2_PLAN });
    await openWaivers(page);
  });

  test('draws both "Do this" moves, each in for a different player, and the card numbers both', async ({ page }) => {
    const section = page.getByTestId('waivers-recommended');
    const rows = section.getByTestId('waiver-tier-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Jordan Love');
    await expect(rows.nth(1)).toContainText('Mark Andrews');
    await expect(rows.nth(0).getByTestId('tier-drop')).toContainText('in for Will Shipley');
    await expect(rows.nth(1).getByTestId('tier-drop')).toContainText('in for Emeka Egbuka');
    await expect(page.getByTestId('waiver-plan-claim')).toHaveCount(2);
    await expect(page.getByTestId('waiver-plan')).toContainText('Drop Will Shipley');
    await expect(page.getByTestId('waiver-plan')).toContainText('Drop Emeka Egbuka');
    /* Andrews is a hole fill: never on the Watch list. */
    await expect(page.getByTestId('tier-watch')).not.toContainText('Mark Andrews');
    for (const row of await rows.all()) {
      const box = (await row.boundingBox())!;
      expect(box.height, 'a row this tall is a paragraph, not a row').toBeLessThan(160);
    }
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('labels a stash with no known return on the Watch list, at $0 to $1', async ({ page }) => {
    const row = page.locator('[data-testid="waiver-tier-row"][data-player-id="r3"]');
    await expect(row.getByTestId('tier-gain')).toHaveText('Return unknown');
    await expect(row.getByTestId('tier-bid')).toHaveText('$0 to stash');
    await noSidewaysScroll(page);
  });

  test('says why the drop, who it is not cutting, and each rival’s reason, inside the phone', async ({ page }) => {
    await page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet.getByTestId('tier-detail-drop')).toContainText('Drop Will Shipley · out now, least points lately on your bench (2.3 a week), held 2 weeks');
    await expect(sheet.getByTestId('tier-detail-kept')).toHaveText('Not cuttingEmmett Johnson (handcuff), Brian Robinson (handcuff)');
    await expect(sheet.getByTestId('tier-detail-rival')).toHaveText(['jfletcher433 41% · QB on bye in week 6, no backup', 'MattLee04 12% · rarely bids']);
    await expect(sheet.getByTestId('tier-detail-bid')).toContainText('Bid $9 · likely $5–14');
    for (const id of ['tier-detail-drop', 'tier-detail-kept', 'tier-detail-rivals']) {
      const box = (await sheet.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${id} runs off the phone`).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await noSidewaysScroll(page);
  });

  test('Team shows the same two moves', async ({ page }) => {
    await page.getByTestId('tab-team').click();
    const rows = page.getByTestId('waiver-card').getByTestId('waiver-tier-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Jordan Love');
    await expect(rows.nth(1)).toContainText('Mark Andrews');
    await noSidewaysScroll(page);
  });
});

/*
 * Alex's live screen, 14 October: Shipley to IR for Love, and Andrews with
 * the best drops listed under him, Tre' Harris first (a just-added receiver
 * with 1.2 points), then the two elite backs' handcuffs.
 */
const BEST_DROPS = [
  { playerId: 'd-th', name: "Tre' Harris", position: 'WR', stat: '1.2 pts', reason: "in your Sleeper lineup with little to show for it, lowest season points on your bench (1.2), held 1 week" },
  { playerId: 'd-br', name: 'Brian Robinson', position: 'RB', stat: 'handcuff to Bijan Robinson', reason: 'handcuff; 10.8 pts this season, held 2 weeks, handcuff to Bijan Robinson' },
  { playerId: 'd-ej', name: 'Emmett Johnson', position: 'RB', stat: 'handcuff to Kenneth Walker', reason: 'handcuff; 12.3 pts this season, held 4 weeks, handcuff to Kenneth Walker' },
];
test.describe('round 2 follow-up: an IR move, and the best drops under Andrews', () => {
  test.beforeEach(async ({ page }) => {
    const base = round2Fixture();
    const love = { ...base.doThese[0]!, drop: { playerId: 'd-ship', name: 'Will Shipley', position: 'RB', reason: 'Out; your open IR slot holds him, so no drop', score: null, handcuff: false, viaReserve: true } };
    const andrews = {
      ...base.doThese[1]!,
      tier: 'do_this',
      drop: { playerId: 'd-th', name: "Tre' Harris", position: 'WR', reason: BEST_DROPS[0]!.reason, score: 4.25, handcuff: false },
      bestDrops: BEST_DROPS,
      bid: { ...(base.doThese[1]!.bid as Record<string, unknown>), posture: 'do_this' },
    };
    const miller = move({ playerId: 'r5', name: 'Kendre Miller', position: 'RB', team: 'NO', tier: 'watch', gain: 2.2, reason: 'Starts over Braelon Allen, +2.2 pts in week 6', drop: null, needsSpot: [] });
    const tiers = { ...base, doThis: love, doThese: [love, andrews], consider: [], watch: [...base.watch, miller] };
    const plan = {
      ...ROUND2_PLAN,
      groups: [
        { ...ROUND2_PLAN.groups[0], drop: null, headline: 'Move Will Shipley to IR, then claim Jordan Love' },
        {
          ...ROUND2_PLAN.groups[1],
          drop: { playerId: 'd-th', name: "Tre' Harris" },
          headline: "Best drops: Tre' Harris, Brian Robinson, Emmett Johnson",
          bestDrops: BEST_DROPS.map(({ reason: _r, ...c }) => c),
          addPlayerId: 'r2',
        },
      ],
      claims: [
        { ...ROUND2_PLAN.claims[0], dropPlayerId: null, dropName: null },
        { ...ROUND2_PLAN.claims[1], dropPlayerId: 'd-th', dropName: "Tre' Harris" },
      ],
    };
    await inSeason(page);
    await serve(page, { tiers, claimPlan: plan });
    await openWaivers(page);
  });

  test('says "Shipley to IR" for Love and lists the best drops under Andrews, Harris first', async ({ page }) => {
    const doRows = page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row');
    await expect(doRows).toHaveCount(2);
    await expect(doRows.nth(0).getByTestId('tier-drop')).toContainText('Will Shipley to IR first');
    const card = page.getByTestId('waiver-plan');
    await expect(card).toContainText('Move Will Shipley to IR, then claim Jordan Love');
    const groups = card.getByTestId('waiver-plan-group');
    /* The list sits under the Andrews step, not under Love. */
    await expect(groups.nth(0).getByTestId('best-drops')).toHaveCount(0);
    const list = groups.nth(1).getByTestId('best-drops');
    await expect(list.getByTestId('best-drops-label')).toHaveText('Best drops (tap for why)');
    const lines = list.getByTestId('best-drop');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toHaveText("1.Tre' Harris WR \u00b7 1.2 pts");
    await expect(lines.nth(1)).toContainText('Brian Robinson');
    for (let i = 0; i < 3; i++) await expect(lines.nth(i)).not.toContainText('(');
    /* The step comes first, then the list. */
    const claimBox = (await groups.nth(1).getByTestId('waiver-plan-claim').boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(listBox.y).toBeGreaterThan(claimBox.y);
    /* A Watch list name never borrows a spot another row uses. */
    const watchRow = page.locator('[data-testid="waiver-tier-row"][data-player-id="r5"]');
    await expect(watchRow.getByTestId('tier-drop')).toContainText('needs a roster spot');
    await expect(watchRow.getByTestId('tier-drop')).not.toContainText('Will Shipley');
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('keeps every best-drops line to two lines at most, with no sideways scroll', async ({ page }) => {
    const lines = page.getByTestId('waiver-plan').getByTestId('best-drop');
    await expect(lines).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const el = lines.nth(i);
      const box = (await el.boundingBox())!;
      const lineHeight = await el.evaluate((n) => parseFloat(getComputedStyle(n).lineHeight));
      expect(box.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await noSidewaysScroll(page);
  });

  test('opens the sheet with the full reasons when the list is tapped', async ({ page }) => {
    await page.getByTestId('waiver-plan').getByTestId('best-drops').click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet).toContainText('Mark Andrews');
    const items = sheet.getByTestId('tier-detail-best-drop');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('lowest season points on your bench (1.2)');
    await expect(items.nth(1)).toContainText('handcuff to Bijan Robinson');
    const box = (await sheet.getByTestId('tier-detail-drop').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await noSidewaysScroll(page);
  });

  test('Team shows the same list under Andrews, and Shipley to IR for Love', async ({ page }) => {
    await page.getByTestId('tab-team').click();
    const rows = page.getByTestId('waiver-card').getByTestId('waiver-tier-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByTestId('tier-drop')).toContainText('Will Shipley to IR first');
    await expect(rows.nth(0).getByTestId('best-drops')).toHaveCount(0);
    const lines = rows.nth(1).getByTestId('best-drop');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText("Tre' Harris");
    for (let i = 0; i < 3; i++) {
      const el = lines.nth(i);
      const box = (await el.boundingBox())!;
      const lineHeight = await el.evaluate((n) => parseFloat(getComputedStyle(n).lineHeight));
      expect(box.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
    }
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });
});
