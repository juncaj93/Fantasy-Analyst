/**
 * The draft board's weighting control, on an iPhone.
 *
 * Four things this has to be true of, and none of them is about arithmetic —
 * that is asserted in `tests/draft.signalBalance.test.ts`, where a board can be
 * compared byte for byte:
 *
 *  1. it is one closed row until somebody asks for it, and that row says where
 *     the control is pointing without being opened;
 *  2. opening it is a tap on a real target, and reveals the slider;
 *  3. moving it saves, and the row's own summary follows the thumb;
 *  4. the board says out loud that it is not ranking the way it usually does —
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

/** Open the row, which is shut on arrival. */
async function expand(page: Page) {
  await page.getByTestId('draft-balance-summary').click();
  await expect(page.getByTestId('draft-balance-slider')).toBeVisible();
}

/** Put the account back where it started, whatever the test did to it. */
test.afterEach(async ({ page }) => {
  await page.request.post('/api/setup/draft-balance', { data: { balance: 'balanced' } });
});

test.describe('draft board weighting', () => {
  test('is one closed row, naming the position it is in', async ({ page }) => {
    await openSetup(page);
    await expect(page.getByTestId('draft-balance-label')).toContainText('Balanced (default)');

    /*
     * Closed means closed: none of the control is on the screen until asked.
     *
     * Asserted as visibility rather than as absent text. A shut `<details>`
     * still carries its body in the DOM — that is what makes it a disclosure
     * and not a lazy load — so `toContainText` would read the slider's labels
     * off a row nobody can see, and pass or fail for the wrong reason.
     */
    await expect(page.getByTestId('draft-balance-body')).toBeHidden();
    await expect(page.getByTestId('draft-balance-slider')).toBeHidden();
  });

  test('opens on a tap, on a target a thumb can hit', async ({ page }) => {
    await openSetup(page);
    const row = await page.getByTestId('draft-balance-summary').boundingBox();
    expect(row!.height, 'the row is not a full tap target').toBeGreaterThanOrEqual(44);

    await expand(page);
    await expect(page.getByTestId('draft-balance-body')).toBeVisible();
    await expect(page.getByTestId('draft-balance-body')).toContainText('Market consensus');
    await expect(page.getByTestId('draft-balance-body')).toContainText('My own research');
    const slider = await page.getByTestId('draft-balance-slider').boundingBox();
    expect(slider!.height).toBeGreaterThanOrEqual(44);

    // ...and it shuts again, which is what a disclosure is.
    await page.getByTestId('draft-balance-summary').click();
    await expect(page.getByTestId('draft-balance-body')).toBeHidden();
  });

  /**
   * The longest position, on the narrowest phone.
   *
   * The row carries two pieces of text on one line — the name of the setting
   * and the position it is in — and "My research first" is the longest thing
   * that second half can say. On a 360px screen that is where a row of this
   * shape stops fitting, so it is checked there rather than assumed anywhere.
   */
  test('fits the longest position on the narrowest row', async ({ page }) => {
    await page.request.post('/api/setup/draft-balance', { data: { balance: 'personal' } });
    await openSetup(page);
    await expect(page.getByTestId('draft-balance-label')).toContainText('My research first');

    const summary = page.getByTestId('draft-balance-summary');
    const clipped = await summary.evaluate(
      (el) => el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1,
    );
    expect(clipped, 'the row clips its own text').toBe(false);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('neither state pushes the page sideways', async ({ page }) => {
    await openSetup(page);
    const overflow = async () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await expand(page);
    expect(await overflow()).toBeLessThanOrEqual(1);
  });

  test('moving it saves, the row follows the thumb, and moving it back restores the default', async ({ page }) => {
    await openSetup(page);
    await expand(page);

    /** Move the thumb and wait for the write it causes, not for a timer. */
    const move = async (position: string) => {
      const saved = page.waitForResponse(
        (r) => r.url().includes('/api/setup/draft-balance') && r.request().method() === 'POST',
      );
      await page.getByTestId('draft-balance-slider').fill(position);
      expect((await saved).status()).toBe(200);
    };

    await move('4');
    // The summary is the thing a closed row shows, so it has to keep up.
    await expect(page.getByTestId('draft-balance-label')).toContainText('My research first');
    await expect(page.getByTestId('draft-balance-body')).toContainText('half again as much');

    // It really was saved, rather than only moved on screen.
    await page.reload();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('draft-balance-label')).toContainText('My research first');
    // ...and a saved position does not force the row open on the next visit.
    await expect(page.getByTestId('draft-balance-body')).toBeHidden();

    await expand(page);
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
