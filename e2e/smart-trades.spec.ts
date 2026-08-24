/**
 * Smart Bilateral Trades on a phone, at every width the app supports.
 *
 * The demo league the dev server seeds is four players against one, which
 * correctly produces no offers at all — the right answer for that fixture and
 * useless for measuring a row. So the endpoint is intercepted here with a
 * payload the engine could genuinely have produced, including the one case that
 * actually breaks layouts: names long enough to want more room than a 360-point
 * phone has.
 *
 * What is checked is shape and behaviour, never wording:
 *
 *  - nothing on Trades scrolls sideways at 430, 390, 375 or 360;
 *  - the ideas are rows, not cards, and enough of them fit above the taskbar to
 *    be worth the space they take;
 *  - the taskbar is untouched by their arrival;
 *  - the detail sheet opens, dismisses, and does not hand its drag to
 *    pull-to-refresh — the arbitration `sheet-vs-pull.spec.ts` exists for, which
 *    this screen must not regress by adding a second sheet to it;
 *  - the tap target is a thumb's worth of row.
 *
 * The composite score is asserted *absent*, because §15 forbids the UI exposing
 * an unexplained one and a number that leaks onto a card is the kind of thing
 * nobody notices until it ships.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * A board of three offers, in the payload shape the service returns.
 *
 * Long names on the first one on purpose: "Amon-Ra St. Brown" and
 * "Marvin Harrison Jr." are real, ordinary, and between them longer than the
 * 360-point column they have to wrap inside.
 */
const BOARD = {
  league: { id: 'demo-league', name: 'Demo Dynasty' },
  found: true,
  offers: [
    offer({
      id: '2:a+b>c',
      partner: 'Dermot',
      give: [
        ['a', 'Amon-Ra St. Brown', 'WR', 14.2],
        ['b', 'Marvin Harrison Jr.', 'WR', 11.8],
      ],
      get: [['c', 'Bijan Robinson', 'RB', 24.5]],
      userGain: 4.3,
      partnerGain: 1.6,
      fairness: 'edge_user',
      activity: 'active',
      sample: 9,
      seasons: 3,
    }),
    offer({
      id: '3:d>e',
      partner: 'Kim',
      give: [['d', 'Jaxon Smith-Njigba', 'WR', 12.1]],
      get: [['e', 'Kenneth Walker III', 'RB', 13.0]],
      userGain: 2.1,
      partnerGain: 0.9,
      fairness: 'even',
      activity: 'effectively_inactive',
      sample: 0,
      seasons: 4,
    }),
    offer({
      id: '4:f>g',
      partner: 'Sam',
      give: [['f', 'Rome Odunze', 'WR', 9.4]],
      get: [['g', 'Tony Pollard', 'RB', 10.2]],
      userGain: 1.4,
      partnerGain: 2.2,
      fairness: 'even',
      activity: 'unknown',
      sample: 0,
      seasons: 0,
    }),
  ],
  search: {
    partners: 3,
    generated: 41,
    scored: 24,
    viable: 5,
    surfaced: 3,
    bounds: { targetsPerPartner: 6, givePerPartner: 6, scoredPerPartner: 12, offersPerPartner: 2, offersTotal: 5, maxPackageSize: 2 },
  },
  capability: { tradeable: true, basis: null, reason: null },
  history: { measured: true, profiles: 2, seasonsComplete: ['2024', '2025'], complete: true, leagueRate: 1.2 },
  notes: [],
  warnings: [],
};

function offer(o: {
  id: string;
  partner: string;
  give: [string, string, string, number][];
  get: [string, string, string, number][];
  userGain: number;
  partnerGain: number;
  fairness: string;
  activity: string;
  sample: number;
  seasons: number;
}) {
  const player = ([playerId, name, position, value]: [string, string, string, number]) => ({
    playerId,
    name,
    position,
    value,
  });
  const outgoing = o.give.reduce((s, p) => s + p[3], 0);
  const incoming = o.get.reduce((s, p) => s + p[3], 0);
  return {
    id: o.id,
    partner: { key: o.id.split(':')[0], rosterId: Number(o.id.split(':')[0]), displayName: o.partner, userId: `u${o.partner}` },
    give: o.give.map(player),
    get: o.get.map(player),
    fairness: {
      band: o.fairness,
      label: o.fairness === 'even' ? 'Roughly even' : 'Slight value edge to you',
      incoming,
      outgoing,
      gap: 0.05,
    },
    user: {
      starterGain: o.userGain,
      depthChange: -1,
      entersLineup: o.get.map(player),
      displaced: [],
      opensSlot: false,
      rationales: ['fills_hole'],
    },
    counterparty: {
      starterGain: o.partnerGain,
      depthChange: 1,
      entersLineup: o.give.map(player),
      displaced: [],
      opensSlot: false,
      rationales: ['upgrades_starter'],
    },
    managerFit: {
      userId: `u${o.partner}`,
      displayName: o.partner,
      activity: o.activity,
      label: o.activity === 'active' ? 'Trades often' : o.activity === 'unknown' ? 'Limited history' : 'No trades on record',
      contribution: o.activity === 'active' ? 0.04 : o.activity === 'unknown' ? 0 : -0.04,
      terms: [],
      evidence: {
        sample: o.sample,
        seasonsObserved: o.seasons,
        historyComplete: o.activity !== 'unknown',
        ratePerSeason: o.sample > 0 ? 2.1 : null,
        leagueRate: 1.2,
        confidence: o.activity === 'unknown' ? 0 : 0.7,
      },
      notes: [],
      uncertain: o.activity === 'unknown',
    },
    score: 0.71,
    breakdown: { user: 0.33, fairness: 0.2, counterparty: 0.09, simplicity: 0.05, managerFit: 0.04, total: 0.71 },
    reasons: ['Fills your RB hole.', 'You can afford to move WR depth.', `Gives ${o.partner} a starting WR.`],
    caveats: o.activity === 'effectively_inactive' ? ['Strong roster fit, but this manager rarely trades.'] : [],
    headline: `+${o.userGain.toFixed(1)} to your lineup, +${o.partnerGain.toFixed(1)} to theirs`,
  };
}

