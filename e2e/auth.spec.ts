/**
 * Login flow, running deliberately without the shared session.
 */

import { expect, test } from '@playwright/test';
import { E2E_PASSPHRASE as PASSPHRASE } from './constants.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('gates the app behind a passphrase and then loads the draft board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Passphrase')).toBeVisible();
  await expect(page.getByTestId('tab-draft')).toHaveCount(0);

  await page.getByLabel('Passphrase').fill('wrong-passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('invalid passphrase')).toBeVisible();

  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('recommended-heading')).toBeVisible();
});
