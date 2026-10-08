/**
 * The number on the left of every Players row is labelled (finding P1).
 *
 * It is Sleeper's draft order after the research nudge, and nothing said so.
 * A heading names the column once, on the same x as the numbers under it,
 * at every width the app is used at.
 */

import { expect, test } from '@playwright/test';

test.describe('the Players rank', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
  });

  test('is labelled over its own column, and says what it is', async ({ page }) => {
    const head = page.getByTestId('players-rank-head');
    await expect(head).toBeVisible();
    await expect(head).toContainText('Rank');
    await expect(head).toContainText('Sleeper’s draft order, moved by your research');

    const headX = await head.locator('.list-head-rank').evaluate((el) => el.getBoundingClientRect().left);
    const rankX = await page
      .getByTestId('player-search-row')
      .first()
      .locator('.rank')
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs(headX - rankX), `heading at ${headX}, numbers at ${rankX}`).toBeLessThanOrEqual(1);
  });

  test('fits on one line without pushing the page sideways', async ({ page }) => {
    const box = await page.getByTestId('players-rank-head').boundingBox();
    expect(box!.height).toBeLessThan(24);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