async function openTrades(page: Page, board: unknown = BOARD) {
  await page.route('**/api/trades/smart*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) });
  });
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
}

/** How far the document can be scrolled sideways. Must always be zero. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
  });
}

test.describe('the trade ideas', () => {
  test.beforeEach(async ({ page }) => {
    await openTrades(page);
    await expect(page.getByTestId('smart-trades')).toBeVisible();
  });

  test('shows one row per idea, above the board', async ({ page }) => {
    await expect(page.getByTestId('smart-trade-row')).toHaveCount(3);

    /*
     * The watchlist survives, and it survives *underneath*.
     *
     * Asserted rather than checked conditionally, which is what this was and
     * which was worth nothing: a board that had vanished entirely would have
     * produced no `trade-row` to compare against and the test would have passed
     * on the strength of the thing it was meant to catch. The ideas are new
     * context above an existing screen, not a replacement for it.
     */
    const boardRows = page.getByTestId('trade-row');
    await expect(boardRows.first()).toBeVisible();
    expect(await boardRows.count()).toBeGreaterThan(0);

    const idea = (await page.getByTestId('smart-trade-row').first().boundingBox())!;
    const firstBoardRow = (await boardRows.first().boundingBox())!;
    expect(idea.y).toBeLessThan(firstBoardRow.y);
  });

  test('leaves the watchlist rows exactly as it found them', async ({ page }) => {
    /*
     * The brief's standing constraint, checked as an outcome: nothing about
     * which players the discovery board shows, in which section, in which order
     * may change because bilateral offers now sit above it.
     *
     * Read twice — once with the offers present, once with the endpoint refused
     * — and compared. The board is a separate request that this feature does not
     * touch, and this is what says so.
     */
    const withOffers = await page.getByTestId('trade-row').allInnerTexts();

    await page.route('**/api/trades/smart*', (route) => route.fulfill({ status: 500, body: 'off' }));
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await expect(page.getByTestId('trades-nav')).toBeVisible();
    await expect(page.getByTestId('smart-trades')).toHaveCount(0);

    const withoutOffers = await page.getByTestId('trade-row').allInnerTexts();
    expect(withoutOffers).toEqual(withOffers);
    expect(withoutOffers.length).toBeGreaterThan(0);
  });

  test('never scrolls sideways, however long the names are', async ({ page }) => {
    expect(await horizontalOverflow(page)).toBe(0);

    // And the long-named row is genuinely inside the viewport.
    const box = (await page.getByTestId('smart-trade-row').first().boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  });

  test('gives every idea a thumb-sized target', async ({ page }) => {
    const rows = page.getByTestId('smart-trade-row');
    for (let i = 0; i < (await rows.count()); i++) {
      const box = (await rows.nth(i).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('fits the ideas and some of the board on the first screen', async ({ page }) => {
    const floor = await page.evaluate(() => document.querySelector('.tabbar')!.getBoundingClientRect().top);
    const rows = page.getByTestId('smart-trade-row');
    let visible = 0;
    for (let i = 0; i < (await rows.count()); i++) {
      const box = await rows.nth(i).boundingBox();
      if (box && box.y + box.height <= floor) visible++;
    }
    expect(visible).toBe(3);
  });

  test('shows a manager cue only where the history says something', async ({ page }) => {
    /*
     * Two of the three fixtures have a measured manager and one is unknown. A
     * cue on the unknown one would be the app describing somebody it has not
     * measured — the failure §10 is written to prevent, in its UI form.
     */
    await expect(page.getByTestId('smart-trade-cue')).toHaveCount(2);
    await expect(page.getByTestId('smart-trade-cue').nth(1)).toHaveAttribute(
      'data-activity',
      'effectively_inactive',
    );
  });

  test('never prints the composite score', async ({ page }) => {
    const text = (await page.getByTestId('smart-trades').innerText()).toLowerCase();
    expect(text).not.toContain('0.71');
    expect(text).not.toContain('score');
  });

  test('leaves the taskbar exactly where it was', async ({ page }) => {
    const bar = (await page.locator('.tabbar').boundingBox())!;
    const height = page.viewportSize()!.height;
    expect(bar.y + bar.height).toBeLessThanOrEqual(height + 1);
    await expect(page.getByTestId('tab-trades')).toBeVisible();
    await expect(page.getByTestId('tab-team')).toBeVisible();
  });
});

test.describe('the detail sheet', () => {
  test.beforeEach(async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('smart-trade-row').first().click();
    await expect(page.getByTestId('smart-trade-detail')).toBeVisible();
  });

  test('says what each side gets, how fair it is, and who the manager is', async ({ page }) => {
    await expect(page.getByTestId('smart-trade-fairness')).toBeVisible();
    await expect(page.getByTestId('smart-trade-manager')).toBeVisible();
    await expect(page.getByTestId('smart-trade-reasons')).toBeVisible();
    await expect(page.getByTestId('smart-trade-evidence')).toBeVisible();
  });

  test('does not overflow at any supported width', async ({ page }) => {
    expect(await horizontalOverflow(page)).toBe(0);
    const body = (await page.getByTestId('smart-trade-detail-body').boundingBox())!;
    expect(body.x + body.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });

  test('closes on Done and leaves nothing behind', async ({ page }) => {
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('smart-trade-detail')).toHaveCount(0);
    await expect(page.getByTestId('smart-trades')).toBeVisible();
  });

  test('does not hand its drag to pull-to-refresh', async ({ page }) => {
    /*
     * The regression `sheet-vs-pull.spec.ts` was written for, re-checked for the
     * one sheet this lane adds. A downward drag that begins on an open sheet
     * must move the sheet and must not arm the pull behind it.
     */
    await page.evaluate(() => {
      const store = { armed: false };
      (window as unknown as { __pull: typeof store }).__pull = store;
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="trades-pull"]');
        const state = el?.getAttribute('data-pull-state');
        if (state && state !== 'idle') store.armed = true;
      });
      observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-pull-state'] });
    });

    const grip = (await page.getByTestId('sheet-grip').boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [10, 60, 140, 240]) await page.mouse.move(x, y + step);
    await page.mouse.up();

    expect(await page.evaluate(() => (window as unknown as { __pull: { armed: boolean } }).__pull.armed)).toBe(false);
  });
});

