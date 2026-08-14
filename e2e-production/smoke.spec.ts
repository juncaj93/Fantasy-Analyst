/**
 * The deployed site, on an iPhone, read-only.
 *
 * This suite runs against production rather than a dev server, which makes it a
 * different kind of test from everything in `e2e/`: it may not write, it may not
 * assume the demo data, and it has to be true of whatever real league and real
 * newsletter happen to be loaded that day. So it asserts the *shell* — that the
 * app arrived, that every screen has its navigation bar, that the tab bar is the
 * height it is supposed to be, that nothing scrolls sideways at any supported
 * width in either theme, and that the numbers a fantasy screen exists to show
 * are on screen — and it asserts them at the three portrait widths from
 * docs/06_UI_AND_QA.md.
 *
 * It writes nothing. Every request it makes is a GET the public site already
 * answers to anyone, and the one write it does attempt is the one that must be
 * refused.
 *
 *   PRODUCTION_URL=https://… npx playwright test --config playwright.production.config.ts
 */

import { expect, test, type Page } from '@playwright/test';

const TABS = ['draft', 'team', 'trades', 'players', 'review', 'setup'] as const;

async function open(page: Page, tab: (typeof TABS)[number]) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(400);
}

/**
 * Wait for a list to answer before deciding it is empty.
 *
 * These tests skip themselves when a deployment has no league connected, which
 * is honest — but a fixed pause plus a bare `count()` cannot tell "nothing to
 * show" from "not back yet", and production is a real database behind a cold
 * worker. On one run that difference silently skipped four of the assertions
 * that matter most, and a skipped test reads exactly like a passing one.
 *
 * So the wait is for an outcome rather than for a duration: rows, or the empty
 * state that means there genuinely are none.
 */
async function settled(page: Page, rowTestId: string): Promise<number> {
  const rows = page.getByTestId(rowTestId);
  await Promise.race([
    rows.first().waitFor({ state: 'visible', timeout: 20_000 }),
    page.locator('.empty, .spinner').first().waitFor({ state: 'visible', timeout: 20_000 }),
  ]).catch(() => {
    /* Neither arrived; the count below reports what is actually there. */
  });
  // A skeleton is still "not back yet", so give the fetch behind it a moment.
  if ((await rows.count()) === 0 && (await page.getByTestId('draft-skeleton').count()) > 0) {
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  }
  return rows.count();
}

