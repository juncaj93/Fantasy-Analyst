/**
 * Best move: a toss-up (4 November 2026), at every width the suite runs (360,
 * 375, 390, 430). Under two points the card names the lean and both numbers,
 * says "Toss-up", and suggests no change: the rows keep Sleeper's lineup.
 * Tapping opens Compare on the two players.
 *
 * The demo week's own answer is written over with a toss-up between two of the
 * demo roster's players, so the card has one to draw.
 */
import { expect, test } from '@playwright/test';
import { inSeason } from './helpers.ts';

const TOSSUP = { slot: 'WR', inPlayerId: '1004', inName: 'Andre Sotelo', outPlayerId: '1001', outName: 'Marcus Vance', gain: 1.25, reason: 'Toss-up' };

test('a toss-up names the lean, both numbers and no change, and opens Compare', async ({ page }) => {
  await inSeason(page);
  await page.goto('/');
  await page.route('**/api/leagues/*/lineup', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, swaps: [], fills: [], tossUps: [TOSSUP] }) });
  });
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();

  const row = page.getByTestId('lineup-tossup');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Toss-up: lean Andre Sotelo over Marcus Vance');
  await expect(row.getByTestId('best-move-points')).toHaveText(/^\d+\.\d vs \d+\.\d projected$/);
  await expect(page.getByTestId('lineup-swap')).toHaveCount(0);
  await expect(page.getByTestId('lineup-verdict')).toHaveCount(0);
  await expect(row).not.toContainText('Sleeper');

  /* Nothing on the card runs off the phone, and the page does not scroll sideways. */
  const fits = await row.evaluate((el) => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fits.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(fits.scroll).toBeLessThanOrEqual(fits.client + 1);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);

  await row.click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await expect(page.getByTestId('compare-column')).toHaveCount(2);
});
