/**
 * Round 34: Trades and Players draw the live screens whatever the status read
 * says, because the switches that could bring the retired ones back are gone.
 *
 * Before this round a server answering `tradesScreens: 'old'` (or no
 * `playersInSeason`) put the old Trades screens and the draft-era Players list
 * back on the phone. Both checks fail on that code.
 */

import { expect, test, type Page } from '@playwright/test';
import { TradeScreensService } from '../src/server/services/tradeScreensService.ts';
import { previewSeasonBoard, previewSeasonCard } from '../src/core/players/seasonPreview.ts';

async function oldSwitchesAndSeason(page: Page, status: 'old' | 'failed') {
  await page.route('**/api/auth/status', async (route) => {
    if (status === 'failed') return route.abort();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, features: { tradesScreens: 'old', preview: null } }) });
  });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const season = { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 10)', assumed: false };
    await route.fulfill({ response, body: JSON.stringify({ ...body, season }) });
  });
  await page.route('**/api/trades/screens/**', async (route) => {
    const url = new URL(route.request().url());
    const s = new TradeScreensService(null as never, null as never, 'normal');
    const body = url.pathname.endsWith('/offers') ? await s.offers(null) : url.pathname.endsWith('/teams') ? await s.teams() : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/\/api\/players\/(season|[^/]+\/season)(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const card = /^\/api\/players\/([^/]+)\/season$/.exec(url.pathname);
    const body = card ? previewSeasonCard(decodeURIComponent(card[1]!)) : previewSeasonBoard();
    await route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'player not found' }) });
  });
}

for (const status of ['old', 'failed'] as const) {
  test(`status read ${status === 'old' ? 'says "old"' : 'fails'}: Trades is still Offers, Build and Check`, async ({ page }) => {
    await oldSwitchesAndSeason(page, status);
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await expect(page.getByTestId('t2-nav')).toBeVisible();
    await expect(page.getByTestId('trade-row')).toHaveCount(0);
  });

  test(`status read ${status === 'old' ? 'says "old"' : 'fails'}: Players after the draft is the in-season screen`, async ({ page }) => {
    await oldSwitchesAndSeason(page, status);
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
    await expect(page.getByTestId('players-season')).toBeVisible();
    await expect(page.getByTestId('p2-sort-open')).toHaveText('Value');
    /* The draft-era list's rank header is not drawn. */
    await expect(page.getByTestId('players-rank-head')).not.toContainText('Sleeper’s draft order');
  });
}
