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

/**
 * The destinations, in the two shapes the bar has.
 *
 * One slot is seasonal and exactly one of Draft and Waivers is ever in it, so
 * the bar carries six either way: the board while there is still a draft to
 * read, and the waiver wire once the season is under way.
 */
const TABS = ['draft', 'team', 'trades', 'players', 'review', 'setup'] as const;
const IN_SEASON = ['team', 'waivers', 'trades', 'players', 'review', 'setup'] as const;

type Tab = (typeof TABS)[number] | (typeof IN_SEASON)[number];

async function open(page: Page, tab: Tab) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(400);
}

/**
 * Which destinations this deployment should be showing today.
 *
 * The seasonal slot is why this is read rather than hardcoded: a suite that
 * named Draft would start failing on the Tuesday of week one — and failing for
 * the reason the feature exists. The expectation comes from the same answer the
 * app reads, the overview's own `season` block. A deployment that predates that
 * field says nothing, and the app keeps Draft, so that is the fallback.
 */
async function expectedTabs(page: Page): Promise<readonly Tab[]> {
  const overview = await page.evaluate(async () => {
    const res = await fetch('/api/overview');
    return res.ok ? ((await res.json()) as { season?: { draftVisible?: boolean } }) : null;
  });
  return overview?.season?.draftVisible === false ? IN_SEASON : TABS;
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
  test('loads, and lands on a floating toolbar with every destination the season has', async ({ page }) => {
    await page.goto('/');
    const expected = await expectedTabs(page);
    for (const tab of expected) {
      await expect(page.getByTestId(`tab-${tab}`), `${tab} is missing`).toBeVisible();
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is not a full target`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is not a full target`).toBeGreaterThanOrEqual(44);
    }
    // ...and nothing else. The count does not change with the season — Waivers
    // takes the slot Draft leaves — so a bar with a hole in it fails here.
    expect(await page.locator('.tabbar button').count()).toBe(expected.length);
    const packed = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!;
      const style = getComputedStyle(bar);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const buttons = [...bar.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        slack: Math.round(bar.getBoundingClientRect().width - (buttons.reduce((s, b) => s + b.width, 0) + chrome)),
        biggestGap: Math.round(Math.max(...buttons.slice(1).map((b, i) => b.left - buttons[i]!.right))),
      };
    });
    expect(packed.slack, 'the pill is stretched rather than packed').toBeLessThanOrEqual(2);
    expect(packed.biggestGap, 'an empty destination slot was left behind').toBeLessThanOrEqual(2);

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
    for (const tab of await expectedTabs(page)) {
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
    for (const tab of await expectedTabs(page)) {
      await open(page, tab);
      const bar = page.locator('.nav-bar').first();
      await expect(bar, `${tab} has no navigation bar`).toBeVisible();
      const box = (await bar.boundingBox())!;
      expect(box.height, `${tab}'s bar is ${box.height}px`).toBeLessThanOrEqual(72);
    }
  });

  test('nothing scrolls sideways, on any screen, in either theme', async ({ page }) => {
    await page.goto('/');
    const tabs = await expectedTabs(page);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const tab of tabs) {
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

  /**
   * The tier-cliff warning, where the live board happens to have one.
   *
   * It shares the metrics line rather than opening a row of its own, so a
   * warned card is exactly as tall as it would be without the warning. Measured
   * on one card twice, because two live players differ in more than this.
   */
  test('a tier-cliff warning costs its card no height', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const warned = page
      .getByTestId('recommendation-row')
      .filter({ has: page.getByTestId('tier-cliff-tag') })
      .first();
    // A board with no position thinning out has nothing to say here, and that
    // is a fact about today's pool rather than a failure of this layout.
    test.skip((await warned.count()) === 0, 'no tier cliff on the board today');

    const measured = await warned.evaluate((el) => {
      const height = () => Math.round(el.getBoundingClientRect().height);
      const chip = el.querySelector('[data-testid="tier-cliff-tag"]')!;
      const metrics = el.querySelector('.player-row-metrics')!.getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      const withWarning = height();
      const parent = chip.parentElement!;
      chip.remove();
      const without = height();
      parent.append(chip);
      return {
        withWarning,
        without,
        onTheMetricsLine: Math.abs(box.top + box.height / 2 - (metrics.top + metrics.height / 2)) <= 2,
        clearOfMetrics: box.left >= metrics.right,
        metricLines: new Set([...el.querySelectorAll('.metric')].map((m) => Math.round(m.getBoundingClientRect().top)))
          .size,
      };
    });

    expect(measured.withWarning, 'the warning makes the card taller').toBe(measured.without);
    expect(measured.onTheMetricsLine, 'the warning is on a row of its own').toBe(true);
    expect(measured.clearOfMetrics, 'the warning is sitting on the numbers').toBe(true);
    expect(measured.metricLines, 'the numbers wrapped to make room for it').toBe(1);
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

  /**
   * A stranger on the Draft page does not poll Sleeper.
   *
   * The board now syncs itself while a live draft is open — on arrival, on
   * resume, and every few seconds after that. Pulling picks is a write, so it
   * needs the session, and this suite never authenticates: from here the loop
   * must not exist at all. That is the read-only half of the guarantee, and it
   * is the half this suite can prove. The polling itself is exercised where a
   * session exists — `e2e/draft-autorefresh.spec.ts`, against a Sleeper the
   * test controls.
   *
   * The probe's absence is the assertion: it is installed by the controller and
   * removed with it, so "no probe" is exactly "no loop running".
   */
  test('does not poll Sleeper for a reader with no session', async ({ page }) => {
    await page.goto('/');
    const tabs = await expectedTabs(page);
    test.skip(!tabs.includes('draft'), 'Draft is out of season on this deployment');

    await open(page, 'draft');
    let syncs = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/drafts\/.*\/sync/.test(req.url())) syncs++;
    });
    // Two cadences' worth of nothing.
    await page.waitForTimeout(12_000);

    expect(syncs, 'an unauthenticated reader starts no background sync loop').toBe(0);
    expect(
      await page.evaluate(() => typeof (window as unknown as { __draftRefresh?: unknown }).__draftRefresh),
      'and no refresh controller is running',
    ).toBe('undefined');
  });
});

