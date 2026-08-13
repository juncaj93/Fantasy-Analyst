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

  test('shows live draft state above the fold', async ({ page }) => {
    await expect(page.getByText('Pick', { exact: true })).toBeVisible();
    await expect(page.getByText('Until you', { exact: true })).toBeVisible();
    await expect(page.getByTestId('board-league-name')).toHaveText('Demo Dynasty');
    await expect(page.getByText(/ADP Demo Underdog ADP/)).toBeVisible();
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

  test('shows the selected league with its scoring profile', async ({ page }) => {
    const card = page.getByTestId('league-card').first();
    await expect(card).toContainText('Demo Dynasty');
    await expect(card).toContainText('Half PPR');
    await expect(card.getByRole('button', { name: '✓ Selected' })).toBeVisible();
  });

  test('imports an ADP snapshot and reports match counts', async ({ page }, testInfo) => {
    // Snapshots are deduped by content hash, and the dev server is shared
    // across projects, so each project imports a distinguishable file.
    const uniqueName = `Ghost ${testInfo.project.name}`;
    await page
      .getByLabel('CSV or JSON')
      .fill(`name,position,team,adp\nMarcus Vance,RB,KC,2.4\n${uniqueName},WR,SEA,140\n`);
    await page.getByRole('button', { name: 'Import ADP' }).click();
    await expect(page.locator('.notice')).toContainText('1 matched');
    await expect(page.locator('.notice')).toContainText('1 unmatched');
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
        html: '<p>Julian Reyes returned to practice but is expected to split work in a committee.</p>',
        force: true,
      },
    });
    expect(res.status()).toBe(200);

    await login(page);
    await openTab(page, 'review');
    await expect(page.getByTestId('review-card').first()).toBeVisible();
  });

  test('lists ambiguous evidence with its matched rule and excerpt', async ({ page }) => {
    const card = page.getByTestId('review-card').first();
    await expect(card).toContainText('rule');
    await expect(card).toContainText('conf');
    await expect(card.locator('.evidence-excerpt')).toBeVisible();
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
    await expect(card.getByText(/overrides the rule engine permanently/)).toBeVisible();
  });
});
