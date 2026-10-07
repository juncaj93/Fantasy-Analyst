/**
 * A week with nothing to claim, said as an answer, at every width.
 *
 * October 2026 audit, the live week-5 board: `Recommended move` was a heading
 * over nothing, the note under it said every option "beats someone on your
 * bench on paper" above three rows that were not scored, and `Proj. Not
 * scored` never said why. Team listed the same two unscored quarterbacks under
 * `Waiver upgrades`. The board is served as production had it: no plan, three
 * unscored trending adds, and the engine's closest near miss.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason as rosterInSeason } from './helpers.ts';

const UNKNOWN = (playerId: string, name: string, position: string, team: string, rank: number, why: string) => ({
  playerId,
  name,
  position,
  team,
  statusFlag: null,
  trending: null,
  adds: 1000,
  heat: 0.5,
  leagueRank: rank,
  why,
});

async function inSeason(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 5)', assumed: false },
      }),
    });
  });
}

async function serveEmptyWeek(page: Page) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...original,
        upgrades: [],
        valueAdds: [],
        moveGroups: [],
        dst: null,
        unknowns: [
          UNKNOWN('u1', 'Aaron Rodgers', 'QB', 'PIT', 18, 'scoring'),
          UNKNOWN('u2', 'C.J. Stroud', 'QB', 'HOU', 25, 'scoring'),
          UNKNOWN('u3', 'Joe Mixon', 'RB', '', 45, 'no_team'),
        ],
        considered: 71,
        skipped: 29,
        headline: 'Your current options grade better than the 42 free agents that could be scored.',
        nearestMiss: {
          playerId: 'n1',
          name: 'KC Concepcion',
          position: 'WR',
          overName: 'Kendre Miller',
          kind: 'bench',
          slot: null,
          gap: 0.28,
          bar: 1,
          basis: 'sleeper',
        },
        claimPlan: {
          surface: false,
          state: 'no_move',
          headline: 'No waiver move recommended',
          instruction: null,
          groups: [],
          claims: [],
          note: null,
          mechanics: null,
          outcomes: [],
          relationships: [],
          protectedPlayers: [],
          budget: null,
          dropHints: [],
          generatedAt: '2026-10-07T18:00:00.000Z',
        },
      }),
    });
  });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('a week with no claim', () => {
  test('Waivers says there is no move, who came closest, and why the rest have no number', async ({ page }) => {
    await inSeason(page);
    await serveEmptyWeek(page);
    await page.goto('/');
    await page.getByTestId('tab-waivers').click();

    const card = page.getByTestId('waivers-no-move');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('waivers-no-move-headline')).toHaveText('No move this week');
    await expect(page.getByTestId('waivers-no-move-detail')).toHaveText(
      'None of the 42 free agents this app could compare beats your roster by enough to be worth a roster spot.',
    );
    await expect(page.getByTestId('waivers-no-move-nearest')).toHaveText(
      'Closest: KC Concepcion, 0.3 pts more than Kendre Miller on Sleeper’s projection. A claim needs 1.0.',
    );

    /* The card sits under the heading it answers, and the false note is gone. */
    const title = await page.getByTestId('waivers-recommended-title').boundingBox();
    const box = (await card.boundingBox())!;
    expect(box.y).toBeGreaterThan(title!.y);
    await expect(page.getByTestId('waivers-others-note')).toHaveCount(0);
    await expect(page.getByText(/beats someone on your bench on paper/)).toHaveCount(0);

    /* The unscored adds under their own heading, with the reasons said once each. */
    await expect(page.getByTestId('waivers-unscored-title')).toBeVisible();
    const note = page.getByTestId('waivers-unscored-note');
    await expect(note).toContainText('Aaron Rodgers and C.J. Stroud: Sleeper’s quarterback projection');
    await expect(note).toContainText('Joe Mixon: not on an NFL team');
    await expect(page.getByTestId('waivers-unscored').getByTestId('waiver-row')).toHaveCount(3);

    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await noSidewaysScroll(page);
  });

  test('Team lists no unscored player under Waiver upgrades, and says there is no move', async ({ page }) => {
    await inSeason(page);
    await rosterInSeason(page);
    await serveEmptyWeek(page);
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();

    const verdict = page.getByTestId('waiver-verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveText(
      'No waiver move this week. Closest: KC Concepcion, 0.3 pts more than Kendre Miller on Sleeper’s projection. A claim needs 1.0.',
    );
    await expect(page.locator('[data-testid="waiver-row"][data-strength="unknown"]')).toHaveCount(0);
    await noSidewaysScroll(page);
  });
});