test.describe('when there is nothing to propose', () => {
  test('says so once, and leaves the board alone', async ({ page }) => {
    await openTrades(page, {
      ...BOARD,
      found: false,
      offers: [],
      notes: ['No bilateral trade in this league currently helps both sides enough to be worth proposing.'],
    });

    await expect(page.getByTestId('smart-trades')).toHaveCount(0);
    await expect(page.getByTestId('smart-trades-empty')).toBeVisible();
    // The discovery board is untouched by the bilateral half finding nothing.
    await expect(page.getByTestId('trades-nav')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('names the format, not the draft, in a league that cannot trade', async ({ page }) => {
    /*
     * A best-ball league has full rosters and no trading. The reader must be
     * told the permanent reason — telling them their draft has not happened
     * would send them back for a feature the format will never have.
     */
    await openTrades(page, {
      ...BOARD,
      found: false,
      offers: [],
      capability: {
        tradeable: false,
        basis: 'best_ball',
        reason: 'This is a best-ball league — there are no lineup decisions and no trading, so there is nothing to offer.',
      },
      notes: ['This is a best-ball league — there are no lineup decisions and no trading, so there is nothing to offer.'],
    });

    /*
     * The screen's contract here is that it prints the *board's* sentence
     * rather than composing one of its own — so the check is that the format
     * reason arrives and the draft reason does not. Which fact produced it is
     * asserted where the fact lives, on `capability.basis` in
     * `tests/trades.lifecycle.test.ts`; this is the reader's half.
     */
    const row = page.getByTestId('smart-trades-empty');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/best-ball/i);
    await expect(row).not.toContainText(/draft/i);
    await expect(page.getByTestId('smart-trades')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('says nothing at all when the request fails', async ({ page }) => {
    /*
     * §18's last empty state, in its UI form: behavioural intelligence is an
     * enhancement, not a dependency. A failed request leaves Trades exactly as
     * it was before this feature existed — not an error, not an empty message
     * about trades that did not load.
     */
    await page.route('**/api/trades/smart*', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await page.goto('/');
    await page.getByTestId('tab-trades').click();

    await expect(page.getByTestId('trades-nav')).toBeVisible();
    await expect(page.getByTestId('smart-trades')).toHaveCount(0);
    await expect(page.getByTestId('smart-trades-empty')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
