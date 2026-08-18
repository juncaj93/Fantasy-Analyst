/**
 * The trailing edge of a player row, and the tag that no longer sits on it.
 *
 * Two changes, one place on the screen.
 *
 * The club marks used to land at slightly different distances from the right
 * edge depending on how wide the number beside them was — a two-character tally
 * pushed the mark one way, a three-character one the other, and a row with no
 * tally at all a third. Nothing was wrong with any single row; the *column* was
 * ragged, which reads as a rendering fault to somebody who could not say what
 * was wrong with it. The fix is layout — a fixed field — and this file asserts
 * the outcome rather than the CSS: every mark on the board starts at the same
 * x, to the pixel.
 *
 * And the AVOID chip is gone from the cards. The tally it was describing is
 * still beside the name, negative sign and all, which is what the reader
 * actually interprets.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/** Where each club mark begins, rounded to the pixel the eye can see. */
async function markLeftEdges(page: Page, within: string): Promise<number[]> {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    return rows
      .map((row) => row.querySelector('.team-logo, .team-code'))
      .filter((mark): mark is Element => mark != null)
      .map((mark) => Math.round(mark.getBoundingClientRect().left));
  }, within);
}

test.describe('the club marks line up', () => {
  test('every mark on the draft board starts on the same edge', async ({ page }) => {
    await openDraft(page);
    const edges = await markLeftEdges(page, '[data-testid="recommendation-row"]');
    expect(edges.length, 'the board should be drawing marks at all').toBeGreaterThan(4);
    expect(new Set(edges).size, `marks started at ${[...new Set(edges)].join(', ')}`).toBe(1);
  });

  /**
   * The case that used to break it.
   *
   * A row with a tally, a row without one and a row with an availability tag
   * are the three widths that produced three different offsets. All three are
   * on the board at once, and the assertion above covers them — this one proves
   * the board actually contains the mix, so a board that happened to be uniform
   * could not pass by accident.
   */
  test('and the board really does mix rows with and without a tally', async ({ page }) => {
    await openDraft(page);
    const rows = page.locator('[data-testid="recommendation-row"]');
    const withTally = await rows.locator('[data-testid="compact-tally"]').count();
    expect(withTally, 'some rows carry a tally').toBeGreaterThan(0);
    expect(withTally, 'and some do not').toBeLessThan(await rows.count());
  });

  test('and the same is true down the players list', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
    const edges = await markLeftEdges(page, '[data-testid="player-search-row"]');
    expect(edges.length).toBeGreaterThan(4);
    expect(new Set(edges).size).toBe(1);
  });

  /**
   * Alignment is not padding.
   *
   * The field is reserved whether or not anything is in it, so the fix must not
   * have been bought by faking a value into the empty rows — no zero-padded
   * `08`, no placeholder dash where a tally would be.
   */
  test('without inventing a value for the rows that have none', async ({ page }) => {
    await openDraft(page);
    const fields = await page
      .locator('[data-testid="recommendation-row"] .player-row-meta')
      .evaluateAll((nodes) => nodes.map((n) => n.textContent!.trim()));
    expect(fields.length).toBeGreaterThan(4);
    for (const text of fields) {
      // Either a real signed tally (with a status tag beside it or not), or
      // genuinely empty. Never a padded or placeholder number.
      expect(text).not.toMatch(/^0\d/);
      expect(text).not.toBe('—');
    }
    expect(fields.some((t) => t === ''), 'some rows leave the field empty').toBe(true);
  });
});

test.describe('the AVOID tag', () => {
  /**
   * Removed from the card, and only from the card.
   *
   * The tally underneath it is untouched: the API still carries the flag, the
   * engine still applies its bounded penalty, and the negative number the
   * reader interprets is still printed beside the name.
   */
  test('no longer appears on any player card', async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId('avoid-tag')).toHaveCount(0);
    await expect(page.locator('[data-testid="board-list"]')).not.toContainText('AVOID');
  });

  test('but the tally it described is still on the row, sign and all', async ({ page }) => {
    await openDraft(page);
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const scored = (board.recommendations as { name: string; newsLifetimeNet: number }[]).filter(
      (r) => r.newsLifetimeNet !== 0,
    );
    expect(scored.length, 'the demo board has players the research has an opinion about').toBeGreaterThan(0);

    // The signed number is still printed beside the name — which is the thing
    // the reader interprets now that nothing interprets it for them.
    for (const rec of scored.slice(0, 3)) {
      const row = page.locator('[data-testid="recommendation-row"]', { hasText: rec.name }).first();
      const expected = rec.newsLifetimeNet > 0 ? `+${rec.newsLifetimeNet}` : `${rec.newsLifetimeNet}`;
      await expect(row.getByTestId('compact-tally')).toContainText(expected);
      await expect(row).not.toContainText('AVOID');
    }
  });

  /**
   * The flag itself is untouched.
   *
   * The API still carries it and the engine still applies its bounded penalty
   * below the threshold — this change removed a label from a card, not a
   * judgement from the model.
   */
  test('and the model still computes it', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const recommendations = board.recommendations as { avoid?: { active: boolean; lifetimeNet: number } }[];
    expect(recommendations.every((r) => typeof r.avoid?.active === 'boolean')).toBe(true);
  });
});
