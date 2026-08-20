/**
 * A tab you already opened should feel already open.
 *
 * ## What was wrong
 *
 * `App.tsx` mounts each tab as `{tab === 'draft' ? <Draft/> : null}`, so leaving
 * a tab destroys the screen and returning builds a new one whose data starts at
 * `null`. Each screen fetched on mount and rendered nothing until the response
 * landed, so every revisit cost a full round trip of blank screen. Measured on
 * the seeded league with a fixed delay added to every `/api/` call, a Draft
 * revisit took 276ms at +250ms and 626ms at +600ms — and on a phone, against a
 * Worker that also queries D1 and scores a board, that is the one to two seconds
 * the app was reported to feel like.
 *
 * ## What these tests defend
 *
 * Not a number. Wall clock in CI is noisy enough that a millisecond budget here
 * would be marked flaky and then ignored, and the interesting property is not
 * "fast" anyway — it is **that the screen never goes back to empty**. So the
 * delay is made enormous and deterministic with `page.route`, and the assertion
 * is that content is on screen while the request that would have produced it is
 * still in the air. A revisit that waits for the network cannot pass that, no
 * matter how quick the network is.
 *
 * The freshness half is defended too, in the same shape: the delayed response
 * carries different data, and the screen has to end up showing it.
 */

import { expect, test, type Page } from '@playwright/test';

/** How long a held request waits. Long enough that no machine is fast enough. */
const HELD_MS = 4000;

/** Open the app and wait for Draft to be genuinely usable. */
async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

async function switchTo(page: Page, tab: string) {
  await page.getByTestId(`tab-${tab}`).click();
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
}

test.describe('returning to a tab opened earlier in the session', () => {
  test('Draft comes back without a blocking load', async ({ page }) => {
    await openApp(page);
    const before = await page.getByTestId('recommendation-row').first().innerText();

    await switchTo(page, 'team');
    await expect(page.getByTestId('starters-title')).toBeVisible();

    /*
     * Every board request from here on is held open. The old behaviour cannot
     * survive this: it had nothing to draw until a board arrived, and no board
     * will arrive for four seconds.
     */
    await page.route('**/api/drafts/*/board*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
      await route.continue();
    });

    await switchTo(page, 'draft');
    // Immediately, while the request above is still being held.
    await expect(page.getByTestId('board-list')).toBeVisible({ timeout: 1500 });
    expect(await page.getByTestId('recommendation-row').first().innerText()).toBe(before);
  });

  test('Team comes back without a blocking load', async ({ page }) => {
    await openApp(page);
    await switchTo(page, 'team');
    await expect(page.getByTestId('starters-title')).toBeVisible();

    await switchTo(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();

    await page.route('**/api/leagues/*/roster', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
      await route.continue();
    });

    await switchTo(page, 'team');
    await expect(page.getByTestId('starters-title')).toBeVisible({ timeout: 1500 });
  });

  test('Players comes back without a blocking load', async ({ page }) => {
    await openApp(page);
    await switchTo(page, 'players');
    await expect(page.getByTestId('players-list')).toBeVisible();

    await switchTo(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();

    await page.route('**/api/players*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
      await route.continue();
    });

    await switchTo(page, 'players');
    await expect(page.getByTestId('players-list')).toBeVisible({ timeout: 1500 });
  });

  test('a slow refresh replaces the shown board once it lands', async ({ page }) => {
    await openApp(page);
    const first = page.getByTestId('recommendation-row').first();
    const before = await first.innerText();

    await switchTo(page, 'team');
    await expect(page.getByTestId('starters-title')).toBeVisible();

    /*
     * The other half of stale-while-revalidate. Showing what you had is only
     * correct if what the server says still wins in the end, so the held
     * response comes back with a name nothing else could have produced.
     */
    await page.route('**/api/drafts/*/board*', async (route) => {
      const response = await route.fetch();
      const board = await response.json();
      if (board.recommendations?.[0]) board.recommendations[0].name = 'Newer Truth';
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ response, json: board });
    });

    await switchTo(page, 'draft');
    // The board that was already known, first...
    await expect(page.getByTestId('board-list')).toBeVisible({ timeout: 1500 });
    expect(await first.innerText()).toBe(before);
    // ...and then the server's answer, without the reader doing anything.
    await expect(first).toContainText('Newer Truth', { timeout: 8000 });
  });

  test('the tab re-tap ladder still clears the search', async ({ page }) => {
    /*
     * The reset semantics that already shipped outrank the cache: an explicit
     * gesture must still do what it says. Tapping Draft while on Draft clears
     * the search field, and nothing about painting from cache may change that.
     */
    await openApp(page);
    await page.getByTestId('draft-search-open').click();
    const field = page.getByTestId('draft-search');
    await field.fill('smith');
    await expect(field).toHaveValue('smith');

    await page.getByTestId('tab-draft').click();
    await expect(page.getByTestId('draft-search')).toBeHidden();
    await expect(page.getByTestId('board-list')).toBeVisible();
  });
});
