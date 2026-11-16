/**
 * Round 33: compare a free agent in three taps, and the "Check status" chip.
 *
 * Part B. From the in-season Players tab: Players, his row, Compare (3 taps),
 * and Compare is open with him and the roster player he would most likely
 * replace already in, a one-tap swap beside them. From Waivers: Waivers, his
 * card, Compare (3 taps). The free agent is a real one from the seeded
 * league, so the comparison is the server's own.
 *
 * Part A. A Compare card whose player had every prop pulled inside 3 hours of
 * kickoff carries a quiet "Check status" chip, 44px tall; a tap says when.
 * The server's answer is used as is, with the pulled time and a kickoff an
 * hour away written onto the free agent's card.
 */

import { expect, test, type Page } from '@playwright/test';
import { previewSeasonBoard, previewSeasonCard } from '../src/core/players/seasonPreview.ts';
import { inSeason as rosterInSeason } from './helpers.ts';

interface PoolRow {
  id: string;
  name: string;
  position: string;
  team: string;
}

async function regularSeason(page: Page) {
  await rosterInSeason(page);
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, features: { ...(body.features ?? {}), playersInSeason: true } }) });
  });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 10)', assumed: false } }),
    });
  });
}

/** A free agent the seeded league really has, at a position Alex also has players at. */
async function realFreeAgent(page: Page): Promise<{ leagueId: string; fa: PoolRow }> {
  const leagues = (await (await page.request.get('/api/leagues')).json()) as { leagues?: { id: string; isSelected: boolean }[] } | { id: string; isSelected: boolean }[];
  const list = Array.isArray(leagues) ? leagues : (leagues.leagues ?? []);
  const leagueId = (list.find((l) => l.isSelected) ?? list[0])!.id;
  for (const position of ['WR', 'RB', 'TE', 'QB', 'DEF']) {
    const mine = await (await page.request.get(`/api/leagues/${leagueId}/compare-pool?tab=mine&position=${position}&q=`)).json();
    if (!mine.rows?.some((r: { ruledOut: boolean }) => !r.ruledOut)) continue;
    const wire = await (await page.request.get(`/api/leagues/${leagueId}/compare-pool?tab=waivers&position=${position}&q=`)).json();
    const fa = wire.rows?.find((r: PoolRow & { owner: string }) => r.owner === 'available');
    if (fa) return { leagueId, fa };
  }
  throw new Error('the seeded league has no free agent at a position Alex plays');
}

/** The Players board, with its first free agent replaced by the real one. */
async function serveBoard(page: Page, fa: PoolRow) {
  const board = previewSeasonBoard();
  const at = board.rows.findIndex((r) => r.ownerRosterId == null);
  const original = board.rows[at]!;
  board.rows[at] = { ...original, id: fa.id, name: fa.name, position: fa.position, team: fa.team, value: 99, overFreeAgent: 99 };
  await page.route(/\/api\/players\/(season|[^/]+\/season)(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const card = /^\/api\/players\/([^/]+)\/season$/.exec(url.pathname);
    const body = card ? (previewSeasonCard(decodeURIComponent(card[1]!)) ?? previewSeasonCard(original.id)) : board;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const PULLED = new Date(Date.now() - 20 * 60_000).toISOString();

/** The server's comparison, with the free agent's props pulled and his kickoff an hour away. */
async function pulledOn(page: Page, id: string) {
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const e of body.evaluations ?? []) {
      if (e.playerId !== id) continue;
      e.ruledOut = false;
      e.lock = { ...(e.lock ?? {}), locked: false, kickoff: new Date(Date.now() + 60 * 60_000).toISOString() };
      e.checkStatus = { pulledAt: PULLED };
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

async function tall(page: Page, testId: string) {
  for (const h of await page.getByTestId(testId).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
    expect(h).toBeGreaterThanOrEqual(43.5);
  }
}

test.describe('compare a free agent in three taps', () => {
  test('from Players: his card, Compare, and his likeliest roster partner is already in', async ({ page }) => {
    await regularSeason(page);
    await page.goto('/');
    const { fa } = await realFreeAgent(page);
    await serveBoard(page, fa);
    await pulledOn(page, fa.id);
    await page.reload();

    let taps = 0;
    await page.getByTestId('tab-players').click();
    taps += 1;
    await page.getByTestId('players-list').getByTestId('player-search-row').filter({ hasText: fa.name.split(' ').pop()! }).first().click();
    taps += 1;
    await page.getByTestId('p2-compare').click();
    taps += 1;
    expect(taps).toBeLessThanOrEqual(3);

    const sheet = page.getByTestId('compare-sheet');
    await expect(sheet.getByTestId('compare-chosen')).toHaveCount(2);
    await expect(sheet.locator(`[data-testid="compare-chosen"][data-player-id="${fa.id}"]`)).toHaveCount(1);
    await expect(sheet.getByTestId('comparison')).toBeVisible();
    await expect(sheet.getByTestId('compare-column')).toHaveCount(2);

    /* Part A on the same card: quiet chip, a tap says when. */
    const chip = sheet.locator(`[data-testid="compare-column"][data-player-id="${fa.id}"]`).getByTestId('check-status');
    await expect(chip).toHaveText('Check status');
    await tall(page, 'check-status');
    await chip.click();
    await expect(chip).toHaveText(/^Props pulled at \d{1,2}:\d{2} (AM|PM)$/);

    /* One tap changes the roster player, when he has another at the position. */
    const swaps = sheet.getByTestId('compare-swap');
    if ((await swaps.count()) > 0) {
      await tall(page, 'compare-swap');
      const other = (await swaps.first().getAttribute('data-player-id'))!;
      await swaps.first().click();
      await expect(sheet.getByTestId('compare-chosen')).toHaveCount(2);
      await expect(sheet.locator(`[data-testid="compare-chosen"][data-player-id="${other}"]`)).toHaveCount(1);
      await expect(sheet.locator(`[data-testid="compare-chosen"][data-player-id="${fa.id}"]`)).toHaveCount(1);
    }
    await noSidewaysScroll(page);
  });

  test('from Waivers: his card, Compare, and Compare opens with both in', async ({ page }) => {
    await regularSeason(page);
    await page.goto('/');
    let taps = 0;
    await page.getByTestId('tab-waivers').click();
    taps += 1;
    await expect(page.getByTestId('waivers-nav')).toBeVisible();
    const row = page.getByTestId('waiver-tier-row').or(page.getByTestId('waiver-row')).first();
    await row.click();
    taps += 1;
    const detail = page.getByTestId('tier-detail');
    const id = (await detail.getByTestId('tier-detail-body').getAttribute('data-player-id'))!;
    const partner = await detail.getByTestId('tier-detail-body').getAttribute('data-partner-id');
    await tall(page, 'wsheet-compare-open');
    await detail.getByTestId('wsheet-compare-open').click();
    taps += 1;
    expect(taps).toBeLessThanOrEqual(3);

    const sheet = page.getByTestId('compare-sheet');
    await expect(sheet.locator(`[data-testid="compare-chosen"][data-player-id="${id}"]`)).toHaveCount(1);
    if (partner) {
      await expect(sheet.getByTestId('compare-chosen')).toHaveCount(2);
      await expect(sheet.locator(`[data-testid="compare-chosen"][data-player-id="${partner}"]`)).toHaveCount(1);
      await expect(sheet.getByTestId('comparison')).toBeVisible();
    } else {
      /* An open spot and nobody at his position: My team's list opens, one tap from a pick. */
      await expect(sheet.getByTestId('compare-add')).toHaveAttribute('aria-expanded', 'true');
    }
    await noSidewaysScroll(page);
  });
});
