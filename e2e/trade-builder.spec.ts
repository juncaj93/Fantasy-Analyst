/**
 * Build a trade, on a phone, at every width the app supports (360, 375, 390,
 * 430 — the projects in `playwright.config.ts`).
 *
 * The endpoints are intercepted: what is measured here is shape and cost, never
 * the engine's judgement (that is `tests/trades.builder.test.ts`):
 *
 *  - **free until it is used.** Opening the fold reads the rosters once;
 *    marking players asks for nothing; `Find trades` is one request.
 *  - **marks live on the phone** and survive a reload; `Clear marks` empties
 *    them.
 *  - **Alex's layout rules.** A card is Give and Get lines (one player per
 *    line), three numbers, one why-line and a status chip; chips stay on one
 *    line; names are normal weight and stats are muted.
 *  - **nothing scrolls sideways** shut, open, with results, or with the sheet
 *    open, even for names longer than the phone has room for.
 *  - **nothing implies the app acts.** Copy pitch copies; it never sends.
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
      reserve: false,
      starter: i < 8,
    })),
  };
}

const NAMES_A = [
  'Patrick Mahomes',
  'Bijan Robinson',
  'Kenneth Walker',
  'Amon-Ra St. Brown',
  'Marvin Harrison Jr.',
  'Jaxon Smith-Njigba',
  'Trey McBride',
  'Christian Kirk',
  'Tony Pollard',
  'Kansas City',
];
const NAMES_B = ['Josh Allen', 'Breece Hall', 'Rhamondre Stevenson', 'Justin Jefferson', 'Jaylen Waddle', 'Garrett Wilson', 'Sam LaPorta', 'Jakobi Meyers', 'Zamir White', 'Buffalo'];

const TEAMS = {
  found: true,
  league: { id: 'demo-league', name: 'Tony’s Pizza Fantasy' },
  horizon: { currentWeek: 7, lastWeek: 17, weeks: 11, playoffWeeks: [15, 16, 17], deadlineWeek: 11, deadlinePassed: false, weeksToDeadline: 5 },
  teams: [roster(1, 'Alex', true, NAMES_A), roster(2, LONG_OWNER, false, NAMES_B), roster(3, 'Ron', false, NAMES_B.map((n) => `${n} II`))],
};

const player = (playerId: string, name: string, position: string, stat: string) => ({ playerId, name, position, team: 'NE', stat });

function pkg(id: string, status: 'likely' | 'maybe' | 'long_shot', extra: Record<string, unknown> = {}) {
  return {
    id,
    partner: { rosterId: 2, label: LONG_OWNER, activity: { thisSeason: 4, earlier: 2, line: 'Has made 4 trades this season, 2 before' } },
    give: [player('1-8', 'Tony Pollard', 'RB', 'RB · 11.0 a game')],
    get: [player('2-4', 'Jaylen Waddle', 'WR', 'WR · 14.0 a game')],
    drops: [],
    irMoves: [],
    alex: { thisWeek: 3, next3: 9.1, playoffs: 9, restOfSeason: 31.4, weighted: 47.9, adjustments: [{ label: 'You lean RB-heavy when value is close', points: -1.2 }] },
    them: { next3: 8.9, restOfSeason: 12.2, weighted: 23.4 },
    need: 'their RB2 is Out',
    why: 'Their RB2 is Out',
    status,
    statusReason: 'About even on value, and it fills a need they have.',
    balance: { give: 55, get: 44, label: 'about even' },
    confidence: 'medium',
    reasons: ['You would start Jaylen Waddle (WR) in 11 of 11 weeks, which lifts the lineup by about 31 pts.', 'For them: their RB2 is Out.'],
    caveats: ['Jaylen Waddle rests on Sleeper’s projection, with no complete Vegas week.'],
    pitch: `Hey Bartholomew, saw your RB2 is Out. I could send Tony Pollard for Jaylen Waddle. Open to it?`,
    ...extra,
  };
}

const BUILT = {
  league: TEAMS.league,
  status: 'ok',
  message: null,
  weeks: { thisWeek: 7, next3: [7, 8, 9], playoffs: [15, 16, 17], last: 17 },
  deadline: { week: 11, passed: false, weeksLeft: 5, line: 'Trades close after week 11.' },
  packages: [
    pkg('a', 'likely'),
    pkg('b', 'maybe', {
      give: [player('1-8', 'Tony Pollard', 'RB', 'RB · 11.0 a game'), player('1-7', 'Christian Kirk', 'WR', 'WR · 9.5 a game')],
      get: [player('2-1', 'Breece Hall', 'RB', 'RB · 15.2 a game · Questionable')],
      why: 'Thin at WR',
      need: 'thin at WR',
    }),
    pkg('c', 'likely', {
      get: [player('2-4', 'Jaylen Waddle', 'WR', 'WR · 14.0 a game'), player('2-7', 'Jakobi Meyers', 'WR', 'WR · 11.0 a game')],
      drops: [{ ...player('1-9', 'Kansas City Practice Squad Receiver', 'WR', 'WR · 4.0 a game'), reason: 'lowest season points on your bench (12.0), held 2 weeks' }],
      why: 'Jaylen Waddle would start 11 of 11 weeks for them',
      need: null,
    }),
  ],
  teams: [],
  audit: { generated: 20, evaluated: 10, shown: 3, hidden: { no_gain_for_them: 6 } },
  notes: [],
  willingness: 'Sleeper does not show offers that were turned down or ignored, so whether this manager would say yes is unknown.',
  advisory: 'Suggestions only. This app never sends, proposes or accepts a trade for you.',
};

const counts = { teams: 0, build: 0 };
let lastBuild = '';

async function openTrades(page: Page, teams: unknown = TEAMS, built: unknown = BUILT): Promise<void> {
  counts.teams = 0;
  counts.build = 0;
  await page.route(/\/trades\/check\/teams/, async (route) => {
    counts.teams++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(teams) });
  });
  await page.route(/\/trades\/build\?/, async (route) => {
    counts.build++;
    lastBuild = route.request().url();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(built) });
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

const mine = (page: Page) => page.getByTestId('trade-builder-mine').getByTestId('trade-builder-player');

async function findTrades(page: Page): Promise<void> {
  await mine(page).nth(8).click();
  await page.getByTestId('trade-builder-run').click();
  await expect(page.getByTestId('trade-builder-results')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
  });
}

/** How many lines of text an element's own text runs to. */
async function textLines(page: Page, testId: string, index = 0): Promise<number> {
  return page.getByTestId(testId).nth(index).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('fa-test-keep-marks')) {
      for (const key of Object.keys(localStorage)) if (key.startsWith('fa.tradeMarks.')) localStorage.removeItem(key);
    }
  });
});

