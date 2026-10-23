/**
 * Every sheet closes the same way (23 October 2026): an X in a grey rounded
 * square at the top right, 44px, named "Close" for a screen reader. Compare
 * had it first; the word Done on every other sheet is gone.
 *
 * At every phone width the suite runs (360, 375, 390, 430), each sheet Alex
 * opens most is opened from its screen, its close control is checked against
 * Compare's look and place, and a tap on it closes the sheet. A guard over the
 * open dialog fails if any button in it says Done or Close in words.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/** The season under way, as the toolbar and Waivers read it. */
async function regularSeason(page: Page) {
  await inSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false } }),
    });
  });
}

/** The X: Compare's look and place, no word on it, and a tap closes the sheet. */
async function closesWithTheX(page: Page, sheet: Locator) {
  await expect(sheet).toBeVisible();
  const words = await sheet.getByRole('button').evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
  expect(words.filter((w) => /^(done|close)$/i.test(w)), 'a close control in words').toEqual([]);

  const close = sheet.getByTestId('sheet-close');
  await expect(close).toHaveCount(1);
  await expect(close).toHaveAttribute('aria-label', 'Close');
  await expect(close).toHaveText('');
  await expect(close).toHaveClass('sheet-close-x');
  await expect(close.locator('svg')).toHaveCount(1);

  const x = (await close.boundingBox())!;
  const card = (await sheet.boundingBox())!;
  expect(x.width, 'a 44px square').toBeGreaterThanOrEqual(44);
  expect(x.height, 'a 44px square').toBeGreaterThanOrEqual(44);
  expect(page.viewportSize()!.width - (x.x + x.width), 'at the right edge').toBeLessThanOrEqual(16);
  expect(x.y - card.y, 'in the header row').toBeLessThanOrEqual(64);
  const look = await close.evaluate((el) => {
    const style = getComputedStyle(el);
    return { radius: style.borderTopLeftRadius, fill: style.backgroundColor };
  });
  expect(look.radius).toBe('12px');
  expect(look.fill, 'the grey square is filled').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  await close.click();
  await expect(sheet).toHaveCount(0);
}

test('the Team player sheet closes with the X', async ({ page }) => {
  await regularSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
  await closesWithTheX(page, page.getByTestId('weekly-sheet'));
});

test('the Compare sheet closes with the X', async ({ page }) => {
  await regularSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
  await closesWithTheX(page, page.getByTestId('compare-sheet'));
});

test('the Players player sheet closes with the X', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  await page.getByTestId('player-search-row').first().click();
  await closesWithTheX(page, page.getByTestId('player-sheet'));
});

test('the waiver move sheet closes with the X', async ({ page }) => {
  await regularSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await page.getByTestId('waiver-tier-row').first().click();
  await closesWithTheX(page, page.getByTestId('tier-detail'));
});

test('a Trades player sheet closes with the X', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await page.getByTestId('trade-row').first().click();
  await closesWithTheX(page, page.getByTestId('player-sheet'));
});
