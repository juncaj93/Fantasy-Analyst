/**
 * The FLX chip, on every screen that offers it.
 *
 * One claim, three places: selecting it leaves running backs, receivers and
 * tight ends on screen and nobody else. The failure it is guarding against is
 * a quarterback appearing — which is what happens the moment somebody reads
 * this as superflex.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/**
 * Every position currently drawn in a list of player rows.
 *
 * Read as one snapshot of the DOM, so a caller has to poll it rather than
 * assert it once: both lists fetch on a debounce, so for a couple of hundred
 * milliseconds after a chip is tapped the rows on screen are still the previous
 * filter's. Asserting immediately would be asserting a stale frame.
 */
async function positionsOn(page: Page, testId: string): Promise<string[]> {
  const rows = page.getByTestId(testId);
  await expect(rows.first()).toBeVisible();
  const positions = await rows.evaluateAll((els) =>
    els.map((e) => (e.getAttribute('data-position') ?? '').toUpperCase()),
  );
  return [...new Set(positions)].sort();
}

/** The same snapshot, retried until the list settles on the expected answer. */
function positionsEventually(page: Page, testId: string) {
  return expect.poll(() => positionsOn(page, testId), { timeout: 5_000 });
}

test.describe('the draft board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
  });

  /**
   * FLX is after the positions rather than among them.
   *
   * It is a view spanning three positions, not a fourth one, and a chip that
   * reads like a position sitting between the real ones invites exactly the
   * confusion this filter must not cause.
   *
   * The seeded league now starts a defence, so this row also carries the case
   * that used to have no browser coverage at all: **DEF comes after FLX**, at
   * the end. Both halves of the ordering claim are asserted at the unit level
   * in `tests/positions.test.ts` — the defence league and the best-ball one —
   * and what this adds is that a real browser draws them in that order rather
   * than in whatever order the chips happen to be emitted.
   */
  test('offers FLX after the positions, and DEF after FLX', async ({ page }) => {
    const chips = await page.getByTestId('flx-filter').textContent();
    expect(chips).toContain('FLX');
    const labels = await page
      .locator('.filter-row .chip')
      .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
    expect(labels).toEqual(['★', 'ALL', 'QB', 'RB', 'WR', 'TE', 'FLX', 'DEF']);
    // The point of the ordering: FLX is not among the positions, and the
    // defence is not between them.
    expect(labels.indexOf('FLX')).toBeGreaterThan(labels.indexOf('TE'));
    expect(labels.indexOf('DEF')).toBeGreaterThan(labels.indexOf('FLX'));
  });

  test('leaves exactly RB, WR and TE on the board', async ({ page }) => {
    await page.getByTestId('flx-filter').click();
    await expect(page.getByTestId('flx-filter')).toHaveAttribute('aria-pressed', 'true');
    await positionsEventually(page, 'recommendation-row').toEqual(['RB', 'TE', 'WR']);
  });

  /** Superflex confusion, named. There are quarterbacks on this board. */
  test('never shows a quarterback under FLX', async ({ page }) => {
    const all = await positionsOn(page, 'recommendation-row');
    expect(all, 'the unfiltered board has quarterbacks to hide').toContain('QB');

    await page.getByTestId('flx-filter').click();
    await positionsEventually(page, 'recommendation-row').not.toContain('QB');
  });

  test('still works with a search on top of it', async ({ page }) => {
    await page.getByTestId('flx-filter').click();
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('sotelo');
    // Andre Sotelo is a tight end, so the flex view keeps him.
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);

    await page.getByTestId('draft-search').fill('halloran');
    // Trey Halloran is a quarterback, so it does not.
    await expect(page.getByTestId('recommendation-row')).toHaveCount(0);
  });

  test('goes back to everybody when ALL is chosen again', async ({ page }) => {
    await page.getByTestId('flx-filter').click();
    await positionsEventually(page, 'recommendation-row').not.toContain('QB');
    await page.locator('.filter-row .chip', { hasText: /^ALL$/ }).click();
    await positionsEventually(page, 'recommendation-row').toContain('QB');
  });
});

test.describe('the player list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
  });

  test('offers the same chip and means the same thing by it', async ({ page }) => {
    await expect(page.getByTestId('flx-filter')).toBeVisible();
    await page.getByTestId('flx-filter').click();
    await positionsEventually(page, 'player-search-row').toEqual(['RB', 'TE', 'WR']);
  });

  test('names it for anybody listening rather than looking', async ({ page }) => {
    await expect(page.getByTestId('flx-filter')).toHaveAttribute(
      'aria-label',
      /running backs, receivers and tight ends/i,
    );
  });
});

test.describe('the comparison picker', () => {
  test('narrows the pool to the flex-eligible', async ({ page }) => {
    // Compare is a post-draft control, and the demo league is mid-draft.
    await inSeason(page);
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();

    await page.getByTestId('compare-sheet').getByTestId('flx-filter').click();
    const rows = page.getByTestId('compare-candidate');
    await expect(rows.first()).toBeVisible();
    await expect
      .poll(
        async () =>
          rows.evaluateAll((els) =>
            els.map((e) => e.querySelector('.pos-pill')?.textContent?.trim().toUpperCase() ?? ''),
          ),
        { timeout: 5_000 },
      )
      .not.toContain('QB');
  });
});
