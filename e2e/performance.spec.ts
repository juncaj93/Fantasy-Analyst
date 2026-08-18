/**
 * The flows that must stay fast, measured rather than eyeballed.
 *
 * This app is expected to feel instant on a phone while the models behind it
 * keep growing — Monte Carlo survival runs, tier arithmetic, usage trends, a
 * board that is now four hundred rows deep rather than forty. Every one of
 * those was the right call and every one of them costs something, and the only
 * signal that the total has become too much is somebody eventually noticing the
 * app feels slow, by which point the cause is a year of commits.
 *
 * So the flows §9 names get a number each.
 *
 * ## Why these numbers are so generous
 *
 * Because they run on a shared CI runner, which can be three times slower than
 * a laptop and occasionally worse, and because a budget that fails on a busy
 * morning is a budget that gets marked flaky and then ignored — which is
 * strictly worse than not having one. These are set to catch a flow going from
 * milliseconds to seconds: a board that starts re-scoring on every keystroke, a
 * filter that refetches, a sheet that pulls the whole player universe. They are
 * not set to police tens of milliseconds, and they should not be tightened
 * until they run somewhere with a predictable clock.
 *
 * The budget that *is* precise lives in `scripts/perf-budget.mjs` and measures
 * gzipped bytes, which are the same everywhere. Bytes for precision, wall clock
 * for the shape of the flow — that split is deliberate.
 *
 * Nothing here is paid, hosted, or an account: it is Playwright, which the
 * repository already runs, and a JSON file.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const budgets = JSON.parse(readFileSync(new URL('../perf-budgets.json', import.meta.url), 'utf8')).flows as Record<
  string,
  number
>;

/**
 * Time one action, in the page's own clock.
 *
 * `performance.now()` rather than a wall clock on the Node side, so the number
 * excludes Playwright's own round trip — which on a loaded runner is a
 * meaningful fraction of the budget and has nothing to do with the app.
 */
async function timed(page: import('@playwright/test').Page, action: () => Promise<void>): Promise<number> {
  const started = await page.evaluate(() => performance.now());
  await action();
  const finished = await page.evaluate(() => performance.now());
  return finished - started;
}

/** Report every measurement, pass or fail, so a trend is visible in the log. */
function report(name: string, ms: number, budget: number) {
  const verdict = ms <= budget ? 'ok' : 'OVER';
  console.log(`perf: ${name.padEnd(24)} ${ms.toFixed(0).padStart(6)}ms  budget ${budget}ms  ${verdict}`);
  expect(ms, `${name} took ${ms.toFixed(0)}ms against a budget of ${budget}ms`).toBeLessThanOrEqual(budget);
}

test.describe('performance budgets', () => {
  test('the shell renders, and Draft is usable, inside budget', async ({ page }) => {
    const started = Date.now();
    await page.goto('/');
    /*
     * "Rendered" means the board is on screen, not that a spinner is.
     *
     * A first paint that shows a skeleton is not the thing being budgeted —
     * the user cannot do anything with it. The first row of players is the
     * moment the app became useful, and that is what is measured.
     */
    await expect(page.getByTestId('board-list')).toBeVisible();
    report('shell + draft render', Date.now() - started, budgets['shellRenderMs']!);
  });

  test('opening the Team tab stays inside budget', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();

    const ms = await timed(page, async () => {
      await page.getByTestId('tab-team').click();
      await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
    });
    report('team tab open', ms, budgets['teamTabOpenMs']!);
  });

  test('coming back to Draft stays inside budget', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');

    const ms = await timed(page, async () => {
      await page.getByTestId('tab-draft').click();
      await expect(page.getByTestId('board-list')).toBeVisible();
    });
    report('draft tab open', ms, budgets['draftTabOpenMs']!);
  });

  test('typing in the search field never goes to the server', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();

    /*
     * The assertion that matters more than the milliseconds.
     *
     * Search filters rows that are already on the client. If a keystroke ever
     * starts a request the flow is not slightly slower, it is a different flow
     * — one that is unusable on a bad connection, which is exactly where a
     * draft happens. So requests are counted, and the count must be zero.
     */
    let requests = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/')) requests++;
    });

    await page.getByTestId('draft-search-open').click();
    const field = page.getByTestId('draft-search');
    await expect(field).toBeVisible();

    const ms = await timed(page, async () => {
      await field.fill('bren');
      await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    });

    report('search response', ms, budgets['searchResponseMs']!);
    expect(requests, 'typing in the search field must not reach the server').toBe(0);
  });

  test('changing the position filter stays inside budget', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();

    const rb = page.getByRole('button', { name: 'RB', exact: true });
    const ms = await timed(page, async () => {
      await rb.click();
      await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    });
    report('filter response', ms, budgets['filterResponseMs']!);
  });

  test('opening a player sheet stays inside budget', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();

    const row = page.getByTestId('recommendation-row').first();
    const collapsed = (await row.boundingBox())!.height;

    /*
     * Waiting on the row actually growing, not on the click returning.
     *
     * The tap reveals the case for the player — verdict, numbers, reasons,
     * counterpoint — by expanding the row in place, so the row getting taller
     * *is* the disclosure having happened. Asserting anything that was already
     * true before the click (the row being visible, say) would measure the
     * round trip to Playwright and call it a render.
     */
    const ms = await timed(page, async () => {
      await row.click();
      await expect
        .poll(async () => (await row.boundingBox())!.height, { timeout: budgets['playerSheetOpenMs']! })
        .toBeGreaterThan(collapsed);
    });
    report('player sheet open', ms, budgets['playerSheetOpenMs']!);
  });
});
