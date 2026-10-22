/**
 * Build a trade, on a phone, at every width the app supports (360, 375, 390,
 * 430 — the projects in `playwright.config.ts`).
 *
 * The endpoints are intercepted: what is measured is shape and cost, never the
 * engine's judgement (that is `tests/trades.builder.test.ts`).
 *
 *  - **One screen** (Alex, 15 October 2026): with a sixteen-player roster on
 *    each side, the Sell chips, the team picker, the Want chips and Find trades
 *    all sit above the tab bar on an 844 px tall screen, with no scrolling,
 *    and each roster wraps to no more than six rows of chips.
 *  - **Chips stay on one line**, nothing scrolls sideways and no text is
 *    clipped.
 *  - **All teams asks one team per request**, shows progress, and retries a
 *    team that failed on its own.
 *  - **Short cards and a short sheet**: one row of numbers and one phrase on a
 *    card; a table and at most two reasons on the sheet, the rest under More.
 *  - **Free until used, marks on the phone**, and nothing implies the app acts.
 */

import { expect, test, type Page } from '@playwright/test';

const LONG_OWNER = 'Bartholomew the Third of Pittsburgh';

const MINE = [
  ['Joe Burrow', 'QB', 'CIN', 'IR'],
  ['Jordan Love', 'QB', 'GB', null],
  ['Bijan Robinson', 'RB', 'ATL', null],
  ['Kenneth Walker', 'RB', 'SEA', null],
  ['Braelon Allen', 'RB', 'NYJ', null],
  ['Brian Robinson', 'RB', 'WAS', 'Questionable'],
  ['Dameon Pierce', 'RB', 'HOU', null],
  ['Emmett Johnson', 'RB', 'ATL', null],
  ['Nico Collins', 'WR', 'HOU', null],
  ['George Pickens', 'WR', 'DAL', null],
  ['Garrett Wilson', 'WR', 'NYJ', null],
  ['Ladd McConkey', 'WR', 'LAC', null],
  ['Emeka Egbuka', 'WR', 'TB', 'Doubtful'],
  ['Sam LaPorta', 'TE', 'DET', null],
  ['Kansas City Chiefs', 'DEF', 'KC', null],
  ['Minnesota Vikings', 'DEF', 'MIN', null],
] as const;

const THEIRS = [
  ['Bo Nix', 'QB', 'DEN', null],
  ['Josh Allen', 'QB', 'BUF', null],
  ['Woody Marks', 'RB', 'HOU', null],
  ['Rhamondre Stevenson', 'RB', 'NE', 'Out'],
  ['Saquon Barkley', 'RB', 'PHI', null],
  ['Chase Brown', 'RB', 'CIN', null],
  ['Jameson Williams', 'WR', 'DET', null],
  ['Romeo Doubs', 'WR', 'GB', null],
  ['Xavier Worthy', 'WR', 'KC', null],
  ['Parker Washington', 'WR', 'JAX', null],
  ['Marvin Harrison Jr.', 'WR', 'ARI', null],
  ['Amon-Ra St. Brown', 'WR', 'DET', null],
  ['Colston Loveland', 'TE', 'CHI', null],
  ['Dallas Goedert', 'TE', 'PHI', 'Questionable'],
  ['Pittsburgh Steelers', 'DEF', 'PIT', null],
  ['Green Bay Packers', 'DEF', 'GB', null],
] as const;

function roster(rosterId: number, label: string, isMine: boolean, list: readonly (readonly [string, string, string, string | null])[]) {
  return {
    rosterId,
    label,
    isMine,
    players: list.map(([name, position, team, status], i) => ({
      playerId: `${rosterId}-${i}`,
      name,
      position,
      team,
      status,
      reserve: status === 'IR',
      starter: i < 10,
    })),
  };
}

const OTHERS = [roster(2, LONG_OWNER, false, THEIRS), roster(3, 'NateyDee', false, THEIRS), roster(4, 'zackstephens54', false, THEIRS)];
const TEAMS = {
  found: true,
  league: { id: 'demo-league', name: 'Tony’s Pizza Fantasy' },
  horizon: { currentWeek: 6, lastWeek: 17, weeks: 12, playoffWeeks: [15, 16, 17], deadlineWeek: 11, deadlinePassed: false, weeksToDeadline: 6 },
  teams: [roster(1, 'Alex', true, MINE), ...OTHERS],
};

