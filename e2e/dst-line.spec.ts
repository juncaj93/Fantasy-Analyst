/**
 * The defence, on a phone.
 *
 * One line on Team, one row on the Waivers board, and never both for the same
 * recommendation. What is being defended here is the restraint: this lane
 * models six weeks of schedule, a bench spot's opportunity cost and a playoff
 * carry, and the reader is shown one line. A second line, a wrapped headline or
 * a card that pushed the lineup down the page would all be the modelling
 * leaking onto the screen.
 *
 * The division is deliberate. Team draws the *slot decision*, because that is
 * what a roster screen is about. Waivers draws the *player*, because "which
 * defence should I add" is a list question there — so the line appears on that
 * page only in the states that name nobody: `wait`, `hold`, `unknown`.
 *
 * The plan is injected rather than seeded, the way `inSeason` injects a settled
 * roster. The demo deployment's league is permanently mid-draft, and pre-draft
 * silence is correct behaviour rather than a fixture problem — it is asserted
 * below on the deployment's own data, and the drawn states are asserted against
 * a response shaped like the one the planner produces. The component, the CSS
 * and the four widths are the real ones either way.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason as settledRoster } from './helpers.ts';

/** A plan as `core/dst/planner.ts` returns one, with a deliberately long headline. */
function plan(over: Record<string, unknown> = {}) {
  return {
    decision: 'stream',
    activation: 'active',
    surface: true,
    headline: 'Stream NYJ over BUF · +4.2',
    why: [
      'New York Jets projects 4.2 pts better than Buffalo this week, clearing the 2.5 pt bar.',
      'The next few weeks point the same way.',
    ],
    evidence: [
      { key: 'gain', label: 'Projected gain', value: '+4.2 pts' },
      { key: 'opponent', label: 'Opponent', value: 'NE' },
      { key: 'implied', label: 'Opponent implied total', value: '17.5' },
      { key: 'cost', label: 'Roster cost', value: 'an open roster spot (1 free)' },
    ],
    target: { playerId: 'nyj', name: 'New York Jets', team: 'NYJ', thisWeek: 11.2, confidence: 'high', unavailable: false, unavailableReason: null, opponent: 'NE', opponentImpliedTotal: 17.5, forward: null, playoff: null },
    stash: null,
    current: { playerId: 'buf', name: 'Buffalo', team: 'BUF', thisWeek: 7, confidence: 'high', unavailable: false, unavailableReason: null, opponent: 'MIA', opponentImpliedTotal: 24, forward: null, playoff: null },
    gain: 4.2,
    bar: 2.5,
    cost: { openSpots: 1, needsDrop: false, dropCandidate: null, points: 0, label: 'an open roster spot (1 free)' },
    temporary: false,
    confidence: 'high',
    playoffWeeks: [15, 16, 17],
    notes: [],
    ...over,
  };
}

async function withPlan(page: Page, body: Record<string, unknown> | null) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...original, dst: body }) });
  });
}

async function inSeason(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false },
      }),
    });
  });
}

