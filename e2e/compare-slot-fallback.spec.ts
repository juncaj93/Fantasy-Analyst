/**
 * Compare's header names the slot the server compared for (23 October 2026),
 * at every width the suite runs (360, 375, 390, 430).
 *
 * Reported from production: opened from a WR row, a TE and a WR read
 * "Week 7 · WR slot", the server marked the pair not comparable and the Start
 * pick vanished with no reason given. The opening slot now gives way to the
 * smallest slot both share (FLEX), the header says so, and the pick is shown.
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function openFromWrRow(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.locator('[data-testid="starter-row"][data-slot="WR"]').first().click();
  await page.getByTestId('weekly-compare').click();
  await expect(page.getByTestId('compare-sheet')).toBeVisible();
}

test('a TE added to a Compare opened on a WR row is a FLEX comparison, with a Start pick', async ({ page }) => {
  await openFromWrRow(page);
  const sheet = page.getByTestId('compare-sheet');
  if (!(await page.getByTestId('compare-picker').isVisible())) await page.getByTestId('compare-add').click();
  await page.getByTestId('compare-tab-all').click();
  const te = page.locator('[data-testid="compare-candidate"][aria-label*=", TE "][data-chosen="false"]').first();
  await expect(te).toBeVisible();
  await te.click();
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();

  const sub = sheet.locator('.cmp-title-sub');
  await expect(sub).toContainText('FLEX slot');
  await expect(sub).not.toContainText('WR slot');
  await expect(page.locator('[data-testid="compare-column"][data-pick="true"]')).toHaveCount(1);

  /* One line, nothing clipped, at this width. */
  const fits = await sub.evaluate((el) => {
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
    return { oneLine: el.getBoundingClientRect().height <= line * 1.5, clipped: el.scrollWidth > el.clientWidth + 1 };
  });
  expect(fits.oneLine, 'the header subtitle stays on one line').toBe(true);
  expect(fits.clipped, 'the header subtitle is not clipped').toBe(false);
  const header = (await sheet.locator('.cmp-title').boundingBox())!;
  expect(header.x + header.width, 'the title fits the sheet').toBeLessThanOrEqual(page.viewportSize()!.width);
});