const player = (playerId: string, name: string, position: string, stat: string) => ({ playerId, name, position, team: 'NE', stat });

function pkg(id: string, rosterId: number, label: string, weighted: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    partner: { rosterId, label, activity: { thisSeason: 4, earlier: 2, line: 'Has made 4 trades this season, 2 before' } },
    give: [player('1-7', 'Emmett Johnson', 'RB', 'RB · 4.2 a game')],
    get: [player(`${rosterId}-7`, 'Romeo Doubs', 'WR', 'WR · 8.7 a game')],
    drops: [],
    irMoves: [],
    alex: { thisWeek: 1.2, next3: 3.1, playoffs: 2.4, restOfSeason: 12.6, weighted, adjustments: [{ label: 'You lean RB-heavy when value is close', points: -1.2 }] },
    them: { next3: 2.6, restOfSeason: 14.7, weighted: 10 },
    need: 'their RB2 is on bye in week 8',
    needShort: 'RB2 bye wk 8',
    why: 'Their RB2 is on bye in week 8',
    status: 'likely',
    statusReason: 'About even on value, and it fills a need they have.',
    statusShort: 'Even value · fills their need',
    whyShort: ['Doubs starts 11 of 12 wks for you', 'Johnson starts 9 of 12 wks for them'],
    balance: { give: 55, get: 44, label: 'about even' },
    confidence: 'medium',
    reasons: ['You would start Romeo Doubs (WR) in 11 of 12 weeks, which lifts the lineup by about 11 pts.', 'For them: their RB2 is on bye in week 8.', 'A third reason that must not reach the sheet.'],
    caveats: ['Romeo Doubs rests on Sleeper’s projection, with no complete Vegas week.'],
    pitch: `Hey ${label.split(' ')[0]}, saw your RB2 is on bye in week 8. I could send Emmett Johnson for Romeo Doubs. Open to it?`,
    costsNow: false,
    basis: 'vegas',
    ...extra,
  };
}

function answer(packages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    league: TEAMS.league,
    status: 'ok',
    message: packages.length ? null : 'No package from these marks helps both you and this team right now.',
    weeks: { thisWeek: 6, next3: [6, 7, 8], playoffs: [15, 16, 17], last: 17 },
    deadline: { week: 11, passed: false, weeksLeft: 6, line: 'Trades close after week 11.' },
    packages,
    teams: [],
    audit: { generated: 20, evaluated: 10, shown: packages.length, hidden: {} },
    notes: [],
    willingness: 'Sleeper does not show offers that were turned down or ignored, so whether this manager would say yes is unknown.',
    advisory: 'Suggestions only. This app never sends, proposes or accepts a trade for you.',
    ...extra,
  };
}

/** Per team: what the build endpoint answers. Team 3 has a package that costs Alex now; team 4 fails once. */
const PER_TEAM: Record<string, unknown> = {
  '2': answer([
    pkg('a', 2, LONG_OWNER, 20),
    pkg('b', 2, LONG_OWNER, 18, {
      give: [player('1-7', 'Emmett Johnson', 'RB', 'RB · 4.2 a game'), player('1-1', 'Jordan Love', 'QB', 'QB · 19.9 a game')],
      status: 'maybe',
      followUp: [{ position: 'QB', weeks: [6], assumes: { rate: 14.2, names: ['Joe Flacco', 'Mac Jones', 'Jameis Winston'] } }],
    }),
  ]),
  '3': answer([pkg('c', 3, 'NateyDee', 30, { costsNow: true, alex: { thisWeek: -1.6, next3: -0.3, playoffs: 1.5, restOfSeason: 6.7, weighted: 30, adjustments: [] }, basis: 'sleeper' })]),
  '4': answer([pkg('d', 4, 'zackstephens54', 12, { drops: [{ ...player('1-15', 'Minnesota Vikings', 'DEF', 'DEF · 5.0 a game'), reason: 'the least you would miss' }] })]),
};

const counts = { teams: 0, build: 0 };
let requested: string[] = [];
let failTeam4 = false;

