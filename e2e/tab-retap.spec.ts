/**
 * Tapping the destination you are already on.
 *
 * iOS gives the current tab the one job it has nothing else to do: take the
 * screen back towards its resting state, and then to the top. Every screen in
 * this app now answers that, and the behaviour is the kind that decays without
 * anybody noticing — a screen grows a new piece of transient state, nobody adds
 * it to the reset, and the gesture quietly stops meaning "home".
 *
 * Two claims, and the second matters more than the first:
 *
 *  1. **A retap unwinds view state.** An open sheet, a pushed page, a typed
 *     query, an expanded row, a narrowed filter — all of it comes back.
 *  2. **A retap touches nothing the reader owns.** A heart, a queue mark, a
 *     tally: those are not view state, and a gesture that reset them would be
 *     destroying data with a tap people make by accident.
 *
 * Scrolling to the top is asserted where the screen is long enough to scroll.
 */

import { expect, test, type Page } from '@playwright/test';
import { emptyQueue, exploreMarket, openSetupGroup, tapAboveCard } from './helpers.ts';

async function open(page: Page, tab: string) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(400);
}

/** Tap the tab that is already current. */
async function retap(page: Page, tab: string) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(500);
}

test.describe('a retap returns the screen home', () => {
  /*
   * The one thing in this file that is not view state is the ★, and the file
   * lights it on purpose to prove a retap leaves it alone. Put back here, so
   * that a test which fails before its last line cannot hand the bookmark to
   * the next spec — nor to the next width, which is the same database: one
   * `playwright test` invocation serves all four projects from one server.
   */
  test.afterEach(async ({ page }) => {
    await emptyQueue(page);
  });

  test('Draft: unwinds the expansion, then the search, then the filter', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');

    /*
     * Narrow it three ways, filter first.
     *
     * The search field and the position chips share one row — opening the field
     * folds the chips away — so the filter has to be set before the field is
     * expanded. That ordering is the screen's, not this test's preference.
     */
    const qb = page.getByRole('button', { name: 'QB', exact: true });
    await qb.click();
    await expect(qb).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('a');
    await page.waitForTimeout(600);
    const row = page.getByTestId('recommendation-row').first();
    await row.click();
    await expect(row.getByTestId('player-detail')).toBeVisible();

    // One rung per tap, innermost first — see `tabReset.ts`.
    await retap(page, 'draft');
    await expect(page.getByTestId('player-detail'), 'the first tap should close the card').toHaveCount(0);
    await expect(page.getByTestId('draft-search'), 'and nothing else').toBeVisible();

    await retap(page, 'draft');
    await expect(page.getByTestId('draft-search'), 'the second tap should close the search').toHaveCount(0);
    await expect(qb, 'and leave the filter').toHaveAttribute('aria-pressed', 'true');

    await retap(page, 'draft');
    await expect(page.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // …and now that there is nothing left to undo, the tap means "the top".
    await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'auto' }));
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(100);
    await retap(page, 'draft');
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeLessThan(20);
  });

  /**
   * …and it leaves the queue exactly where it was.
   *
   * The star is a bookmark the reader placed. A gesture that cleared it would
   * be losing work to a mistap, which is the one thing this must never do.
   */
  test('Draft: a retap is not destructive', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');

    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    const star = row.getByTestId('queue-control');
    await star.click();
    await expect(star).toHaveAttribute('data-queued', '1');

    await retap(page, 'draft');

    const same = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(same.getByTestId('queue-control'), 'a tab tap unqueued a player').toHaveAttribute(
      'data-queued',
      '1',
    );
  });

  test('Players: clears the query and returns to the top', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');

    await page.getByLabel('Search players').fill('a');
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'auto' }));
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(100);

    // The query is the only rung, so the first tap spends itself on it…
    await retap(page, 'players');
    await expect(page.getByLabel('Search players')).toHaveValue('');

    // …and the next one, with nothing left to undo, goes to the top.
    await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'auto' }));
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(100);
    await retap(page, 'players');
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeLessThan(20);
  });

  /**
   * A sheet is modal, and covers the bar — which is why it is not dismissed
   * from there.
   *
   * The retap ladder does close any sheet the screen is holding, and that rung
   * is real: it fires whenever the tab is tapped. It is simply not *reachable*
   * while the sheet is up, because an iOS sheet presented over a tab bar covers
   * it, exactly as this one does. That is the native behaviour and it is worth
   * pinning down rather than discovering later as a bug report, so this asserts
   * both halves: the bar is genuinely covered, and the sheet has its own two
   * ways out — the backdrop and a swipe or key — which is what a modal owes the
   * reader instead.
   */
  test('Trades: a sheet covers the bar, and closes on its own terms', async ({ page }) => {
    await page.goto('/');
    await open(page, 'trades');
    await exploreMarket(page);
    const rows = page.getByTestId('trade-row');
    test.skip((await rows.count()) === 0, 'no trade suggestions on this seed');

    await rows.first().click();
    const sheet = page.getByTestId('player-sheet');
    await expect(sheet).toBeVisible();

    /*
     * The bar is under the modal: what is on top at the tab's own centre is not
     * the button.
     *
     * *Which* layer is on top is not the claim and must not be asserted as one.
     * The sheet is `bottom: 0` with a content-driven height, so whether the tab
     * bar's centre lands on the sheet itself or on the backdrop above which it
     * sits depends on how tall this particular sheet's content is — which
     * differs between engines, and did: this read the sheet specifically and
     * passed in Chromium at every width while failing in WebKit at every width.
     * Both layers are modal and both intercept the tap, which is the whole
     * point.
     */
    const overBar = await page.evaluate(() => {
      const tab = document.querySelector('[data-testid="tab-trades"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2);
      return {
        isTab: hit?.closest('[data-testid="tab-trades"]') != null,
        isModal: hit?.closest('[data-testid="player-sheet"], [data-testid="sheet-scroller"]') != null,
      };
    });
    expect(overBar.isTab, 'the tab bar is tappable through an open sheet').toBe(false);
    expect(overBar.isModal, 'something that is neither the sheet nor its backdrop is over the bar').toBe(true);

    // …and it goes away without one, by the backdrop.
    // The see-through zone above the card, which is what a tap outside lands on
    // now that the backdrop is colour and the scroller covers it.
    await tapAboveCard(page);
    await expect(sheet).toHaveCount(0);

    /*
     * Once it is gone the bar is the bar again, and the ladder applies.
     *
     * The market fold is still open across the retap, which is deliberate: a
     * tab tap unwinds what the app put over the screen, and an inventory the
     * reader chose to open is a view they set rather than an overlay they are
     * stuck under. See `unwindOne` in `TradesScreen`.
     */
    await retap(page, 'trades');
    await expect(page.getByTestId('trade-row').first()).toBeVisible();
  });

  test('Setup: comes back out to the root of Settings, one step at a time', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await openSetupGroup(page, 'data');

    await page.getByTestId('setup-step-vegas').click();
    await expect(page.getByTestId('panel-vegas')).toBeVisible();

    await retap(page, 'setup');

    /*
     * One tap gives back the panel, not the group it was opened from.
     *
     * A reader who opened Data, went into Vegas and tapped Setup meant "come
     * back out of Vegas" — coming back to three shut folds would throw away two
     * steps of navigation for one tap, and make them find their place again.
     */
    await expect(page.getByTestId('panel-vegas')).toHaveCount(0);
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();

    // The second tap is the one that folds the screen back to its three lines.
    await retap(page, 'setup');
    await expect(page.getByTestId('setup-step-vegas')).toHaveCount(0);
    await expect(page.getByTestId('setup-group-data')).toBeVisible();
  });

  /**
   * And every destination survives being tapped twice.
   *
   * The cheap, broad half of the claim: whatever a screen does with a retap, it
   * may not throw, blank itself or lose its navigation. Run across the whole
   * bar because the ladder is per-screen and a new screen is exactly where this
   * would be forgotten.
   */
  test('every destination stays on its feet when tapped twice', async ({ page }) => {
    await page.goto('/');
    /*
     * Wait for the bar before reading it. `evaluateAll` is not a Playwright
     * assertion and does not retry: it answers with whatever matches at the
     * instant it runs, and on a loaded machine that instant lands before the
     * bar has mounted. The failure that produces is `Received: 0` with a
     * screenshot showing every destination present — the test asking too
     * early, wearing the costume of a missing toolbar.
     */
    await expect(page.locator('.tabbar button').first()).toBeVisible();
    const tabs = await page
      .locator('.tabbar button')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-testid')!.replace('tab-', '')));
    expect(tabs.length).toBeGreaterThan(4);

    for (const tab of tabs) {
      await open(page, tab);
      await retap(page, tab);
      await expect(page.getByTestId(`tab-${tab}`), `${tab} lost its place`).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.tabbar'), `${tab} lost the bar`).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${tab} overflows by ${overflow}px after a retap`).toBeLessThanOrEqual(1);
    }
  });
});
