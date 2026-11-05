/**
 * Floor and Ceiling pick a toss-up's lean (5 November 2026), at every width
 * the suite runs (360, 375, 390, 430). The label is one short phrase: Team's
 * Best move reads "Toss-up: lean X over Y (more upside)", Compare's lean card
 * "Lean (more upside)". The longest of the two words is the one tried here.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

const TOSSUP = {
  slot: 'WR',
  inPlayerId: '1004',
  inName: 'Andre Sotelo',
  outPlayerId: '1001',
  outName: 'Marcus Vance',
  gain: -0.6,
  reason: 'Toss-up',
  leanTag: 'more upside',
};

async function fits(page: Page, el: Locator) {
  const box = await el.evaluate((node) => ({ right: node.getBoundingClientRect().right, scroll: node.scrollWidth, client: node.clientWidth }));
  expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
}

test('Team names the lean with the mode\'s word, and the bench line agrees', async ({ page }) => {
  await inSeason(page);
  await page.goto('/');
  await page.route('**/api/leagues/*/lineup', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, mode: 'ceiling', swaps: [], fills: [], tossUps: [TOSSUP] }) });
  });
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();

  const row = page.getByTestId('lineup-tossup');
  await expect(row).toContainText('Toss-up: lean Andre Sotelo over Marcus Vance (more upside)');
  await expect(row.getByTestId('tossup-lean-tag')).toHaveText('(more upside)');
  await expect(page.getByTestId('bench-toggle')).toContainText('Toss-up');
  await expect(page.getByTestId('bench-toggle')).not.toContainText('No better option');
  await fits(page, row);
});

test('Compare\'s lean card carries the same word', async ({ page }) => {
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const [lead, other] = body.evaluations as { playerId: string; name: string }[];
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        recommendedPlayerId: null,
        /* Four mixed positions share no slot; the card under test is the narrow one, so say they do. */
        slot: { ...(body.slot ?? {}), comparable: true },
        tossUp: { leanPlayerId: lead!.playerId, leanName: lead!.name, otherPlayerId: other!.playerId, otherName: other!.name, leanTag: 'more upside' },
      }),
    });
  });
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.getByTestId('compare-open').click();
  await page.getByTestId('compare-tab-all').click();
  const priced = page.locator('[data-testid="compare-candidate"][aria-label*=" projected"]');
  await expect(priced.nth(3)).toBeVisible();
  /* Four cards, the narrowest the sheet draws them. */
  for (const i of [0, 1, 2, 3]) await priced.nth(i).click();
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  const lean = page.getByTestId('compare-lean');
  await expect(lean).toHaveText('Lean (more upside)');
  const card = page.locator('[data-testid="compare-column"]').filter({ has: lean });
  await expect(card).toHaveCount(1);
  await fits(page, card);
});
