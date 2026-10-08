/**
 * Setup's code is off the first screen's path, and there when it is wanted.
 *
 * October 2026: Setup, Review and Data health moved to their own `setup-*.js`
 * chunk (about 21KB gzipped) so the entry chunk drops from ~133.5KB to ~113.9KB
 * without raising the 135KB ceiling. That is only an improvement if the first
 * screen does not wait for it and the tab still opens, including after the
 * signal has gone.
 */

import { expect, test } from '@playwright/test';

test.describe('the Setup chunk', () => {
  test('is not fetched before the first screen, and is fetched soon after it', async ({ page }) => {
    const fetched: { url: string; at: number }[] = [];
    const start = Date.now();
    page.on('request', (req) => {
      if (/\/assets\/setup-[^/]+\.js$/.test(req.url())) fetched.push({ url: req.url(), at: Date.now() - start });
    });
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();
    // Fetched after the first screen, on its own timer.
    await expect.poll(() => fetched.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('opens Setup from the cache once the signal has gone', async ({ page, context }) => {
    const loaded = page.waitForResponse((res) => /\/assets\/setup-[^/]+\.js$/.test(res.url()), { timeout: 10_000 });
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();
    await loaded;
    await context.setOffline(true);
    await page.getByTestId('tab-setup').click();
    // The screen's own code is already here; the shell renders it rather than a load error.
    await expect(page.getByText('Setup could not be loaded', { exact: false })).toHaveCount(0);
    await expect(page.locator('main')).not.toBeEmpty();
    await context.setOffline(false);
  });
});
