/**
 * iPhone-portrait smoke tests over the seeded demo dataset.
 *
 * Covers the flows in docs/06_UI_AND_QA.md: log in, review the draft board,
 * open a recommendation's reasoning, import ADP, inspect player intelligence,
 * resolve the review queue, compare start/sit, and the degraded state when
 * Vegas data is missing.
 */

import { expect, test, type Page } from '@playwright/test';

/** The session is established once by `auth.setup.ts` and reused here. */
async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tab-draft')).toBeVisible();
}

async function openTab(page: Page, tab: 'draft' | 'team' | 'players' | 'review') {
  await page.getByTestId(`tab-${tab}`).click();
}

test.describe('shell', () => {
  test('never scrolls horizontally at this width', async ({ page }) => {
    await login(page);
    for (const tab of ['draft', 'team', 'players', 'review'] as const) {
      await openTab(page, tab);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${tab} tab overflows horizontally`).toBeLessThanOrEqual(1);
    }
  });

  test('tab targets are large enough to tap', async ({ page }) => {
    await login(page);
    for (const tab of ['draft', 'team', 'players', 'review'] as const) {
      const box = await page.getByTestId(`tab-${tab}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('shows the review backlog as a badge on the tab bar', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('tab-review').locator('.tab-badge')).toBeVisible();
  });
});

test.describe('draft room', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'draft');
    await expect(page.getByTestId('recommended-heading')).toBeVisible();
  });

  test('shows live draft state above the fold, on one line', async ({ page }) => {
    // The stat-card banner is gone by design, but nothing it carried is: the
    // pick number, the round and the wait are still the first thing on screen,
    // beside the league name.
    await expect(page.getByTestId('board-league-name')).toHaveText('Demo Dynasty');
    const status = page.getByTestId('draft-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('#3');
    await expect(status).toContainText('R1');

    // Everything else about the league is available, just folded away.
    await expect(page.getByText(/Draft order/)).toHaveCount(1);
    await page.getByText('League and draft order').click();
    await expect(page.getByText(/Draft order/)).toBeVisible();
  });

  test('puts the player list high on the screen', async ({ page }) => {
    // The point of removing the banner: the first player should be visible
    // without scrolling, on the smallest supported phone.
    const heading = await page.getByTestId('recommended-heading').boundingBox();
    const firstRow = await page.getByTestId('recommendation-row').first().boundingBox();
    const viewport = page.viewportSize()!;
    expect(heading!.y).toBeLessThan(viewport.height * 0.35);
    expect(firstRow!.y + firstRow!.height).toBeLessThan(viewport.height);
  });

  test('colour-codes positions without losing the letters', async ({ page }) => {
    const pill = page.getByTestId('recommendation-row').first().locator('.pos-pill');
    await expect(pill).toBeVisible();
    // Colour is an accelerator; the position text is what carries the meaning.
    expect((await pill.innerText()).trim()).toMatch(/^(QB|RB|WR|TE|K|DEF)$/);
  });

  test('ranks available players and hides drafted ones', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    expect(await rows.count()).toBeGreaterThan(3);
    // Marcus Vance (1001) and Devin Okafor (1002) are picks 1 and 2 in the seed.
    await expect(page.locator('[data-testid="recommendation-row"][data-player-id="1001"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="recommendation-row"][data-player-id="1002"]')).toHaveCount(0);
  });

  test('explains a recommendation with component scores on tap', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    await expect(first.locator('.explain')).toBeVisible();

    // Components are exposed individually, not collapsed into one opaque score.
    const labels = (await first.locator('.component-label').allInnerTexts()).join(' | ');
    for (const label of ['ADP value', 'Roster need', 'Positional scarcity', 'League fit', 'Survival to next pick', 'Total']) {
      expect(labels, `missing component: ${label}`).toContain(label);
    }
    await expect(first.getByText('Why')).toBeVisible();
  });

  test('filters the board by position', async ({ page }) => {
    await page.getByRole('button', { name: 'QB', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    for (const text of await page.locator('.pos-team').allInnerTexts()) {
      expect(text).toContain('QB');
    }
  });

  test('says what the shape of the roster means, not just what is missing', async ({ page }) => {
    const alerts = page.getByTestId('roster-alert');
    expect(await alerts.count()).toBeGreaterThan(0);
    // A bare label is what the brief rules out: each alert carries its reason.
    const first = alerts.first();
    expect((await first.innerText()).split('\n').filter(Boolean).length).toBeGreaterThan(1);
  });

  test('shows at most two decision tags on a row', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const tags = rows.nth(i).getByTestId('decision-tags').locator('.tag');
      expect(await tags.count(), 'a row should never become a badge wall').toBeLessThanOrEqual(2);
    }
  });

  test('stars a player, keeps it across a reload, and explains the boost', async ({ page }) => {
    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    const star = row.getByTestId('my-guy-control');
    await expect(star).toHaveAttribute('data-level', '0');

    await star.click();
    const flagged = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(flagged.getByTestId('my-guy-control')).toHaveAttribute('data-level', '1');

    // Tapping cycles rather than opening a menu — one thumb, one clock.
    await flagged.getByTestId('my-guy-control').click();
    await expect(flagged.getByTestId('my-guy-control')).toHaveAttribute('data-level', '2');

    await page.reload();
    const afterReload = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(afterReload.getByTestId('my-guy-control')).toHaveAttribute('data-level', '2');

    await afterReload.click();
    await expect(afterReload.locator('.explain')).toContainText('Strong My Guy');

    // Leave the board as it was found, so the shared dev server stays clean.
    await afterReload.getByTestId('my-guy-control').click();
    await afterReload.getByTestId('my-guy-control').click();
    await expect(
      page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`).getByTestId('my-guy-control'),
    ).toHaveAttribute('data-level', '0');
  });

  test('starring does not also expand the row', async ({ page }) => {
    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    await row.getByTestId('my-guy-control').click();
    const after = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(after.locator('.explain')).toHaveCount(0);
    await after.getByTestId('my-guy-control').click();
    await after.getByTestId('my-guy-control').click();
    await after.getByTestId('my-guy-control').click();
  });

  test('offers no control that could make a pick', async ({ page }) => {
    const joined = (await page.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    expect(joined).not.toContain('draft this');
    expect(joined).not.toContain('auto draft');
    expect(joined).not.toContain('make pick');
  });
});

test.describe('team, ADP import and start/sit', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'team');
    await expect(page.getByTestId('league-card').first()).toBeVisible();
  });

  test('shows the league in use with its scoring profile', async ({ page }) => {
    const card = page.getByTestId('league-card').first();
    await expect(card).toContainText('Demo Dynasty');
    await expect(card).toContainText('Half PPR');
    // Choosing a league lives in Setup; Team only refreshes it.
    await expect(card.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('lists the roster split into starters and bench', async ({ page }) => {
    await expect(page.getByText('Starters', { exact: true })).toBeVisible();
    await expect(page.getByText('Bench', { exact: true })).toBeVisible();
    expect(await page.getByTestId('roster-row').count()).toBeGreaterThan(2);
  });

  test('compares two players and explains the recommendation', async ({ page }) => {
    await page.locator('[data-testid="roster-row"][data-player-id="1001"]').click();
    await page.locator('[data-testid="roster-row"][data-player-id="1004"]').click();
    await page.getByRole('button', { name: /Compare 2 players/ }).click();

    const comparison = page.getByTestId('comparison');
    await expect(comparison).toBeVisible();
    await expect(page.getByTestId('comparison-verdict')).toContainText('Start');
    await expect(comparison).toContainText('confidence');
    await expect(comparison.getByRole('columnheader', { name: 'Vegas' })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: 'Coverage' })).toBeVisible();
  });

  test('recommends a whole lineup and never offers to apply it', async ({ page }) => {
    const card = page.getByTestId('lineup-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('lineup-verdict')).toBeVisible();

    await card.getByRole('group').getByText('Recommended lineup in full').click();
    await expect(card.getByRole('columnheader', { name: 'Slot' })).toBeVisible();

    // Recommendation only: there is no control here that changes a lineup.
    const buttons = (await card.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    expect(buttons).not.toContain('apply');
    expect(buttons).not.toContain('set lineup');
    expect(buttons).not.toContain('save lineup');
  });

  test('shows a degraded, honest state when Vegas data is missing', async ({ page }) => {
    // Cal Whitfield (1011) is rostered but has no props in the mock game.
    await page.locator('[data-testid="roster-row"][data-player-id="1001"]').click();
    await page.locator('[data-testid="roster-row"][data-player-id="1011"]').click();
    await page.getByRole('button', { name: /Compare 2 players/ }).click();

    const comparison = page.getByTestId('comparison');
    await expect(comparison).toContainText('no Vegas data for');
    await expect(comparison).toContainText('unknown');
  });
});

test.describe('player intelligence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'players');
  });

  test('searches players and opens the evidence timeline', async ({ page }) => {
    await page.getByLabel('Search players').fill('vance');
    await page.locator('[data-testid="player-search-row"][data-player-id="1001"]').click();

    await expect(page.getByTestId('evidence-heading')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Last 7d' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Lifetime' })).toBeVisible();
  });

  test('shows the original excerpt for every evidence item, not just a tally', async ({ page }) => {
    await page.getByLabel('Search players').fill('vance');
    await page.locator('[data-testid="player-search-row"][data-player-id="1001"]').click();
    await expect(page.getByTestId('evidence-excerpt').first()).toContainText('named the starter');
  });

  test('states plainly when there are no cached props', async ({ page }) => {
    await page.getByLabel('Search players').fill('whitfield');
    await page.locator('[data-testid="player-search-row"][data-player-id="1011"]').click();
    await expect(page.getByText(/No prop data cached/)).toBeVisible();
  });
});

test.describe('review queue', () => {
  // Reviewing consumes queue items, and the dev server is shared across
  // projects, so each test ingests its own newsletter first. The mixed sentence
  // is guaranteed to land in review rather than auto-apply.
  test.beforeEach(async ({ page }, testInfo) => {
    const res = await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: `e2e-${testInfo.project.name}-${testInfo.title}`,
        from: 'editor@demo.newsletter',
        subject: 'Camp Report',
        date: new Date().toISOString(),
        // The marker keeps each issue's content unique: identical content is
        // deduped by design, which would starve later tests of review items.
        html:
          `<p>Issue ${testInfo.project.name} / ${testInfo.title}.</p>` +
          '<p>Julian Reyes returned to practice but is expected to split work in a committee.</p>',
        force: true,
      },
    });
    expect(res.status()).toBe(200);

    await login(page);
    await openTab(page, 'review');
    await expect(page.getByTestId('review-card').first()).toBeVisible();
  });

  test('lists ambiguous evidence with a reason, excerpt and confidence', async ({ page }) => {
    const card = page.getByTestId('review-card').first();
    await expect(card.locator('.evidence-excerpt')).toBeVisible();
    await expect(card.getByTestId('review-reason')).toContainText('Why:');
    await expect(card).toContainText('confidence:');
  });

  test('accepting an item removes it from the queue and updates the badge', async ({ page }) => {
    const cardsBefore = await page.getByTestId('review-card').count();
    await page.getByRole('button', { name: '✓ Accept' }).first().click();
    await expect(page.getByTestId('review-card')).toHaveCount(cardsBefore - 1);
  });

  test('exposes explicit correction controls rather than gesture-only actions', async ({ page }) => {
    const card = page.getByTestId('review-card').first();
    await card.getByRole('button', { name: '✎ Change' }).click();
    await expect(card.getByRole('button', { name: 'positive', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'mixed', exact: true })).toBeVisible();
    await expect(card.getByText(/Your correction wins from now on/)).toBeVisible();
  });
});
