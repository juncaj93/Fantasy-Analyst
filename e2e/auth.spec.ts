/**
 * Public reads, protected writes — verified without the shared session.
 *
 * Fantasy data is deliberately public, so the app must open straight to the
 * content with no login wall. Changing anything must still be refused until the
 * passphrase is entered.
 */

import { expect, test } from '@playwright/test';
import { E2E_PASSPHRASE as PASSPHRASE } from './constants.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('opens straight to the app with no login wall', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tab-draft')).toBeVisible();
  await expect(page.getByLabel('Passphrase')).toHaveCount(0);
  // Real data, not an empty shell.
  await page.getByTestId('tab-draft').click();
  await expect(page.getByTestId('board-list')).toBeVisible();
});

test('shows that it is view-only until unlocked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.header-meta')).toContainText('view only');
});

test('refuses changes until unlocked, then allows them', async ({ page }) => {
  // Refused while locked.
  const locked = await page.request.post('/api/sleeper/sync-players');
  expect(locked.status()).toBe(401);

  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  const unlock = page.getByTestId('unlock-card');
  await expect(unlock).toBeVisible();

  await unlock.getByLabel('Passphrase').fill('wrong-passphrase');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.locator('.notice')).toContainText('not right');

  await unlock.getByLabel('Passphrase').fill(PASSPHRASE);
  await unlock.getByRole('button', { name: 'Unlock' }).click();

  // The unlock card goes away and the header stops saying view-only.
  await expect(page.getByTestId('unlock-card')).toHaveCount(0);
  await expect(page.locator('.header-meta')).not.toContainText('view only');
});
