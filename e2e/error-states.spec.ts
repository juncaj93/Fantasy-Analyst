/**
 * What a season screen says when its own read fails.
 *
 * The error notice is the whole answer. A line under it that reads as a fact
 * about the data ("Your roster was not found", "No players found") is false:
 * nothing was found or not found, because nothing arrived.
 */

import { expect, test, type Page } from '@playwright/test';

/** Show the in-season bar (Waivers and Matchup) whatever the seed's calendar says. */
async function seasonBar(page: Page): Promise<void> {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        season: { ...(body.season ?? {}), draftVisible: false },
        lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true },
      },
    });
  });
}

test.describe('a screen whose read fails', () => {
  test('Waivers shows the error and nothing about a missing roster', async ({ page }) => {
    await seasonBar(page);
    await page.route('**/api/leagues/*/waivers', (route) => route.abort('failed'));
    await page.goto('/');
    await page.getByTestId('tab-waivers').click();

    await expect(page.getByText('Couldn’t load this yet. Pull to refresh or try again.')).toBeVisible();
    await expect(page.getByText('Your roster was not found in this league.', { exact: false })).toHaveCount(0);
  });

  test('Players shows the error, not an empty list, and throws nothing', async ({ page }) => {
    const thrown: string[] = [];
    page.on('pageerror', (e) => thrown.push(e.message));
    await page.route('**/api/players?*', (route) => route.abort('failed'));
    await page.goto('/');
    await page.getByTestId('tab-players').click();

    await expect(page.getByText('Couldn’t load this yet. Pull to refresh or try again.')).toBeVisible();
    await expect(page.getByText('No players found.')).toHaveCount(0);
    expect(thrown, 'the failed read escaped as an unhandled error').toEqual([]);
  });
});