/**
 * The flex view, the recommended lineup and the waiver advice, live.
 *
 * These read the real league rather than the demo one, so they assert what has
 * to be true of *any* roster — the flex view contains only running backs,
 * receivers and tight ends; the starters are the slots this league starts; the
 * waiver card never names a player somebody owns — and they skip themselves
 * honestly when a deployment has nothing loaded, using the same settled-list
 * wait as the rest of the suite so a slow worker is never mistaken for an
 * empty one.
 */
test.describe('the season features', () => {
  test('FLX leaves running backs, receivers and tight ends and nobody else', async ({ page }) => {
    await page.goto('/');
    const expected = await expectedTabs(page);
    test.skip(!expected.includes('draft'), 'the season has started, so there is no draft board to filter');

    await open(page, 'draft');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');
    test.skip((await page.getByTestId('flx-filter').count()) === 0, 'this league starts none of RB, WR or TE');

    await page.getByTestId('flx-filter').click();
    await expect
      .poll(
        async () =>
          page
            .getByTestId('recommendation-row')
            .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-position')))].sort()),
        { timeout: 15_000 },
      )
      .toEqual(['RB', 'TE', 'WR']);
  });

  test('Team shows the league title alone, above starters by slot', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');
    const header = page.getByTestId('league-card').first();
    await expect(header).toBeVisible();

    // The metadata that left the header. Checked as words rather than as a
    // layout, so it stays true whatever the design does next.
    const text = (await header.innerText()).toLowerCase();
    for (const gone of ['ppr', 'teams', 'flex slot', 'pt passing']) {
      expect(text, `the header still prints "${gone}"`).not.toContain(gone);
    }

    test.skip((await settled(page, 'starter-row')) === 0, 'no roster on this deployment');

    // Every slot drawn is a slot this league actually starts, and every filled
    // one carries its position tint plus the word.
    const lineup = await page.evaluate(async () => {
      const overview = await (await fetch('/api/overview')).json();
      const id = overview?.selectedLeague?.id;
      if (!id) return null;
      return (await (await fetch(`/api/leagues/${id}/lineup`)).json()) as {
        found: boolean;
        slots: { slot: string; playerId: string | null }[];
      };
    });
    test.skip(!lineup?.found, 'no roster on this deployment');

    const drawn = await page
      .getByTestId('starter-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slot')));
    expect(drawn).toEqual(lineup!.slots.map((s) => s.slot));

    for (const card of await page.locator('[data-testid="starter-row"][data-starter="true"]').all()) {
      const position = (await card.getAttribute('data-position'))!;
      await expect(card).toHaveClass(new RegExp(`card-pos-${position}\\b`));
      await expect(card).toContainText('Starter');
    }
    // A backup is the same row without the tint, which is the whole visual claim.
    for (const card of await page.getByTestId('bench-row').all()) {
      await expect(card).not.toHaveClass(/card-pos/);
      await expect(card).toContainText('Bench');
    }
  });

  test('the comparison picker opens and reaches beyond the roster', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');
    test.skip((await page.getByTestId('compare-open').count()) === 0, 'no league on this deployment');

    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    // Nothing chosen yet is not a comparison.
    await expect(page.getByTestId('compare-run')).toBeDisabled();

    /*
     * Waited for directly rather than through `settled`.
     *
     * That helper races the rows against the page's own empty state, and the
     * empty state it would find is the one *behind* the sheet — a screen with
     * nothing on it is not the same fact as a picker with nobody in it. Here
     * the rows are the only outcome worth waiting for.
     */
    await page
      .getByTestId('compare-candidate')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => {});
    test.skip((await page.getByTestId('compare-candidate').count()) === 0, 'no player list on this deployment');

    // The pool is the league, not the roster: somebody in it is not owned by
    // the user. (On a real deployment there are thousands who are not.)
    const labels = await page
      .getByTestId('compare-candidate')
      .evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
    expect(labels.some((l) => l.includes('Free agent') || l.includes('Rostered elsewhere'))).toBe(true);

    await page.getByTestId('sheet-close').click();
  });

  test('waiver advice never names a player somebody owns, and promises no transaction', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    const data = await page.evaluate(async () => {
      const overview = await (await fetch('/api/overview')).json();
      const id = overview?.selectedLeague?.id;
      if (!id) return null;
      const [waivers, roster] = await Promise.all([
        (await fetch(`/api/leagues/${id}/waivers`)).json(),
        (await fetch(`/api/leagues/${id}/roster`)).json(),
      ]);
      return { waivers, roster } as {
        waivers: { found: boolean; upgrades: { candidates: { playerId: string }[] }[]; considered: number };
        roster: { starters: { playerId: string }[]; bench: { playerId: string }[] };
      };
    });
    test.skip(!data?.waivers?.found, 'no roster on this deployment');

    const mine = new Set([
      ...data!.roster.starters.map((p) => p.playerId),
      ...data!.roster.bench.map((p) => p.playerId),
    ]);
    for (const upgrade of data!.waivers.upgrades) {
      for (const candidate of upgrade.candidates) {
        expect(mine.has(candidate.playerId), 'a player already on the roster was offered as an add').toBe(false);
      }
    }

    // Whatever it says, it says it is advice.
    const card = page.getByTestId('waiver-card');
    if ((await card.count()) > 0) {
      const buttons = (await card.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
      for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
        expect(buttons, `a control reading "${forbidden}" would imply a transaction`).not.toContain(forbidden);
      }
    }
  });
});

