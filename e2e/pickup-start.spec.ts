/**
 * Best move: "Pick up and start" (18 October 2026), at every width the suite
 * runs (360, 375, 390, 430).
 *
 *  - the headline and its numbers line each stay on one line, chips included,
 *    with nothing clipped and no sideways scroll;
 *  - no "Sleeper" word next to a number;
 *  - tapping opens Compare on the two players, with the drop said in the sheet;
 *  - a free agent who only ties is one line in the sheet, never the headline.
 *
 * The demo week has no pickup, so the call is written into the Waivers answer,
 * with one of the demo wire's own free agents and Alex's real names in the
 * sentence (the longest pair this round has seen).
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/* A swap for the card to replace, in the demo roster's own players. */
const SWAP = { slot: 'WR', inPlayerId: '1004', inName: 'Andre Sotelo', outPlayerId: '1001', outName: 'Marcus Vance', gain: 1.25, reason: 'test' };

async function freeAgent(page: Page): Promise<{ id: string; name: string }> {
  const leagues = await (await page.request.get('/api/leagues')).json();
  const league = leagues.leagues.find((l: { isSelected: boolean }) => l.isSelected) ?? leagues.leagues[0];
  const pool = await (await page.request.get(`/api/leagues/${league.id}/compare-pool?tab=waivers&position=ALL&q=`)).json();
  const row = pool.rows.find((r: { owner: string }) => r.owner === 'available') ?? pool.rows[0];
  return { id: row.id, name: row.name };
}

function move(fa: { id: string }, verdict: 'start' | 'consider', over: Partial<Record<string, unknown>> = {}) {
  return {
    verdict,
    playerId: fa.id,
    name: 'Jaleel McLaughlin',
    position: 'RB',
    team: 'CLE',
    points: 7.6,
    gain: verdict === 'start' ? 0.9 : 0,
    margin: verdict === 'start' ? 0.9 : 0,
    slot: 'FLEX',
    over: { playerId: '1001', name: 'Emeka Egbuka', points: 6.7 },
    displaces: { playerId: '1001', name: 'Emeka Egbuka', points: 6.7 },
    drop: null,
    pickDrop: null,
    starterOut: null,
    ...over,
  };
}

async function withPickup(page: Page, plan: (fa: { id: string; name: string }) => Record<string, unknown>) {
  await inSeason(page);
  await page.goto('/');
  const fa = await freeAgent(page);
  await page.route('**/api/leagues/*/lineup', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, swaps: [SWAP], fills: [] }) });
  });
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, found: true, pickupStart: { threshold: 0.5, tieTolerance: 0.05, bestOwned: 140, bestOwnedSlots: [], notNow: [], audit: [], start: null, consider: [], ...plan(fa) } }),
    });
  });
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  return fa;
}

/** One line: the element is no taller than one line of its own text, and nothing inside it is cut off. */
async function oneLine(page: Page, testId: string) {
  const box = await page.getByTestId(testId).evaluate((el) => {
    const s = getComputedStyle(el);
    const line = Number.parseFloat(s.lineHeight) || Number.parseFloat(s.fontSize) * 1.3;
    return { height: el.getBoundingClientRect().height, line, scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(box.height, `${testId} height ${box.height} for a line of ${box.line}`).toBeLessThanOrEqual(box.line * 1.5);
  expect(box.scroll, `${testId} clipped`).toBeLessThanOrEqual(box.client + 1);
}

test('Pick up and start: one line, chips on the numbers line, no Sleeper word, drop in the sheet', async ({ page }) => {
  const fa = await withPickup(page, (f) => ({
    start: move(f, 'start', { drop: { playerId: '1004', name: "Tre' Harris" }, starterOut: { playerId: 'x', name: 'Quinshon Judkins' } }),
  }));
  const row = page.getByTestId('lineup-pickup');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('lineup-swap')).toHaveCount(0);
  await expect(row.getByTestId('best-move-pickup-names')).toHaveText(/^Pick up and start (Jaleel |J\. )?McLaughlin over (Emeka |E\. )?Egbuka$/);
  await expect(row.getByTestId('best-move-points')).toContainText('7.6 vs');
  await expect(row.getByTestId('best-move-starter-out')).toHaveText('Starter out');
  await expect(row.getByTestId('best-move-drop')).toHaveText('drop Harris');

  await oneLine(page, 'best-move-pickup-names');
  await oneLine(page, 'best-move-points');
  /* The chips sit inside the card, not past its edge. */
  const card = (await row.boundingBox())!;
  for (const id of ['best-move-starter-out', 'best-move-drop']) {
    const chip = (await row.getByTestId(id).boundingBox())!;
    expect(chip.x + chip.width, `${id} inside the card`).toBeLessThanOrEqual(card.x + card.width);
  }
  const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(page_.scroll).toBeLessThanOrEqual(page_.client);
  /* The word "Sleeper" never sits next to a number on the card. */
  expect(await page.getByTestId('lineup-card').innerText()).not.toMatch(/Sleeper/i);

  await row.click();
  await expect(page.getByTestId('compare-sheet')).toBeVisible();
  const notes = page.getByTestId('compare-best-move-note');
  await expect(notes.nth(0)).toContainText('free agent: add him in Sleeper');
  await expect(notes.nth(1)).toHaveText("Your roster is full: drop Tre' Harris to add him.");
  const ids = await page.getByTestId('compare-chosen').evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id')));
  expect(new Set(ids)).toEqual(new Set(['1001', fa.id]));
});

test('a free agent who only ties is a line in the sheet, never the headline', async ({ page }) => {
  await withPickup(page, (f) => ({ consider: [move(f, 'consider')] }));
  await expect(page.getByTestId('lineup-pickup')).toHaveCount(0);
  const swap = page.getByTestId('lineup-swap');
  await expect(swap).toBeVisible();
  await swap.click();
  await expect(page.getByTestId('compare-best-move-note')).toHaveText('Tie on waivers: Jaleel McLaughlin, 7.6, free agent');
});

test('with no call, Best move is exactly as before', async ({ page }) => {
  await withPickup(page, () => ({}));
  await expect(page.getByTestId('lineup-pickup')).toHaveCount(0);
  await page.getByTestId('lineup-swap').click();
  await expect(page.getByTestId('compare-sheet')).toBeVisible();
  await expect(page.getByTestId('compare-best-move-note')).toHaveCount(0);
});

test('a full roster with no honest drop: "Pick your drop" on one line, the options in the sheet', async ({ page }) => {
  await withPickup(page, (f) => ({
    start: move(f, 'start', {
      starterOut: { playerId: 'x', name: 'Quinshon Judkins' },
      pickDrop: [
        { playerId: '1004', name: 'Brian Robinson', reason: 'no start in weeks 6 to 8' },
        { playerId: '1005', name: 'Emmett Johnson', reason: null },
      ],
    }),
  }));
  const row = page.getByTestId('lineup-pickup');
  await expect(row.getByTestId('best-move-drop')).toHaveText('Pick your drop');
  await oneLine(page, 'best-move-pickup-names');
  await oneLine(page, 'best-move-points');
  const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(page_.scroll).toBeLessThanOrEqual(page_.client);
  await row.click();
  const notes = page.getByTestId('compare-best-move-note');
  await expect(notes.nth(1)).toHaveText('Your roster is full: pick your drop.');
  await expect(notes.nth(2)).toHaveText('1. Brian Robinson: no start in weeks 6 to 8');
  await expect(notes.nth(3)).toHaveText('2. Emmett Johnson');
});
