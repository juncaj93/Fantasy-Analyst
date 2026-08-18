/**
 * Waivers: the destination that arrives when Draft leaves, and the page behind
 * it.
 *
 * Two things are being defended, and they are separable on purpose.
 *
 * The first is the swap. One slot in the toolbar is seasonal, and exactly one
 * of Draft and Waivers is ever in it — a bar that showed both would be seven
 * destinations on a 360px phone, and one that showed neither would strand the
 * reader. The season state is stubbed rather than waited for, because the demo
 * deployment is in preseason and will be until September.
 *
 * The second is the page. It is a shell over data the league-intelligence pass
 * has not produced yet, so most of these assertions are about what it does
 * *not* say: no invented FAAB figure, no fabricated competition, no multi-week
 * verdict nobody computed.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * The app, told the regular season is under way.
 *
 * `/api/overview` is the one place the toolbar reads the season from, so this
 * is the whole of the fixture — no clock is moved and no league is edited.
 */
async function inSeason(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: {
          phase: 'regular',
          draftVisible: false,
          reason: 'the regular season is under way (week 3)',
          assumed: false,
        },
      }),
    });
  });
}

async function openWaivers(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

test.describe('the seasonal slot in the toolbar', () => {
  test('carries Draft before the season and Waivers once it starts', async ({ page }) => {
    await page.goto('/');
    // Preseason, as the demo deployment actually is.
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('tab-waivers')).toHaveCount(0);

    await inSeason(page);
    await page.reload();
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
  });

  /** Immediately to the right of Team, which is the screen it belongs beside. */
  test('puts Waivers next to Team', async ({ page }) => {
    await inSeason(page);
    await page.goto('/');
    const ids = await page.locator('.tabbar button').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-testid')),
    );
    expect(ids.indexOf('tab-waivers')).toBe(ids.indexOf('tab-team') + 1);
  });

  /**
   * The bar is sized by its contents, so the swap costs it nothing — but that
   * is a claim about a stylesheet, and this is the assertion that it is true at
   * every width this suite runs at.
   */
  test('keeps the toolbar on one row and inside the screen', async ({ page }) => {
    await inSeason(page);
    await page.goto('/');
    const bar = page.locator('.tabbar');
    const box = (await bar.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.width).toBeLessThanOrEqual(width);
    // One row: the pill is a single tap target tall plus its own padding.
    expect(box.height).toBeLessThan(80);
    const tops = await bar.locator('button').evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size, 'every destination should sit on one line').toBe(1);
  });

  /** The board is not deleted, only demoted — the screen still renders. */
  test('leaves the draft screen reachable when the reader is already on it', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    await inSeason(page);
    await expect(page.getByTestId('board-list')).toBeVisible();
  });
});

test.describe('the waivers page', () => {
  test.beforeEach(async ({ page }) => openWaivers(page));

  test('lists who is available as one decision per player', async ({ page }) => {
    const rows = page.getByTestId('waiver-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByTestId('waiver-fit')).toContainText(/Upgrades|Fills/);
    await expect(rows.first().getByTestId('waiver-short-term')).toContainText('pts');
  });

  /**
   * The rule this page exists to keep.
   *
   * Expected cost, likely competition and multi-week value are facts about the
   * twelve people in your league. Until that pass lands they are dashes with an
   * explanation attached, and the page says so once at the bottom.
   */
  test('never invents an expected cost', async ({ page }) => {
    const row = page.getByTestId('waiver-row').first();
    expect(await row.getByTestId('waiver-cost').innerText()).not.toMatch(/\d/);
    await expect(page.getByTestId('waivers-pending')).toContainText('shown as unknown rather than estimated');

    await row.click();
    const sheet = page.getByTestId('waiver-detail');
    await expect(sheet).toBeVisible();
    for (const field of ['Expected cost', 'Competition', 'Beyond this week']) {
      await expect(sheet).toContainText(field);
    }
    // Every one of the three is the unknown mark rather than a number.
    expect(await sheet.getByTestId('waiver-unknown').count()).toBeGreaterThanOrEqual(3);
  });

  test('filters by position without offering a chip that empties the list', async ({ page }) => {
    const filters = page.getByTestId('waiver-filters');
    await expect(filters).toBeVisible();
    const chips = await filters.locator('button').allInnerTexts();
    expect(chips[0]!.trim()).toBe('ALL');

    for (const chip of chips.slice(1)) {
      const position = chip.trim();
      await filters.locator('button', { hasText: new RegExp(`^${position}$`) }).first().click();
      const rows = page.getByTestId('waiver-row');
      await expect(rows.first()).toBeVisible();
      if (position === 'FLEX') {
        for (const row of await rows.all()) {
          expect(['RB', 'WR', 'TE']).toContain(await row.getAttribute('data-position'));
        }
      } else {
        for (const row of await rows.all()) {
          expect(await row.getAttribute('data-position')).toBe(position);
        }
      }
    }
  });

  /** No second way to ask. The gesture is the way. */
  test('offers no refresh button, and does pull to refresh', async ({ page }) => {
    const labels = (await page.locator('button:visible').allInnerTexts()).join(' | ').toLowerCase();
    expect(labels).not.toContain('refresh');

    let called = 0;
    await page.route('**/api/startsit/refresh', async (route) => {
      called += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          deduped: false,
          sources: [],
          headline: 'Already current',
          complete: true,
        }),
      });
    });

    const box = (await page.getByTestId('waivers-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 40;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
    await page.mouse.up();

    await expect.poll(() => called, { timeout: 10_000 }).toBe(1);
  });

  /** Advisory in every sense: there is no control here that transacts. */
  test('offers nothing that would make a claim', async ({ page }) => {
    await expect(page.locator('body')).toContainText('add or drop in Sleeper');
    const buttons = (await page.locator('button:visible').allInnerTexts()).join(' ').toLowerCase();
    for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
      expect(buttons, `a control reading "${forbidden}" would imply a transaction`).not.toContain(forbidden);
    }
  });

  /** Nothing on this page may widen it. */
  test('fits the phone', async ({ page }) => {
    const width = page.viewportSize()!.width;
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(width);
  });
});