/**
 * The decision intelligence, live.
 *
 * Read-only like the rest of this file, plus the one write that has to be
 * refused: the Start/Sit refresh spends provider quota, so an unauthenticated
 * request for it must come back 401 rather than doing anything.
 *
 * Every assertion here is about *shape* rather than about a number — which
 * components the deployed engine emits, that the caps hold, that a mode change
 * reaches the server — because the numbers belong to whatever real league and
 * real week the deployment happens to be serving.
 */
test.describe('the decision intelligence', () => {
  test('the draft board carries the cost of waiting and NFL-team overlap, both bounded', async ({ page }) => {
    await page.goto('/');
    const expected = await expectedTabs(page);
    test.skip(!expected.includes('draft'), 'the season has started, so there is no draft board');

    const board = await page.evaluate(async () => {
      /*
       * The draft id comes from the league listing, which is where it lives.
       *
       * `/api/overview` reports the selected league as id, name and season and
       * has never carried a draft id, so reading one from it returned undefined
       * every time and skipped this test on every run since it was written --
       * green, and checking nothing. The screen itself reads `/api/leagues`.
       */
      const overview = await (await fetch('/api/overview')).json();
      const selected = overview?.selectedLeague?.id;
      const { leagues = [] } = await (await fetch('/api/leagues')).json();
      const league =
        leagues.find((l: { id: string; draftId: string | null }) => l.id === selected && l.draftId) ??
        leagues.find((l: { draftId: string | null }) => l.draftId);
      if (!league?.draftId) return null;
      return (await fetch(`/api/drafts/${league.draftId}/board?limit=25`)).json() as Promise<{
        recommendations: {
          components: { key: string; contribution: number }[];
          opportunity?: { score: number };
          concentration?: { score: number };
        }[];
      }>;
    });
    test.skip(!board || board.recommendations.length === 0, 'no draft board on this deployment');

    for (const rec of board!.recommendations) {
      const by = (key: string) => rec.components.find((c) => c.key === key);
      const opportunity = by('opportunity');
      const concentration = by('team_concentration');
      expect(opportunity, 'the deployed board has no cost-of-waiting component').toBeTruthy();
      expect(concentration, 'the deployed board has no NFL-team overlap component').toBeTruthy();

      // The caps, checked against the live board rather than against a fixture.
      expect(opportunity!.contribution).toBeGreaterThanOrEqual(0);
      expect(opportunity!.contribution).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.abs(concentration!.contribution)).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });

  test('Start/Sit offers three modes, and asking for one reaches the server', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    const modes = page.getByTestId('mode-row');
    await expect(modes).toBeVisible();
    for (const mode of ['balanced', 'floor', 'ceiling']) {
      await expect(page.getByTestId(`mode-${mode}`)).toBeVisible();
    }
    await expect(page.getByTestId('mode-balanced')).toHaveAttribute('aria-pressed', 'true');

    // The mode is a question asked of the server, not a client-side sort.
    const answered = await page.evaluate(async () => {
      const overview = await (await fetch('/api/overview')).json();
      const id = overview?.selectedLeague?.id;
      if (!id) return null;
      const [floor, ceiling] = await Promise.all([
        (await fetch(`/api/leagues/${id}/lineup?mode=floor`)).json(),
        (await fetch(`/api/leagues/${id}/lineup?mode=ceiling`)).json(),
      ]);
      return { floor: floor?.mode, ceiling: ceiling?.mode };
    });
    test.skip(!answered, 'no league selected on this deployment');
    expect(answered!.floor).toBe('floor');
    expect(answered!.ceiling).toBe('ceiling');
  });

  /**
   * The refresh is a gesture now, and it still refuses a stranger.
   *
   * There is no button to look for: Team is pulled down to reload it, and the
   * two controls that used to do it are gone. What is checked here is what a
   * deployment can actually go wrong about — that the surface the gesture is
   * attached to is on the page, that the accessible fallback exists for anything
   * that cannot make a pointer gesture, and that the write behind both is still
   * closed to somebody with no session. Whether the gesture *arms* at 68px is
   * settled in `tests/pullToRefresh.test.ts` and does not need a live site.
   */
  test('the refresh is reachable, and refuses a stranger', async ({ page, request }) => {
    await page.goto('/');
    await open(page, 'team');
    await expect(page.getByTestId('team-pull')).toBeVisible();
    await expect(page.getByTestId('pull-refresh-fallback')).toHaveCount(1);
    // And the controls it replaced did not come back.
    const labels = (await page.locator('button:visible').allInnerTexts()).join(' | ').toLowerCase();
    expect(labels).not.toContain('refresh');

    // It spends provider quota, so it is a write, and a write from nobody is
    // refused. This suite never authenticates, so the refresh is never run.
    const write = await request.post('/api/startsit/refresh', { failOnStatusCode: false });
    expect([401, 429, 503]).toContain(write.status());
  });

  test('every Start/Sit component the deployed engine emits is one it can explain', async ({ page }) => {
    await page.goto('/');
    const lineup = await page.evaluate(async () => {
      const overview = await (await fetch('/api/overview')).json();
      const id = overview?.selectedLeague?.id;
      if (!id) return null;
      return (await fetch(`/api/leagues/${id}/lineup`)).json() as Promise<{
        found: boolean;
        bench: { components: { key: string; label: string; display: string }[]; drivers?: string[] }[];
      }>;
    });
    test.skip(!lineup?.found || (lineup?.bench ?? []).length === 0, 'no scorable roster on this deployment');

    for (const evaluation of lineup!.bench) {
      for (const component of evaluation.components) {
        // No bare labels: every component says what it measured, which is the
        // rule the whole breakdown rests on.
        expect(component.display.length, `${component.key} has no explanation`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The two markets, on the deployed board.
   *
   * Everything about DOG is provable offline except that it arrived. The
   * snapshot is fetched in CI, imported over HTTP and read back through the
   * ranking, and every step in between can fail without anything breaking: the
   * board keeps working and simply stops mentioning Underdog. That failure has
   * to be visible from here or it is not visible anywhere.
   *
   * Written so that both answers are meaningful. A deployment carrying DOG must
   * show it and must sort by it; a deployment without it must say so on the
   * board rather than leaving a blank column and no explanation. Neither branch
   * is a silent pass, which is the whole point — a test that skipped when the
   * column was empty would go quiet at exactly the moment it mattered.
   */
  test('the board prices against both markets, and says so when it cannot', async ({ page }) => {
    await page.goto('/');
    // The app does not land on Draft, and a test that looked for rows without
    // going there would skip itself on every run and report nothing.
    await open(page, 'draft');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const dog = await page.evaluate(async () => {
      const overview = await (await fetch('/api/overview')).json();
      const selected = overview?.selectedLeague?.id;
      // The draft id lives on the league listing rather than on the overview,
      // so the board is reached the same way the screen reaches it.
      const { leagues = [] } = await (await fetch('/api/leagues')).json();
      const league =
        leagues.find((l: { id: string; draftId: string | null }) => l.id === selected && l.draftId) ??
        leagues.find((l: { draftId: string | null }) => l.draftId);
      if (!league?.draftId) return null;
      const board = await (await fetch(`/api/drafts/${league.draftId}/board?limit=60`)).json();
      return {
        state: board?.dogState ?? null,
        format: board?.marketFormat ?? null,
        withDog: (board?.recommendations ?? []).filter((r: { dogAdp: number | null }) => r.dogAdp != null).length,
      };
    });
    test.skip(!dog, 'no league selected on this deployment');

    if (!dog!.state?.available) {
      // The degraded state is a feature and is allowed — but it must be an
      // explained one. "DOG is missing" and "DOG is missing because the
      // snapshot is nine days old" are different products.
      expect(dog!.state?.reason ?? '', 'an unavailable DOG must say why').not.toBe('');
      return;
    }

    // Provenance travels with the numbers, or they are not usable numbers.
    expect(dog!.state.sourceType).toBe('raw_adp');
    expect(dog!.state.provider).toBeTruthy();
    expect(['fresh', 'aging']).toContain(dog!.state.freshness);
    expect(dog!.withDog).toBeGreaterThan(0);

    // The weights are the format's own, read from Sleeper's settings.
    expect(dog!.format?.weights).toEqual(
      dog!.format?.bestBall ? { dog: 0.75, sleeper: 0.25 } : { dog: 0.6, sleeper: 0.4 },
    );

    // And the column reaches a card rather than stopping at the response.
    await expect(page.getByTestId('board-list')).toHaveAttribute('data-dog', 'yes');
    await expect(page.getByTestId('recommendation-row').first().locator('.player-row-metrics')).toContainText('DOG');
  });

  /**
   * Three orderings of the same rows, against the real board.
   *
   * The guarantee is that switching is a permutation and nothing else: the
   * order changes and every number on every card stays where it was. That is
   * unit-tested, but it is a claim about the deployed bundle, and a bundle is
   * what a user actually gets.
   */
  test('Score, ADP and DOG reorder the deployed board without touching a number', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    test.skip((await settled(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const control = page.getByTestId('draft-sort');
    await expect(control).toBeVisible();
    await expect(page.getByTestId('sort-score')).toHaveAttribute('aria-checked', 'true');

    const snapshot = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        return {
          order: rows.map((r) => r.getAttribute('data-player-id')!),
          numbers: Object.fromEntries(
            rows.map((r) => [
              r.getAttribute('data-player-id')!,
              (r.querySelector('.player-row-metrics')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            ]),
          ),
        };
      });

    const byScore = await snapshot();

    for (const mode of ['adp', 'dog'] as const) {
      const button = page.getByTestId(`sort-${mode}`);
      // DOG is only offered when the board has DOG to sort by, which is the
      // designed behaviour rather than a fault.
      if ((await button.count()) === 0 || !(await button.isEnabled())) continue;

      await button.click();
      await expect(button).toHaveAttribute('aria-checked', 'true');
      const sorted = await snapshot();

      expect(sorted.order.slice().sort(), `${mode} must be the same players`).toEqual(byScore.order.slice().sort());
      for (const [playerId, metrics] of Object.entries(byScore.numbers)) {
        expect(sorted.numbers[playerId], `${mode} changed a number on ${playerId}`).toBe(metrics);
      }
    }

    await page.getByTestId('sort-score').click();
    await expect(page.getByTestId('sort-score')).toHaveAttribute('aria-checked', 'true');
    expect((await snapshot()).order).toEqual(byScore.order);
  });
});
