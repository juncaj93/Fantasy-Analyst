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

/**
 * The banner that used to say this is gone. The state is not: it moved to the
 * Setup tab, where unlocking happens, as a mark plus an accessible name — so it
 * still reads to a screen reader without costing every page a line of chrome.
 */
test('shows that it is view-only until unlocked', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('view-only')).toBeVisible();
  await expect(page.getByTestId('tab-setup')).toHaveAccessibleName(/view only/i);
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

  // The unlock card goes away and the view-only mark goes with it.
  await expect(page.getByTestId('unlock-card')).toHaveCount(0);
  await expect(page.getByTestId('view-only')).toHaveCount(0);
});
