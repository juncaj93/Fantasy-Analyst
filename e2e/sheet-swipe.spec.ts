/**
 * Swipe-to-dismiss on a sheet, under a finger.
 *
 * Every sheet in the app is the one `Sheet` component, and every one of them
 * gets its gesture from `useSheetDrag` (`src/web/sheetDrag.ts`), so the player
 * card stands in for all of them here: it is the tall, scrolling one, which is
 * where the scroll-top rule matters. The WebKit projects run this at 360, 375,
 * 390 and 430.
 *
 * The drags are touch events with real time between them (see `touchDrag`),
 * because the sheet listens to touches and a mouse is not a finger.
 */

import { expect, test, type Page } from '@playwright/test';
import { centreOf, pastTheSettle, sheetBodyScroll, swipeSheetAway, tapAboveCard, touchDrag } from './helpers.ts';

async function openPlayerCard(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  const rows = page.getByTestId('player-search-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
  // Past the rise, so the card starts each drag at rest.
  await page.waitForTimeout(400);
}

/** The card's drawn offset from where it rests, in px. */
async function cardOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector('.sheet') as HTMLElement;
    return new DOMMatrix(getComputedStyle(card).transform).m42;
  });
}

async function scrimOpacity(page: Page): Promise<number> {
  return page.evaluate(() => Number(getComputedStyle(document.querySelector('.sheet-backdrop')!).opacity));
}

const sheet = (page: Page) => page.getByTestId('player-sheet');

test.describe('swiping a sheet down', () => {
  test('from the grip, closes it', async ({ page }) => {
    await openPlayerCard(page);
    const result = await swipeSheetAway(page, { over: '.sheet-grip' });
    expect(result.claimed, 'the sheet did not take the drag').toBe(true);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId('sheet-backdrop')).toHaveCount(0);
  });

  test('from the header, closes it', async ({ page }) => {
    await openPlayerCard(page);
    await swipeSheetAway(page, { over: '.sheet-title' });
    await expect(sheet(page)).toHaveCount(0);
  });

  test('from the body at its top, closes it', async ({ page }) => {
    await openPlayerCard(page);
    expect((await sheetBodyScroll(page)).top).toBe(0);
    await swipeSheetAway(page, { over: '.sheet-body' });
    await expect(sheet(page)).toHaveCount(0);
  });

  test('from the body while it is scrolled, leaves the card alone', async ({ page }) => {
    await openPlayerCard(page);
    // A card with more in it than fits, made rather than hoped for, then read into.
    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      const filler = document.createElement('div');
      filler.style.height = '1200px';
      body.append(filler);
      body.scrollTop = 40;
    });
    expect((await sheetBodyScroll(page)).top).toBe(40);
    const result = await touchDrag(page, await centreOf(page, '.sheet-body'), { dy: 320, ms: 180 });
    expect(result.claimed, 'the sheet took a drag that belonged to the scroll').toBe(false);
    expect(result.offsetBeforeLift).toBe(0);
    await pastTheSettle(page);
    await expect(sheet(page)).toBeVisible();
  });

  test('with a quick flick, closes it short of the line', async ({ page }) => {
    await openPlayerCard(page);
    // 60px in 60ms: 1px/ms, well short of the distance that closes on its own.
    await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 60, ms: 60, steps: 6 });
    await expect(sheet(page)).toHaveCount(0);
  });

  test('slowly, past the line, closes it', async ({ page }) => {
    await openPlayerCard(page);
    // 200px over a second, then held: no speed left at the lift, only distance.
    await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 200, ms: 1000, steps: 25, hold: 200 });
    await expect(sheet(page)).toHaveCount(0);
  });

  test('slowly, short of the line, springs back to where it rests', async ({ page }) => {
    await openPlayerCard(page);
    const result = await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 60, ms: 600, steps: 15, hold: 200 });
    expect(result.offsetBeforeLift, 'the card did not follow the finger').toBeCloseTo(60 - 4, -1);
    expect(result.scrimBeforeLift!, 'the dim did not lighten with the card').toBeLessThan(1);
    await pastTheSettle(page);
    await expect(sheet(page)).toBeVisible();
    expect(await cardOffset(page)).toBe(0);
    expect(await scrimOpacity(page)).toBe(1);
  });

  test('follows the finger without jumping when the drag begins', async ({ page }) => {
    await openPlayerCard(page);
    // Under the slop the card does not move at all…
    const small = await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 3, ms: 60, steps: 3, hold: 150 });
    expect(small.offsetBeforeLift).toBe(0);
    await pastTheSettle(page);
    // …and past it, it is counted from where the drag began, not from the touch.
    const moved = await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 40, ms: 400, steps: 40, hold: 150 });
    expect(moved.offsetBeforeLift!).toBeGreaterThanOrEqual(34);
    expect(moved.offsetBeforeLift!).toBeLessThanOrEqual(40);
  });

  test('upward, barely lifts it and never past a few pixels', async ({ page }) => {
    await openPlayerCard(page);
    const result = await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: -300, ms: 300, hold: 150 });
    expect(result.offsetBeforeLift!).toBeLessThan(0);
    expect(result.offsetBeforeLift!).toBeGreaterThan(-6.5);
    await pastTheSettle(page);
    await expect(sheet(page)).toBeVisible();
    expect(await cardOffset(page)).toBe(0);
  });

  test('sideways, is left to whatever scrolls sideways', async ({ page }) => {
    await openPlayerCard(page);
    const result = await touchDrag(page, await centreOf(page, '.sheet-body'), { dx: -200, dy: 30, ms: 200 });
    expect(result.claimed).toBe(false);
    await pastTheSettle(page);
    await expect(sheet(page)).toBeVisible();
  });

  test('leaves the page behind exactly where it was', async ({ page }) => {
    await openPlayerCard(page);
    const before = await page.evaluate(() => ({ y: window.scrollY, top: document.body.style.top }));
    await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 60, ms: 400, hold: 150 });
    await pastTheSettle(page);
    expect(await page.evaluate(() => ({ y: window.scrollY, top: document.body.style.top }))).toEqual(before);
    await swipeSheetAway(page);
    await expect(sheet(page)).toHaveCount(0);
  });

  test('with reduced motion asked for, still closes, without the animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPlayerCard(page);
    await touchDrag(page, await centreOf(page, '.sheet-grip'), { dy: 320, ms: 180 });
    // Closed on the lift, not after an exit.
    await expect(sheet(page)).toHaveCount(0, { timeout: 1_000 });
  });

  test('keeps Done, a tap above it and Escape as ways out', async ({ page }) => {
    await openPlayerCard(page);
    await page.getByTestId('sheet-close').click();
    await expect(sheet(page)).toHaveCount(0);

    await page.getByTestId('player-search-row').first().click();
    await expect(sheet(page)).toBeVisible();
    await tapAboveCard(page);
    await expect(sheet(page)).toHaveCount(0);

    await page.getByTestId('player-search-row').first().click();
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
  });
});
