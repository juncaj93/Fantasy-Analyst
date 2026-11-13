/**
 * The in-season Players tab (Round 24) on a phone, at every supported width.
 *
 * The switch is turned on by answering `/api/auth/status` with
 * `playersInSeason: true`, the draft is over by answering `/api/overview`
 * with a regular-season phase, and the tab's two routes are answered by the
 * preview's own functions on the made-up league: the same answers the preview
 * upload gives. What is checked:
 *
 *  - switch off: today's screen, and the new route is never asked;
 *  - switch on while a draft is ahead: today's draft screen, untouched;
 *  - switch on after the draft: sorted by rest-of-season value, with draft
 *    order one tap away and the pick, 7d and 30d kept on every row;
 *  - Trade targets: other teams' players only, each with Likely, Maybe or
 *    Unlikely; Injured: each with the week he is back;
 *  - the card: this week, the next four weeks with the bye marked, the last
 *    five games, and the direct comparison on a trade target;
 *  - every control at least 44px, nothing scrolls sideways, no info buttons.
 */

import { expect, test, type Page } from '@playwright/test';
import { previewSeasonBoard, previewSeasonCard } from '../src/core/players/seasonPreview.ts';

async function setup(page: Page, opts: { on: boolean; draftAhead: boolean }) {
  const asked: string[] = [];
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, features: { ...(body.features ?? {}), playersInSeason: opts.on } }) });
  });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const season = opts.draftAhead
      ? { phase: 'preseason', draftVisible: true, reason: 'your draft has not finished yet', assumed: false }
      : { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 10)', assumed: false };
    await route.fulfill({ response, body: JSON.stringify({ ...body, season }) });
  });
  await page.route(/\/api\/players\/(season|[^/]+\/season)(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    const card = /^\/api\/players\/([^/]+)\/season$/.exec(url.pathname);
    const body = card ? previewSeasonCard(decodeURIComponent(card[1]!)) : previewSeasonBoard();
    await route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'player not found' }) });
  });
  return asked;
}

async function openPlayers(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  await expect(page.getByTestId('players-list')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function expectTapTargets(page: Page, selector: string) {
  const heights = await page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(43.5);
}

const names = (page: Page) => page.getByTestId('player-search-row').locator('.player-name').allInnerTexts();

test.describe('the in-season Players tab', () => {
  test('switch off: today’s screen, and the new route is never asked', async ({ page }) => {
    const asked = await setup(page, { on: false, draftAhead: false });
    await openPlayers(page);
    await expect(page.getByTestId('players-season')).toHaveCount(0);
    await expect(page.getByTestId('p2-controls')).toHaveCount(0);
    await expect(page.getByTestId('players-rank-head')).toContainText('Sleeper’s draft order, moved by your research');
    await expect(page.getByTestId('players-pick').first()).toBeVisible();
    expect(asked).toEqual([]);
  });

  test('switch on while a draft is ahead: the draft screen, untouched', async ({ page }) => {
    const asked = await setup(page, { on: true, draftAhead: true });
    await openPlayers(page);
    await expect(page.getByTestId('players-season')).toHaveCount(0);
    await expect(page.getByTestId('players-adp').first()).toBeVisible();
    expect(asked).toEqual([]);
  });

  test('sorted by rest-of-season value, with draft order, the pick, 7d and 30d kept', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await expect(page.getByTestId('players-season')).toBeVisible();
    await expect(page.getByTestId('p2-sort-open')).toHaveText('Value');
    const values = (await page.getByTestId('p2-value').allInnerTexts()).map((t) => Number(t.replace(/^Value/, '').trim()));
    expect(values.length).toBeGreaterThan(10);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    const first = page.getByTestId('player-search-row').first();
    await expect(first).toContainText('7d');
    await expect(first).toContainText('30d');
    await expect(first.getByTestId('players-pick')).toContainText(/\d+\.\d{2}/);

    await page.getByTestId('p2-sort-open').click();
    await page.getByTestId('p2-sort-draft').click();
    await expect(page.getByTestId('p2-sort-open')).toHaveText('Draft order');
    const board = previewSeasonBoard();
    const byDraft = [...board.rows].sort((a, b) => (a.adjustedRank ?? 1e9) - (b.adjustedRank ?? 1e9)).map((r) => r.name);
    expect((await names(page)).slice(0, 5)).toEqual(byDraft.slice(0, 5));
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('Trade targets: other teams only, each with how likely the owner is to deal', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await page.getByTestId('p2-view-trade').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBe(previewSeasonBoard().rows.filter((r) => r.trade).length);
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      words.push(await rows.nth(i).getByTestId('p2-willing').innerText());
      await expect(rows.nth(i).getByTestId('owner-pill')).not.toHaveText('You');
    }
    /* Likely first, then Maybe, then Unlikely. */
    const order = { Likely: 0, Maybe: 1, Unlikely: 2 } as Record<string, number>;
    expect(words.every((w) => w in order)).toBe(true);
    expect(words.map((w) => order[w])).toEqual([...words.map((w) => order[w])].sort((a, b) => a! - b!));
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('Injured: out now, each with the week he is back', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await page.getByTestId('p2-view-injured').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(rows.nth(i).getByTestId('p2-back')).toHaveText(/^(Back Wk \d+|Out)$/);
    expect((await names(page)).sort()).toEqual(['Hollis Marchetti', 'Teo Ferreira', 'Tobin Achebe']);
  });

  test('the card: this week, the next four with the bye marked, the last five games', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await page.getByTestId('player-search').fill('Mbeki');
    await page.getByTestId('player-search-row').first().locator('.dense-row-open').click();
    const card = page.getByTestId('p2-card');
    await expect(card.getByTestId('p2-this-week')).toContainText(/\d+\.\d/);
    await expect(card.getByTestId('p2-next-cell')).toHaveCount(4);
    await expect(card.locator('[data-testid="p2-next-cell"][data-bye="yes"]')).toHaveText(/Wk 12\s*BYE/);
    await expect(card.getByTestId('p2-last').locator('li')).toHaveCount(5);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('a trade target’s card shows the pick, one reason and the direct comparison', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await page.getByTestId('p2-view-trade').click();
    await page.getByTestId('player-search-row').first().locator('.dense-row-open').click();
    const card = page.getByTestId('p2-card');
    await expect(card.getByTestId('p2-card-willing')).toHaveText(/^(Likely|Maybe|Unlikely)$/);
    await expect(card.getByTestId('p2-reason')).toContainText(/^Starts at \w+, .+ to the bench, \+\d+\.\d a week$/);
    await expect(card.getByTestId('p2-versus')).toBeVisible();
  });

  test('a mistyped surname still finds the player, through the server search', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    const rows = page.getByTestId('player-search-row');
    const before = await rows.count();
    /* A dropped letter after the opening three, as the live smoke test types it. */
    await page.getByTestId('player-search').fill('Mbei');
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(before);
    await expect(rows.first().locator('.player-name')).toHaveText('Silas Mbeki');
    await page.getByTestId('player-search').fill('zzzqqqxxx');
    await expect(page.getByText(/Nobody matching/i)).toBeVisible();
  });

  test('every control is a thumb, nothing scrolls sideways, and there is no info button', async ({ page }) => {
    await setup(page, { on: true, draftAhead: false });
    await openPlayers(page);
    await expectTapTargets(page, '[data-testid="p2-views"] button, [data-testid="p2-sort-open"], [data-testid="players-controls"] button, [data-testid="player-search-row"] .dense-row-open');
    await expect(page.locator('.info-line-button, [aria-label*="More about" i]')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
