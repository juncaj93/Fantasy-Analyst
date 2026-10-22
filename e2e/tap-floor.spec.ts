/**
 * Buttons answer a thumb across the 44px floor, whatever height they draw at.
 *
 * Measured the way a finger lands: a tap 21px above and below the centre of a
 * drawn button must still reach it. The boxes are 32px and 36px on purpose (a
 * header stays one line); the reach is an invisible ::after.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSetupGroup, pastTheSettle } from './helpers.ts';

async function reaches(page: Page, target: Locator): Promise<boolean[]> {
  const box = (await target.boundingBox())!;
  const handle = await target.elementHandle();
  return page.evaluate(
    ({ el, x, y }) => [y - 21, y + 21].map((at) => el != null && el.contains(document.elementFromPoint(x, at))),
    { el: handle, x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

test('a sheet’s Done and its full-profile link each reach 44px', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  await page.getByTestId('player-search-row').first().click();
  const sheet = page.getByTestId('player-sheet');
  await expect(sheet.getByTestId('sheet-close')).toHaveText('Done');
  await pastTheSettle(page);

  expect(await reaches(page, sheet.getByTestId('sheet-close')), 'Done').toEqual([true, true]);
  expect(await reaches(page, sheet.getByTestId('player-full-profile')), 'View full profile').toEqual([true, true]);
});

test('a 36px button reaches 44px', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await openSetupGroup(page, 'data');
  await page.getByTestId('setup-step-sleeper').click();
  const buttons = page.locator('button.btn:not(.btn-sm):not(.btn-compact)').filter({ visible: true });
  await expect(buttons.first()).toBeVisible();
  for (const button of await buttons.all()) {
    expect((await button.boundingBox())!.height, 'drawn at the 36px it always was').toBeLessThan(44);
    expect(await reaches(page, button)).toEqual([true, true]);
  }
});
