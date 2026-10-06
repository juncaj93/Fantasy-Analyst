/**
 * Check a trade, on a phone, at every width the app supports.
 *
 * The endpoints are intercepted: the dev server's demo league is a handful of
 * players and cannot show three weeks of lineup math, and what is being
 * measured here is shape and cost, never wording:
 *
 *  - **it is free until it is used.** Opening the fold reads the rosters once;
 *    the check itself is one request per deliberate tap, and a change of
 *    selection asks for nothing. Counted, not assumed.
 *  - **no row spreads across the width.** Past rounds regressed when a third
 *    number was added to a row. A result row is a label, one figure and a
 *    sentence; a player row is a pill, a name and a mark. The figure must start
 *    where the label column ends, and not at the far edge.
 *  - **nothing scrolls sideways at 430, 390, 375 or 360**, shut, open, with a
 *    result, and with the working open, even for names long enough to want more
 *    room than the phone has.
 *  - **every control is a thumb's worth** and the picked state is announced.
 *  - **nothing implies the app acts on a trade.**
 */

import { expect, test, type Page } from '@playwright/test';

const LONG_OWNER = 'Bartholomew the Third of Pittsburgh';

function roster(rosterId: number, label: string, isMine: boolean, names: string[]) {
  const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'WR', 'RB', 'DEF'];
  return {
    rosterId,
    label,
    isMine,
    players: names.map((name, i) => ({
      playerId: `${rosterId}-${i}`,
      name,
      position: positions[i % positions.length]!,
      team: ['KC', 'DAL', 'NE', 'SF'][i % 4]!,
      status: i === 2 ? 'Questionable' : null,
      reserve: i === 9,
      starter: i < 8,
    })),
  };
}

const NAMES_A = [
  'Patrick Mahomes',
  'Saquon Barkley',
  'Jonathan Taylor',
  'Amon-Ra St. Brown',
  'Marvin Harrison Jr.',
  'Jaxon Smith-Njigba',
  'Trey McBride',
  'Christian Kirk',
  'Tony Pollard',
  'Kansas City',
];
const NAMES_B = NAMES_A.map((n, i) => (i === 0 ? 'Josh Allen' : i === 3 ? 'Justin Jefferson' : i === 1 ? 'Bijan Robinson' : n));

const TEAMS = {
  found: true,
  league: { id: 'demo-league', name: 'Tony’s Pizza Fantasy' },
  horizon: { currentWeek: 5, lastWeek: 17, weeks: 13, playoffWeeks: [15, 16, 17], deadlineWeek: 11, deadlinePassed: false, weeksToDeadline: 7 },
  teams: [
    roster(1, 'Alex', true, NAMES_A),
    roster(2, LONG_OWNER, false, NAMES_B),
    roster(3, 'Ron', false, NAMES_A.map((n) => `${n} (R)`)),
  ],
};

function line(playerId: string, name: string, position: string) {
  return {
    playerId,
    name,
    position,
    team: 'KC',
    rate: 17.2,
    basis: 'market',
    rateNote: null,
    games: 12,
    designation: 'healthy',
    injuryNote: null,
    byeWeek: 9,
    byeInside: true,
    rosValue: 62,
    startsWeeks: 12,
  };
}

function side(rosterId: number, label: string, isMine: boolean, net: number) {
  return {
    label,
    rosterId,
    isMine,
    lineupChange: net - 2.1,
    depthChange: 1.1,
    adjustments: isMine ? [{ key: 'rb_lean', label: 'You lean RB-heavy when value is close', points: 1 }] : [],
    adjustmentTotal: isMine ? 1 : 0,
    net,
    incoming: [line('x', 'Amon-Ra St. Brown', 'WR'), line('y', 'Marvin Harrison Jr.', 'WR')],
    outgoing: [line('z', 'Jaxon Smith-Njigba', 'WR')],
    mustDrop: null,
    unvaluedStarters: [],
  };
}

