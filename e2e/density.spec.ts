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
   * The position arrives as a pill, and as nothing else.
   *
   * This asserted an *edge* — a three-pixel bar of the position's hue down the
   * leading side of every row — on the argument that the hue had to survive
   * somewhere once the wash was removed. It did not have to survive twice.
   * Forty rails turn a player index into a chart with a colour key, while the
   * pill on the same row was already saying the position in letters, which is
   * the cue that works in monochrome and for a reader who has not learned the
   * convention. The louder of the two was the one carrying less, so it went.
   *
   * What is asserted now is the whole of the claim: the row is the list's own
   * surface on every side, and the position is legible without reading a colour
   * at all.
   */
  test('carries its position in the pill rather than in the row', async ({ page }) => {
    const readings = await page.getByTestId('player-search-row').evaluateAll((rows) =>
      rows.slice(0, 8).map((r) => {
        const style = getComputedStyle(r);
        return {
          background: style.backgroundColor,
          edge: Number.parseFloat(style.borderLeftWidth) || 0,
          badge: (r.querySelector('.pos-pill')?.textContent ?? '').trim(),
        };
      }),
    );
    const group = await page
      .getByTestId('players-list')
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    expect(readings.length).toBeGreaterThan(4);
    for (const { background, edge, badge } of readings) {
      // Transparent, or the group's own surface. Either way: not a wash.
      expect(['rgba(0, 0, 0, 0)', group]).toContain(background);
      expect(edge, `a row still paints a ${edge}px rail`).toBe(0);
      expect(badge, 'the position is not written anywhere on the row').toMatch(/^(QB|RB|WR|TE|K|DEF)$/);
    }
    // …and the list really does hold more than one position, so a uniform
    // screen could not pass this by accident.
    expect(new Set(readings.map((r) => r.badge)).size).toBeGreaterThan(1);
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

/**
 * The player himself: one dossier, the same four sections, wherever it was
 * opened from and whichever way it is framed.
 *
 * Tapping a name opens a sheet; the pushed page is what a reader asks for when
 * a skim turns into a study. Both draw `PlayerDossier`, which is why these
 * assertions do not care which one is on screen — and why the app cannot grow
 * two answers to "what do we know about him".
 */
test.describe('the player dossier', () => {
  test('names the player, qualifies him, and offers every section', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const row = page.getByTestId('player-search-row').first();
    await expect(row).toBeVisible();
    const name = await row.locator('.player-name').innerText();

    await row.click();
    const sheet = page.getByTestId('player-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.sheet-player-name')).toHaveText(name);
    // The identity is drawn, not spelled: the position pill and the club's mark,
    // and both in front of the name exactly as the row has them. The order
    // itself is asserted in `player-detail.spec.ts`.
    await expect(sheet.locator('.sheet-player-title .pos-pill')).toBeVisible();

    /*
     * Every section, on one surface, without choosing a tab first.
     *
     * The sheet used to carry the page's segmented control. A reader who taps a
     * name is asking who this is, and a segmented control answers by asking
     * them a question back — so the sheet stacks the lot in the order it is
     * wanted and the segments stay on the pushed page, which is the deep read.
     */
    await expect(page.getByTestId('player-page-sections')).toHaveCount(0);
    const snapshot = page.getByTestId('player-page-snapshot');
    await expect(snapshot).toBeVisible();
    // The windows moved up into the band above the snapshot; the news is here.
    await expect(page.getByTestId('player-page-metrics')).toContainText('30d');
    /*
     * The newsletter's news, said once.
     *
     * Which of the two blocks carries it depends on the player: a takeaway is
     * lifted out of the ledger when one of his items supports a sentence, and
     * `Latest news` then shows what is left rather than repeating it — so a
     * player with a single applied item has a takeaway and no news list, and
     * one with several has both. What must always be true is that a player the
     * newsletter has written about says so somewhere on his card.
     */
    const takeaway = snapshot.getByTestId('newsletter-takeaway');
    const news = snapshot.getByTestId('evidence-heading');
    await expect
      .poll(async () => (await takeaway.count()) + (await news.count()), {
        message: 'a player with newsletter evidence carried none of it on his card',
      })
      .toBeGreaterThan(0);

    // It dismisses without touching the list, which is still exactly there.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });

  /**
   * …and the same dossier, on his own page, when asked for.
   *
   * The sheet is the first stop and the page is the second. Both have to name
   * him and both have to offer every section, or "one object across the app" is
   * a claim rather than a fact.
   */
  test('offers the same sections on the pushed page', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const row = page.getByTestId('player-search-row').first();
    const name = await row.locator('.player-name').innerText();
    await row.click();
    await page.getByTestId('player-full-profile').click();

    const pushed = page.getByTestId('player-page');
    await expect(pushed).toBeVisible();
    await expect(pushed.locator('.nav-title')).toHaveText(name);
    await expect(pushed.locator('.player-page-ident .pos-pill')).toBeVisible();
    const labels = await page.getByTestId('player-page-sections').locator('button').allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual(['Overview', 'Outlook', 'Market', 'Evidence']);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });

  /**
   * The snapshot is one scroll, and it is a vertical one.
   *
   * This used to step through the four segments. There are none in a sheet now,
   * so it scrolls the surface instead — every section is on it, and any one of
   * them that overflowed would show up at some point on the way down.
   */
  test('never scrolls sideways, anywhere down the snapshot', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await page.getByTestId('player-search-row').first().click();
    const body = page.locator('.sheet-body');
    await expect(body).toBeVisible();

    const height = await body.evaluate((el) => el.scrollHeight);
    for (let top = 0; top <= height; top += 200) {
      await body.evaluate((el, y) => el.scrollTo({ top: y }), top);
      await page.waitForTimeout(80);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the snapshot overflows by ${overflow}px at ${top}px down`).toBeLessThanOrEqual(1);
    }
  });
});