test.describe('build a trade: cost', () => {
  test('costs nothing until opened, one roster read, and one request per Find trades', async ({ page }) => {
    await openTrades(page);
    expect(counts).toEqual({ teams: 0, build: 0 });
    await openFold(page);
    expect(counts.teams).toBe(1);

    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
    await expect(page.getByTestId('trade-builder-need-sell')).toBeVisible();
    await mine(page).nth(8).click();
    await page.getByTestId('trade-builder-team').selectOption('2');
    await page.getByTestId('trade-builder-theirs').getByTestId('trade-builder-player').nth(4).click();
    expect(counts.build, 'marking asked the server for something').toBe(0);

    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('builder-card').first()).toBeVisible();
    expect(counts.build).toBe(1);
    const url = new URL(lastBuild);
    expect(url.searchParams.get('sell')).toBe('1-8');
    expect(url.searchParams.get('team')).toBe('2');
    expect(url.searchParams.get('want')).toBe('2:2-4');
  });

  test('marks survive a reload and Clear marks empties them', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await mine(page).nth(8).click();
    await expect(mine(page).nth(8)).toHaveAttribute('aria-pressed', 'true');
    await expect(mine(page).nth(8).getByTestId('trade-builder-chip')).toHaveText('Sell');

    await page.evaluate(() => sessionStorage.setItem('fa-test-keep-marks', '1'));
    await page.reload();
    await page.getByTestId('tab-trades').click();
    await openFold(page);
    await expect(mine(page).nth(8)).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('trade-builder-clear').click();
    await expect(mine(page).nth(8)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
  });
});