async function openTrades(page: Page): Promise<void> {
  counts.teams = 0;
  counts.build = 0;
  requested = [];
  await page.route(/\/trades\/check\/teams/, async (route) => {
    counts.teams++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEAMS) });
  });
  await page.route(/\/trades\/build\?/, async (route) => {
    counts.build++;
    const url = new URL(route.request().url());
    requested.push(url.search);
    const team = url.searchParams.get('team') ?? 'all';
    if (team === '4' && failTeam4) {
      failTeam4 = false;
      await route.fulfill({ status: 500, body: 'boom' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PER_TEAM[team] ?? answer([])) });
  });
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await expect(page.getByTestId('trade-builder')).toBeVisible();
}

async function openFold(page: Page): Promise<void> {
  const toggle = page.getByTestId('trade-builder-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('trade-builder-panel')).toBeVisible();
}

const mine = (page: Page) => page.getByTestId('trade-builder-mine').getByTestId('pick-chip');
const theirs = (page: Page) => page.getByTestId('trade-builder-theirs').getByTestId('pick-chip');

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
  });
}

/** Distinct rows of chips in a picker. */
async function chipRows(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => new Set(Array.from(el.children).map((c) => Math.round(c.getBoundingClientRect().top))).size);
}

/** Every chip's text fits on one line inside the chip, nothing cut off. */
async function chipsWhole(page: Page, testId: string): Promise<{ lines: number; clipped: string[] }> {
  return page.getByTestId(testId).evaluate((el) => {
    let lines = 1;
    const clipped: string[] = [];
    for (const chip of Array.from(el.children) as HTMLElement[]) {
      const tops = new Set(Array.from(chip.children).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
      lines = Math.max(lines, tops.size);
      for (const part of Array.from(chip.children) as HTMLElement[]) if (part.scrollWidth > part.clientWidth + 1) clipped.push(part.textContent ?? '');
    }
    return { lines, clipped };
  });
}

test.beforeEach(async ({ page }) => {
  failTeam4 = false;
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('fa-test-keep-marks')) {
      for (const key of Object.keys(localStorage)) if (key.startsWith('fa.tradeMarks.')) localStorage.removeItem(key);
    }
  });
});

test.describe('build a trade: one screen', () => {
  test('a 16-player roster on each side and Find trades fit 844 px with no scrolling', async ({ page }) => {
    const width = page.viewportSize()!.width;
    await page.setViewportSize({ width, height: 844 });
    await openTrades(page);
    await openFold(page);
    await page.getByTestId('trade-builder-team').selectOption('2');
    await expect(theirs(page)).toHaveCount(16);
    /* Let the fold's scroll to the top settle. */
    await page.waitForTimeout(500);

    const tabbar = (await page.locator('.tabbar').boundingBox())!;
    const bottomLimit = tabbar.y;
    const firstSell = (await mine(page).first().boundingBox())!;
    const lastWant = (await theirs(page).last().boundingBox())!;
    const team = (await page.getByTestId('trade-builder-team').boundingBox())!;
    const run = (await page.getByTestId('trade-builder-run').boundingBox())!;

    expect(firstSell.y, 'the first Sell chip is on screen').toBeGreaterThanOrEqual(0);
    expect(team.y + team.height).toBeLessThanOrEqual(bottomLimit);
    /* Above Find trades, not just above the tab bar: nothing sits under the sticky bar. */
    expect(lastWant.y + lastWant.height, `last Want chip ends at ${Math.round(lastWant.y + lastWant.height)}, Find trades at ${Math.round(run.y)}`).toBeLessThanOrEqual(run.y);
    expect(run.y + run.height, 'Find trades sits above the tab bar').toBeLessThanOrEqual(bottomLimit);
    expect(run.y).toBeGreaterThan(0);

    expect(await chipRows(page, 'trade-builder-mine'), 'your roster rows').toBeLessThanOrEqual(6);
    expect(await chipRows(page, 'trade-builder-theirs'), 'their roster rows').toBeLessThanOrEqual(6);
  });

  test('chips are one line, with nothing clipped and no sideways scroll', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await page.getByTestId('trade-builder-team').selectOption('2');
    for (const id of ['trade-builder-mine', 'trade-builder-theirs']) {
      const { lines, clipped } = await chipsWhole(page, id);
      expect(lines, `${id} chip text runs to ${lines} lines`).toBe(1);
      expect(clipped, `${id} clipped`).toEqual([]);
    }
    await mine(page).nth(5).click();
    await expect(mine(page).nth(5).getByTestId('pick-chip-tag')).toHaveText('Sell');
    await theirs(page).nth(7).click();
    await expect(theirs(page).nth(7).getByTestId('pick-chip-tag')).toHaveText('Want');
    expect((await chipsWhole(page, 'trade-builder-mine')).lines).toBe(1);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('a chip is POS, short name and club, with an injury letter', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    const johnson = mine(page).filter({ hasText: 'E. Johnson' });
    await expect(johnson.locator('.pick-chip-pos')).toHaveText('RB');
    await expect(johnson.locator('.pick-chip-team')).toHaveText('ATL');
    await expect(mine(page).filter({ hasText: 'B. Robinson' }).getByTestId('pick-chip-hurt')).toHaveText('Q');
    await expect(mine(page).filter({ hasText: 'J. Burrow' }).getByTestId('pick-chip-hurt')).toHaveText('IR');
    await expect(mine(page).filter({ hasText: 'E. Egbuka' }).getByTestId('pick-chip-hurt')).toHaveText('D');
    /* Grouped by position: quarterbacks first. */
    await expect(mine(page).first().locator('.pick-chip-pos')).toHaveText('QB');
  });
});

