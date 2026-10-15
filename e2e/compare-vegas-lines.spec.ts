/**
 * Compare round of 15 October 2026, at every phone width the suite runs
 * (360, 375, 390, 430):
 *
 *  - the Vegas lines sit under Base (Yards, Catches, TD %), and there is no
 *    Uncertainty row and no paragraph;
 *  - two players and four players each fit one screen, nothing scrolls
 *    sideways, and no text is cut off;
 *  - a number on Sleeper's week is grey with a `Sleeper` label under it, on
 *    the card and in the table, while a posted line keeps its normal colour.
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function openCompare(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
}

async function compareFirst(page: Page, count: number, position?: string) {
  await page.getByTestId('compare-tab-all').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
  if (position) {
    await page.getByRole('group', { name: 'Filter by position' }).getByRole('button', { name: position, exact: true }).click();
    await page.waitForTimeout(300);
  }
  const ids = await page
    .getByTestId('compare-candidate')
    .evaluateAll((els, n) => els.slice(0, n).map((e) => e.getAttribute('data-player-id')!), count);
  for (const id of ids) {
    const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${id}"]`);
    await row.click();
    await expect(row).toHaveAttribute('data-chosen', 'true');
  }
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await page.waitForTimeout(400);
}

/** Every element in the verdict and the table whose own text is wider than its box. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const roots = [document.querySelector('[data-testid="comparison"]'), document.querySelector('[data-testid="compare-grid"]')];
    const bad: string[] = [];
    for (const root of roots) {
      if (!root) continue;
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!ownText || getComputedStyle(el).display === 'inline' || el.classList.contains('sr-only')) continue;
        if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className || el.tagName}: "${el.textContent?.trim()}"`);
      }
    }
    return bad;
  });
}

for (const count of [2, 4] as const) {
  test(`Compare with ${count} players fits one screen, with no sideways scroll and nothing cut off`, async ({ page }) => {
    await openCompare(page);
    await compareFirst(page, count);

    const viewport = page.viewportSize()!;
    const total = (await page.getByTestId('compare-total').boundingBox())!;
    expect(total.y + total.height, 'the Score row is on screen without scrolling').toBeLessThanOrEqual(viewport.height);

    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(pageOverflow, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
    const tableOverflow = await page.getByTestId('compare-table-scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(tableOverflow, 'the table does not scroll sideways').toBeLessThanOrEqual(0);
    const cardsOverflow = await page.locator('.cmp2-cols').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(cardsOverflow, 'the cards do not scroll sideways').toBeLessThanOrEqual(0);

    // Every column sits inside the table: the numbers line up under each name.
    const table = (await page.getByTestId('compare-table-scroll').boundingBox())!;
    for (const cell of await page.locator('[data-testid="compare-total"] [role="cell"]').all()) {
      const box = (await cell.boundingBox())!;
      expect(box.x + box.width, 'a Score cell inside the table').toBeLessThanOrEqual(table.x + table.width + 0.5);
    }

    expect(await clipped(page), 'no text cut off').toEqual([]);
  });
}

test('the Vegas lines sit under Base, and Uncertainty is gone', async ({ page }) => {
  await openCompare(page);
  await compareFirst(page, 2, 'WR');
  const grid = page.getByTestId('compare-grid');
  const labels = await grid.locator('.cmp2-factor-label').allInnerTexts();
  expect(labels.slice(0, 4)).toEqual(['Base', 'Yards', 'Catches', 'TD %']);
  await expect(grid).not.toContainText('Uncertainty');
  await expect(page.getByTestId('compare-factor-detail')).toHaveCount(0);
  await expect(page.getByTestId('compare-sheet')).not.toContainText('lower confidence');
});

test('two quarterbacks get Pass yds, Pass TD and Rush yds', async ({ page }) => {
  await openCompare(page);
  await compareFirst(page, 2, 'QB');
  const labels = await page.getByTestId('compare-grid').locator('.cmp2-factor-label').allInnerTexts();
  expect(labels.slice(0, 4)).toEqual(['Base', 'Pass yds', 'Pass TD', 'Rush yds']);
});

test('a number on Sleeper’s week is grey with a Sleeper label, and a posted line is not', async ({ page }) => {
  /*
   * The demo week prices everybody it lists, so the first player's number is
   * turned into Sleeper's week on the way in: the rule under test is how the
   * screen draws a `published` basis, not how the server picks one.
   */
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const first = body.evaluations?.[0];
    if (first?.decision) {
      first.decision = { ...first.decision, basis: 'published' };
      first.expectation = {
        ...first.expectation,
        contributions: (first.expectation.contributions ?? []).filter((c: { market: string }) => c.market === 'anytime_td' || c.market === 'pass_yards'),
        missingMarkets: ['receiving_yards', 'receptions', 'rush_yards'],
      };
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await openCompare(page);
  await compareFirst(page, 2);

  const grey = page.locator('[data-testid="compare-column"] .cmp2-col-score.num-sleeper');
  await expect(grey).toHaveCount(1);
  const column = page.locator('[data-testid="compare-column"]', { has: page.locator('.cmp2-col-score.num-sleeper') });
  await expect(column.getByTestId('sleeper-tag')).toHaveText('Sleeper');
  await expect(column).not.toContainText('lower confidence');

  // In the table: Base and Score grey in that column, and only there.
  await expect(page.locator('[data-testid="compare-factor"][data-factor="base"] [data-muted="true"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="compare-total"] [data-muted="true"]')).toHaveCount(1);

  // The label reads: small, but at the app's faint text colour, never a hairline.
  const tag = column.getByTestId('sleeper-tag');
  const size = await tag.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(9);

  // A normal number keeps the normal colour.
  const other = page.locator('[data-testid="compare-column"] .cmp2-col-score:not(.num-sleeper)').first();
  const colour = (l: typeof other) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await colour(grey)).not.toBe(await colour(other));
});
