/**
 * The stash and block lines (review round 8, W5), on a phone.
 *
 * The seeded league's own tiers, with the two lines injected the way
 * `waiver-tiers.spec.ts` injects its layout cases: the longest names and
 * reasons the engine can write, at each of the four widths the projects run
 * (360, 375, 390, 430). Each is its own short line, never a control, and the
 * bid is never clipped off the end.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason as rosterInSeason } from './helpers.ts';

async function inSeason(page: Page) {
  await rosterInSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false } }),
    });
  });
}

const STASH = {
  playerId: 'stash-1',
  name: 'Christopher Montgomery-Wellington III',
  position: 'RB',
  team: 'ATL',
  path: { kind: 'next_man_up', starterId: 'star', starterName: 'Christian McCaffrey', starterRate: 21.4 },
  reason: 'next up behind Christian McCaffrey, hurt',
  value: 21.4,
  bid: { kind: 'claim', low: 0, high: 1 },
  room: { kind: 'drop', playerId: 'aw', name: 'Antonio Williams' },
};

const BLOCK = {
  playerId: 'block-1',
  name: 'Marquez Valdes-Scantling',
  position: 'WR',
  team: 'NO',
  reason: 'opponent needs a WR',
  detail: 'his WR Puka Nacua is on bye',
  gain: 6.2,
  bid: { kind: 'claim', low: 1, high: 3 },
  room: { kind: 'open' },
};

async function serve(page: Page, extra: Record<string, unknown>) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...original, tiers: { ...original.tiers, ...extra } }) });
  });
}

async function openWaivers(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

test.describe('the stash and block lines', () => {
  test('say the pick, one reason and the bid, wrapped rather than clipped, with no sideways scroll', async ({ page }) => {
    await inSeason(page);
    await serve(page, { upsideStash: STASH, block: BLOCK });
    await openWaivers(page);

    await expect(page.getByTestId('tier-extra-title')).toHaveText('Stash and block');
    const stash = page.getByTestId('waiver-stash-line');
    const block = page.getByTestId('waiver-block-line');
    await expect(stash.locator('.player-name')).toHaveText(
      'Stash: Christopher Montgomery-Wellington III (next up behind Christian McCaffrey, hurt), bid $0 to $1',
    );
    await expect(stash.locator('.verdict-line')).toHaveText('Drop Antonio Williams (drop-ready)');
    await expect(block.locator('.player-name')).toHaveText('Block: Marquez Valdes-Scantling (opponent needs a WR), bid $1 to $3');
    await expect(block.locator('.verdict-line')).toHaveText('Open bench spot');

    for (const line of [stash, block]) {
      const name = line.locator('.player-name');
      /* Nothing clipped: the text fits its box, however many lines it takes. */
      const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped, 'the line is cut off').toBe(false);
      const box = (await line.boundingBox())!;
      expect(box.height, 'a line this tall is a paragraph').toBeLessThan(120);
    }

    /* A line, not a control: nothing to tap that adds, drops or bids. */
    await expect(page.getByTestId('tier-extra').getByRole('button')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    await expect(page.getByTestId('tier-extra')).not.toContainText('—');
  });

  test('sits under Worth considering and above the Watch list', async ({ page }) => {
    await inSeason(page);
    await serve(page, { upsideStash: STASH, block: BLOCK });
    await openWaivers(page);
    const extra = (await page.getByTestId('tier-extra-title').boundingBox())!.y;
    const consider = page.getByTestId('tier-consider-title');
    if ((await consider.count()) > 0) expect(extra).toBeGreaterThan((await consider.boundingBox())!.y);
    const watch = page.getByTestId('tier-watch-title');
    if ((await watch.count()) > 0) expect(extra).toBeLessThan((await watch.boundingBox())!.y);
  });

  test('draws nothing when there is no stash and no block', async ({ page }) => {
    await inSeason(page);
    await serve(page, { upsideStash: null, block: null });
    await openWaivers(page);
    await expect(page.getByTestId('tier-extra-title')).toHaveCount(0);
    await expect(page.getByTestId('waiver-block-line')).toHaveCount(0);
  });

  test('draws a block alone, free agent wording', async ({ page }) => {
    await inSeason(page);
    await serve(page, { upsideStash: null, block: { ...BLOCK, bid: { kind: 'free' } } });
    await openWaivers(page);
    await expect(page.getByTestId('waiver-block-line').locator('.player-name')).toHaveText(
      'Block: Marquez Valdes-Scantling (opponent needs a WR), free agent, no bid',
    );
    await expect(page.getByTestId('waiver-stash-line')).toHaveCount(0);
  });
});
