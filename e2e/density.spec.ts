/**
 * The compact lists, as numbers.
 *
 * Players and Trades were the two screens the density pass was actually about,
 * and "denser" is the kind of claim that decays quietly: a row grows a line, a
 * card comes back, an explanation moves up from the detail page, and six months
 * later the screen is what it was. So the outcome is asserted rather than
 * described — how many players fit on a phone, how tall a row is allowed to be,
 * that a suggestion is a row and not a card, and that neither list can scroll
 * sideways at any supported width.
 *
 * This file measures shape only. What the rows *say* is app.spec.ts's job, and
 * none of those assertions were weakened to make these pass.
 */

import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, tab: 'players' | 'trades') {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(400);
}

/** The y a row has to clear to count as being on the first screen. */
async function toolbarTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.tabbar')!.getBoundingClientRect().top);
}

async function rowsOnFirstScreen(page: Page, testId: string): Promise<number> {
  const floor = await toolbarTop(page);
  const rows = page.getByTestId(testId);
  const count = await rows.count();
  let visible = 0;
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    if (box && box.y + box.height <= floor) visible++;
  }
  return visible;
}

test.describe('the players list is a database, not a stack of cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });

  /**
   * Ten, measured, on the narrowest phone the app supports.
   *
   * The card this replaced was a two-line row with its own margin, its own
   * shadow and its own rounded corners, and eight of them filled a 360×800
   * screen. The same two lines on one grouped surface, separated by a hairline,
   * fit ten — and the tap target did not move: see the height assertion below.
   */
  test('fits ten players on the first screen', async ({ page }) => {
    expect(await rowsOnFirstScreen(page, 'player-search-row')).toBeGreaterThanOrEqual(10);
  });

  /**
   * Dense is not cramped.
   *
   * The floor is the one number a density pass may never trade away: 44px is a
   * thumb, and a row a thumb cannot land on is not a row. The ceiling is what
   * keeps it a list — two lines of type and their padding, and nothing else.
   */
  test('every row is a full tap target and none of them is a card', async ({ page }) => {
    const boxes = await page.getByTestId('player-search-row').evaluateAll((rows) =>
      rows.map((r) => r.getBoundingClientRect().height),
    );
    expect(boxes.length).toBeGreaterThan(5);
    for (const height of boxes) {
      expect(height, `a row is only ${height}px tall`).toBeGreaterThanOrEqual(44);
      expect(height, `a row has grown to ${height}px, which is a card`).toBeLessThanOrEqual(74);
    }
  });

  /**
   * The position arrives as an edge and a pill, and not as a wash.
   *
   * A tinted row is what the brief asked to be removed: at forty rows a screen,
   * a saturated background stops being information and starts being the loudest
   * thing on the page. The hue is still there — the leading border proves it,
   * and the six positions still differ — but the surface a name is read against
   * is the list's own.
   */
  test('carries its position on the edge rather than across the whole row', async ({ page }) => {
    const readings = await page.getByTestId('player-search-row').evaluateAll((rows) =>
      rows.slice(0, 8).map((r) => {
        const style = getComputedStyle(r);
        return { edge: style.borderLeftColor, background: style.backgroundColor };
      }),
    );
    const group = await page
      .getByTestId('players-list')
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    expect(new Set(readings.map((r) => r.edge)).size, 'positions are indistinguishable').toBeGreaterThan(1);
    for (const { background } of readings) {
      // Transparent, or the group's own surface. Either way: not a wash.
      expect(['rgba(0, 0, 0, 0)', group]).toContain(background);
    }
  });

  test('never scrolls sideways', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the page overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  });

  /**
   * The numbers are numbers, whatever the width.
   *
   * The first attempt at these columns gave each of four an equal share of the
   * line, and a draft rank of `15.2` came out of it as `1…` on a 360px phone.
   * A truncated number is worse than no number: it is a value the reader will
   * misread rather than skip.
   */
  test('prints its numbers whole rather than truncating them', async ({ page }) => {
    const clipped = await page.getByTestId('players-adp').evaluateAll((cells) =>
      cells
        .map((c) => c.querySelector('.dense-metric-value') as HTMLElement | null)
        .filter((v): v is HTMLElement => v != null)
        .filter((v) => v.scrollWidth > v.clientWidth + 1)
        .map((v) => v.textContent ?? ''),
    );
    expect(clipped, `these values are cut off: ${clipped.join(', ')}`).toEqual([]);
  });
});