const OK = {
  found: true,
  league: TEAMS.league,
  horizon: TEAMS.horizon,
  sides: {
    a: { rosterId: 1, label: 'Alex', isMine: true },
    b: { rosterId: 2, label: LONG_OWNER, isMine: false },
  },
  evaluation: {
    status: 'ok',
    insufficientReason: null,
    weeks: { first: 5, last: 17, count: 13 },
    a: side(1, 'Alex', true, 142.7),
    b: side(2, LONG_OWNER, false, -38.4),
    verdict: {
      kind: 'favors_a',
      gap: 181.1,
      band: 24.5,
      headline: `Favors you by about 181 pts over the rest of the season.`,
    },
    reasons: [
      'You would start Amon-Ra St. Brown (WR) in 12 of 13 weeks, which lifts the lineup by about 140 pts.',
      `${LONG_OWNER} lose Jaxon Smith-Njigba who starts 13 of 13 weeks, costing about 38 pts of lineup.`,
    ],
    caveats: ['Replacement level (a free agent): WR 8.4, RB 9.1 pts a game.', 'Trades close after week 11.'],
    confidence: 'medium',
    confidenceReasons: ['Marvin Harrison Jr. rests on Sleeper’s projection, with no complete Vegas week.'],
    replacement: [],
  },
  notes: ['This league does not trade draft picks this season.', 'Waiver money (FAAB) that moves in a trade is not valued.'],
  advisory: 'A read of the numbers only. This app does not make a trade for anyone, and the call is yours.',
};

const INSUFFICIENT = {
  ...OK,
  evaluation: {
    ...OK.evaluation,
    status: 'insufficient',
    insufficientReason:
      'No number can be put on Marvin Harrison Jr.: ruled out and no season line is stored for him. A verdict needs a real projection for every player moved.',
    a: null,
    b: null,
    verdict: null,
    reasons: [],
    caveats: [],
  },
};

const counts = { teams: 0, check: 0 };

async function openTrades(page: Page, check: unknown = OK): Promise<void> {
  counts.teams = 0;
  counts.check = 0;
  await page.route(/\/trades\/check\/teams/, async (route) => {
    counts.teams++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEAMS) });
  });
  await page.route(/\/trades\/check\?/, async (route) => {
    counts.check++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(check) });
  });
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await expect(page.getByTestId('trade-check')).toBeVisible();
}

async function openFold(page: Page): Promise<void> {
  const toggle = page.getByTestId('trade-check-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('trade-check-panel')).toBeVisible();
}

async function pickTwo(page: Page): Promise<void> {
  await page.getByTestId('trade-check-players-a').getByTestId('trade-check-player').nth(3).click();
  await page.getByTestId('trade-check-players-b').getByTestId('trade-check-player').nth(3).click();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
  });
}

test.describe('check a trade: cost', () => {
  test('costs nothing until it is opened, then one small read, then one request per tap', async ({ page }) => {
    await openTrades(page);
    expect(counts, 'a request went out before anybody opened the fold').toEqual({ teams: 0, check: 0 });

    await openFold(page);
    expect(counts.teams).toBe(1);
    expect(counts.check).toBe(0);

    // Choosing players asks for nothing.
    await pickTwo(page);
    expect(counts.check).toBe(0);

    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-result')).toBeVisible();
    expect(counts.check).toBe(1);

    // Shutting and reopening the fold does not read the rosters again.
    await page.getByTestId('trade-check-toggle').click();
    await page.getByTestId('trade-check-toggle').click();
    expect(counts.teams).toBe(1);
  });

  test('cannot be run with nobody chosen, and a changed pick clears the old answer', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await expect(page.getByTestId('trade-check-run')).toBeDisabled();

    await pickTwo(page);
    await expect(page.getByTestId('trade-check-run')).toBeEnabled();
    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-result')).toBeVisible();

    // An answer about a trade that is no longer the one on screen is worse than none.
    await page.getByTestId('trade-check-players-a').getByTestId('trade-check-player').nth(1).click();
    await expect(page.getByTestId('trade-check-result')).toHaveCount(0);
  });
});

