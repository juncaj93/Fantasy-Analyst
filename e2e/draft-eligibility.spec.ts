/**
 * The Score regression, defended in a browser.
 *
 * A live board sorted by `Score` opened with seven players carrying `ADP —`,
 * `Val —` and `Next —`, clustered on 84, above every priced player the draft
 * had not yet reached — and three of them had not taken an NFL snap in years.
 * Every unit-level cause is pinned in `tests/audit.draftScore.test.ts`. This
 * file exists because the symptom was a *screen*: the numbers were individually
 * defensible and the page was still wrong, and nothing that ran in CI looked at
 * the page.
 *
 * The seed carries the three cases that make it reachable — see `DEMO_UNPRICED`
 * in `src/devserver/seed.ts`:
 *
 *   - **Wes Okonkwo** (LV) and **Dane Petrossian** (ARI) are on NFL rosters and
 *     unpriced by both markets. They belong on the board, below everybody the
 *     market has an opinion about, with an unknown Score.
 *   - **Hollis Marchetti** has no club and no price, and is recorded exactly as
 *     Sleeper records a player who retired years ago: `active: true`, an
 *     ordinary `search_rank`, nothing in the payload admitting he stopped
 *     playing. He is not a draft recommendation.
 */

import { expect, test, type Page } from '@playwright/test';

const ROSTERED_UNPRICED = ['Wes Okonkwo', 'Dane Petrossian'];
const HISTORICAL = 'Hollis Marchetti';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/** Every row on the board, top to bottom, with the numbers it is showing. */
async function rows(page: Page) {
  return page.$$eval('[data-testid="recommendation-row"]', (nodes) =>
    nodes.map((row) => {
      const text = (selector: string) =>
        (row.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        name: text('.player-name'),
        score: text('[data-testid="score-metric"] .score-value'),
        metrics: text('.player-row-metrics'),
      };
    }),
  );
}

test.describe('the board a Score sort opens with', () => {
  test('never leads with a player no market has priced', async ({ page }) => {
    await openDraft(page);
    const board = await rows(page);
    expect(board.length).toBeGreaterThan(3);

    // Whatever the top of the board is, it is not somebody with no Score.
    const firstUnscored = board.findIndex((r) => !/^\d+$/.test(r.score));
    const lastScored = board.map((r) => /^\d+$/.test(r.score)).lastIndexOf(true);
    if (firstUnscored !== -1) expect(firstUnscored).toBeGreaterThan(lastScored);
    expect(/^\d+$/.test(board[0]!.score)).toBe(true);
  });

  test('gives an unpriced player a dash rather than a number', async ({ page }) => {
    await openDraft(page);
    const board = await rows(page);

    for (const name of ROSTERED_UNPRICED) {
      const row = board.find((r) => r.name.includes(name));
      expect(row, `${name} should still be on the board — he is on an NFL roster`).toBeTruthy();
      /*
       * The number that must never come back.
       *
       * His composite is near zero because market value is *absent* rather than
       * low, and `draftScore(0)` is 83. Any two-digit number in the eighties
       * here is the original bug.
       */
      expect(row!.score, `${name} carries a Score he cannot have earned`).not.toMatch(/^\d+$/);
    }
  });

  test('keeps a player with no club and no price off the recommendations', async ({ page }) => {
    await openDraft(page);
    const board = await rows(page);
    expect(board.some((r) => r.name.includes(HISTORICAL))).toBe(false);
  });

  test('every scored player carries the evidence the Score was built from', async ({ page }) => {
    await openDraft(page);
    const board = await rows(page);
    // A Score is a claim about a priced player, so a row that shows one must
    // also show the price it was computed against. `ADP —` beside a number was
    // the visible signature of the whole fault.
    for (const row of board.filter((r) => /^\d+$/.test(r.score))) {
      expect(row.metrics, `${row.name} shows a Score with no ADP behind it`).not.toMatch(/ADP\s*—/);
    }
  });

  test('the top of the board is unchanged by the ADP and DOG sorts', async ({ page }) => {
    await openDraft(page);
    for (const mode of ['sort-adp', 'sort-dog', 'sort-score']) {
      await page.getByTestId(mode).click();
      const board = await rows(page);
      // Whichever market is being read, an unpriced player is never first.
      expect(/^\d+$/.test(board[0]!.score), `${mode} led with an unscored player`).toBe(true);
      expect(board.some((r) => r.name.includes(HISTORICAL))).toBe(false);
    }
  });
});