test.describe('the deployed app', () => {
  test('loads, and lands on a tab bar with all six destinations', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await expect(page.getByTestId(`tab-${tab}`), `${tab} is missing`).toBeVisible();
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is not a full target`).toBeGreaterThanOrEqual(44);
    }
    // The bar owns the bottom of the screen and nothing sits under it.
    const gap = await page.evaluate(() => {
      const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
      return Math.round(window.innerHeight - nav.bottom);
    });
    expect(gap).toBe(0);
  });

  test('every screen has a compact navigation bar, and none is a banner', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await open(page, tab);
      const bar = page.locator('.nav-bar').first();
      await expect(bar, `${tab} has no navigation bar`).toBeVisible();
      const box = (await bar.boundingBox())!;
      expect(box.height, `${tab}'s bar is ${box.height}px`).toBeLessThanOrEqual(72);
    }
  });

  test('nothing scrolls sideways, on any screen, in either theme', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const tab of TABS) {
        await open(page, tab);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${tab} overflows sideways in ${theme}`).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * The draft board is the reason the app exists, so its four numbers are
   * checked as text rather than as a screenshot: Score, ADP, Val and Next, on
   * the metrics line, with the tally beside the name.
   */
  test('the draft board still reads Score · ADP · Val · Next', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');

    const rows = page.getByTestId('recommendation-row');
    // A deployment with no league connected has an honest empty state instead,
    // and that is not a failure of this pass — but "not back yet" is not that.
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const metrics = await rows.first().locator('.player-row-metrics').innerText();
    expect(metrics).toMatch(/Score\s+\d{1,3}/);
    expect(metrics).toContain('ADP');
    expect(metrics).toMatch(/\bVal\b/);
    expect(metrics).toMatch(/\bNext\b/);

    // The position is still written in letters, not only painted.
    const badge = (await rows.first().locator('.pos-pill').innerText()).trim();
    expect(badge).toMatch(/^(QB|RB|WR|TE|K|DEF)$/);

    // And the live state is in the bar, where it cannot scroll away.
    await expect(page.getByTestId('draft-status')).toBeVisible();
  });

  test('the board starts high on the page and shows several players', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    const count = await settled(page, 'recommendation-row');
    test.skip(count === 0, 'no draft board on this deployment');

    const viewport = page.viewportSize()!;
    const first = (await rows.first().boundingBox())!;
    expect(first.y).toBeLessThan(viewport.height * 0.35);

    let visible = 0;
    for (let i = 0; i < count; i++) {
      const box = await rows.nth(i).boundingBox();
      if (box && box.y + box.height <= viewport.height - 50) visible++;
    }
    expect(visible, 'the first screen should be mostly players').toBeGreaterThanOrEqual(5);
  });

  test('a player card opens in place and closes again', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const first = rows.first();
    await first.click();
    await expect(first.getByTestId('player-detail')).toBeVisible();
    // It fits on the screen rather than becoming a page of its own.
    expect((await first.boundingBox())!.height).toBeLessThan(page.viewportSize()!.height);
    await first.locator('.row-button').click();
  });

  test('Setup reads as a settings screen, and every area opens and comes back', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await expect(page.getByTestId('appearance')).toBeVisible();

    for (const id of ['sleeper', 'league', 'adp', 'newsletter', 'vegas']) {
      const row = page.getByTestId(`setup-step-${id}`);
      await expect(row, `${id} is missing`).toBeVisible();
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await page.getByTestId('setup-step-vegas').click();
    await expect(page.getByTestId('panel-vegas')).toBeVisible();
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });

  test('the three appearances all apply, and none of them hides the text', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');

    await page.getByTestId('appearance-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByTestId('appearance-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).not.toBe(dark);

    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    expect(text).not.toBe(light);

    // Back to following the phone, which is the default and what the next
    // visitor should get.
    await page.getByTestId('appearance-system').click();
    expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
  });

  test('a player opens in place, carrying his whole file', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const rows = page.getByTestId('player-search-row');
    test.skip((await settled(page, 'player-search-row')) === 0, 'no player list on this deployment');

    const first = rows.first();
    await first.click();
    await expect(first.getByTestId('player-file')).toBeVisible();
    await expect(first.getByTestId('evidence-heading')).toBeVisible();
    // A disclosure, not a screen: the list is still underneath it.
    expect(await rows.count()).toBeGreaterThan(0);
    expect(new URL(page.url()).pathname).toBe('/');
    await first.locator('.row-button').click();
  });

  test('Setup’s areas are pushed screens, and the edge stays Safari’s in a tab', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await page.getByTestId('setup-step-vegas').click();
    const pushed = page.getByTestId('setup-detail-vegas');
    await expect(pushed).toBeVisible();
    // In a browser tab the edge belongs to Safari, and the app says so.
    await expect(pushed).toHaveAttribute('data-swipe-back', 'off');
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });

  test('the board can be searched, and the search can be cleared', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    const search = page.getByTestId('draft-search');
    await expect(search).toBeVisible();

    const rows = page.getByTestId('recommendation-row');
    const before = await settled(page, 'recommendation-row');
    test.skip(before === 0, 'no draft board on this deployment');
    const name = (await rows.first().locator('.player-name').innerText()).split(' ').pop()!;

    await search.fill(name);
    // Narrowing is what the search is for; the board never grows because of it.
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(before);
    expect(await rows.count()).toBeGreaterThan(0);

    // Clearing puts the board back to its own length, and keeps it there: the
    // deeper slice the search fetched must never be what the board shows.
    await page.getByTestId('search-clear').click();
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(before);
    await page.waitForTimeout(1200);
    expect(await rows.count(), 'the board settles at its own length').toBe(before);
  });

  test('is installable, and still refuses a write from a stranger', async ({ page, request }) => {
    await page.goto('/');
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).display).toBe('standalone');

    // Reading is public; changing anything is not. This is the one request in
    // the suite that is not a GET, and it must be refused.
    const write = await request.post('/api/sleeper/sync-players', { failOnStatusCode: false });
    expect([401, 503]).toContain(write.status());
  });
});
