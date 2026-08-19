/**
 * Tiers may explain the Score board. They may never reorder it.
 *
 * The bug: the board was re-sorted into tier bands before the dividers were
 * drawn, so that a divider's claim — everything above this line is one tier —
 * came out literally true. It was true, and the board was wrong. On the
 * reported tight-end board a Score of 68 was drawn above two Scores of 83
 * because the market clustered him higher, and on the running-back board the
 * best-scoring player was pushed below four worse ones. The Score tab is the
 * one view whose entire job is to say who to draft, and it was contradicting
 * itself in the only way a reader cannot argue with: position on screen.
 *
 * These run against the rendered board rather than a unit fixture because that
 * is where the bug was — the model had the ordering right the whole time, and
 * the screen re-sorted it on the way to the DOM. A unit test of the ranking
 * would have passed throughout.
 *
 * Asserted per position, because the reporter noted quarterbacks looked fine
 * while tight ends and backs did not: one position passing proves nothing about
 * the pipeline.
 */

import { expect, test, type Page } from '@playwright/test';

/** The Scores down the board, in the order they are drawn. Unscored rows drop out. */
async function renderedScores(page: Page): Promise<number[]> {
  const cells = await page.locator('[data-testid="recommendation-row"] .score-value').allInnerTexts();
  return cells.map((t) => t.trim()).filter((t) => /^\d+$/.test(t)).map(Number);
}

/** Row order and divider positions, read straight off the list in DOM order. */
async function renderedSequence(page: Page) {
  return page.evaluate(() => {
    const out: { kind: 'row' | 'divider'; score: number | null; rank: string | null }[] = [];
    const list = document.querySelector('[data-testid="board-list"]');
    for (const node of Array.from(list?.querySelectorAll('[data-testid="tier-divider"], [data-testid="recommendation-row"]') ?? [])) {
      if (node.getAttribute('data-testid') === 'tier-divider') {
        out.push({ kind: 'divider', score: null, rank: null });
      } else if (node.getAttribute('data-testid') === 'recommendation-row') {
        const raw = node.querySelector('.score-value')?.textContent?.trim() ?? '';
        out.push({
          kind: 'row',
          score: /^\d+$/.test(raw) ? Number(raw) : null,
          rank: node.querySelector('.rank')?.textContent?.trim() ?? null,
        });
      }
    }
    return out;
  });
}

test.describe('the Score board is ordered by Score', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
  });

  /*
   * Every position, including the two that were wrong and the one that was not.
   * FLEX and the unfiltered board are here because they take a different path
   * through the screen — no single position means no dividers at all — and a
   * fix that only held under a position filter would be half a fix.
   */
  for (const position of ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLX']) {
    test(`never puts a lower Score above a higher one — ${position}`, async ({ page }) => {
      if (position !== 'ALL') {
        const chip = page.getByRole('button', { name: position, exact: true });
        if ((await chip.count()) === 0) test.skip(true, `no ${position} filter on this board`);
        await chip.click();
        await expect(page.getByTestId('board-list')).toBeVisible();
      }
      const rows = await page.getByTestId('recommendation-row').count();
      test.skip(rows === 0, `no ${position} rows on this board`);

      const scores = await renderedScores(page);
      expect(scores.length, `${position} drew no scored rows`).toBeGreaterThan(1);
      for (let i = 1; i < scores.length; i++) {
        expect(
          scores[i]!,
          `${position}: row ${i + 1} scores ${scores[i]} and sits below row ${i} scoring ${scores[i - 1]}`,
        ).toBeLessThanOrEqual(scores[i - 1]!);
      }
    });
  }

  test('a tier divider separates adjacent rows without moving any of them', async ({ page }) => {
    const te = page.getByRole('button', { name: 'TE', exact: true });
    if ((await te.count()) === 0) test.skip(true, 'no TE filter on this board');
    await te.click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();

    const sequence = await renderedSequence(page);
    const rows = sequence.filter((s) => s.kind === 'row');
    expect(rows.length).toBeGreaterThan(1);

    // Drop the separators and the remaining sequence is still Score-ordered:
    // a divider is punctuation, not a sort key.
    const scores = rows.map((r) => r.score).filter((s): s is number => s != null);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }

    // Never above the first row, and never two in a row.
    expect(sequence[0]?.kind).toBe('row');
    for (let i = 1; i < sequence.length; i++) {
      if (sequence[i]!.kind === 'divider') expect(sequence[i - 1]!.kind).toBe('row');
    }

    // Rank numbering follows what is drawn, so the leftmost number still counts
    // down the page whatever the tiers did.
    const ranks = rows.map((r) => r.rank);
    expect(ranks.slice(0, 4)).toEqual(['1', '2', '3', '4']);
  });

  /*
   * The other two sorts keep their own semantics. The invariant is general —
   * the selected sort decides the order — so a fix that quietly forced Score
   * ordering into the ADP and DOG views would be a different bug of the same
   * kind, and this is what would catch it.
   */
  for (const [mode, testid] of [
    ['ADP', 'sort-adp'],
    ['DOG', 'sort-dog'],
  ] as const) {
    test(`${mode} keeps its own ordering, tiers and all`, async ({ page }) => {
      const control = page.getByTestId(testid);
      if ((await control.count()) === 0 || (await control.isDisabled())) {
        test.skip(true, `no ${mode} sort available on this board`);
      }
      const te = page.getByRole('button', { name: 'TE', exact: true });
      if ((await te.count()) > 0) await te.click();
      await control.click();
      await expect(control).toHaveAttribute('aria-checked', 'true');

      const values = await page.evaluate((label: string) => {
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        return rows
          .map((r) => [...r.querySelectorAll('.metric')].find((m) => m.textContent?.trim().startsWith(label)))
          .map((m) => Number((m?.textContent?.match(/[\d.]+/) ?? [])[0]))
          .filter((n) => Number.isFinite(n));
      }, mode);

      expect(values.length, `${mode} drew no comparable rows`).toBeGreaterThan(1);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${mode} row ${i + 1} is out of order`).toBeGreaterThanOrEqual(values[i - 1]!);
      }
    });
  }
});