test.describe('build a trade: cost', () => {
  test('free until opened, marking asks for nothing, one team is one request', async ({ page }) => {
    await openTrades(page);
    expect(counts).toEqual({ teams: 0, build: 0 });
    await openFold(page);
    expect(counts.teams).toBe(1);
    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
    await mine(page).filter({ hasText: 'E. Johnson' }).click();
    await page.getByTestId('trade-builder-team').selectOption('2');
    await theirs(page).filter({ hasText: 'R. Doubs' }).click();
    expect(counts.build).toBe(0);
    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('builder-card').first()).toBeVisible();
    expect(counts.build).toBe(1);
    const q = new URLSearchParams(requested[0]);
    expect(q.get('team')).toBe('2');
    expect(q.get('sell')).toBe('1-7');
    expect(q.get('want')).toBe('2:2-7');
    expect(q.get('sweep')).toBeNull();
  });

  test('All teams asks one team per request, shows progress, and merges the best five', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await mine(page).filter({ hasText: 'E. Johnson' }).click();
    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('trade-builder-progress')).toHaveText('3 of 3 teams');
    expect(counts.build).toBe(3);
    expect(requested.map((r) => new URLSearchParams(r).get('team'))).toEqual(['2', '3', '4']);
    for (const r of requested) expect(new URLSearchParams(r).get('sweep')).toBe('1');
    /* Help-now packages ahead of the one that costs Alex now: 20, 18, 12, then the 30 that costs now ((30-5)/1.5 = 16.7 goes between). */
    const order = await page.getByTestId('builder-card').evaluateAll((cards) => cards.map((c) => c.querySelector('.builder-partner')?.textContent));
    expect(order).toEqual([LONG_OWNER, LONG_OWNER, 'NateyDee', 'zackstephens54']);
  });

  test('a team that fails says so in one line and can be retried on its own', async ({ page }) => {
    failTeam4 = true;
    await openTrades(page);
    await openFold(page);
    await mine(page).filter({ hasText: 'E. Johnson' }).click();
    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('trade-builder-progress')).toContainText('1 didn’t load');
    await expect(page.getByTestId('builder-card')).toHaveCount(3);
    await page.getByTestId('trade-builder-retry').click();
    await expect(page.getByTestId('builder-card')).toHaveCount(4);
    expect(requested.filter((r) => new URLSearchParams(r).get('team') === '4')).toHaveLength(2);
    expect(requested.filter((r) => new URLSearchParams(r).get('team') === '2')).toHaveLength(1);
  });

  test('marks survive a reload and Clear empties them', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await mine(page).nth(4).click();
    await expect(mine(page).nth(4)).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => sessionStorage.setItem('fa-test-keep-marks', '1'));
    await page.reload();
    await page.getByTestId('tab-trades').click();
    await openFold(page);
    await expect(mine(page).nth(4)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('trade-builder-clear').click();
    await expect(mine(page).nth(4)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
  });
});

