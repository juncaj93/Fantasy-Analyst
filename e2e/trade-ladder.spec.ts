/**
 * The negotiation card on a phone, at every width the app supports.
 *
 * `GET /api/leagues/:id/trades/ladder?playerId=` has been complete, tested and
 * reachable for a while with nothing drawing it. This is the reader's half of
 * drawing it, and what it checks is shape, cost and silence — never wording:
 *
 *  - **it costs nothing until it is asked for.** The endpoint runs the lineup
 *    optimiser four times, so the request must not go out while a card is
 *    merely being skimmed. Counted, rather than assumed.
 *  - **it is drawn only where a ladder exists.** A player you already hold has
 *    no partner and a free agent is an add; neither gets a control whose answer
 *    is known in advance.
 *  - **it says nothing about a manager nobody has measured.** The case the
 *    owner's own league is in the night his draft ends, and the one a screen is
 *    likeliest to break by printing "rarely trades" over an empty sample. The
 *    absence line is a fact about the evidence; the tendency line must be gone
 *    entirely, and the assertion is on the vocabulary rather than on a string.
 *  - **nothing scrolls sideways at 430, 390, 375 or 360**, open or shut, and
 *    the fold is a full thumb of tap target with no nested control.
 *
 * The endpoint is intercepted because the dev server's demo league is five
 * players against five, which correctly produces a *blocked* ladder — the right
 * answer for that fixture and useless for measuring three rungs. The board
 * underneath is the deployment's own: it already ships one player of each
 * ownership, which is exactly what the "drawn only where a ladder exists" claim
 * needs and is not something a fixture should be inventing.
 */

import { expect, test, type Page } from '@playwright/test';
import { exploreMarket } from './helpers.ts';

/** The seeded board's three rows, one of each ownership. */
const HELD_BY_RIVAL = 'Devin Okafor';
const MINE = 'Marcus Vance';
const FREE_AGENT = 'Kai Brennan';

/**
 * A priced ladder, in the shape `buildLadder` produces one.
 *
 * `sample` decides the only thing that varies between the fixtures below: how
 * much completed trade history the partner has. Four is the profile's own
 * threshold, so three is the interesting side of it.
 */
function ladder(opts: { sample: number; confident: boolean }) {
  return {
    found: true,
    league: { id: 'demo-league', name: 'Demo Dynasty' },
    partner: {
      rosterId: 2,
      ownerName: 'Rival',
      profile: {
        profile: {
          rosterId: 2,
          ownerName: 'Rival',
          sample: opts.sample,
          minSample: 4,
          confident: opts.confident,
          initiationRate: opts.confident ? 0.7 : null,
          tradesPerSeason: opts.confident ? 2.4 : null,
          prefersConsolidation: opts.confident,
          tradesPicks: opts.confident,
          tradesFaab: false,
          acquiresPositions: opts.confident ? ['RB'] : [],
          sendsPositions: opts.confident ? ['WR'] : [],
          negotiation: 'unknown',
          notes: opts.confident
            ? ['Usually starts the conversation.', 'Has a history of sending two players for one.', 'Based on 6 trade(s) across 2 season(s).']
            : [`Only ${opts.sample} completed trade(s) on record — not enough to describe a tendency.`],
          seasonsObserved: ['2025', '2026'],
        },
        sample: opts.sample,
        confident: opts.confident,
        computedAt: '2026-08-01T00:00:00.000Z',
        stale: false,
      },
    },
    target: { playerId: '1002', name: HELD_BY_RIVAL, position: 'WR', value: 18.4 },
    ladder: {
      targetPlayerId: '1002',
      targetName: HELD_BY_RIVAL,
      opening: 9.68,
      fair: { low: 11, high: 17 },
      doNotExceed: 20,
      rungs: [],
      reasons: ['Worth more to you than to the field, because of where your roster is thin.'],
      blocked: null,
      advisory: 'never auto-sent',
    },
    consolidation: null,
  };
}

/** The ladder the engine returns when there is no deal to price. */
const BLOCKED = {
  ...ladder({ sample: 0, confident: false }),
  ladder: {
    ...ladder({ sample: 0, confident: false }).ladder,
    opening: 0,
    fair: { low: 0, high: 0 },
    doNotExceed: 0,
    reasons: [],
    blocked: 'He is worth more to his current roster than to yours. Any price that works for them loses for you.',
  },
};

/** How many times the app has asked for a ladder. */
let asked = 0;

async function openTrades(page: Page, body: unknown = ladder({ sample: 0, confident: false })): Promise<void> {
  asked = 0;
  await page.route('**/trades/ladder*', async (route) => {
    asked++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await exploreMarket(page);
}

/** Open one board row's card. The ladder lives inside the trade case on it. */
async function openCard(page: Page, name: string): Promise<void> {
  await page.getByTestId('trade-row').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('trade-case')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
  });
}

