/**
 * Round 26: the look-ahead lines on a phone (`WAIVERS_LOOKAHEAD`).
 *
 * The seeded league's own tiers, with the stash (an inherited role), a cover
 * and a named block injected the way `waiver-stash-block.spec.ts` injects its
 * lines, at each of the four widths the projects run (360, 375, 390, 430).
 * Each is its own short line, never a control, nothing clipped, no sideways
 * scroll, in light and dark.
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
  playerId: 'opp-1',
  name: 'Christopher Montgomery-Wellington III',
  position: 'WR',
  team: 'CIN',
  path: { kind: 'opportunity', starterId: 'chase', starterName: "Ja'Marr Chase", cause: 'season', estimate: 15.2, basis: 'inferred' },
  reason: 'Chase out for the season, gets his targets',
  value: 15.2,
  bid: { kind: 'claim', low: 6, high: 6 },
  room: { kind: 'drop', playerId: 'aw', name: 'Antonio Williams' },
};

const COVER = {
  playerId: 'cover-1',
  name: 'Marquez Valdes-Scantling',
  position: 'TE',
  team: 'NO',
  week: 12,
  reason: 'covers your Week 12 bye at TE',
  gain: 6.2,
  bid: { kind: 'claim', low: 2, high: 2 },
  room: { kind: 'open' },
};

const BLOCK = {
  playerId: 'block-1',
  name: 'Jaxon Smith-Njigba',
  position: 'RB',
  team: 'SEA',
  reason: 'Matty has no RB this week',
  detail: 'his RB Hollis Marchetti is on IR',
  gain: 7.1,
  bid: { kind: 'claim', low: 3, high: 3 },
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

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`the look-ahead lines, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('say the pick, one reason and the bid, three lines, nothing clipped, no sideways scroll', async ({ page }) => {
      await inSeason(page);
      await serve(page, { upsideStash: STASH, cover: [COVER], block: BLOCK });
      await openWaivers(page);

      await expect(page.getByTestId('tier-extra-title')).toHaveText('Cover, stash and block');
      const stash = page.getByTestId('waiver-stash-line');
      const cover = page.getByTestId('waiver-cover-line');
      const block = page.getByTestId('waiver-block-line');
      await expect(stash.locator('.player-name')).toHaveText(
        'Stash: Christopher Montgomery-Wellington III (Chase out for the season, gets his targets), bid $6',
      );
      await expect(cover.locator('.player-name')).toHaveText('Add: Marquez Valdes-Scantling (covers your Week 12 bye at TE), bid $2');
      await expect(block.locator('.player-name')).toHaveText('Block: Jaxon Smith-Njigba (Matty has no RB this week), bid $3');
      await expect(page.getByTestId('tier-extra').locator('.player-row')).toHaveCount(3);

      for (const line of [stash, cover, block]) {
        const name = line.locator('.player-name');
        const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(clipped, 'the line is cut off').toBe(false);
        const box = (await line.boundingBox())!;
        expect(box.height, 'a line this tall is a paragraph').toBeLessThan(120);
        /* The text reads against its background (WCAG AA for body text). */
        const contrast = await name.evaluate((el) => {
          const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const lum = ([r, g, b]: number[]) =>
            [r!, g!, b!].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
          let bg: HTMLElement | null = el as HTMLElement;
          let color = 'rgba(0, 0, 0, 0)';
          while (bg && /rgba\(0, 0, 0, 0\)|transparent/.test((color = getComputedStyle(bg).backgroundColor))) bg = bg.parentElement;
          const a = lum(rgb(getComputedStyle(el).color));
          const b = lum(rgb(color === 'rgba(0, 0, 0, 0)' ? 'rgb(255,255,255)' : color));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        expect(contrast, 'low contrast').toBeGreaterThanOrEqual(4.5);
      }

      /* Lines, not controls: nothing to tap that adds, drops or bids. */
      await expect(page.getByTestId('tier-extra').getByRole('button')).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      await expect(page.getByTestId('tier-extra')).not.toContainText('—');
      await expect(page.getByTestId('tier-extra')).not.toContainText('Sleeper');
    });
  });
}