test.describe('build a trade: layout', () => {
  test('a card is Give and Get lines, three numbers, a why-line and a status chip', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await findTrades(page);
    const cards = page.getByTestId('builder-card');
    await expect(cards).toHaveCount(3);

    const card = cards.nth(1);
    await expect(card.getByTestId('builder-status')).toHaveText('Maybe');
    await expect(card.getByTestId('builder-give').locator('.builder-player')).toHaveCount(2);
    await expect(card.getByTestId('builder-get').locator('.builder-player')).toHaveCount(1);
    await expect(card.getByTestId('builder-nums').locator('.builder-num')).toHaveCount(3);
    await expect(card.getByTestId('builder-nums')).toContainText('Week 7');
    await expect(card.getByTestId('builder-nums')).toContainText('Next 3 weeks');
    await expect(card.getByTestId('builder-nums')).toContainText('Playoffs');
    await expect(card.getByTestId('builder-why')).toContainText('Thin at WR');

    /* One player per line: the two Give players sit on different lines. */
    const players = card.getByTestId('builder-give').locator('.builder-player');
    const first = (await players.nth(0).boundingBox())!;
    const second = (await players.nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y + first.height - 2);

    /* Names normal weight, stats muted. */
    const name = card.locator('.builder-name').first();
    const stat = card.locator('.builder-stat').first();
    expect(Number(await name.evaluate((el) => getComputedStyle(el).fontWeight))).toBeLessThan(600);
    expect(await stat.evaluate((el) => getComputedStyle(el).color)).not.toBe(await name.evaluate((el) => getComputedStyle(el).color));

    /* A drop is its own line on the card that needs one. */
    await expect(cards.nth(2).getByTestId('builder-drop')).toContainText('Kansas City Practice Squad Receiver');
  });

  test('chips stay on one line', async ({ page }) => {
    await openTrades(page);
    await openFold(page);
    await mine(page).nth(8).click();
    expect(await textLines(page, 'trade-builder-chip')).toBe(1);
    await page.getByTestId('trade-builder-run').click();
    await expect(page.getByTestId('builder-card').first()).toBeVisible();
    for (let i = 0; i < 3; i++) expect(await textLines(page, 'builder-status', i)).toBe(1);
  });

  test('never scrolls sideways: shut, open, with results, and with the sheet open', async ({ page }) => {
    await openTrades(page);
    expect(await horizontalOverflow(page)).toBe(0);
    await openFold(page);
    expect(await horizontalOverflow(page)).toBe(0);
    await page.getByTestId('trade-builder-team').selectOption('2');
    expect(await horizontalOverflow(page)).toBe(0);
    await findTrades(page);
    expect(await horizontalOverflow(page)).toBe(0);
    for (const card of await page.getByTestId('builder-card').all()) {
      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
    await page.getByTestId('builder-card').nth(2).click();
    await expect(page.getByTestId('builder-detail-body')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('every control is a thumb of tap target, and the marked state is announced', async ({ page }) => {
    await openTrades(page);
    expect((await page.getByTestId('trade-builder-toggle').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await openFold(page);
    const row = mine(page).first();
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    expect((await page.getByTestId('trade-builder-run').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByTestId('trade-builder-clear').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByLabel('Trade with')).toBeVisible();
  });
});

test.describe('build a trade: the sheet', () => {
  test('carries the full case, and Copy pitch copies without sending anything', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __copied: string[] }).__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t: string) => void (window as unknown as { __copied: string[] }).__copied.push(t) },
      });
    });
    await openTrades(page);
    await openFold(page);
    await findTrades(page);
    await page.getByTestId('builder-card').nth(2).click();
    const sheet = page.getByTestId('builder-detail-body');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('builder-activity')).toHaveText('Has made 4 trades this season, 2 before');
    await expect(sheet.getByTestId('builder-detail-drops')).toContainText('lowest season points on your bench');
    await expect(sheet.getByTestId('builder-pitch')).toContainText('I could send Tony Pollard for Jaylen Waddle');

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await sheet.getByTestId('builder-copy').click();
    await expect(sheet.getByTestId('builder-copy')).toHaveText('Copied');
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    expect(copied).toEqual([BUILT.packages[2]!.pitch]);
    expect(requests.filter((u) => /\/api\//.test(u)), 'copying a pitch reached the server').toEqual([]);

    const words = (await sheet.textContent()) ?? '';
    expect(words).toMatch(/never sends, proposes or accepts/);
    expect(words).toMatch(/unknown/);
    expect(words).not.toMatch(/\d+%/);
  });
});

test.describe('build a trade: states', () => {
  test('after the deadline, Find trades is off and the screen says why', async ({ page }) => {
    const closed = { ...TEAMS, horizon: { ...TEAMS.horizon, currentWeek: 12, deadlinePassed: true, weeksToDeadline: 0 } };
    await openTrades(page, closed);
    await openFold(page);
    await expect(page.getByTestId('trade-builder-deadline')).toContainText('Trades are closed');
    await mine(page).nth(8).click();
    await expect(page.getByTestId('trade-builder-run')).toBeDisabled();
  });

  test('no package says so in one line', async ({ page }) => {
    await openTrades(page, TEAMS, { ...BUILT, packages: [], message: 'No package from your Sell marks helps both you and another team right now.' });
    await openFold(page);
    await findTrades(page);
    await expect(page.getByTestId('trade-builder-empty')).toHaveText(/helps both you and another team/);
    await expect(page.getByTestId('builder-card')).toHaveCount(0);
  });
});
