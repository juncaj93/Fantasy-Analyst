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
 * Cards are buttons that open a sheet. Since 21 October 2026 a card carries
 * status chips (`Drop: Miller`, `Pick your drop`), which describe the plan in
 * Alex's words; the control itself, its name and the rest of its text never
 * reads "drop", "bid", "add" or "claim".
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

/** Unfold Watch list, Drop-ready and Trending, which open collapsed (22 October 2026). */
async function openFolds(page: Page) {
  const closed = page.locator('.wfold .bench-toggle[aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** The fixed set of chips a waiver card may carry (21 October 2026). */
const CHIP = /^(Free agent|Waivers( until \w+)?( \$\d+(–\d+)?)?|Open spot|Needs a drop|Pick your drop|Drop: .+|IR: .+|\$\d+(–\d+)?|Starter out|Q|D|O|IR|PUP|SUS)$/;

/** Every control on the screen, read for a transaction word. A card's status chips are labels, read on their own. */
async function noTransactionControl(page: Page) {
  for (const chip of await page.locator('button:visible [data-testid="wcard-chip"]').allInnerTexts()) expect(chip.trim()).toMatch(CHIP);
  const texts = (
    await page.locator('button:visible').evaluateAll((els) =>
      /* A folded list's toggle names the list ("Drop-ready (2)"); it opens rows, nothing else. */
      els.filter((el) => !el.classList.contains('bench-toggle')).map((el) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('[data-testid="wcard-chip"]').forEach((n) => n.remove());
        return `${copy.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
      }),
    )
  ).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase());
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
      /* At most one short reason; the full sentence is the sheet's "Why". */
      for (const reason of await row.getByTestId('tier-reason').allInnerTexts()) expect(reason.trim().length).toBeLessThanOrEqual(32);
      expect(await row.getByTestId('tier-gain').innerText()).toMatch(/^\+\d+\.\d$|^—$/);
    }
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('opens a move on two players side by side, and nothing else', async ({ page }) => {
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet).toBeVisible();
    /* The seeded moves fill open spots, so the other column is the empty slot. */
    const view = sheet.getByTestId('wsheet-compare').or(sheet.getByTestId('wsheet-weeks'));
    await expect(view).toBeVisible();
    for (const gone of ['Why', 'Lineup', 'Your spot', 'Last week', 'His numbers', 'Also fits', 'never makes a transaction', 'Advisory']) {
      await expect(sheet).not.toContainText(gone);
    }
  });

  test('adds three weeks up week by week, and marks a Sleeper week without the word', async ({ page }) => {
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await sheet.getByTestId('wsheet-period-three').click();
    const weeks = sheet.getByTestId('wsheet-week');
    await expect(weeks).toHaveCount(3);
    for (const col of [0, 1]) {
      let sum = 0;
      for (const row of await weeks.all()) sum += Number(await row.getByTestId('wsheet-cell').nth(col).getAttribute('data-points'));
      const total = Number(await sheet.getByTestId('wsheet-total-cell').nth(col).getAttribute('data-points'));
      expect(total).toBeCloseTo(sum, 6);
      expect(await sheet.getByTestId('wsheet-total-cell').nth(col).innerText()).toBe(sum.toFixed(1));
    }
    for (const marked of await sheet.locator('[data-testid="wsheet-cell"].num-sleeper').all()) {
      await expect(marked.locator('.sr-only')).toHaveText(', Sleeper projection');
      expect(await marked.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
    }
    const drawn = await sheet.getByTestId('wsheet-weeks').evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
      return copy.textContent ?? '';
    });
    expect(drawn, 'no "Sleeper" drawn beside a number').not.toMatch(/sleeper/i);
    const box = (await sheet.getByTestId('wsheet-weeks').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await noSidewaysScroll(page);
  });

  test('draws "Do this" as cards, with no summary box when each claim stands alone', async ({ page }) => {
    const doRows = page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row');
    if ((await doRows.count()) === 0) {
      await expect(page.getByTestId('waivers-no-move')).toBeVisible();
      return;
    }
    /* Each "Do this" move has its own drop or an open spot, so nothing depends on anything: the cards say it all. */
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
    await noTransactionControl(page);
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
    await expect(first.getByTestId('tier-reason')).toHaveText('Burrow on bye wk 6');
    /* The name is never the part that gives way: the badge shrinks first. */
    const name = (await first.locator('.player-name').boundingBox())!;
    expect(name.width).toBeGreaterThan(100);

    const claim = page.locator('[data-testid="waiver-tier-row"][data-player-id="t2"]');
    /* One chip for the claim: the waiver status and the bid band together (22 October 2026). */
    await expect(claim.getByTestId('wcard-chip')).toHaveText(['Waivers $64–100', 'Drop: Miller']);
    const box = (await claim.boundingBox())!;
    expect(box.height, 'a row this tall is a paragraph, not a row').toBeLessThan(110);
    await noSidewaysScroll(page);
    await noTransactionControl(page);

    /* The sheet carries the card's chips: the status or bid, then the drop. */
    await claim.click();
    await expect(page.getByTestId('tier-detail').getByTestId('wsheet-chips').locator('[data-chip]')).toHaveText(['Waivers $64–100', 'Drop: Miller']);
  });

  test('says each tier under its own heading, in order, the long lists folded', async ({ page }) => {
    const titles = ['waivers-recommended-title', 'tier-consider-title', 'tier-watch-title', 'drop-ready-title'];
    let last = -1;
    for (const id of titles) {
      const y = (await page.getByTestId(id).boundingBox())!.y;
      expect(y, `${id} is out of order`).toBeGreaterThan(last);
      last = y;
    }
    await expect(page.getByTestId('tier-consider-title')).toHaveText('Worth considering');
    await expect(page.getByTestId('tier-watch-title')).toHaveText(/^Watch list \(\d+\)$/);
    await expect(page.getByTestId('drop-ready-title')).toHaveText('Drop-ready (1)');
    /* Folded until tapped, like Team's bench. */
    await expect(page.getByTestId('tier-watch-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('drop-ready-row')).toHaveCount(0);
    await openFolds(page);
    await expect(page.getByTestId('tier-watch-toggle')).toHaveAttribute('aria-expanded', 'true');
    /* A stash has no points: Team's dash in the score column, the words on the arrow line. */
    await expect(page.locator('[data-player-id="t3"]').getByTestId('tier-gain')).toHaveText('—');
    await expect(page.locator('[data-player-id="t3"]').getByTestId('tier-reason')).toHaveText('IR stash, out now');
    await expect(page.getByTestId('drop-ready-row')).toHaveText(/Kendre Miller.*No start in weeks 5 to 7/);
    await expect(page.getByTestId('drop-ready').getByRole('button')).toHaveCount(0);
  });

  test('says a free agent in a chip, and no rule or help text anywhere', async ({ page }) => {
    await expect(page.getByTestId('waiver-tier-row').first().locator('[data-chip="free"]')).toHaveText('Free agent');
    await expect(page.getByTestId('waivers-free-agent-rule')).toHaveCount(0);
    await expect(page.getByTestId('waivers-info-button')).toHaveCount(0);
    await openFolds(page);
    for (const gone of ['Advisory', 'never makes', 'instant add', 'not scored here', 'what the move adds']) await expect(page.locator('main')).not.toContainText(gone);
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
    await expect(page.getByTestId('drop-ready-title')).toHaveText('Drop-ready (1)');
    await openFolds(page);
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
    await expect(rows.nth(0).locator('[data-chip="drop"]')).toHaveText('Drop: Shipley');
    await expect(rows.nth(1).locator('[data-chip="drop"]')).toHaveText('Drop: Egbuka');
    await expect(rows.nth(1).getByTestId('tier-reason')).toHaveText('LaPorta on bye wk 6');
    /* Two claims, each with its own drop: neither depends on the other, so no summary box. */
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
    /* Andrews is a hole fill: never on the Watch list. */
    await openFolds(page);
    await expect(page.getByTestId('tier-watch')).not.toContainText('Mark Andrews');
    for (const row of await rows.all()) {
      const box = (await row.boundingBox())!;
      expect(box.height, 'a row this tall is a paragraph, not a row').toBeLessThan(110);
    }
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });

  test('labels a stash with no known return on the Watch list, at $0 to $1', async ({ page }) => {
    await openFolds(page);
    const row = page.locator('[data-testid="waiver-tier-row"][data-player-id="r3"]');
    await expect(row.getByTestId('tier-gain')).toHaveText('—');
    await expect(row.getByTestId('tier-reason')).toHaveText('Out now, return unknown');
    await expect(row.locator('[data-chip="waivers"]')).toHaveText('Waivers $0–1');
    await row.click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet.getByTestId('wsheet-chips').locator('[data-chip]')).toHaveText(['Waivers $0–1', 'Drop: McConkey']);
    /* This payload carries no week figures, so the sheet has this week only (the three-week default for a stash is a unit test). */
    await noSidewaysScroll(page);
  });

  test('lists the drop on the sheet by name, pill and season points, and no reasons', async ({ page }) => {
    await page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet.getByTestId('tier-detail-best-drop')).toHaveCount(1);
    await expect(sheet.getByTestId('tier-detail-best-drop')).toContainText('Will Shipley');
    for (const gone of ['Not cutting', 'jfletcher433', 'least points lately', 'Bid $9']) await expect(sheet).not.toContainText(gone);
    const box = (await sheet.getByTestId('wsheet-drops').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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

  test('says "IR: Shipley" for Love and "Drop: Harris" for Andrews, with the best drops on the sheet', async ({ page }) => {
    const doRows = page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row');
    await expect(doRows).toHaveCount(2);
    await expect(doRows.nth(0).locator('[data-chip="ir"]')).toHaveText('IR: Shipley');
    await expect(doRows.nth(1).locator('[data-chip="drop"]')).toHaveText('Drop: Harris');
    /* No summary box and no drop list on a card: both moves stand alone. */
    await expect(page.getByTestId('waiver-plan')).toHaveCount(0);
    await expect(page.getByTestId('best-drops')).toHaveCount(0);
    /* A Watch list name never borrows a spot another row uses. */
    await openFolds(page);
    const watchRow = page.locator('[data-testid="waiver-tier-row"][data-player-id="r5"]');
    await expect(watchRow.locator('[data-chip="needs"]')).toHaveText('Needs a drop');
    await expect(watchRow).not.toContainText('Shipley');
    await noSidewaysScroll(page);
    await noTransactionControl(page);
    await watchRow.click();
    await expect(page.getByTestId('tier-detail').getByTestId('wsheet-chips').locator('[data-chip]')).toHaveText(['Free agent', 'Needs a drop']);
  });

  test('opens Andrews onto three drop options: name, pill and season points, no reasons', async ({ page }) => {
    await page.getByTestId('waivers-recommended').getByTestId('waiver-tier-row').nth(1).click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet).toContainText('Mark Andrews');
    const items = sheet.getByTestId('tier-detail-best-drop');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Tre' Harris");
    await expect(items.nth(0)).toContainText('1.2 pts');
    await expect(items.nth(1)).toContainText('Brian Robinson');
    await expect(sheet).not.toContainText('lowest season points');
    await expect(sheet).not.toContainText('handcuff to');
    for (let i = 0; i < 3; i++) {
      const box = (await items.nth(i).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await noSidewaysScroll(page);
  });

  test('Team shows the same cards: IR: Shipley for Love, Drop: Harris for Andrews, the list on the sheet', async ({ page }) => {
    await page.getByTestId('tab-team').click();
    const rows = page.getByTestId('waiver-card').getByTestId('waiver-tier-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('[data-chip="ir"]')).toHaveText('IR: Shipley');
    await expect(rows.nth(1).locator('[data-chip="drop"]')).toHaveText('Drop: Harris');
    await expect(page.getByTestId('best-drops')).toHaveCount(0);
    await rows.nth(1).click();
    await expect(page.getByTestId('tier-detail').getByTestId('tier-detail-best-drop')).toHaveCount(3);
    await noSidewaysScroll(page);
    await noTransactionControl(page);
  });
});

/*
 * The waiver card (21 October 2026), at each of the four widths the projects
 * run: a 44px face that is never squashed, a name line and a chip line that
 * never wrap, a third line only for a reason, rows in one card with hairline
 * dividers like "Your lineup" (22 October 2026; the padding, type and sizes
 * are the parity test's below), a 44px tap target, and no "Sleeper" drawn
 * beside a number.
 */
test.describe('the waiver card on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await inSeason(page);
    await serve(page, { tiers: round2Fixture(), claimPlan: ROUND2_PLAN });
    await openWaivers(page);
  });

  test('two lines, three with a reason; no photo; nothing wraps or clips sideways', async ({ page }) => {
    const cards = page.getByTestId('waiver-tier-row');
    await expect(cards.first()).toBeVisible();
    const width = page.viewportSize()!.width;
    const measured = await cards.evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const faces = el.querySelectorAll('img.player-face, .player-face, .cmp2-face').length;
        const top = el.querySelector('.player-row-top')!.getBoundingClientRect();
        const name = el.querySelector('.player-row-top .player-name')!.getBoundingClientRect();
        const chips = el.querySelector('[data-testid="wcard-chips"]') as HTMLElement;
        const chipsBox = chips.getBoundingClientRect();
        const kids = [...chips.children].map((c) => c.getBoundingClientRect());
        const reason = el.querySelector('[data-testid="tier-reason"]');
        return {
          left: box.left,
          right: box.right,
          height: box.height,
          bottom: box.bottom,
          padding: [style.paddingTop, style.paddingLeft, style.paddingRight, style.paddingBottom].map(parseFloat),
          inGroup: el.parentElement?.classList.contains('slot-group') ?? false,
          faces,
          identityBeforeName: (() => {
            const pill = el.querySelector('.player-row-top .pos-pill')!.getBoundingClientRect();
            const logo = el.querySelector('.player-row-top .team-logo, .player-row-top .team-code')?.getBoundingClientRect();
            return pill.right <= (logo?.left ?? name.left) + 1 && (logo ? logo.right <= name.left + 1 : true);
          })(),
          topHeight: top.height,
          nameHeight: name.height,
          nameLineHeight: parseFloat(getComputedStyle(el.querySelector('.player-row-top .player-name')!).lineHeight) || 20,
          chipsHeight: chipsBox.height,
          chipRight: chipsBox.right,
          childTops: kids.map((k) => Math.round((k.top + k.bottom) / 2)),
          childRights: kids.map((k) => k.right),
          hasReason: reason != null,
        };
      }),
    );
    for (const card of measured) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(width);
      expect(card.height, 'a tap target under 44px').toBeGreaterThanOrEqual(44);
      expect(card.inGroup, 'a row outside the one card').toBe(true);
      expect(card.faces, 'a photo on a list card (22 October 2026: photos only on the sheet)').toBe(0);
      expect(card.identityBeforeName, 'pill, logo, then name, as on Team').toBe(true);
      expect(card.nameHeight, 'the name wrapped').toBeLessThanOrEqual(card.nameLineHeight * 1.5);
      /* One line of chips: every chip on the same row, none past the card. */
      expect(new Set(card.childTops).size, 'the chip line wrapped').toBe(1);
      for (const r of card.childRights) expect(r).toBeLessThanOrEqual(card.right - card.padding[2]! + 0.5);
      /* The lineup row's first line, then the chip line and at most one reason line. */
      expect(card.height).toBeLessThanOrEqual(card.hasReason ? 84 : 66);
    }
    /* Rows in one card touch: a hairline between them, no gap. */
    for (let i = 1; i < measured.length; i++) {
      const gap = (await cards.nth(i).boundingBox())!.y - measured[i - 1]!.bottom;
      if (gap >= 0 && gap < 20) expect(Math.round(gap)).toBe(0);
    }
    const drawn = await cards.evaluateAll((els) => els.map((el) => el.textContent ?? '').join(' '));
    expect(drawn, 'no "Sleeper" beside a number').not.toMatch(/sleeper\s*\d|\d\s*sleeper/i);
    await noSidewaysScroll(page);
  });

  test('a long name and the longest chips still keep to one line each', async ({ page }) => {
    const base = round2Fixture();
    const long = { ...base.doThese[0]!, name: 'Christopher Montgomery-Wellington III', drop: { ...base.doThese[0]!.drop!, name: 'Bartholomew Featherstonehaugh-Smythe' } };
    await serve(page, { tiers: { ...base, doThis: long, doThese: [long, base.doThese[1]!] }, claimPlan: ROUND2_PLAN });
    await page.reload();
    await page.getByTestId('tab-waivers').click();
    const card = page.getByTestId('waiver-tier-row').first();
    await expect(card).toContainText('Christopher');
    const lines = await card.evaluate((el) => {
      const chips = [...el.querySelectorAll('[data-testid="wcard-chips"] > *')].map((c) => { const r = c.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); });
      const name = el.querySelector('.player-row-top .player-name') as HTMLElement;
      const waivers = el.querySelector('[data-chip="waivers"]') as HTMLElement;
      return {
        chipRows: new Set(chips).size,
        nameClipped: name.scrollWidth > name.clientWidth,
        nameWraps: name.getBoundingClientRect().height > 30,
        waivers: waivers.textContent,
        waiversClipped: waivers.scrollWidth > waivers.clientWidth + 0.5,
      };
    });
    expect(lines.chipRows).toBe(1);
    /* "Waivers $5–14" fits whole beside the name at every width. */
    expect(lines.waivers).toBe('Waivers $5–14');
    expect(lines.waiversClipped, 'the waiver chip was cut off').toBe(false);
    expect(lines.nameWraps).toBe(false);
    await noSidewaysScroll(page);
  });

  test('the header is the title, the update time, the budget and refresh: no info button', async ({ page }) => {
    await expect(page.getByTestId('waivers-info-button')).toHaveCount(0);
    const refresh = (await page.getByTestId('waivers-refresh').boundingBox())!;
    expect(refresh.width).toBeGreaterThanOrEqual(44);
    expect(refresh.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId('waivers-budget')).toHaveText(/^ · FAAB \$\d+ of \$\d+$/);
    await expect(page.getByTestId('faab-budget')).toHaveCount(0);
    await expect(page.getByTestId('tier-watch-note')).toHaveCount(0);
    await noSidewaysScroll(page);
  });

  test('Team draws the same card with the same numbers as Waivers', async ({ page }) => {
    const read = async () =>
      page.getByTestId('waiver-tier-row').evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute('data-player-id'),
          cls: el.className,
          gain: el.querySelector('[data-testid="tier-gain"]')?.textContent,
          chips: [...el.querySelectorAll('[data-testid="wcard-chip"]')].map((c) => c.textContent),
          reason: el.querySelector('[data-testid="tier-reason"]')?.textContent ?? null,
        })),
      );
    const onWaivers = await read();
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('waiver-card').getByTestId('waiver-tier-row').first()).toBeVisible();
    const onTeam = await page.getByTestId('waiver-card').getByTestId('waiver-tier-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-player-id')));
    const teamCards = (await read()).filter((c) => onTeam.includes(c.id));
    expect(teamCards.length).toBeGreaterThan(0);
    for (const card of teamCards) expect(card).toEqual(onWaivers.find((w) => w.id === card.id));
  });
});

/*
 * A plan whose claims depend on each other gets the numbered summary: names
 * only, one line each, the fallback saying when it runs.
 */
test.describe('the "Do this" summary', () => {
  test('appears only for claims that depend on each other, as short numbered lines', async ({ page }) => {
    await inSeason(page);
    const plan = {
      ...ROUND2_PLAN,
      claims: [
        { ...ROUND2_PLAN.claims[0], addName: 'Keenan Allen', dropPlayerId: 'd-jw', dropName: 'Jaylen Wright' },
        { ...ROUND2_PLAN.claims[1], addName: 'Tyjae Spears', dropPlayerId: 'd-jw', dropName: 'Jaylen Wright', qualifier: 'Only if 1 loses', relation: 'fallback' },
      ],
    };
    await serve(page, { tiers: round2Fixture(), claimPlan: plan });
    await openWaivers(page);
    const box = page.getByTestId('waiver-plan');
    await expect(box.getByTestId('waiver-plan-claim')).toHaveText(['Add Allen, drop Wright', 'Add Spears, drop Wright, if 1 loses']);
    await expect(box.getByRole('button')).toHaveCount(0);
    await noSidewaysScroll(page);
  });
});

/*
 * Style parity (22 October 2026): Alex compared Waivers with Team and they
 * "looked like two different apps". A waiver row is a variant of the Team
 * lineup row, and this reads the computed styles off both, at every width the
 * projects run, and fails naming the property and the two values.
 */
type Look = Record<string, string>;

async function lookOf(page: Page, row: string, group: string): Promise<Look> {
  return page.evaluate(
    ({ row, group }) => {
      const r = document.querySelector(row) as HTMLElement;
      const g = r.closest(group) as HTMLElement;
      const second = g.querySelectorAll(':scope > .player-row')[1] as HTMLElement | undefined;
      const name = getComputedStyle(r.querySelector('.player-name')!);
      const pill = r.querySelector('.pos-pill')!.getBoundingClientRect();
      const logo = r.querySelector('.team-logo, .team-code')!.getBoundingClientRect();
      const chip = r.querySelector('.fixture-chip')!.getBoundingClientRect();
      const top = r.querySelector('.player-row-top')!.getBoundingClientRect();
      const rs = getComputedStyle(r);
      const gs = getComputedStyle(g);
      return {
        'name font-family': name.fontFamily,
        'name font-size': name.fontSize,
        'name font-weight': name.fontWeight,
        'name color': name.color,
        'pill size': `${Math.round(pill.width)}x${Math.round(pill.height)}`,
        'logo size': `${Math.round(logo.width)}x${Math.round(logo.height)}`,
        'chip height': `${Math.round(chip.height)}`,
        'first line height': `${Math.round(top.height)}`,
        'row padding-left': rs.paddingLeft,
        'row padding-right': rs.paddingRight,
        'divider color': second ? getComputedStyle(second).borderTopColor : 'none',
        'card radius': gs.borderRadius,
        'card background': gs.backgroundColor,
      };
    },
    { row, group },
  );
}

function sameLook(a: Look, b: Look, what: string) {
  /* A one-row card has no divider to read; the two-row cards above it carry the check. */
  const differ = Object.keys(a)
    .filter((k) => a[k] !== b[k] && !(k === 'divider color' && b[k] === 'none'))
    .map((k) => `${k}: Team ${a[k]} vs ${what} ${b[k]}`);
  expect(differ, `style differs between a Team lineup row and ${what}`).toEqual([]);
}

test.describe('style parity with the Team lineup', () => {
  test('a waiver row, on Waivers and on Team, matches a Team lineup row', async ({ page }, testInfo) => {
    await inSeason(page);
    await serve(page, { tiers: round2Fixture(), claimPlan: ROUND2_PLAN });
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-group')).toBeVisible();
    await expect(page.getByTestId('waiver-card').getByTestId('waiver-tier-row').first()).toBeVisible();
    /* A starter row with a fixture chip, so both rows carry one. */
    const starter = '[data-testid="starters-group"] > [data-starter="true"]:has(.fixture-chip):has(.team-logo)';
    await expect(page.locator(starter).first()).toBeVisible();
    const team = await lookOf(page, starter, '.slot-group');
    const teamWaiver = await lookOf(page, '[data-testid="waiver-card"] [data-testid="waiver-tier-row"]', '.slot-group');
    sameLook(team, teamWaiver, 'a Team "Waiver moves" row');
    expect(teamWaiver['divider color'], 'the Waiver moves card should hold two rows here').not.toBe('none');

    /* The side-by-side picture: the lineup and the waiver moves under it. */
    if (testInfo.project.name.endsWith('390')) {
      const lineup = (await page.getByTestId('starters-group').boundingBox())!;
      await page.getByTestId('waiver-card').scrollIntoViewIfNeeded();
      const shot = await page.screenshot({ fullPage: true, path: testInfo.outputPath('team-390.png') });
      await testInfo.attach('team-lineup-and-waiver-moves', { body: shot, contentType: 'image/png' });
      expect(lineup.height).toBeGreaterThan(0);
    }

    await page.getByTestId('tab-waivers').click();
    const waiver = '[data-testid="waivers-recommended"] [data-testid="waiver-tier-row"]';
    await expect(page.locator(waiver).first()).toBeVisible();
    const doThis = await lookOf(page, waiver, '.slot-group');
    expect(doThis['divider color'], 'the Do this card should hold two rows here').not.toBe('none');
    sameLook(team, doThis, 'a Waivers row');
    await openFolds(page);
    sameLook(team, await lookOf(page, '[data-testid="tier-watch"] [data-testid="waiver-tier-row"]', '.wfold'), 'a Watch list row');
    if (testInfo.project.name.endsWith('390')) {
      await testInfo.attach('waivers', { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath('waivers-390.png') }), contentType: 'image/png' });
    }
  });
});
