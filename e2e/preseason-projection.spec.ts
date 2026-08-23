/**
 * The last mile, from the phone.
 *
 * The parser, the identity ladder, the scoring-profile identity and the storage
 * were all proven long before this existed — and none of them could be reached
 * from a browser, which made the feature correct and unusable. This is the
 * guard against that happening again: the path a person actually walks, in a
 * real browser, on a phone-sized screen.
 *
 * What it does not do is import a snapshot. The demo seed carries no StartWho
 * paste and inventing one here would be testing a fixture; the import itself is
 * proven against the real clipboard in the unit and route suites.
 */

import { expect, test, type Page } from '@playwright/test';

async function openPanel(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
  const panel = page.getByTestId('panel-preseason-projection');
  await panel.scrollIntoViewIfNeeded();
  await panel.locator('summary').click();
  return panel;
}

test.describe('the preseason projection panel', () => {
  test('is reachable from Setup and says what is loaded', async ({ page }) => {
    const panel = await openPanel(page);
    await expect(panel.getByTestId('projection-status')).toBeVisible();
    // Nothing imported in the demo, and it says so rather than showing a zero.
    await expect(panel.getByTestId('projection-status')).toContainText('Nothing imported');
  });

  test('is named for what it is, not for Vegas', async ({ page }) => {
    /*
     * The one thing this panel must never do. A StartWho number is a projection
     * derived *from* betting markets, and filing it under the heading that
     * means "lines a book is taking bets on" would make the two look
     * interchangeable in the one place a reader goes to find out whether they
     * are.
     */
    const panel = await openPanel(page);
    const heading = (await panel.locator('summary').innerText()).toLowerCase();
    expect(heading).toContain('projection');
    expect(heading).not.toContain('vegas');
  });

  test('offers a way in, and says the snapshot arrives by hand', async ({ page }) => {
    const panel = await openPanel(page);
    await expect(panel.getByTestId('open-projection-paste')).toBeVisible();
    // Acquisition is manual by policy, and the screen is where that is stated.
    await expect(panel).toContainText(/paste/i);
    await expect(panel).toContainText(/not (fetched|scraped)|nothing is fetched/i);
  });

  test('opens a paste sheet whose Preview waits for something to read', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByTestId('open-projection-paste').click();

    const sheet = page.getByTestId('projection-paste-sheet');
    await expect(sheet).toBeVisible();
    // Nothing pasted yet, so there is nothing to preview.
    await expect(page.getByTestId('projection-preview')).toBeDisabled();

    await page.getByTestId('projection-paste-input').fill('▸ Somebody\nQB1 · Buffalo Bills\n300.0');
    await expect(page.getByTestId('projection-preview')).toBeEnabled();
  });

  test('refuses a paste that is not a projection table, in words', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByTestId('open-projection-paste').click();
    await page.getByTestId('projection-paste-input').fill('hello\nthere\nfriend');
    await page.getByTestId('projection-preview').click();

    // An error the reader can act on, and no preview panel pretending to work.
    await expect(page.getByTestId('projection-preview-panel')).toHaveCount(0);
    await expect(panel.locator('.notice, [data-tone="error"]').first()).toBeVisible();
  });

  test('fits the phone', async ({ page }) => {
    await openPanel(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
