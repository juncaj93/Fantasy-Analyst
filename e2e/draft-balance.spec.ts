/**
 * The draft board's weighting control, on an iPhone.
 *
 * Three things this has to be true of, and none of them is about arithmetic —
 * that is asserted in `tests/draft.signalBalance.test.ts`, where a board can be
 * compared byte for byte:
 *
 *  1. it sits in Settings, at the default position, and says what that means
 *     in words rather than in a number;
 *  2. moving it saves, and the sentence under it changes to describe where it
 *     now is;
 *  3. the board says out loud that it is not ranking the way it usually does —
 *     a tuned ranking that looked untuned would be the one genuinely dangerous
 *     outcome here.
 *
 * The stored position is an account setting on a server this whole suite
 * shares, so every test here puts it back afterwards. A spec that left the
 * board tuned would quietly change the one every other spec is reading.
 */

import { expect, test, type Page } from '@playwright/test';

async function openSetup(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await expect(page.getByTestId('draft-balance')).toBeVisible();
}

/** Put the account back where it started, whatever the test did to it. */
test.afterEach(async ({ page }) => {
  await page.request.post('/api/setup/draft-balance', { data: { balance: 'balanced' } });
});

test.describe('draft board weighting', () => {
  test('starts balanced, and says so in words', async ({ page }) => {
    await openSetup(page);
    await expect(page.getByTestId('draft-balance-label')).toContainText('Balanced');
    await expect(page.getByTestId('draft-balance-label')).toContainText('default');
    await expect(page.getByTestId('draft-balance')).toContainText('Market consensus');
    await expect(page.getByTestId('draft-balance')).toContainText('My own research');
    // The positions are named, never numbered: a reader is not asked what 1.25
    // means.
    await expect(page.getByTestId('draft-balance')).not.toContainText('1.25');
  });

  test('the slider is a real 44px target and does not push the page sideways', async ({ page }) => {
    await openSetup(page);
    const box = await page.getByTestId('draft-balance-slider').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('moving it saves, and moving it back restores the default', async ({ page }) => {
    await openSetup(page);

    /** Move the thumb and wait for the write it causes, not for a timer. */
    const move = async (position: string) => {
      const saved = page.waitForResponse(
        (r) => r.url().includes('/api/setup/draft-balance') && r.request().method() === 'POST',
      );
      await page.getByTestId('draft-balance-slider').fill(position);
      expect((await saved).status()).toBe(200);
    };

    await move('4');
    await expect(page.getByTestId('draft-balance-label')).toContainText('My research first');
    await expect(page.getByTestId('draft-balance')).toContainText('half again as much');

    // It really was saved, rather than only moved on screen.
    await page.reload();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('draft-balance-label')).toContainText('My research first');

    await move('2');
    await page.reload();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('draft-balance-label')).toContainText('Balanced (default)');
  });

  test('the board says when it is not ranking the way it usually does', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('your own research is set');

    await page.request.post('/api/setup/draft-balance', { data: { balance: 'personal' } });
    await page.reload();
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.locator('main')).toContainText('louder than usual');
  });
});