test.describe('check a trade: layout', () => {
  test('a result row is a label, one figure and a sentence, and the figure does not run to the edge', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await pickTwo(page);
    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-result')).toBeVisible();

    const rows = page.getByTestId('trade-check-row');
    await expect(rows).toHaveCount(2);
    const viewport = page.viewportSize()!.width;

    let figureX: number | null = null;
    for (let i = 0; i < 2; i++) {
      const row = rows.nth(i);
      // Exactly one figure on the row.
      await expect(row.getByTestId('trade-check-figure')).toHaveCount(1);
      const dd = (await row.locator('dd').boundingBox())!;
      const fig = (await row.getByTestId('trade-check-figure').boundingBox())!;
      // The number starts where the reading column starts, not at the far edge.
      expect(Math.abs(fig.x - dd.x), `figure sits ${Math.round(fig.x - dd.x)}px into its column`).toBeLessThanOrEqual(2);
      expect(fig.x + fig.width).toBeLessThanOrEqual(viewport);
      // Both rows share one reading edge.
      figureX ??= fig.x;
      expect(Math.abs(fig.x - figureX)).toBeLessThanOrEqual(1);
    }
  });

  test('a player row is a pill, a name and a mark, and no more', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await pickTwo(page);
    const row = page.getByTestId('trade-check-players-a').getByTestId('trade-check-player').nth(3);
    const parts = await row.evaluate((el) => Array.from(el.children).map((c) => c.className));
    // state, body, mark: three children, the third only when the row is picked.
    expect(parts.length).toBeLessThanOrEqual(3);
    const name = (await row.locator('.list-row-body').boundingBox())!;
    const box = (await row.boundingBox())!;
    // The name column takes the room: the row does not spread into columns.
    expect(name.width).toBeGreaterThan(box.width * 0.55);
  });

  test('never scrolls sideways: shut, open, with a result, and with the working open', async ({ page }) => {
    await openTrades(page);
    expect(await horizontalOverflow(page)).toBe(0);
    await openFold(page);
    expect(await horizontalOverflow(page)).toBe(0);
    await pickTwo(page);
    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-result')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.getByTestId('trade-check-details-toggle').click();
    await expect(page.getByTestId('trade-check-details-body')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);

    const body = (await page.getByTestId('trade-check-result').boundingBox())!;
    expect(body.x).toBeGreaterThanOrEqual(0);
    expect(body.x + body.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });

  test('every control is a thumb of tap target, and the picked state is announced', async ({ page }) => {
    await openTrades(page);
    const toggle = (await page.getByTestId('trade-check-toggle').boundingBox())!;
    expect(toggle.height, `fold control is ${Math.round(toggle.height)}px`).toBeGreaterThanOrEqual(44);
    await openFold(page);
    const run = (await page.getByTestId('trade-check-run').boundingBox())!;
    expect(run.height).toBeGreaterThanOrEqual(44);
    const first = page.getByTestId('trade-check-players-a').getByTestId('trade-check-player').first();
    expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    // The select is a real, labelled control.
    await expect(page.getByLabel('First team gives')).toBeVisible();
  });

  test('a full side stops taking players rather than failing quietly', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    const rows = page.getByTestId('trade-check-players-a').getByTestId('trade-check-player');
    for (let i = 0; i < 4; i++) await rows.nth(i).click();
    await expect(rows.nth(4)).toHaveAttribute('data-state', 'full');
    await expect(page.getByTestId('trade-check-players-a').locator('[aria-pressed="true"]')).toHaveCount(4);
  });
});

test.describe('check a trade: what it says', () => {
  test('says plainly when there is not enough to put a number on a trade', async ({ page }) => {
    await openTrades(page, INSUFFICIENT);
    await openFold(page);
    await pickTwo(page);
    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-insufficient')).toBeVisible();
    await expect(page.getByTestId('trade-check-row')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('never implies the app proposed, made or answered a trade', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await pickTwo(page);
    await page.getByTestId('trade-check-run').click();
    await expect(page.getByTestId('trade-check-result')).toBeVisible();
    await page.getByTestId('trade-check-details-toggle').click();
    const text = await page.getByTestId('trade-check').innerText();
    expect(text).not.toMatch(/\b(propos\w*|offer\w*|accept\w*|declin\w*|submit\w*|send|sent|sends|added|adding|dropped|dropping|claimed|claiming)\b/i);
    await expect(page.getByTestId('trade-check-advisory')).toContainText('does not make a trade for anyone');
  });

  test('draws Alex’s habits as a labeled line, not as part of the lineup', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await pickTwo(page);
    await page.getByTestId('trade-check-run').click();
    await page.getByTestId('trade-check-details-toggle').click();
    await expect(page.getByTestId('trade-check-adjustment')).toHaveCount(1);
    await expect(page.getByTestId('trade-check-adjustment')).toContainText('RB-heavy');
  });

  test('a failed read leaves the rest of Trades as it was', async ({ page }) => {
    await page.route(/\/trades\/check\/teams/, (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await expect(page.getByTestId('trades-nav')).toBeVisible();
    await page.getByTestId('trade-check-toggle').click();
    await expect(page.getByTestId('trade-check-error')).toBeVisible();
    await expect(page.getByTestId('market-fold')).toBeVisible();
  });
});