test.describe('a trade suggestion is a row', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await open(page, 'trades');
  });

  /**
   * Three lines, not five.
   *
   * The card this replaced carried a name, an injury line, a three-cell table
   * of tally windows, a trend sentence and a confidence badge — five stacked
   * blocks, four of which filled a phone. The same five facts are a name line,
   * a row of windows and one sentence with the confidence at the end of it.
   */
  test('is a row rather than a five-line card', async ({ page }) => {
    const rows = page.getByTestId('trade-row');
    await expect(rows.first()).toBeVisible();
    const heights = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const height of heights) {
      expect(height, `a suggestion is only ${height}px tall`).toBeGreaterThanOrEqual(44);
      expect(height, `a suggestion has grown back to ${height}px`).toBeLessThanOrEqual(96);
    }
  });

  /**
   * The three windows are on the row, named, and none of them was dropped.
   *
   * Density is not allowed to cost a reading. Lifetime, 30d and 7d are three
   * different questions about the same signal and the screen answered all three
   * before this pass; it answers all three now, in a third of the height.
   */
  test('still gives all three tally windows, each of them labelled', async ({ page }) => {
    const first = page.getByTestId('trade-row').first();
    await expect(first).toContainText('Life');
    await expect(first).toContainText('30d');
    await expect(first).toContainText('7d');
  });

  /**
   * And the case behind it is one tap away, on the player's own page.
   *
   * Not a screen of its own: a reader who taps a name expects the player. The
   * case arrives as context above the same four sections every other screen
   * opens, which is what makes a player one object across the app.
   */
  test('opens the whole case on the player’s own page', async ({ page }) => {
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-page')).toBeVisible();
    const kase = page.getByTestId('trade-case');
    await expect(kase).toBeVisible();
    await expect(kase).toContainText('Why');
    await expect(page.getByTestId('player-page-sections')).toBeVisible();

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('trade-row').first()).toBeVisible();
  });

  test('never scrolls sideways', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the page overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  });
});

/**
 * The player page itself: one destination, the same four sections, wherever it
 * was opened from.
 */
test.describe('the player page', () => {
  test('names the player, qualifies him, and offers every section', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const row = page.getByTestId('player-search-row').first();
    await expect(row).toBeVisible();
    const name = await row.locator('.player-name').innerText();

    await row.click();
    const pushed = page.getByTestId('player-page');
    await expect(pushed).toBeVisible();
    await expect(pushed.locator('.nav-title')).toHaveText(name);
    // The identity is drawn, not spelled: the position pill and the club's mark.
    await expect(pushed.locator('.player-page-ident .pos-pill')).toBeVisible();

    const labels = await page.getByTestId('player-page-sections').locator('button').allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual(['Overview', 'Outlook', 'Market', 'Evidence']);
  });

  /**
   * The metrics adapt to what the screen behind actually knows.
   *
   * Players deals in the draft market and hands it over; Trades does not have
   * it and never did. A page opened from Trades used to be able to print three
   * dashes and one reading, which is a header saying nothing four times.
   */
  test('shows market numbers from Players and tally windows from Trades', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await page.getByTestId('player-search-row').first().click();
    await expect(page.getByTestId('player-page-metrics')).toHaveAttribute('data-mode', 'market');
    await expect(page.getByTestId('player-page-metrics')).toContainText('ADP');

    await open(page, 'trades');
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-page-metrics')).toHaveAttribute('data-mode', 'tally');
    await expect(page.getByTestId('player-page-metrics')).toContainText('Life');
  });

  test('never scrolls sideways, on any section', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await page.getByTestId('player-search-row').first().click();
    for (const section of ['Overview', 'Outlook', 'Market', 'Evidence']) {
      await page.getByTestId('player-page-sections').getByRole('button', { name: section }).click();
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${section} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });
});