test.describe('the price band', () => {
  test('is closed, and costs nothing until it is opened', async ({ page }) => {
    await openTrades(page);
    await openCard(page, HELD_BY_RIVAL);

    const toggle = page.getByTestId('trade-ladder-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    /*
     * Not merely hidden. The endpoint prices four lineups, so a card that
     * fetched it on open would spend that on every reader who tapped a name.
     */
    await expect(page.getByTestId('trade-ladder-body')).toHaveCount(0);
    expect(asked, 'the ladder was requested before anybody asked for it').toBe(0);
  });

  test('asks once, and draws the three rungs', async ({ page }) => {
    await openTrades(page, ladder({ sample: 6, confident: true }));
    await openCard(page, HELD_BY_RIVAL);

    await page.getByTestId('trade-ladder-toggle').click();
    await expect(page.getByTestId('trade-ladder-detail')).toBeVisible();
    expect(asked).toBe(1);

    const rungs = page.getByTestId('trade-ladder-rungs').locator('.weekly-line');
    await expect(rungs).toHaveCount(3);
    /* The unit is named, because §15 forbids an unexplained figure on a card. */
    await expect(page.getByTestId('trade-ladder-unit')).toContainText(/points/i);

    // Shut and reopened, it does not ask again.
    await page.getByTestId('trade-ladder-toggle').click();
    await expect(page.getByTestId('trade-ladder-body')).toHaveCount(0);
    await page.getByTestId('trade-ladder-toggle').click();
    await expect(page.getByTestId('trade-ladder-detail')).toBeVisible();
    expect(asked).toBe(1);
  });

  test('draws the sentence and no rungs when there is no deal to price', async ({ page }) => {
    await openTrades(page, BLOCKED);
    await openCard(page, HELD_BY_RIVAL);
    await page.getByTestId('trade-ladder-toggle').click();

    await expect(page.getByTestId('trade-ladder-blocked')).toBeVisible();
    /* Zeroes in every field are what a blocked ladder carries; none are drawn. */
    await expect(page.getByTestId('trade-ladder-rungs')).toHaveCount(0);
  });

  test('is not offered for a player who cannot be traded for', async ({ page }) => {
    await openTrades(page);

    // Your own player: there is no partner to negotiate with.
    await openCard(page, MINE);
    await expect(page.getByTestId('trade-ladder-toggle')).toHaveCount(0);
    await page.getByTestId('sheet-close').click();

    // And a free agent is an add, not a trade.
    await openCard(page, FREE_AGENT);
    await expect(page.getByTestId('trade-ladder-toggle')).toHaveCount(0);
    expect(asked).toBe(0);
  });

  test('never scrolls sideways, open or shut', async ({ page }) => {
    await openTrades(page, ladder({ sample: 6, confident: true }));
    await openCard(page, HELD_BY_RIVAL);
    expect(await horizontalOverflow(page)).toBe(0);

    await page.getByTestId('trade-ladder-toggle').click();
    await expect(page.getByTestId('trade-ladder-detail')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);

    const body = (await page.getByTestId('trade-ladder-detail').boundingBox())!;
    expect(body.x).toBeGreaterThanOrEqual(0);
    expect(body.x + body.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });

  test('is one tap target with an accessible name and no nested control', async ({ page }) => {
    await openTrades(page);
    await openCard(page, HELD_BY_RIVAL);

    const toggle = page.getByTestId('trade-ladder-toggle');
    const box = (await toggle.boundingBox())!;
    expect(box.height, `the control is ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);
    expect(await toggle.evaluate((el) => el.tagName)).toBe('BUTTON');
    expect(await toggle.locator('button, a, input, summary').count()).toBe(0);
  });
});

/**
 * The half of this feature that had to be got right.
 *
 * A league whose draft ended last night has no completed trade in it, and every
 * manager is unmeasured rather than inactive. The card names the manager — a
 * fact — and claims nothing else.
 */
test.describe('what it says about the manager holding him', () => {
  /** Words that describe a person. None may appear below the threshold. */
  const TENDENCY = /usually|rarely|often|prefers|history of|buying|selling|trades about/i;

  test('says nothing about a manager the league has not measured', async ({ page }) => {
    await openTrades(page, ladder({ sample: 0, confident: false }));
    await openCard(page, HELD_BY_RIVAL);
    await page.getByTestId('trade-ladder-toggle').click();

    const partner = page.getByTestId('trade-ladder-partner');
    await expect(partner).toBeVisible();
    /* Who to ask is still answered — that is the fact the screen exists for. */
    await expect(partner).toContainText('Rival');

    await expect(page.getByTestId('trade-ladder-manager')).toHaveCount(0);
    await expect(page.getByTestId('trade-ladder-manager-absent')).toBeVisible();
    expect(await partner.innerText()).not.toMatch(TENDENCY);
  });

  test('says nothing on a sample below the threshold either', async ({ page }) => {
    await openTrades(page, ladder({ sample: 3, confident: false }));
    await openCard(page, HELD_BY_RIVAL);
    await page.getByTestId('trade-ladder-toggle').click();

    const partner = page.getByTestId('trade-ladder-partner');
    await expect(page.getByTestId('trade-ladder-manager')).toHaveCount(0);
    /* The count is a fact about the evidence, so it is allowed and is shown. */
    await expect(page.getByTestId('trade-ladder-manager-absent')).toContainText('3');
    expect(await partner.innerText()).not.toMatch(TENDENCY);
  });

  test('reads a manager the league has genuinely measured', async ({ page }) => {
    await openTrades(page, ladder({ sample: 6, confident: true }));
    await openCard(page, HELD_BY_RIVAL);
    await page.getByTestId('trade-ladder-toggle').click();

    await expect(page.getByTestId('trade-ladder-manager')).toBeVisible();
    await expect(page.getByTestId('trade-ladder-manager-absent')).toHaveCount(0);
    expect(await page.getByTestId('trade-ladder-partner').innerText()).toMatch(TENDENCY);
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
