/**
 * Round 36, Alex's preview review: choosing players to compare, from Matchup.
 *
 *  1. Selecting a player never moves or shifts the list. A pick is a check on
 *     the row; nothing above the list appears or grows.
 *  2. The second pick does not open the comparison by itself. A bar fixed at
 *     the bottom holds Compare: grey until two are picked, then green, and
 *     the answer shows only when it is tapped (pick, pick, Compare).
 *  3. The X cancels and clears the picks.
 *
 * The switch is turned on by answering the status read with `uiRevamp: true`.
 * Both of the first two tests fail on the code before this change: the strip
 * of chosen names appeared above the list on the first pick (moving every
 * row down) and the second pick opened the comparison with no tap.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function season(page: Page) {
  await inSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 12)', assumed: false },
        lifecycle: { ...(body.lifecycle ?? {}), draftVisible: false, matchupVisible: true },
      },
    });
  });
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, features: { ...(body.features ?? {}), uiRevamp: true } } });
  });
}

/** Opens Compare from Matchup's bar and waits for the list to settle. */
async function openFromMatchup(page: Page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'revamp');
  await page.getByTestId('tab-matchup').click();
  await page.getByTestId('matchup-compare-open').click();
  await expect(page.getByTestId('compare-candidate').nth(2)).toBeVisible();
  /* The sheet slides up; measure only once it has stopped. */
  await settledY(page);
}

async function settledY(page: Page): Promise<number | undefined> {
  let last: number | undefined;
  for (let i = 0; i < 20; i += 1) {
    const y = (await page.getByTestId('compare-candidate').first().boundingBox())?.y;
    if (y !== undefined && y === last) return y;
    last = y;
    await page.waitForTimeout(100);
  }
  return last;
}

/** Where the first five rows are on the glass. */
async function rowTops(page: Page): Promise<number[]> {
  return page
    .getByTestId('compare-candidate')
    .evaluateAll((els) => els.slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10));
}

test.describe('choosing players to compare', () => {
  test.beforeEach(async ({ page }) => season(page));

  test('selecting a player does not move the list; the pick is a check on the row', async ({ page }) => {
    await openFromMatchup(page);
    const before = await rowTops(page);
    const first = page.getByTestId('compare-candidate').nth(0);
    await first.click();
    await expect(first).toHaveAttribute('data-chosen', 'true');
    await expect(first.locator('.cmp2-row-check svg')).toBeVisible();
    await page.waitForTimeout(400);
    expect(await rowTops(page)).toEqual(before);
    await page.getByTestId('compare-candidate').nth(1).click();
    await page.waitForTimeout(400);
    expect(await rowTops(page)).toEqual(before);
    /* Nothing grew above the list. */
    await expect(page.getByTestId('compare-strip')).toBeHidden();
  });

  test('the second pick does not open Compare; the bottom Compare button does', async ({ page }) => {
    await openFromMatchup(page);
    const go = page.getByTestId('compare-go');
    await expect(go).toBeVisible();
    await expect(go).toBeDisabled();
    await expect(go).toHaveAttribute('data-ready', 'no');
    const grey = await go.evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.getByTestId('compare-candidate').nth(0).click();
    await expect(go).toBeDisabled();
    await page.getByTestId('compare-candidate').nth(1).click();
    await expect(go).toBeEnabled();
    await expect(go).toHaveAttribute('data-ready', 'yes');
    expect(await go.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(grey);

    /* No answer without the tap, even after the verdict has had time to arrive. */
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('comparison')).toHaveCount(0);
    await expect(page.getByTestId('compare-picker')).toBeVisible();

    /* The bar stays at the bottom of the sheet, a full tap target, and nothing scrolls sideways. */
    const [bar, sheet] = [await page.getByTestId('compare-foot').boundingBox(), await page.getByTestId('compare-sheet').boundingBox()];
    expect(Math.abs(bar!.y + bar!.height - (sheet!.y + sheet!.height))).toBeLessThan(40);
    expect((await go.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await go.click();
    await expect(page.getByTestId('comparison')).toBeVisible();
    await expect(page.getByTestId('compare-foot')).toHaveCount(0);
  });

  test('the X cancels and clears the picks', async ({ page }) => {
    await openFromMatchup(page);
    await page.getByTestId('compare-candidate').nth(0).click();
    await page.getByTestId('compare-candidate').nth(1).click();
    await page.getByTestId('compare-sheet').getByTestId('sheet-close').click();
    await expect(page.getByTestId('compare-sheet')).toHaveCount(0);
    await page.getByTestId('matchup-compare-open').click();
    await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
    await expect(page.locator('[data-testid="compare-candidate"][data-chosen="true"]')).toHaveCount(0);
    await expect(page.getByTestId('compare-go')).toBeDisabled();
  });
});
