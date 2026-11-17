/**
 * Round 35: the UI revamp, part 1 (UI_REVAMP).
 *
 * The switch is off on the server here, as on the live site; each test turns
 * it on by answering the status read with `uiRevamp: true`, which is exactly
 * what the server does when UI_REVAMP = "on". The last test checks that with
 * the switch off nothing moved.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function season(page: Page, { revamp = true }: { revamp?: boolean } = {}) {
  await inSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 11)', assumed: false },
        lifecycle: { ...(body.lifecycle ?? {}), draftVisible: false, matchupVisible: true },
      },
    });
  });
  if (!revamp) return;
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, features: { ...(body.features ?? {}), uiRevamp: true } } });
  });
}

async function openTeam(page: Page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'revamp');
  await expect(page.getByTestId('starter-row').first()).toBeVisible();
}

test.describe('navigation', () => {
  test.beforeEach(async ({ page }) => season(page));

  test('the bar carries the game-day jobs; Setup is the gear, and Back returns', async ({ page }) => {
    await openTeam(page);
    const tabs = page.locator('nav.tabbar button');
    await expect(tabs).toHaveText(['Team', 'Matchup', 'Waivers', 'Trades', 'Players']);
    await expect(page.getByTestId('tab-setup')).toHaveCount(0);

    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-nav')).toContainText('Matchup');
    await page.getByTestId('nav-setup').click();
    await expect(page.getByTestId('nav-bar').first()).toContainText('Setup');
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('tab-matchup')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('matchup-score')).toBeVisible();
  });

  test('the current tab is marked, and only it', async ({ page }) => {
    await openTeam(page);
    const fill = (id: string) =>
      page.getByTestId(`tab-${id}`).locator('.tab-glyph').evaluate((el) => getComputedStyle(el).backgroundColor);
    const clear = await fill('matchup');
    expect(await fill('team')).not.toBe(clear);
    await page.getByTestId('tab-matchup').click();
    /* The pill fades across in 120 ms. */
    await expect.poll(() => fill('matchup')).not.toBe(clear);
    await expect.poll(() => fill('team')).toBe(clear);
  });

  test('every screen bar is the same height, names its screen, and nothing scrolls sideways', async ({ page }) => {
    await openTeam(page);
    const heights: number[] = [];
    for (const id of ['team', 'matchup', 'waivers', 'trades', 'players'] as const) {
      await page.getByTestId(`tab-${id}`).click();
      const bar = page.locator('.nav-bar').first();
      await expect(bar).toBeVisible();
      heights.push(Math.round((await bar.boundingBox())!.height));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, id).toBeLessThanOrEqual(0);
    }
    expect(new Set(heights).size, heights.join(',')).toBe(1);
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('league-card')).toContainText('Team');
  });

  test('Team and Matchup targets are at least 44px', async ({ page }) => {
    await openTeam(page);
    for (const box of await page.locator('[data-testid="starter-row"], .nav-bar button, nav.tabbar button').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-score')).toBeVisible();
    const halves = await page.locator('button.matchup-half').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(halves.length).toBeGreaterThan(0);
    for (const h of halves) expect(h).toBeGreaterThanOrEqual(44);
  });
});

test.describe('shortcuts', () => {
  test.beforeEach(async ({ page }) => season(page));

  /* Round 36 (Alex's review): the answer shows on the Compare tap, never on the second pick by itself. */
  test('Compare shows the answer on the Compare tap after two picks', async ({ page }) => {
    await openTeam(page);
    await page.getByTestId('compare-open').click();
    await page.getByTestId('compare-candidate').nth(0).click();
    await page.getByTestId('compare-candidate').nth(1).click();
    await expect(page.getByTestId('compare-picker')).toBeVisible();
    await page.getByTestId('compare-go').click();
    await expect(page.getByTestId('comparison')).toBeVisible();
    await expect(page.getByTestId('compare-picker')).toHaveCount(0);
  });

  test('Compare opens from Matchup in one tap', async ({ page }) => {
    await openTeam(page);
    await page.getByTestId('tab-matchup').click();
    await page.getByTestId('matchup-compare-open').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
  });
});

test.describe('speed', () => {
  test.beforeEach(async ({ page }) => season(page));

  test('a later launch shows the last good lineup at once and the server\'s behind it', async ({ page }) => {
    await openTeam(page);
    const first = await page.getByTestId('starter-row').allTextContents();
    /* The next launch, with the lineup and roster reads held for four seconds. */
    await page.route('**/api/leagues/*/lineup', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await page.reload();
    await expect(page.getByTestId('starter-row').first()).toBeVisible({ timeout: 1500 });
    expect(await page.getByTestId('starter-row').allTextContents()).toEqual(first);
  });

  test('loading draws rows, not a line of text', async ({ page }) => {
    await page.route('**/api/leagues/*/roster', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await page.goto('/');
    await expect(page.getByTestId('roster-skeleton')).toBeVisible();
    await expect(page.locator('.spinner')).toHaveCount(0);
    const row = await page.getByTestId('roster-skeleton').locator('.skeleton-row').first().boundingBox();
    expect(Math.round(row!.height)).toBe(44);
  });

  test('touching a tab starts its read once; opening it does not ask again', async ({ page }) => {
    await openTeam(page);
    let reads = 0;
    page.on('request', (r) => {
      if (/\/api\/leagues\/[^/]+\/matchup$/.test(new URL(r.url()).pathname)) reads += 1;
    });
    await page.getByTestId('tab-matchup').dispatchEvent('pointerdown');
    await expect.poll(() => reads).toBe(1);
    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-score')).toBeVisible();
    await page.waitForTimeout(500);
    expect(reads).toBe(1);
  });
});

test.describe('with the switch off', () => {
  test.beforeEach(async ({ page }) => season(page, { revamp: false }));

  test('nothing moved: Setup is a tab, Team is titled by the league, no gear', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('starter-row').first()).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-ui', 'revamp');
    await expect(page.getByTestId('tab-setup')).toBeVisible();
    await expect(page.getByTestId('nav-setup')).toHaveCount(0);
    await expect(page.getByTestId('league-card')).toContainText('Demo Dynasty');
  });
});
