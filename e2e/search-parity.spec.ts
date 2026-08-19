/**
 * The same query, typed into two different screens, finds the same player.
 *
 * `tests/search.contract.test.ts` proves this at the unit level across all
 * three code paths, exhaustively, for every punctuation and typo case. This
 * spec exists to prove the *wiring* — that the screens really are plugged into
 * that matcher in a browser, against the real server, and not merely that the
 * module would give the right answer if anyone asked it.
 *
 * Draft filters a board already in memory; Players asks the server, which
 * recalls candidates in SQL and ranks them with the shared matcher. Those are
 * genuinely different paths, and the whole point of the work is that a reader
 * cannot tell which one they are on.
 *
 * The queries are deliberately ones the *old* code could not answer: a typo,
 * and a fragment from the middle of a surname. The demo seed has no hyphen or
 * apostrophe in any name, so the punctuation half of the matrix stays where it
 * can actually be exercised — in the unit tests, against a fixture that does.
 */

import { expect, test, type Page } from '@playwright/test';

/** Type into Draft's board filter and read back the names still drawn. */
async function draftSearch(page: Page, query: string): Promise<string[]> {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
  await page.getByTestId('draft-search-open').click();
  const field = page.getByTestId('draft-search');
  await expect(field).toBeVisible();
  await field.fill(query);
  // The board filters in place with no request, so there is nothing to await
  // beyond the rows settling.
  await expect(page.getByTestId('board-list')).toBeVisible();
  return page.getByTestId('recommendation-row').locator('.player-name').allInnerTexts();
}

/** Type into the Players screen, which goes to the server, and read the rows. */
async function playersSearch(page: Page, query: string): Promise<string[]> {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  const field = page.getByTestId('player-search');
  await expect(field).toBeVisible();
  await field.fill(query);
  // This one *is* a request. Waiting on the row list rather than on a timer.
  await expect
    .poll(async () => (await page.getByTestId('player-search-row').count()) > 0, { timeout: 10_000 })
    .toBe(true);
  return page.getByTestId('player-search-row').locator('.player-name').allInnerTexts();
}

const CASES = [
  { why: 'a one-letter slip in a surname', query: 'Brennen', expect: 'Kai Brennan' },
  { why: 'two letters transposed', query: 'Kowalksi', expect: 'Nate Kowalski' },
  { why: 'a fragment from the middle of a surname', query: 'walski', expect: 'Nate Kowalski' },
  { why: 'a partial first and last name', query: 'Kai Bren', expect: 'Kai Brennan' },
];

test.describe('the same query finds the same player on Draft and on Players', () => {
  for (const { why, query, expect: name } of CASES) {
    test(`${why}: “${query}”`, async ({ page }) => {
      const onDraft = await draftSearch(page, query);
      expect(onDraft, `Draft did not find ${name} for “${query}”`).toContain(name);

      const onPlayers = await playersSearch(page, query);
      expect(onPlayers, `Players did not find ${name} for “${query}”`).toContain(name);
    });
  }

  test('a stranger is a stranger on both', async ({ page }) => {
    /*
     * The guard that stops every assertion above from passing for a matcher
     * that simply returns everybody.
     *
     * Written against each screen's empty state rather than through the helpers
     * above, because both screens *replace* their list with a sentence when
     * nothing matches — so waiting for the list is waiting for something that
     * is deliberately not there.
     */
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('zzzzzz');
    await expect(page.getByText(/Nobody available matching/i)).toBeVisible();
    await expect(page.getByTestId('recommendation-row')).toHaveCount(0);

    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await page.getByTestId('player-search').fill('zzzzzz');
    await expect(page.getByText(/Nobody matching/i)).toBeVisible();
    await expect(page.getByTestId('player-search-row')).toHaveCount(0);
  });
});