test.describe('build a trade: card and sheet', () => {
  async function findAll(page: Page) {
    await openTrades(page);
    await openFold(page);
    await mine(page).filter({ hasText: 'E. Johnson' }).click();
    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('trade-builder-progress')).toHaveText('3 of 3 teams');
  }

  test('a card is chips and team, one Give line, one Get line, one row of four numbers, one phrase', async ({ page }) => {
    await findAll(page);
    const card = page.getByTestId('builder-card').nth(1);
    await expect(card.getByTestId('builder-status')).toHaveText('Maybe');
    await expect(card.getByTestId('builder-give')).toContainText('E. Johnson RB 4.2 + J. Love QB 19.9');
    await expect(card.getByTestId('builder-get')).toContainText('R. Doubs WR 8.7');
    await expect(card.locator('.builder-num')).toHaveCount(4);
    await expect(card.getByTestId('builder-nums')).toContainText('Wk 6');
    await expect(card.getByTestId('builder-nums')).toContainText('Next 3');
    await expect(card.getByTestId('builder-nums')).toContainText('Playoffs');
    await expect(card.getByTestId('builder-nums')).toContainText('Them');
    await expect(card.getByTestId('builder-why')).toHaveText('RB2 bye wk 8');
    /* No sentences on a card: nothing ending in a full stop. */
    expect(await card.textContent()).not.toMatch(/[a-z]\.\s|[a-z]\.$/);
    for (const id of ['builder-give', 'builder-get']) {
      const lines = await card.getByTestId(id).locator('.builder-one').evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size;
      });
      expect(lines, `${id} is one line`).toBe(1);
    }
    /* Trading Love with Burrow out leaves no QB in week 6: the card says so, and still fits. */
    await expect(card.getByTestId('builder-add')).toHaveText('Then add a QB');
    const head = (await card.locator('.builder-card-head').boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(head.x + head.width).toBeLessThanOrEqual(box.x + box.width);
    /* The one that costs Alex now carries the chip. */
    await expect(page.getByTestId('builder-card').filter({ hasText: 'NateyDee' }).getByTestId('builder-costs-now')).toHaveText('Costs you now');
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('the sheet: status with one reason, a table, at most two reasons, the rest under More', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __copied: string[] }).__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t: string) => void (window as unknown as { __copied: string[] }).__copied.push(t) },
      });
    });
    await findAll(page);
    await page.getByTestId('builder-card').filter({ hasText: 'NateyDee' }).click();
    const sheet = page.getByTestId('builder-detail-body');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('builder-table').locator('tbody tr')).toHaveCount(3);
    await expect(sheet.getByTestId('builder-reasons').locator('li')).toHaveCount(2);
    await expect(sheet.getByTestId('builder-basis')).toHaveText('Built mostly on Sleeper’s projection, not Vegas');
    await expect(sheet.getByTestId('builder-more-body')).toHaveCount(0);
    await expect(sheet).not.toContainText('Your habits');
    await expect(sheet).not.toContainText('A third reason');

    /* The sheet's first view fits the screen, once it has finished rising. */
    await page.waitForTimeout(600);
    const actions = (await sheet.getByTestId('builder-copy').boundingBox())!;
    expect(actions.y + actions.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await sheet.getByTestId('builder-copy').click();
    await expect(sheet.getByTestId('builder-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([(PER_TEAM['3'] as { packages: { pitch: string }[] }).packages[0]!.pitch]);
    expect(requests.filter((u) => /\/api\//.test(u))).toEqual([]);

    await sheet.getByTestId('builder-more').click();
    await expect(sheet.getByTestId('builder-more-body')).toBeVisible();
    await expect(sheet.getByTestId('builder-activity')).toHaveText('Has made 4 trades this season, 2 before');
    await expect(sheet.getByTestId('builder-advisory')).not.toContainText('never sends');
    expect(await sheet.textContent()).not.toMatch(/\d+%/);
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

test.describe('build a trade: a follow-up add', () => {
  test('the sheet names the free agents the numbers assume', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await page.getByTestId('trade-builder-team').selectOption('2');
    await mine(page).filter({ hasText: 'E. Johnson' }).click();
    await page.getByTestId('trade-builder-run').click();
    await page.getByTestId('builder-card').filter({ hasText: 'J. Love' }).click();
    const line = page.getByTestId('builder-detail-body').getByTestId('builder-detail-add');
    await expect(line).toContainText('No QB on your roster in week 6.');
    await expect(line).toContainText('Numbers assume a free agent at 14.2 pts: Joe Flacco, Mac Jones, Jameis Winston (their average)');
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

/**
 * Inner padding (Alex, 15 October 2026): the label, chips, info line, team
 * dropdown, pill and buttons start where the card's title starts, 12 px in,
 * as on the Team cards, and nothing touches the card's edge.
 */
test.describe('build a trade and check a trade: inner padding', () => {
  /** Everything visible in a fold's body that sits closer than 12 px to either edge. */
  async function touching(page: Page, foldId: string): Promise<string[]> {
    return page.getByTestId(foldId).evaluate((fold, id) => {
      const f = fold.getBoundingClientRect();
      const body = fold.querySelector(`[data-testid='${id}-body']`)!;
      const out: string[] = [];
      for (const el of Array.from(body.querySelectorAll('*')) as HTMLElement[]) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (el.closest('.sheet, [role="dialog"], .sr-only')) continue;
        if (b.left < f.left + 11.5 || b.right > f.right - 11.5) out.push(`${el.dataset.testid ?? el.className ?? el.tagName} ${Math.round(b.left - f.left)}/${Math.round(f.right - b.right)}`);
      }
      return out;
    }, foldId);
  }

  test('Build a trade: every control is inset like the title, and the pill fits whole beside the dropdown', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await page.getByTestId('trade-builder-team').selectOption('2');
    await page.getByTestId('trade-builder-unmarked').click();
    await expect(page.getByTestId('trade-builder-unmarked')).toHaveText('+ unmarked on');
    expect(await touching(page, 'trade-builder')).toEqual([]);

    const title = (await page.getByTestId('trade-builder-toggle').locator('.fold-label').boundingBox())!;
    const label = (await page.locator('#tb-sell-label').boundingBox())!;
    const chip = (await mine(page).first().boundingBox())!;
    expect(Math.abs(label.x - title.x), 'the Sell label lines up with the title').toBeLessThanOrEqual(1);
    expect(Math.abs(chip.x - title.x), 'the first chip lines up with the title').toBeLessThanOrEqual(1);

    const fold = (await page.getByTestId('trade-builder').boundingBox())!;
    const select = (await page.getByTestId('trade-builder-team').boundingBox())!;
    const pill = page.getByTestId('trade-builder-unmarked');
    const pillBox = (await pill.boundingBox())!;
    expect(Math.abs(pillBox.y + pillBox.height / 2 - (select.y + select.height / 2)), 'the pill sits on the dropdown row').toBeLessThanOrEqual(2);
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(fold.x + fold.width - 11.5);
    expect(select.width, 'the dropdown keeps a usable width').toBeGreaterThanOrEqual(112);
    expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the pill label is whole').toBe(true);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('Build a trade carries a Beta tag beside its title', async ({ page }) => {
    await openTrades(page);
    const tag = page.getByTestId('trade-builder-tag');
    await expect(tag).toHaveText('Beta');
    const title = (await page.getByTestId('trade-builder-toggle').locator('.fold-label').boundingBox())!;
    const box = (await tag.boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThanOrEqual(3);
    expect(box.x).toBeGreaterThan(title.x + title.width);
  });

  test('Check a trade: both sides and the button are inset like the title', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-check-toggle').click();
    await expect(page.getByTestId('trade-check-panel')).toBeVisible();
    await expect(page.getByTestId('trade-check-players-b').getByTestId('pick-chip').first()).toBeVisible();
    expect(await touching(page, 'trade-check')).toEqual([]);
    const title = (await page.getByTestId('trade-check-toggle').locator('.fold-label').boundingBox())!;
    for (const id of ['trade-check-team-a', 'trade-check-team-b', 'trade-check-run']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(Math.abs(b.x - title.x), `${id} lines up with the title`).toBeLessThanOrEqual(1);
    }
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

test.describe('build a trade: states', () => {
  test('after the deadline, Find trades is off and one line says why', async ({ page }) => {
    await page.route(/\/trades\/check\/teams/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...TEAMS, horizon: { ...TEAMS.horizon, currentWeek: 12, deadlinePassed: true, weeksToDeadline: 0 } }) }),
    );
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await openFold(page);
    await expect(page.getByTestId('trade-builder-deadline')).toContainText('Trades closed after week 11');
    await mine(page).nth(4).click();
    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
  });

  test('banners are one line, with the detail on tap', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    const line = page.getByTestId('trade-builder-deadline');
    const h = (await line.boundingBox())!.height;
    expect(h).toBeLessThanOrEqual(36);
    await page.getByTestId('trade-builder-deadline-info').click();
    await expect(page.getByTestId('trade-builder-deadline-detail')).toBeVisible();
  });
});
