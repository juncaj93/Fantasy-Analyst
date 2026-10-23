/**
 * Matchup's player cards with Team's number (23 October 2026), at every width
 * the suite runs (360, 375, 390, 430): the adjusted figure stays on one line
 * and is never clipped, and no row wraps.
 */
import { expect, test } from '@playwright/test';

test('every projected number on a Matchup card fits on one line, unclipped', async ({ page }) => {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } } });
  });
  await page.goto('/');
  await page.getByTestId('tab-matchup').click();
  await expect(page.getByTestId('matchup-score')).toBeVisible();

  const numbers = page.getByTestId('matchup-player-proj');
  expect(await numbers.count()).toBeGreaterThan(0);
  const fits = await numbers.evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
      return {
        text: el.textContent ?? '',
        oneLine: el.getBoundingClientRect().height <= line * 1.5,
        clipped: el.scrollWidth > el.clientWidth + 1,
      };
    }),
  );
  for (const f of fits) {
    expect(f.oneLine, `"${f.text}" stays on one line`).toBe(true);
    expect(f.clipped, `"${f.text}" is not clipped`).toBe(false);
  }
  for (const row of await page.getByTestId('matchup-row').all()) {
    expect((await row.boundingBox())!.height, 'a starter row stays on one line').toBeLessThan(52);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
