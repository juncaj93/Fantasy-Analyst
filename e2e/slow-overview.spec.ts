/**
 * A slow answer is not a missing season.
 *
 * On 28 September 2026 the live site took 30-45 seconds to answer
 * `/api/overview`, and for all of that time the bar showed the pre-season set
 * (Draft, Team, Trades, Players, Setup) to a reader in week 4, with Waivers and
 * Matchup gone. The bar was reading "not answered yet" as "no season".
 *
 * These hold the overview back on purpose and look at the bar while it waits.
 * See `src/web/seasonTabs.ts`.
 */

import { expect, test, type Page, type Route } from '@playwright/test';

/** An in-season answer: Draft gone, Waivers in its slot, Matchup open. */
async function inSeason(route: Route) {
  const response = await route.fetch();
  const body = await response.json();
  await route.fulfill({
    json: {
      ...body,
      season: { phase: 'regular', draftVisible: false, reason: 'week 4', assumed: false },
      lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true },
    },
  });
}

/**
 * Hold the overview until the test lets it go, then answer in season.
 * Returns the release.
 */
async function holdOverview(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/overview', async (route) => {
    await gate;
    await inSeason(route);
  });
  return release;
}

const bar = (page: Page) => page.locator('.tabbar');

test.describe('while the overview is still on its way', () => {
  test('a returning reader keeps the bar they had, not a pre-season one', async ({ page }) => {
    // A first visit that completes, in season, so the device has seen an answer.
    await page.route('**/api/overview', inSeason);
    await page.goto('/');
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    await expect(bar(page)).toHaveAttribute('data-season', 'server');
    await page.unroute('**/api/overview');

    // The next open, with the overview held back.
    const release = await holdOverview(page);
    await page.reload();
    await expect(bar(page)).toHaveAttribute('data-season', 'remembered');
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    // Still waiting several seconds in, and still the same bar.
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    release();
    await expect(bar(page)).toHaveAttribute('data-season', 'server');
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
  });

  test('a first visit shows no seasonal tab it has not been told about', async ({ page }) => {
    const release = await holdOverview(page);
    await page.goto('/');
    await expect(bar(page)).toHaveAttribute('data-season', 'pending');
    await expect(bar(page)).toHaveAttribute('aria-busy', 'true');
    // The four that never come and go, and none of the seasonal three.
    for (const tab of ['team', 'trades', 'players', 'setup']) {
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    }
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toHaveCount(0);
    await expect(page.getByTestId('tab-matchup')).toHaveCount(0);

    release();
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(bar(page)).not.toHaveAttribute('aria-busy', 'true');
  });

  test('a slow league list does not hold the bar back', async ({ page }) => {
    await page.route('**/api/overview', inSeason);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/leagues', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/');
    await expect(page.getByTestId('tab-waivers')).toBeVisible({ timeout: 5_000 });
    await expect(bar(page)).toHaveAttribute('data-season', 'server');
    release();
  });
});

test.describe('when the overview fails', () => {
  test('with nothing remembered, the board is kept, as it always was', async ({ page }) => {
    await page.route('**/api/overview', (route) => route.fulfill({ status: 500, json: { error: 'down' } }));
    await page.goto('/');
    await expect(page.getByTestId('app-error')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(bar(page)).toHaveAttribute('data-season', 'failed');
  });

  test('with an answer remembered, the bar keeps it', async ({ page }) => {
    await page.route('**/api/overview', inSeason);
    await page.goto('/');
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await page.unroute('**/api/overview');

    await page.route('**/api/overview', (route) => route.fulfill({ status: 500, json: { error: 'down' } }));
    await page.reload();
    await expect(page.getByTestId('app-error')).toBeVisible();
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(bar(page)).toHaveAttribute('data-season', 'remembered');
  });
});
