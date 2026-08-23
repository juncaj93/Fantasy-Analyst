/**
 * The Score / ADP / DOG / PTS control, as a contract.
 *
 * Two claims are being defended, and the second is the one that matters.
 *
 * **It costs no row.** The control sits in the navigation bar beside the
 * refresh glyph rather than above the list, because on this screen a row is a
 * player. That is asserted as a number, because "compact" is otherwise an
 * opinion that drifts back.
 *
 * **Switching it changes the order and nothing else.** A sort that quietly
 * renormalised a Score, or recomputed a tier from its new neighbours, would
 * look entirely correct in a screenshot — the rows would be in the right order
 * and the numbers on them would be wrong. So every number on every card is
 * captured before and after, and compared per player.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/** Every card's numbers, keyed by player, in whatever order they are drawn. */
async function cardNumbers(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const row of document.querySelectorAll('[data-testid="recommendation-row"]')) {
      const id = row.getAttribute('data-player-id')!;
      const metrics = row.querySelector('.player-row-metrics');
      out[id] = (metrics?.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return out;
  });
}

/** The board's order, top to bottom. */
async function order(page: Page) {
  return page.$$eval('[data-testid="recommendation-row"]', (rows) =>
    rows.map((r) => r.getAttribute('data-player-id')!),
  );
}

test.describe('the control', () => {
  test('offers exactly four modes and defaults to Score', async ({ page }) => {
    await openDraft(page);
    const control = page.getByTestId('draft-sort');
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('role', 'radiogroup');

    await expect(page.getByTestId('sort-score')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('sort-dog')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('sort-pts')).toHaveAttribute('aria-checked', 'false');
    /*
     * Four, and no fifth. PTS joined DOG and ADP when the preseason projection
     * import landed; like DOG it is always drawn and says so in its label when
     * nothing has been imported, rather than appearing and disappearing under
     * the reader's thumb.
     */
    await expect(control.locator('button')).toHaveCount(4);
  });

  test('sits beside the board control without adding a row', async ({ page }) => {
    await openDraft(page);
    const overlap = await page.evaluate(() => {
      const sort = document.querySelector('[data-testid="draft-sort"]')!.getBoundingClientRect();
      /*
       * The bar's other action, which used to be the refresh glyph.
       *
       * That glyph is gone — the board reloads by pull now — and the way into
       * the draft board took its place, moving out of the title line where it
       * was a 15px mark reading as decoration on the league's name. What this
       * test is about is unchanged: the sort shares that row rather than adding
       * one of its own.
       */
      const other = document.querySelector('[data-testid="draft-board-open"]')!.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="draft-nav"]')!.getBoundingClientRect();
      return {
        sharesLine: sort.bottom > other.top && other.bottom > sort.top,
        // And inside the bar that was already there.
        insideNav: sort.top >= nav.top - 1 && sort.bottom <= nav.bottom + 1,
      };
    });
    expect(overlap.sharesLine).toBe(true);
    expect(overlap.insideNav).toBe(true);
  });

  test('names each mode for anybody listening rather than looking', async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-label', /Sleeper ADP/);
    await expect(page.getByTestId('sort-dog')).toHaveAttribute('aria-label', /Underdog/);
    // And PTS says what it is, which is a projection rather than a betting line.
    await expect(page.getByTestId('sort-pts')).toHaveAttribute('aria-label', /projection/i);
  });
});

test.describe('switching', () => {
  test('reorders the board', async ({ page }) => {
    await openDraft(page);
    const byScore = await order(page);

    await page.getByTestId('sort-adp').click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');
    const byAdp = await order(page);

    // Same players, different sequence.
    expect([...byAdp].sort()).toEqual([...byScore].sort());
    expect(byAdp).not.toEqual(byScore);
  });

  /**
   * The claim the whole feature rests on. Every number on every card — Score,
   * ADP, DOG, Val, Next — captured before and after and compared per player.
   */
  test('changes not one number on any card', async ({ page }) => {
    await openDraft(page);
    const before = await cardNumbers(page);

    await page.getByTestId('sort-adp').click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');
    const afterAdp = await cardNumbers(page);

    await page.getByTestId('sort-dog').click();
    await expect(page.getByTestId('sort-dog')).toHaveAttribute('aria-checked', 'true');
    const afterDog = await cardNumbers(page);

    expect(Object.keys(before).length).toBeGreaterThan(3);
    for (const [id, metrics] of Object.entries(before)) {
      expect(afterAdp[id], `ADP sort changed ${id}`).toBe(metrics);
      expect(afterDog[id], `DOG sort changed ${id}`).toBe(metrics);
    }
  });

  test('returns to the board the server sent when Score is chosen again', async ({ page }) => {
    await openDraft(page);
    const original = await order(page);
    await page.getByTestId('sort-adp').click();
    await page.getByTestId('sort-dog').click();
    await page.getByTestId('sort-score').click();
    await expect(page.getByTestId('sort-score')).toHaveAttribute('aria-checked', 'true');
    expect(await order(page)).toEqual(original);
  });

  test('leaves the position filter and the queue alone', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('queue-filter').click();
    await expect(page.getByTestId('queue-filter')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('sort-adp').click();
    // The filter the reader chose is still the filter they chose.
    await expect(page.getByTestId('queue-filter')).toHaveAttribute('aria-pressed', 'true');
  });

  test('orders by ADP ascending, with the unpriced at the bottom', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('sort-adp').click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');

    const adps = await page.$$eval('[data-testid="recommendation-row"]', (rows) =>
      rows.map((row) => {
        const text = Array.from(row.querySelectorAll('.metric'))
          .map((m) => m.textContent ?? '')
          .find((t) => t.trim().startsWith('ADP'));
        const value = Number((text ?? '').replace(/[^0-9.]/g, ''));
        return Number.isFinite(value) && value > 0 ? value : null;
      }),
    );

    const priced = adps.filter((v): v is number => v != null);
    expect(priced.length).toBeGreaterThan(3);
    // Ascending, and every unpriced row sits after every priced one.
    for (let i = 1; i < priced.length; i++) expect(priced[i]!).toBeGreaterThanOrEqual(priced[i - 1]!);
    const lastPriced = adps.lastIndexOf(priced[priced.length - 1]!);
    expect(adps.slice(0, lastPriced + 1).every((v) => v != null)).toBe(true);
  });
});
