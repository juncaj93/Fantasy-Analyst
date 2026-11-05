/**
 * Compare's header names the slot the server compared for (23 October 2026),
 * at every width the suite runs (360, 375, 390, 430).
 *
 * Reported from production: opened from a WR row, a TE and a WR read
 * "Week 7 · WR slot", the server marked the pair not comparable and the Start
 * pick vanished with no reason given. The opening slot now gives way to the
 * smallest slot both share (FLEX), the header says so, and the pick is shown.
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/*
 * Opened from the RB row: the demo roster's one receiver is Doubtful, and
 * Doubtful counts as Out since 5 November 2026, so no WR row has a player.
 * The point is the same: the opening slot gives way to the slot both share.
 */
async function openFromRbRow(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.locator('button[data-testid="starter-row"][data-slot="RB"]').first().click();
  await page.getByTestId('weekly-compare').click();
  await expect(page.getByTestId('compare-sheet')).toBeVisible();
}

test('a TE added to a Compare opened on an RB row is a FLEX comparison, with a Start pick', async ({ page }) => {
  await openFromRbRow(page);
  const sheet = page.getByTestId('compare-sheet');
  if (!(await page.getByTestId('compare-picker').isVisible())) await page.getByTestId('compare-add').click();
  await page.getByTestId('compare-tab-all').click();
  const te = page.locator('[data-testid="compare-candidate"][aria-label*=", TE "][data-chosen="false"]').first();
  await expect(te).toBeVisible();
  await te.click();
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();

  const sub = sheet.locator('.cmp-title-sub');
  await expect(sub).toContainText('FLEX slot');
  await expect(sub).not.toContainText('RB slot');
  await expect(page.locator('[data-testid="compare-column"][data-pick="true"]')).toHaveCount(1);

  /* One line, nothing clipped, at this width. */
  const fits = await sub.evaluate((el) => {
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
    return { oneLine: el.getBoundingClientRect().height <= line * 1.5, clipped: el.scrollWidth > el.clientWidth + 1 };
  });
  expect(fits.oneLine, 'the header subtitle stays on one line').toBe(true);
  expect(fits.clipped, 'the header subtitle is not clipped').toBe(false);
  const header = (await sheet.locator('.cmp-title').boundingBox())!;
  expect(header.x + header.width, 'the title fits the sheet').toBeLessThanOrEqual(page.viewportSize()!.width);
});

/*
 * A toss-up (4 November 2026): two players within two points. The lean's card
 * says "Toss-up" and "Lean" where Start would be, and nobody gets Start.
 */
test('a close call is a toss-up with a lean, not a Start pick', async ({ page }) => {
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const [lead, other] = body.evaluations as { playerId: string; name: string }[];
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        recommendedPlayerId: null,
        tossUp: { leanPlayerId: lead!.playerId, leanName: lead!.name, otherPlayerId: other!.playerId, otherName: other!.name },
        evaluations: [lead, other, ...body.evaluations.slice(2)],
      }),
    });
  });
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.getByTestId('compare-open').click();
  await page.getByTestId('compare-tab-all').click();
  /* Two players who have a number this week, so both cards can show one. */
  const priced = page.locator('[data-testid="compare-candidate"][aria-label*=" projected"]');
  await expect(priced.nth(1)).toBeVisible();
  for (const i of [0, 1]) await priced.nth(i).click();
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await expect(page.locator('[data-testid="compare-column"][data-pick="true"]')).toHaveCount(0);
  await expect(page.getByTestId('compare-tossup')).toHaveText('Toss-upLean');
  /* On the lean's card, and only there. */
  await expect(page.locator('[data-testid="compare-column"]').filter({ has: page.getByTestId('compare-tossup') })).toHaveCount(1);
  /* Both numbers stay on the cards; only the Start pick is withheld. */
  const scores = page.getByTestId('compare-column').getByTestId('compare-score');
  await expect(scores).toHaveCount(2);
  for (const score of await scores.all()) await expect(score).toHaveText(/\d/);
  await expect(page.getByTestId('compare-sheet')).not.toContainText('Start');
});
