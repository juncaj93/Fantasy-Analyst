/**
 * The corner of a player's card, beside Done: the heart before the draft, the
 * owner after it.
 *
 * The heart only ever moved the draft board, so once Sleeper calls the draft
 * finished the corner answers *who holds him* instead. The switch is the same
 * `season.draftVisible` that puts Draft in the bar, so a league heading into
 * its next draft gets the heart back without a code change. Both sides are
 * pinned here by overriding only that one field.
 *
 * The seeded league is two rosters: `You` holds Marcus Vance (`1001`), `Rival`
 * holds Devin Okafor (`1002`).
 */

import { expect, test, type Page } from '@playwright/test';

const MINE = '1001';
const RIVAL = '1002';

async function draftAhead(page: Page, ahead: boolean): Promise<void> {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const season = ahead
      ? { phase: 'preseason', draftVisible: true, reason: 'your draft has not finished yet', assumed: false }
      : { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 4)', assumed: false };
    await route.fulfill({ response, body: JSON.stringify({ ...body, season }) });
  });
}

async function openPlayers(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  await expect(page.getByTestId('players-list')).toBeVisible();
}

async function openCard(page: Page, playerId: string): Promise<void> {
  const row = page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
}

test.describe('the card corner once the draft is over', () => {
  test.beforeEach(async ({ page }) => {
    await draftAhead(page, false);
    await openPlayers(page);
  });

  test('names a rival manager and draws no heart', async ({ page }) => {
    await openCard(page, RIVAL);
    const sheet = page.getByTestId('player-sheet');
    await expect(sheet.getByTestId('owner-pill')).toHaveText('Rival');
    await expect(sheet.getByTestId('my-guy-control')).toHaveCount(0);
  });

  test('says You on your own player', async ({ page }) => {
    await openCard(page, MINE);
    await expect(page.getByTestId('player-sheet').getByTestId('owner-pill')).toHaveText('You');
  });

  test('says Available on a free agent', async ({ page }) => {
    await page.getByTestId('players-owner-open').click();
    await page.getByTestId('players-owner-option').filter({ hasText: /^Available/ }).click();
    await expect(page.getByTestId('players-owner-sheet')).toBeHidden();
    // The filter lands after a debounce; wait until the rostered players leave.
    await expect
      .poll(() =>
        page.getByTestId('player-search-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id'))),
      )
      .not.toContain(MINE);
    const first = page.getByTestId('player-search-row').first();
    await expect(first).toBeVisible();
    await first.click();
    const sheet = page.getByTestId('player-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('owner-pill')).toHaveText('Available');
    await expect(sheet.getByTestId('my-guy-control')).toHaveCount(0);
  });
});

test.describe('the card corner while a draft is ahead', () => {
  test('keeps the heart and draws no owner', async ({ page }) => {
    await draftAhead(page, true);
    await openPlayers(page);
    await openCard(page, RIVAL);
    const sheet = page.getByTestId('player-sheet');
    await expect(sheet.getByTestId('my-guy-control')).toBeVisible();
    await expect(sheet.getByTestId('owner-pill')).toHaveCount(0);
  });
});

/**
 * The list row follows the same gate as the card.
 *
 * After the draft: the owner pill where the heart was, and the row's third
 * number is this league's pick (`Pick 1.02`) rather than ADP. Before it: the
 * heart and ADP, exactly as they were. Either way the numbers stay one group at
 * the leading edge: three of them once spread to the far ends of the row.
 */
function row(page: Page, playerId: string) {
  return page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
}

async function numbersStayTogether(page: Page, playerId: string): Promise<void> {
  const r = row(page, playerId);
  const rowBox = (await r.boundingBox())!;
  const cells = r.locator('.dense-metric');
  await expect(cells).toHaveCount(3);
  const last = (await cells.nth(2).boundingBox())!;
  expect(last.x + last.width - rowBox.x, 'the third number has drifted to the far edge').toBeLessThan(
    rowBox.width * 0.6,
  );
}

test.describe('the list row once the draft is over', () => {
  test.beforeEach(async ({ page }) => {
    await draftAhead(page, false);
    await openPlayers(page);
  });

  test('names the owner, prints the pick and draws no heart', async ({ page }) => {
    const rival = row(page, RIVAL);
    await expect(rival.getByTestId('owner-pill')).toHaveText('Rival');
    await expect(rival.getByTestId('players-pick')).toHaveText(/Pick\s*1\.02/);
    await expect(rival.getByTestId('players-adp')).toHaveCount(0);
    await expect(rival.getByTestId('my-guy-control')).toHaveCount(0);
    await expect(row(page, MINE).getByTestId('owner-pill')).toHaveText('You');
    await numbersStayTogether(page, RIVAL);
  });

  test('gives an undrafted free agent a dash for a pick', async ({ page }) => {
    const free = page
      .getByTestId('player-search-row')
      .filter({ has: page.locator('[data-testid="owner-pill"][data-owner="Available"]') })
      .first();
    await expect(free).toBeVisible();
    await expect(free.getByTestId('players-pick')).toHaveText(/Pick\s*—/);
  });
});

test.describe('the list row while a draft is ahead', () => {
  test('keeps the heart and ADP', async ({ page }) => {
    await draftAhead(page, true);
    await openPlayers(page);
    const rival = row(page, RIVAL);
    await expect(rival.getByTestId('my-guy-control')).toBeVisible();
    await expect(rival.getByTestId('players-adp')).toBeVisible();
    await expect(rival.getByTestId('owner-pill')).toHaveCount(0);
    await numbersStayTogether(page, RIVAL);
  });
});
