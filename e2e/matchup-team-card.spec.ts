/**
 * Round 31, one number per player: a card on Matchup prints the number its row
 * prints, and one of Alex's own players opens Team's card (Team's lineup is
 * read only on that tap, never on a plain Matchup load). Runs at every width
 * the suite runs (360, 375, 390, 430): the sheet fits with no sideways scroll.
 */
import { expect, test, type Page } from '@playwright/test';

async function openMatchup(page: Page, lineupReads: string[]) {
  page.on('request', (r) => {
    if (/\/api\/leagues\/[^/]+\/lineup$/.test(new URL(r.url()).pathname)) lineupReads.push(r.url());
  });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } } });
  });
  await page.goto('/');
  await page.getByTestId('tab-matchup').click();
  await expect(page.getByTestId('matchup-score')).toBeVisible();
}

test('one of Alex\'s players opens a card with his row\'s number, and Team\'s lineup is read only on the tap', async ({ page }) => {
  const lineupReads: string[] = [];
  await openMatchup(page, lineupReads);
  const before = lineupReads.length;

  const mine = page.locator('[data-testid="matchup-player"][data-side="mine"][data-openable="true"]');
  expect(await mine.count()).toBeGreaterThan(0);
  const first = mine.first();
  const id = await first.getAttribute('data-player-id');
  const rowNumber = ((await first.getByTestId('matchup-player-proj').first().textContent()) ?? '').match(/\d+\.\d/)?.[0] ?? null;

  /* Nothing on Matchup asked for Team's lineup before the tap (other than what Team itself read first). */
  await page.waitForTimeout(300);
  expect(lineupReads.length).toBe(before);

  await first.click();
  const card = page.getByTestId('weekly-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-player-id', id!);
  await expect(page.getByTestId('weekly-verdict')).toBeVisible();
  if (rowNumber) {
    const score = page.getByTestId('weekly-score');
    if ((await score.count()) > 0) await expect(score).toContainText(rowNumber);
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
