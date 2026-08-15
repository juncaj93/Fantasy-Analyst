/**
 * The deployed site, on an iPhone, read-only.
 *
 * This suite runs against production rather than a dev server, which makes it a
 * different kind of test from everything in `e2e/`: it may not write, it may not
 * assume the demo data, and it has to be true of whatever real league and real
 * newsletter happen to be loaded that day. So it asserts the *shell* — that the
 * app arrived, that every screen has its navigation bar, that the floating
 * toolbar is the size and in the place it is supposed to be, that nothing
 * scrolls sideways at any supported width in either theme, and that the numbers
 * a fantasy screen exists to show are on screen — and it asserts them at the
 * three portrait widths from docs/06_UI_AND_QA.md.
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
  test('loads, and lands on a floating toolbar with all six destinations', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await expect(page.getByTestId(`tab-${tab}`), `${tab} is missing`).toBeVisible();
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is not a full target`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is not a full target`).toBeGreaterThanOrEqual(44);
    }

    /*
     * The toolbar floats clear of the bottom edge rather than sitting on it,
     * so what is below it is a number the design chooses — `--toolbar-gap`,
     * which on a screen with a home indicator is what keeps the destinations
     * off it. Anything more than that gap is the page holding space it should
     * not, which is the bug this has always been watching for.
     */
    const bar = await page.evaluate(() => {
      const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:var(--toolbar-gap)';
      document.body.append(probe);
      const intended = Math.round(Number.parseFloat(getComputedStyle(probe).paddingBottom));
      probe.remove();
      return {
        gap: Math.round(window.innerHeight - nav.bottom),
        intended,
        width: Math.round(nav.width),
        height: Math.round(nav.height),
        viewportWidth: window.innerWidth,
      };
    });
    expect(bar.gap, 'the page owns only the gap the toolbar floats by').toBe(bar.intended);
    // A compact pill, not a band with a gutter.
    expect(bar.width, `the bar is ${bar.width}px on a ${bar.viewportWidth}px screen`).toBeLessThanOrEqual(
      bar.viewportWidth - 40,
    );
    expect(bar.height).toBeGreaterThanOrEqual(54);
    expect(bar.height).toBeLessThanOrEqual(64);
  });

  /**
   * The destination that is lit is the screen that is showing.
   *
   * The toolbar keeps no selection of its own, and this is the property that
   * buys: exactly one destination current, and it is the one whose screen is
   * on — including on a nested screen, which belongs to the destination that
   * opened it.
   */
  test('exactly one destination is current, and it is the screen on show', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await open(page, tab);
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    }

    await open(page, 'setup');
    await page.getByTestId('setup-step-vegas').click();
    await expect(page.getByTestId('panel-vegas')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    await page.getByTestId('back-button').click();
  });

  /**
   * The Draft controls, compressed.
   *
   * A search glyph immediately left of the position filters, on one row, and a
   * field that unfolds when it is asked for. What it matches is not this
   * suite's business — production has whatever players it has — but that the
   * control is there, is one row, and opens is.
   */
  test('Draft opens with a search button beside the filters, not a search row', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');

    const controls = page.getByTestId('draft-search-controls');
    await expect(controls).toBeVisible();
    await expect(controls).toHaveAttribute('data-search', 'closed');
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    const row = (await controls.boundingBox())!;
    expect(row.height, `the control row is ${row.height}px`).toBeLessThanOrEqual(52);

    await page.getByTestId('draft-search-open').click();
    const field = page.getByTestId('draft-search');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    // Opening it moves nothing: the row is the same height in both states.
    expect(Math.abs((await controls.boundingBox())!.height - row.height)).toBeLessThanOrEqual(1);

    await page.getByTestId('draft-search-close').click();
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    await expect(page.getByTestId('draft-search-open')).toBeVisible();
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

    /* Above the toolbar's own top edge, asked for rather than guessed. */
    const floor = await page.evaluate(() => document.querySelector('.tabbar')!.getBoundingClientRect().top);
    let visible = 0;
    for (let i = 0; i < count; i++) {
      const box = await rows.nth(i).boundingBox();
      if (box && box.y + box.height <= floor) visible++;
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

    const rows = page.getByTestId('recommendation-row');
    const before = await settled(page, 'recommendation-row');
    test.skip(before === 0, 'no draft board on this deployment');
    const name = (await rows.first().locator('.player-name').innerText()).split(' ').pop()!;

    // The field is folded into a glyph until it is asked for. What it then
    // matches is unchanged, which is what the rest of this test is about.
    await page.getByTestId('draft-search-open').click();
    const search = page.getByTestId('draft-search');
    await expect(search).toBeVisible();

    await search.fill(name);
    // Narrowing is what the search is for; the board never grows because of it.
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(before);
    expect(await rows.count()).toBeGreaterThan(0);

    // Clearing puts the board back to its own length, and keeps it there: the
    // deeper slice the search fetched must never be what the board shows.
    await page.getByTestId('search-clear').click();
    await expect(search, 'clearing empties the field; only Cancel closes it').toBeVisible();
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(before);
    await page.waitForTimeout(1200);
    expect(await rows.count(), 'the board settles at its own length').toBe(before);

    // And Cancel folds it away again, leaving the row as it was.
    await page.getByTestId('draft-search-close').click();
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    await expect(page.getByTestId('draft-search-open')).toBeVisible();
  });

  /**
   * A card may not disagree with itself about last season.
   *
   * The defect this guards against shipped, and looked reasonable on the way
   * out: `8 GP` from Sleeper above `2025: missed 2 games with a toe injury`
   * from the injury report, two correct sources counting different things. It
   * survived every local test because both halves were right in isolation.
   *
   * So this asserts the relationship rather than any player's numbers, against
   * whatever the live board happens to hold: total missed is games available
   * minus games played, injury never explains more absences than there were,
   * and a note that leaves some of them unexplained does not get to read like a
   * complete account of the season.
   */
  test('never states an injury total that contradicts games played', async ({ page, request }) => {
    await page.goto('/');
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const ids = (await rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-player-id'))))
      .filter((id): id is string => !!id)
      .slice(0, 12);
    expect(ids.length, 'the board should carry players to check').toBeGreaterThan(0);

    let checked = 0;
    for (const id of ids) {
      const res = await request.get(`/api/players/${id}/detail`, { failOnStatusCode: false });
      if (res.status() !== 200) continue;
      const detail = await res.json();
      const a = detail.availability;
      if (!a) continue;
      checked++;

      if (a.gamesAvailable != null && a.gamesPlayed != null) {
        expect(a.gamesMissedTotal, `${id}: total missed is not derived from participation`).toBe(
          a.gamesAvailable - a.gamesPlayed,
        );
      }
      if (a.gamesMissedTotal != null) {
        expect(a.injuryAttributedMisses, `${id}: injury explains more games than were missed`).toBeLessThanOrEqual(
          a.gamesMissedTotal,
        );
        expect(a.unresolvedMisses).toBe(a.gamesMissedTotal - a.injuryAttributedMisses);
      }

      // The stat line and the note describe one season, in one set of numbers.
      if (detail.lastSeason?.gamesPlayed != null) {
        expect(a.gamesPlayed, `${id}: the note disagrees with the GP shown above it`).toBe(
          detail.lastSeason.gamesPlayed,
        );
      }

      // An unqualified "missed N games" is a claim about the whole season, and
      // is only available to a note that accounts for the whole season.
      const claim = /missed (\d+) games? with/.exec(detail.injuryContext ?? '');
      if (claim) {
        expect(a.unresolvedMisses, `${id}: "${detail.injuryContext}" leaves absences unexplained`).toBe(0);
      }
    }

    // Nothing to check is a real answer in August — the board may be all
    // rookies and healthy players — but it must not look like a pass.
    test.skip(checked === 0, 'no player on this board has last-season injury history');
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