async function openWaivers(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

test.describe('the defence line on Team', () => {
  async function openTeam(page: Page) {
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();
  }

  test('says the answer, and only the answer', async ({ page }) => {
    await inSeason(page);
    await settledRoster(page);
    await withPlan(page, plan());
    await openTeam(page);

    const line = page.getByTestId('dst-line');
    await expect(line).toBeVisible();
    await expect(page.getByTestId('dst-headline')).toHaveText('Stream NYJ over BUF · +4.2');
    await expect(page.getByTestId('dst-state')).toHaveText('Stream');
    await expect(line).toHaveAttribute('data-decision', 'stream');
  });

  test('stays on one line and inside the viewport at this width', async ({ page }, testInfo) => {
    await inSeason(page);
    await settledRoster(page);
    await withPlan(
      page,
      plan({
        decision: 'stream_and_stash',
        headline: 'Stream Pittsburgh this week · stash Denver for Weeks 15–17',
      }),
    );
    await openTeam(page);

    const line = page.getByTestId('dst-line');
    await expect(line).toBeVisible();
    const box = (await line.boundingBox())!;
    const width = testInfo.project.use.viewport!.width;

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
    /*
     * One line. The row's own height, not the text's: a headline that wrapped
     * would take the card with it, and a defence is not worth two lines on a
     * screen whose first job is the lineup.
     */
    expect(box.height).toBeLessThan(72);

    /* And the page itself never scrolls sideways because of it. */
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('opens why on a tap, and the evidence one tap deeper', async ({ page }) => {
    await inSeason(page);
    await settledRoster(page);
    await withPlan(page, plan());
    await openTeam(page);

    await page.getByTestId('dst-line').click();
    await expect(page.getByTestId('dst-detail-body')).toBeVisible();
    await expect(page.getByTestId('dst-why')).toContainText('clearing the 2.5 pt bar');
    await expect(page.getByTestId('dst-cost')).toContainText('open roster spot');

    /* The evidence is deliberately not on the first screen of the sheet. */
    await expect(page.getByTestId('dst-evidence')).toHaveCount(0);
    await page.getByTestId('dst-evidence-toggle').click();
    await expect(page.getByTestId('dst-evidence')).toContainText('Opponent implied total');
  });

  test('is not repeated inside the waiver teaser under it', async ({ page }) => {
    await inSeason(page);
    await settledRoster(page);
    await withPlan(page, plan());
    await openTeam(page);

    /*
     * The same recommendation twice on one screen — once as the line, once as a
     * ranked row measured against a different bar — is the duplicate state this
     * lane is required not to produce.
     */
    await expect(page.getByTestId('dst-line')).toBeVisible();
    await expect(page.locator('[data-testid="waiver-row"][data-position="DEF"]')).toHaveCount(0);
  });

  test('draws nothing at all when the planner has nothing to say', async ({ page }) => {
    await inSeason(page);
    await settledRoster(page);
    await withPlan(page, plan({ surface: false, decision: 'hold', headline: '' }));
    await openTeam(page);

    await expect(page.getByTestId('dst-line')).toHaveCount(0);
  });
});

test.describe('the defence on the Waivers board', () => {
  test('appears as a row, with the club rather than a headshot', async ({ page }) => {
    await inSeason(page);
    await withPlan(page, plan());
    await openWaivers(page);

    const row = page.locator('[data-testid="waiver-row"][data-position="DEF"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('New York Jets');
    await expect(row.getByTestId('waiver-strength')).toHaveText('Stream');
    /*
     * The identity cluster draws the club — a mark, or its letters when the
     * mark cannot be loaded. What matters is that the row identifies a *team*:
     * there is no field on a waiver row a player headshot could come from, and
     * a defence identified by nothing would draw the position pill alone.
     */
    await expect(row.locator('[data-testid="team-logo"][data-team="NYJ"], [data-testid="team-code"]')).toHaveCount(1);
  });

  test('is filterable, like every other position on the board', async ({ page }) => {
    await inSeason(page);
    await withPlan(page, plan());
    await openWaivers(page);

    await page.getByTestId('waiver-filter-def').click();
    await expect(page.locator('[data-testid="waiver-row"][data-position="DEF"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="waiver-row"]:not([data-position="DEF"])')).toHaveCount(0);
  });

  test('is said once — the row, or the line, never both', async ({ page }) => {
    await inSeason(page);
    await withPlan(page, plan());
    await openWaivers(page);

    await expect(page.locator('[data-testid="waiver-row"][data-position="DEF"]')).toBeVisible();
    await expect(page.getByTestId('dst-line')).toHaveCount(0);
  });

  test('falls back to the line for a state that names nobody', async ({ page }) => {
    await inSeason(page);
    await withPlan(
      page,
      plan({ decision: 'hold', headline: 'Hold BUF — next 3 favourable', target: null, gain: 0.7 }),
    );
    await openWaivers(page);

    await expect(page.getByTestId('dst-headline')).toHaveText('Hold BUF — next 3 favourable');
    await expect(page.locator('[data-testid="waiver-row"][data-position="DEF"]')).toHaveCount(0);
  });

  test('is silent on the deployment’s own data, which has not drafted', async ({ page }) => {
    /*
     * No interception. The demo league's draft is live, and a manager mid-draft
     * has no weekly acquisition pressure — so the correct number of defence
     * surfaces on this page is zero, and it is asserted against the real
     * endpoint rather than against a fixture.
     */
    await inSeason(page);
    await openWaivers(page);

    await expect(page.getByTestId('dst-line')).toHaveCount(0);
    await expect(page.locator('[data-testid="waiver-row"][data-position="DEF"]')).toHaveCount(0);
  });
});
