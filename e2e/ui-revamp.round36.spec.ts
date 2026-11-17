/**
 * Round 36: the UI revamp, part 2 (UI_REVAMP): Waivers, Trades, Players and
 * Setup in the new look, at every phone width the projects run.
 *
 * The switch is off on the server here, as on the live site; each test turns
 * it on by answering the status read with `uiRevamp: true`. Waivers gets the
 * preview's made-up picks (scripts/ui-preview-fixtures.mjs), Trades and the
 * Players board the preview leagues' answers, computed here by the same code
 * the preview uploads use. Every test fails on the code before Round 36.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';
import { TradeScreensService } from '../src/server/services/tradeScreensService.ts';
import { previewSeasonBoard, previewSeasonCard } from '../src/core/players/seasonPreview.ts';
// @ts-expect-error plain JavaScript shared with the preview scripts
import { withPreviewWaivers } from '../scripts/ui-preview-fixtures.mjs';

async function world(page: Page, { revamp = true, draftAhead = false }: { revamp?: boolean; draftAhead?: boolean } = {}) {
  await inSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const season = draftAhead
      ? { phase: 'preseason', draftVisible: true, reason: 'your draft has not finished yet', assumed: false }
      : { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 12)', assumed: false };
    await route.fulfill({
      json: { ...body, season, lifecycle: { ...(body.lifecycle ?? {}), draftVisible: draftAhead, matchupVisible: !draftAhead } },
    });
  });
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, features: { ...(body.features ?? {}), uiRevamp: revamp } } });
  });
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: withPreviewWaivers(await response.json()) });
  });
  const trades = new TradeScreensService(null as never, null as never, 'normal');
  await page.route('**/api/trades/screens/**', async (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith('/offers')
      ? await trades.offers(null)
      : url.pathname.endsWith('/teams')
        ? await trades.teams()
        : await trades.verdict({
            partner: Number(url.searchParams.get('b')),
            give: (url.searchParams.get('give') ?? '').split(',').filter(Boolean),
            get: (url.searchParams.get('get') ?? '').split(',').filter(Boolean),
          });
    await route.fulfill({ json: body });
  });
  await page.route(/\/api\/players\/(season|[^/]+\/season)(\?|$)/, async (route) => {
    const card = /^\/api\/players\/([^/]+)\/season$/.exec(new URL(route.request().url()).pathname);
    const body = card ? previewSeasonCard(decodeURIComponent(card[1]!)) : previewSeasonBoard();
    await route.fulfill({ status: body ? 200 : 404, json: body ?? { error: 'player not found' } });
  });
}

async function open(page: Page, tab: 'waivers' | 'trades' | 'players') {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'revamp');
  await page.getByTestId(`tab-${tab}`).click();
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function tall(page: Page, selector: string) {
  const heights = await page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
}

test.describe('Waivers', () => {
  test.beforeEach(async ({ page }) => world(page));

  test('each pick is a card: the bid on the right, then the gain, the spot and one reason', async ({ page }) => {
    await open(page, 'waivers');
    await expect(page.getByTestId('waivers-week')).toHaveText('Week 12');
    const card = page.getByTestId('waiver-tier-row').first();
    await expect(card.locator('.wcard-bid')).toHaveText('Waivers $9');
    await expect(card.getByTestId('tier-gain')).toHaveText('+11.4');
    await expect(card.getByTestId('tier-reason')).toHaveText('Brennan on bye wk 12');
    const [cardBox, bidBox] = [await card.boundingBox(), await card.locator('.wcard-bid').boundingBox()];
    expect(cardBox!.x + cardBox!.width - (bidBox!.x + bidBox!.width)).toBeLessThan(24);
    await tall(page, '[data-testid="waiver-tier-row"], [data-testid$="-line"]');
    await noSidewaysScroll(page);
  });

  test('stash, cover and block are cards with the bid on the right, and a tap opens Compare', async ({ page }) => {
    await open(page, 'waivers');
    const stash = page.getByTestId('waiver-stash-line');
    await expect(stash.locator('.wcard-bid')).toHaveText('Waivers $0–1');
    await expect(stash.getByTestId('extra-kind')).toHaveText('Stash');
    await expect(page.getByTestId('waiver-cover-line').getByTestId('extra-kind')).toHaveText('Cover');
    await expect(page.getByTestId('waiver-block-line').locator('.wcard-bid')).toHaveText('Waivers $1–3');
    await page.getByTestId('waiver-cover-line').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();
  });
});

test.describe('Trades', () => {
  test.beforeEach(async ({ page }) => world(page));

  test('an offer is the pick, one reason and three tiles; Check this offer still checks it', async ({ page }) => {
    await open(page, 'trades');
    const offer = page.getByTestId('t2-offer-card').first();
    await expect(offer.getByTestId('t2-give')).toBeVisible();
    await expect(offer.getByTestId('t2-reason')).toBeVisible();
    await expect(offer.locator('.t2r-tile')).toHaveCount(3);
    await expect(offer.locator('.t2r-tile').first()).toContainText('This week');
    await tall(page, '.t2r-tile, [data-testid="t2-check-this"]');
    await noSidewaysScroll(page);
    await offer.getByTestId('t2-check-this').click();
    await expect(page.getByTestId('t2-check-word')).toBeVisible();
    const size = await page.getByTestId('t2-check-word').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThan(28);
  });

  test('the picker keeps its green Add button and X cancels', async ({ page }) => {
    await open(page, 'trades');
    await page.getByTestId('t2-check-this').first().click();
    await page.getByTestId('t2-check-give-add').click();
    await expect(page.getByTestId('t2-picker-add')).toHaveText('Add players');
    await page.getByTestId('t2-check-option').first().click();
    await expect(page.getByTestId('t2-picker-add')).toHaveAttribute('data-ready', 'yes');
    await page.getByTestId('t2-picker').getByTestId('sheet-close').click();
    await expect(page.getByTestId('t2-picker')).toHaveCount(0);
  });
});

test.describe('Players', () => {
  test.beforeEach(async ({ page }) => world(page));

  test('the value is the row\'s one bold number on the right; who holds him sits under it', async ({ page }) => {
    await open(page, 'players');
    const row = page.getByTestId('player-search-row').first();
    const value = row.getByTestId('p2-value');
    await expect(value).toHaveText(/^\d+\.\d$/);
    expect(await value.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    const [rowBox, valueBox] = [await row.boundingBox(), await value.boundingBox()];
    expect(valueBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width / 2);
    await expect(row.getByTestId('owner-pill')).toBeVisible();
    await expect(page.getByTestId('players-rank-head')).toContainText('Value');
    await expect(page.getByTestId('players-rank-head').locator('.list-head-note')).toBeHidden();
    await page.getByTestId('p2-view-trade').click();
    const target = page.getByTestId('player-search-row').first();
    await expect(target.getByTestId('owner-pill')).toBeVisible();
    await expect(target.getByTestId('p2-willing')).toBeVisible();
    await noSidewaysScroll(page);
  });
});

test.describe('Setup', () => {
  test.beforeEach(async ({ page }) => world(page));

  test('a few labelled sections, no folds, no draft-only rows, Data health kept', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-setup').click();
    await expect(page.getByTestId('setup-sections')).toBeVisible();
    await expect(page.locator('.section-title')).toContainText(['League', 'News and lines', 'Health', 'App']);
    await expect(page.getByTestId('setup-group-data')).toHaveCount(0);
    await expect(page.getByTestId('setup-step-adp')).toHaveCount(0);
    await expect(page.getByTestId('draft-balance')).toHaveCount(0);
    await expect(page.getByTestId('setup-data-health')).toBeVisible();
    await tall(page, '[data-testid="setup-sections"] .list-row');
    await noSidewaysScroll(page);
    /* A page behind a row: its help paragraph is gone, its facts stay. */
    await page.getByTestId('setup-step-sleeper').click();
    await expect(page.getByText(/The player list is how Fantasy Analyst recognizes names/)).toBeHidden();
  });
});

test.describe('draft mode', () => {
  test('keeps today\'s look while a draft is ahead, even with the switch on', async ({ page }) => {
    await world(page, { draftAhead: true });
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-ui', 'revamp');
    await expect(page.getByTestId('nav-setup')).toHaveCount(0);
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-season')).toHaveCount(0);
  });
});

test.describe('with the switch off', () => {
  test('Waivers, Trades and Setup draw as today', async ({ page }) => {
    await world(page, { revamp: false });
    await page.goto('/');
    await page.getByTestId('tab-waivers').click();
    await expect(page.getByTestId('waiver-tier-row').first()).toBeVisible();
    await expect(page.locator('.wcard-bid')).toHaveCount(0);
    await expect(page.getByTestId('waiver-stash-line')).toContainText('Stash: Hollis Marchetti');
    await page.getByTestId('tab-trades').click();
    await expect(page.getByTestId('t2-offer').first()).toBeVisible();
    await expect(page.locator('.t2r-tile')).toHaveCount(0);
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-group-data')).toBeVisible();
    await expect(page.getByTestId('setup-sections')).toHaveCount(0);
  });
});
