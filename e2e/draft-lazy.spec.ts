/**
 * The Draft screen's code is fetched only while a draft is ahead.
 *
 * `App.tsx` reaches the Draft screen through `lazy()`, emitted as `draft-*.js`,
 * and draws it only while `overview.season.draftVisible` holds. These check
 * that in a real browser, by watching which files it actually asks for:
 *
 * - the dev server's seeded league is mid-draft, so the board's code arrives
 *   and the board draws;
 * - Demo Mode's placeholder is in season, so nothing named `draft-*.js` is ever
 *   requested, on any screen;
 * - a download that fails leaves the app standing, with a way to recover.
 */

import { expect, test, type Page } from '@playwright/test';

const DRAFT_CHUNK = /\/assets\/draft-[^/]+\.js$/;

function watchDraftChunks(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (DRAFT_CHUNK.test(new URL(req.url()).pathname)) seen.push(req.url());
  });
  return seen;
}

test('mid-draft, the board’s code arrives and the board draws', async ({ page }) => {
  const seen = watchDraftChunks(page);
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
  expect(seen.length, 'the Draft screen came from its own chunk').toBeGreaterThan(0);
});

test('in season, the Draft screen’s code is never requested', async ({ page }) => {
  const seen = watchDraftChunks(page);
  await page.goto('/?demo=in-season');
  await expect(page.getByTestId('demo-bar')).toBeVisible();
  await expect(page.getByTestId('tab-draft')).toHaveCount(0);
  for (const name of ['team', 'matchup', 'waivers', 'players', 'setup']) {
    await page.getByTestId(`tab-${name}`).click();
    await expect(page.getByTestId(`tab-${name}`)).toHaveAttribute('aria-current', 'page');
    // Each screen's first read is back. Not `networkidle`: some screens poll.
    await expect(page.locator('.app-main .skeleton, .app-main .spinner')).toHaveCount(0);
  }
  expect(seen, 'a draft-*.js request in season').toEqual([]);
  await page.getByTestId('demo-exit').click();
});

test('a failed download leaves the app standing, and says how to recover', async ({ page }) => {
  await page.route(DRAFT_CHUNK, (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  await expect(page.getByTestId('screen-load-error')).toBeVisible();
  await expect(page.getByTestId('screen-load-error')).toContainText('could not be loaded');
  // The rest of the app is still there and still works.
  await expect(page.getByTestId('tab-team')).toBeVisible();
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
});
