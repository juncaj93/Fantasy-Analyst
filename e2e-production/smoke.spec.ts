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
 * That sentence was not true until the final audit's F-01 was fixed. This suite
 * navigates to Matchup, and `GET /api/leagues/:id/matchup` used to record both
 * sides of its forecast to the calibration ledger — so every smoke run inserted
 * and updated rows in the deployed database while describing itself as
 * read-only. The write now lives on the worker's own clock. Nothing here
 * exercises it, deliberately: a smoke suite that provoked a calibration write to
 * prove the writer works would be mutating production to test a cron.
 *
 *   PRODUCTION_URL=https://… npx playwright test --config playwright.production.config.ts
 *
 * ---------------------------------------------------------------------------
 * **CI DOES NOT RUN THIS FILE, AND THAT IS WHY IT BREAKS AFTER UI WORK.**
 *
 * `ci.yml` runs `e2e/`. This suite runs only in `smoke.yml`, after a deploy —
 * so the first thing that tells you a UI change invalidated an assertion in
 * here is production going red, minutes after the merge that caused it. That
 * has happened twice.
 *
 * This file keeps its *own copies* of assertions that `e2e/` also makes. When a
 * row, a label, a card, a metric or a navigation path changes shape, both
 * suites have to be reconciled with the intended UI, and this one has to be
 * *run*, not searched. Grep is not proof: the second miss was a grep for `Val`
 * that returned two docblock comments, which read as "no assertions" when the
 * live one sat eleven lines below them.
 *
 * Run it against a local production build before declaring any UI branch
 * merge-ready — it is part of the exact-head gate, not an afterthought:
 *
 *   npm run build && node scripts/build-server.mjs
 *   FA_SEED=1 … node scripts/dev-server.mjs --port 8794 &
 *   PRODUCTION_URL=http://127.0.0.1:8794 \
 *     npx playwright test --config playwright.production.config.ts \
 *     --project=chromium-iphone-390 --project=chromium-small-360
 *
 * A local run against the demo seed is expected to be **green**. It was not,
 * for a long time: two assertions stood red — the Team `Starter` text, stale
 * since the density work moved that word into the row's `aria-label`, and a
 * waiver check that matched `bid` inside `1 likely bidder`. Both were defects
 * in this file rather than in the app, and both are fixed. A standing red that
 * everybody knows to ignore is worse than no test, because the next real
 * failure hides behind it. Any failure here is now yours.
 * ---------------------------------------------------------------------------
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * The destinations, in the shapes the bar has.
 *
 * One slot is seasonal and exactly one of Draft and Waivers is ever in it, so
 * the bar carries five either way: the board while there is still a draft to
 * read, and the waiver wire once the season is under way. Matchup is the
 * exception — it arrives the day a draft completes, which is before Draft
 * leaves, so between those two moments there are six.
 *
 * Review is not a destination. It is maintenance and it lives in Settings; this
 * suite reaches it the way a reader does, through the row there.
 */
const TABS = ['draft', 'team', 'trades', 'players', 'setup'] as const;
const IN_SEASON = ['team', 'waivers', 'trades', 'players', 'setup'] as const;

type Tab = (typeof TABS)[number] | (typeof IN_SEASON)[number] | 'matchup';

/**
 * Tap a destination, and wait for the screen behind it rather than for a clock.
 *
 * This was `click()` and a flat `waitForTimeout(400)` — the pattern `settled`
 * and `settledIds` below were written to retire, kept here because the app is
 * quick and 400ms usually covers it. Usually is the problem: production smoke
 * runs with `retries: 2`, so an assertion that lost the race on the real first
 * attempt and won it on the retry was reported as green with a `flaky` note
 * nobody reads. Three assertions were doing exactly that.
 *
 * The outcome is three facts. The destination is the current one; the screen it
 * leads to has drawn its own navigation bar — every screen draws one in its
 * loading state as well as its loaded one; and that screen's first read has
 * come back, which is what the skeletons and the spinner say while it has not.
 *
 * The third is not decoration. Waiting only for the bar returns *sooner* than
 * the 400ms this replaced, and a dozen gates in this file ask a bare `count()`
 * immediately afterwards — `market-fold-toggle`, `flx-filter` — so an earlier
 * return turns a screen that is merely still loading into "this deployment
 * hasn't got one", which is a silent skip: the exact failure this file's own
 * `settled` was written against. Tolerant on purpose: a screen still loading
 * after twenty seconds is reported by the test's own gate, in that gate's own
 * words, rather than as a timeout in here.
 */
async function open(page: Page, tab: Tab) {
  await page.getByTestId(`tab-${tab}`).click();
  await expect(page.getByTestId(`tab-${tab}`), `${tab} did not become the current destination`).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.nav-bar').first(), `${tab} drew no screen`).toBeVisible();
  await expect(page.locator('.app-main .skeleton, .app-main .spinner'))
    .toHaveCount(0, { timeout: 20_000 })
    .catch(() => {
      /* Still loading; the caller's own gate decides what that means. */
    });
}

/**
 * Read one of the deployed site's own JSON endpoints.
 *
 * Deliberately `page.request` rather than a `fetch` inside `page.evaluate`,
 * which is how every one of these reads was written.
 *
 * These are assertions about the *API*, and running them inside the document
 * bought nothing and cost the suite its first-attempt honesty: a relative URL
 * is resolved against the document, and on the run that prompted this work five
 * of them came back `SyntaxError: The string did not match the expected
 * pattern.` — WebKit's message for a URL it cannot resolve — from evaluates
 * whose first statement is `fetch('/api/overview')`, a literal path with
 * nothing in it to mistype. Each one passed on the retry, so the run reported
 * green. `page.request` shares the browser context's cookies and resolves
 * against the configured `baseURL` instead of against whatever document is
 * current, so there is no such window to lose.
 *
 * Not `ok()` is `null` rather than a throw, which is what the `fetch` version
 * did with a refusal: every caller below already decides for itself whether an
 * absent answer is a skip or a failure.
 */
async function apiJson<T>(page: Page, path: string): Promise<T | null> {
  const res = await page.request.get(path, { failOnStatusCode: false });
  return res.ok() ? ((await res.json()) as T) : null;
}

/**
 * The selected league's id, or null where this deployment has none.
 *
 * Five reads below start with this exact pair of lines; it is one fact about
 * the deployment and is asked for once.
 */
async function selectedLeagueId(page: Page): Promise<string | null> {
  const overview = await apiJson<{ selectedLeague?: { id?: string } }>(page, '/api/overview');
  return overview?.selectedLeague?.id ?? null;
}

/**
 * Whether a draft is running on this deployment, asked of the roster.
 *
 * `null` where no league is selected, which is a skip rather than an answer.
 * Three tests below branch on this, each for the reason written at its own call
 * site: mid-draft Team is a different screen, not a broken one.
 */
async function midDraft(page: Page): Promise<boolean | null> {
  const id = await selectedLeagueId(page);
  if (!id) return null;
  const roster = await apiJson<{ live?: boolean }>(page, `/api/leagues/${id}/roster`);
  return roster?.live === true;
}

/**
 * The draft this deployment has a board for, or null.
 *
 * The id lives on the league listing rather than on the overview — the screen
 * reaches it the same way — and the selected league's own draft is preferred
 * over whichever other league happens to carry one.
 */
async function draftId(page: Page): Promise<string | null> {
  const selected = await selectedLeagueId(page);
  const listing = await apiJson<{ leagues?: { id: string; draftId: string | null }[] }>(page, '/api/leagues');
  const leagues = listing?.leagues ?? [];
  const league = leagues.find((l) => l.id === selected && l.draftId) ?? leagues.find((l) => l.draftId);
  return league?.draftId ?? null;
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
  const overview = await apiJson<{
    season?: { draftVisible?: boolean };
    lifecycle?: { matchupVisible?: boolean };
  }>(page, '/api/overview');
  const base = overview?.season?.draftVisible === false ? IN_SEASON : TABS;
  // Matchup sits immediately after Team, which is the screen it belongs beside.
  // A deployment that predates the field says nothing and gets no Matchup tab,
  // which is what the app itself does with the same absence.
  if (overview?.lifecycle?.matchupVisible !== true) return base;
  const at = base.indexOf('team') + 1;
  return [...base.slice(0, at), 'matchup' as const, ...base.slice(at)];
}

/**
 * Skip when this deployment has no draft board to reach.
 *
 * Draft leaves the bar the moment this league's draft completes — the board
 * exists to help make picks and the picks are made — and everything below that
 * reaches the board reaches it by tapping that destination. So these checks are
 * real for as long as there is a draft to read and honestly inapplicable
 * afterwards, which is a skip rather than a failure.
 *
 * Stated once here rather than inline at each call, because there are fourteen
 * of them and thirteen were missing it: this file is not run by CI, so the
 * first thing that would have reported the omission is production going red
 * minutes after a merge. That has happened twice before, for exactly this
 * reason.
 */
async function requireDraftBoard(page: Page): Promise<void> {
  const tabs = await expectedTabs(page);
  test.skip(!tabs.includes('draft'), 'this league has finished drafting, so the board has left the bar');
}


/**
 * The board's rows, once they have stopped changing.
 *
 * A fixed `waitForTimeout` is not enough against a deployed site. Changing the
 * filter refetches over the network, and the first run of this check read the
 * rows 400ms after the click — before the queue's response had landed — so it
 * captured the *whole board*, and then reported the sort control for
 * re-ordering a list it had never actually been shown.
 *
 * Two consecutive identical reads is the honest signal that the list is the one
 * being looked at rather than the one on its way out.
 */
async function settledIds(page: Page): Promise<string[]> {
  const read = () =>
    page.$$eval('[data-testid="recommendation-row"]', (rows) =>
      rows.map((row) => row.getAttribute('data-player-id') ?? ''),
    );

  let previous = await read();
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(300);
    const current = await read();
    if (current.length === previous.length && current.every((id, i) => id === previous[i])) return current;
    previous = current;
  }
  return previous;
}

/**
 * Open the Trades market inventory, if this deployment has one.
 *
 * The buy/sell/hold board is folded away behind `Explore the market` and its
 * rows are not rendered while it is shut, so a spec that reads a `trade-row`
 * has to ask for it. Deliberately tolerant, like everything else in this file:
 * a deployment with no board draws no control, and that is a skip rather than
 * a failure — the caller's own `present` count decides.
 */
async function exploreMarket(page: Page): Promise<void> {
  const toggle = page.getByTestId('market-fold-toggle');
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** How long to wait for a list nobody has established anything about yet. */
const FIRST_LOOK = 20_000;

/**
 * How long to wait for a list this run has already watched come back empty.
 *
 * Long enough to notice that it has since filled — a board that arrives while
 * the suite is running is still a board this suite should be checking — and
 * short enough that the emptiness is not paid for again at every gate.
 */
const SECOND_LOOK = 2_000;

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
 *
 * The budget is the caller's, because the two questions this file asks of a
 * list cost differently: waiting for a list this deployment is known to have is
 * always worth the full `FIRST_LOOK`, and re-establishing an emptiness that has
 * already been established at length is not. See `present`.
 */
async function settled(page: Page, rowTestId: string, budget = FIRST_LOOK): Promise<number> {
  const rows = page.getByTestId(rowTestId);
  await Promise.race([
    rows.first().waitFor({ state: 'visible', timeout: budget }),
    page.locator('.empty, .spinner').first().waitFor({ state: 'visible', timeout: budget }),
  ]).catch(() => {
    /* Neither arrived; the count below reports what is actually there. */
  });
  // A skeleton is still "not back yet", so give the fetch behind it a moment.
  if ((await rows.count()) === 0 && (await page.getByTestId('draft-skeleton').count()) > 0) {
    await rows.first().waitFor({ state: 'visible', timeout: budget }).catch(() => {});
  }
  return rows.count();
}

/**
 * Wait until an element has stopped moving — two readings in the same place.
 *
 * For grabbing something small on a surface that animates in. A sheet rises
 * over a couple of hundred milliseconds, and a bounding box measured while it
 * is still rising describes where the target *was*.
 */
async function stopsMoving(page: Page, testId: string, tries = 20): Promise<void> {
  let previous = '';
  for (let i = 0; i < tries; i++) {
    const box = await page.getByTestId(testId).boundingBox();
    const here = box ? `${Math.round(box.x)},${Math.round(box.y)}` : '';
    if (here && here === previous) return;
    previous = here;
    await page.waitForTimeout(50);
  }
}

/** What each width has established about each list, keyed by both. */
const established = new Map<string, 'rows' | 'empty'>();

/**
 * Whether this deployment has a list to show at all — asked properly once.
 *
 * Nearly every check below opens a screen and then declines to run when the
 * list it is about is empty, which is honest: production is a real league and a
 * board with nothing on it is a fact about today rather than a defect. But the
 * *question* was being asked from scratch each time, and asking it costs a full
 * `settled()` wait whenever the answer is "nothing" — there are no rows to
 * appear, so the race below runs to its timeout.
 *
 * That is the arithmetic that killed a production run. The board was
 * legitimately empty for a few minutes — its refresh job had died, tracked
 * separately — and the dozen gates in this file each spent twenty-odd seconds
 * discovering it, three times over for the three widths: about thirteen minutes
 * of pure waiting, through the step's twenty-minute ceiling, and the suite was
 * cut off mid-run. The same suite passed in 15m36s once the board filled, so
 * nothing here was broken except how many times it paid for one answer.
 *
 * So the answer is remembered for the width that established it. The first gate
 * to ask about a list pays the full wait; the rest are told. The waiting that
 * matters is kept: a list that has rows is still waited for at full length
 * every time, because "not back yet" must never be read as "nothing to show" —
 * that is the defect `settled()` itself was written for. And an empty verdict
 * is not a sentence: each later gate still looks for `SECOND_LOOK`, so a board
 * that fills halfway through the run is picked up and every gate after it goes
 * back to the full wait.
 *
 * What this does *not* do is decide anything for a list a test has already
 * reached and filtered — see the position loop in the Score-ordering test,
 * which calls `settled()` directly. An empty *filtered* board says nothing
 * about whether this deployment has a board.
 */
async function present(page: Page, rowTestId: string): Promise<number> {
  // Per width: the same deployment, but each project is its own browser and
  // its own run of every gate, and a verdict is only worth as much as the
  // widths it was actually measured at.
  const key = `${test.info().project.name} ${rowTestId}`;
  const count = await settled(page, rowTestId, established.get(key) === 'empty' ? SECOND_LOOK : FIRST_LOOK);
  established.set(key, count === 0 ? 'empty' : 'rows');
  return count;
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
        pageX: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-x')),
      };
    });
    expect(bar.gap, 'the page owns only the gap the toolbar floats by').toBe(bar.intended);
    /*
     * A compact pill, not a band with a gutter — bounded by the page it floats
     * over rather than by a number of its own.
     *
     * This asked for 20px either side, which the bar cleared at every count
     * until the destinations grew: six at 54 come to 336, and 336 is exactly
     * what a 360px phone leaves between the margins every screen's content
     * already keeps. The old bound would have failed the widest bar on the
     * narrowest phone for sitting where the page sits, which is not the bug
     * this is watching for — a band welded across the screen is. Read
     * `--page-x` from the page so the two cannot drift apart silently.
     */
    expect(bar.width, `the bar is ${bar.width}px on a ${bar.viewportWidth}px screen`).toBeLessThanOrEqual(
      bar.viewportWidth - 2 * bar.pageX,
    );
    /*
     * One floor again, at every width and every count.
     *
     * This was two numbers for a while. A seventh destination did not fit at
     * 374px and under, so the stylesheet spent two points of the pill's *own*
     * padding either side to make it — `--toolbar-pad` dropped to 3 and the bar
     * came out 52 there rather than 56 — and this test had to know about it.
     * Review moved into Settings, the widest the bar gets is six, six fit at
     * their full width on the narrowest phone, and the special case is gone
     * along with the rule that made it.
     *
     * The floor that matters is not this one either way: every destination is
     * asserted at 44 by 44 at the top of this same test, at every width, and
     * `toolbar.spec.ts` asserts it in both directions. This band only says the
     * bar is still a pill rather than a band or a sliver.
     */
    expect(bar.height, `the bar is ${bar.height}px with ${expected.length} destinations`).toBeGreaterThanOrEqual(54);
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
    await requireDraftBoard(page);
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
   * The draft board is the reason the app exists, so its numbers are checked as
   * text rather than as a screenshot: Score, the two market deltas and Next, on
   * the metrics line, with the tally beside the name.
   *
   * `Val` used to be one of them. The row prints market *consequence* now —
   * `ADP +3` is three picks ahead of Sleeper's market, `DOG -22` is twenty-two
   * picks past Underdog's — which is the subtraction a reader was doing against
   * the pick on the clock anyway, and `Val` was a third answer to the same
   * question. It moved to the expanded card with both raw markets.
   */
  test('the draft board reads Score · ADP · DOG · Next as market deltas', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');

    const rows = page.getByTestId('recommendation-row');
    // A deployment with no league connected has an honest empty state instead,
    // and that is not a failure of this pass — but "not back yet" is not that.
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const metrics = await rows.first().locator('.player-row-metrics').innerText();
    expect(metrics).toMatch(/Score\s+\d{1,3}/);
    expect(metrics).toContain('ADP');
    expect(metrics).toMatch(/\bNext\b/);
    expect(metrics, 'Val is still on the compact row').not.toMatch(/\bVal\b/);

    // The ADP column is a signed whole number of picks, or an honest unknown —
    // never a raw market position, which is what it used to be.
    const adp = (await rows.first().getByTestId('adp-metric').innerText()).trim();
    expect(adp, `the ADP column read "${adp}"`).toMatch(/^ADP\s+([+-]?\d+|unknown)$/);

    // The position is still written in letters, not only painted.
    const badge = (await rows.first().locator('.pos-pill').innerText()).trim();
    expect(badge).toMatch(/^(QB|RB|WR|TE|K|DEF)$/);

    // And the live state is in the bar, where it cannot scroll away.
    await expect(page.getByTestId('draft-status')).toBeVisible();
  });

  /**
   * The ★ queue, in the order somebody put it in — read-only.
   *
   * This is the one regression whose whole symptom was that a *previously
   * selected* sort re-ordered the queue: a reader on Score never saw it, and a
   * reader on ADP or DOG lost their drop on the next render. So the check is
   * exactly that — cycle the control and assert the rows never move.
   *
   * Nothing here stars, unstars or drags. A production smoke does not write to
   * somebody's real queue, and it does not need to: the fault was in what the
   * *sort* did to an existing order, not in the drag, and the drag itself is
   * covered at every canonical width in `e2e/draft-queue-order.spec.ts`.
   *
   * Skips honestly when the deployment has fewer than two queued players,
   * because with nothing to reorder there is nothing this could prove — and a
   * silently passing test would read exactly like a verified one.
   */
  test('the queue keeps its own order under every sort', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const queueFilter = page.getByTestId('queue-filter');
    test.skip((await queueFilter.count()) === 0, 'no queue filter on this deployment');

    /*
     * Wait for the queued board to arrive, by watching for the request itself.
     *
     * `aria-pressed` flips the moment the chip is tapped; the rows it asks for
     * arrive a request later. `settledIds` returns as soon as two reads 300ms
     * apart agree, and over a real network they agree on the board still on
     * screen — the unfiltered one. So this test measured "did a sort re-order
     * the queue" against a list that had never been the queue, then read `[]`
     * once the empty queued board landed, and reported a re-ordering.
     *
     * That is what failed on the deploys of #89 and #108. Nothing was wrong
     * with either deployment: production's queue is empty, which is a
     * `test.skip`.
     *
     * A previous attempt waited for the *rows* to stop matching the unfiltered
     * board, and it made things worse — three widths instead of two. The board
     * on a live deployment is not still: the refresh controller rebuilds it
     * whenever Sleeper moves, so "the list changed" is satisfied by an ordinary
     * poll while the queued response is still in flight. The DOM cannot answer
     * "has the thing I asked for arrived"; the response can, so this waits on
     * that instead. Registered before the click, because a fast answer would
     * otherwise be missed.
     *
     * The sorts below need no equivalent wait: sorting is client-side —
     * `orderBoardRows` over rows already in memory — and issues no request.
     */
    const queuedBoard = page
      .waitForResponse((res) => res.url().includes('queued=1') && res.status() === 200, {
        timeout: 20_000,
      })
      .catch(() => null);

    await queueFilter.click();
    await expect(queueFilter).toHaveAttribute('aria-pressed', 'true');
    await queuedBoard;

    const before = await settledIds(page);
    test.skip(before.length < 2, 'fewer than two players queued on this deployment');

    // The control is still there and still remembers the mode, and says plainly
    // that it is not the thing ordering these rows.
    await expect(page.getByTestId('draft-sort')).toHaveAttribute('data-inactive', 'yes');

    for (const mode of ['sort-adp', 'sort-dog', 'sort-score']) {
      await page.getByTestId(mode).click();
      await expect(page.getByTestId(mode)).toHaveAttribute('aria-checked', 'true');
      expect(await settledIds(page), `${mode} re-ordered the queue`).toEqual(before);
    }
  });

  test('the board starts high on the page and shows several players', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    const count = await present(page, 'recommendation-row');
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
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

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
    await requireDraftBoard(page);
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const first = rows.first();
    await first.click();
    await expect(first.getByTestId('player-detail')).toBeVisible();
    // It fits on the screen rather than becoming a page of its own.
    expect((await first.boundingBox())!.height).toBeLessThan(page.viewportSize()!.height);
    await first.locator('.row-button').click();
  });

  /**
   * The two actions on a row, on the deployed site, without touching either.
   *
   * A compact row leads somewhere, and two of them also carry a control that
   * acts on the player without opening him — the star on the board, the heart
   * on Players. Those were written as a `<button>` nested inside the row's own
   * `<button>`: invalid, one tab stop where there are two actions, and a target
   * the size of the glyph. Production is where that was measured, at 28×28, and
   * production is therefore where the fix is read back.
   *
   * Read-only, like everything in this file, and the separation is read from
   * the structure rather than by pressing anything: a control that is not a
   * descendant of the way-in button cannot activate it, whatever it does with
   * its own event. `e2e/row-alignment.spec.ts` presses both and asserts the
   * outcome, against a dev server it is allowed to write to.
   */
  for (const [screen, tab, rowTestId, wayIn, control] of [
    ['the draft board', 'draft', 'recommendation-row', '.row-button', 'queue-control'],
    ['Players', 'players', 'player-search-row', '.dense-row-open', 'my-guy-control'],
  ] as const) {
    test(`draws a row on ${screen} and its own control as two separate targets`, async ({ page }) => {
      await page.goto('/');
      if (tab === 'draft') await requireDraftBoard(page);
      await open(page, tab);
      test.skip((await present(page, rowTestId)) === 0, `no ${screen} on this deployment`);

      const rows = await page.locator(`[data-testid="${rowTestId}"]`).evaluateAll(
        (all, { way, ctrl }) =>
          all
            .filter((r) => {
              const box = r.getBoundingClientRect();
              // Clear of the sticky bars, so a hit test answers for the row.
              return box.top > 120 && box.bottom < window.innerHeight - 120;
            })
            .slice(0, 4)
            .map((r) => {
              const el = r.querySelector(`[data-testid="${ctrl}"]`) as HTMLElement | null;
              const open = r.querySelector(way) as HTMLElement | null;
              if (!el || !open) return null;
              const box = el.getBoundingClientRect();
              const hits: string[] = [];
              for (const fx of [0, 0.5, 1]) {
                for (const fy of [0, 0.5, 1]) {
                  const x = box.left + Math.min(Math.max(box.width * fx, 1), box.width - 1);
                  const y = box.top + Math.min(Math.max(box.height * fy, 1), box.height - 1);
                  const at = document.elementFromPoint(x, y);
                  hits.push(el === at || el.contains(at) ? 'ok' : 'blocked');
                }
              }
              return {
                nested: r.querySelector('button button') != null,
                /* The control is beside the way in, not inside it. */
                sibling: !open.contains(el),
                actions: r.querySelectorAll('button').length,
                target: { width: box.width, height: box.height },
                hits: hits.join(' '),
                wayIn: open.getBoundingClientRect().height,
              };
            })
            .filter((r) => r != null),
        { way: wayIn, ctrl: control },
      );

      expect(rows.length, `${screen} drew no row clear of the app's own bars`).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.nested, 'a button is nested inside a button').toBe(false);
        expect(r.sibling, 'the control is still inside the way in').toBe(true);
        expect(r.actions, `${screen} row offers ${r.actions} buttons rather than two`).toBe(2);
        expect(r.target.width, `the control is ${r.target.width}px wide`).toBeGreaterThanOrEqual(44);
        expect(r.target.height, `the control is ${r.target.height}px tall`).toBeGreaterThanOrEqual(44);
        expect(r.hits, 'something else answers inside the control').toBe('ok ok ok ok ok ok ok ok ok');
        expect(r.wayIn, 'the way in is no longer a full target').toBeGreaterThanOrEqual(44);
      }
    });
  }

  /**
   * The expanded player, on both screens, in the deployed build.
   *
   * This file's own preamble is the argument for having it here as well as in
   * `e2e/player-detail.spec.ts`: `ci.yml` runs `e2e/` and never runs this, so a
   * card that changes shape after a merge shows up first as production going
   * red. The card *has* just changed shape, and these are the parts of it that
   * are true of any deployment rather than of the demo seed — the order the
   * identity is drawn in, the order the readings appear in, and the vocabulary
   * that must not be on a player card at all.
   *
   * Nothing here assumes a projection, a season, an injury or a single item of
   * evidence exists for whoever production happens to show first. It asserts
   * the cells that *are* drawn are drawn in the fixed order, which is the claim
   * that can actually regress.
   */
  test('opens one expanded player, in one identity order, on Players and on Trades', async ({ page }) => {
    /**
     * Where the header's marks are painted — face, name, and the marks under it.
     *
     * This read one line for as long as the header was one line: position,
     * club, name, status, left to right. The card carries a 64px portrait now
     * and the block beside it is two lines — the name, and under it the marks
     * that qualify him — because a face on the single line cost the name too
     * much: measured across the seed at 360px it truncated nineteen of
     * twenty-two names. See the note on `PlayerSheet`.
     *
     * Read as geometry rather than as DOM order, exactly as before: a card can
     * put the pill first in the markup and paint it anywhere.
     */
    const identity = () =>
      page.locator('.sheet-player-title').evaluate((title) => {
        const pick = (sel: string, mark: string) => {
          const el = title.querySelector(sel) as HTMLElement | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { mark, x: r.left, top: r.top, bottom: r.bottom };
        };
        return {
          face: pick('[data-testid="sheet-player-face"]', 'face'),
          name: pick('.sheet-player-name', 'name'),
          quals: [
            pick('.pos-pill', 'position'),
            pick('.team-logo, .team-code', 'club'),
            pick('[data-testid="injury-tag"]', 'status'),
          ].filter((p): p is { mark: string; x: number; top: number; bottom: number } => p != null),
        };
      });

    /**
     * The band's labels, lower-cased — the stylesheet uppercases them, and this
     * is an assertion about readings rather than about typography.
     */
    const band = async () =>
      (await page.getByTestId('player-page-metrics').locator('.stat-label').allInnerTexts()).map((l) =>
        l.trim().toLowerCase(),
      );

    /**
     * The fixed order, with the cells this player has no data for removed.
     *
     * `Rank` and `ADP` only exist where the screen behind deals in the draft
     * market; `PTS` only where a preseason snapshot covers him; the two season
     * cells only where his statistics have been ingested. What may never happen
     * is two of them swapping places.
     */
    const ORDER = ['rank', 'adp', '7d', '30d', 'life', 'pts'];
    const inOrder = (labels: string[]) => {
      const fixed = labels.filter((l) => ORDER.includes(l));
      const season = labels.filter((l) => /^\d{4} (gp|rank)$/.test(l));
      expect(fixed, `the band reordered itself: ${labels.join(' · ')}`).toEqual(
        ORDER.filter((l) => fixed.includes(l)),
      );
      // The two season cells arrive together, after everything fixed, GP first.
      if (season.length > 0) {
        expect(season.map((l) => l.split(' ')[1])).toEqual(['gp', 'rank']);
        expect(labels.indexOf(season[0]!)).toBeGreaterThan(labels.indexOf(fixed[fixed.length - 1]!));
      }
      // Whatever is on the band, none of it is a block that left the card.
      expect(labels).not.toContain('moved');
    };

    const card = async () => {
      const marks = await identity();

      // A portrait is optional presentation and may legitimately be initials,
      // but the box is always drawn — so its absence is a real failure.
      expect(marks.face, 'the expanded card is not drawing a portrait at all').not.toBeNull();
      expect(marks.name, 'the expanded card is not drawing a name').not.toBeNull();

      // The portrait leads: everything that says *who* is on the leading side.
      expect(marks.face!.x, 'the portrait is not the leading mark in the header').toBeLessThan(marks.name!.x);
      for (const q of marks.quals) {
        expect(marks.face!.x, `${q.mark} is drawn left of the portrait`).toBeLessThan(q.x);
      }

      // The name is a line above the marks that qualify it, not beside them.
      for (const q of marks.quals) {
        expect(q.top, `${q.mark} is back on the name's own line`).toBeGreaterThanOrEqual(marks.name!.bottom - 1);
      }

      // And those marks keep the row's order, left to right, on their own line.
      expect(
        marks.quals.map((m) => m.mark),
        'the expanded card reordered the marks that qualify the name',
      ).toEqual(['position', 'club', 'status'].filter((m) => marks.quals.some((q) => q.mark === m)));
      for (let i = 1; i < marks.quals.length; i++) {
        expect(
          marks.quals[i]!.x,
          `${marks.quals[i]!.mark} is drawn left of ${marks.quals[i - 1]!.mark}`,
        ).toBeGreaterThan(marks.quals[i - 1]!.x);
      }

      inOrder(await band());

      /*
       * The card is not the evidence console.
       *
       * `mag 13`, `uncategorised`, the review status, the rule id and the
       * confidence score are all real and all about the classifier. They belong
       * under Evidence on the player's own page, which this file already opens
       * elsewhere, and nowhere near a card somebody tapped to find out what
       * happened to a footballer.
       */
      const text = await page.getByTestId('player-page-snapshot').innerText();
      expect(text, 'the magnitude is back on the card').not.toMatch(/\bmag \d/);
      expect(text, 'the category-debug label is back on the card').not.toContain('uncategorised');
      expect(text).not.toContain('auto_applied');
      for (const gone of ['News by window', 'Vegas props', 'Categories', 'Draft market']) {
        expect(text, `"${gone}" is back on the expanded card`).not.toContain(gone);
      }

      /*
       * One modal, announced as the player whose card it is.
       *
       * The identity above is why this cannot be assumed. A sheet takes its
       * accessible name from its visible title, and this title is that cluster
       * rather than a string, so the card shipped for a long time claiming
       * `role="dialog"` and `aria-modal` with no name at all: a reader
       * listening to the deployed app was put inside a modal without being
       * told whose card had opened.
       *
       * Checked through the role and the computed name rather than through the
       * attribute, because what matters is what assistive technology works out
       * — and checked here as well as in `e2e/player-detail.spec.ts` for this
       * file's usual reason: `ci.yml` runs `e2e/` and never runs this, so the
       * deployed build is the only place a broken name would otherwise show up
       * silently. The expected name is read off the visible card, so it holds
       * for whichever player production happens to show and fails just as
       * loudly if the name grows the pill or the status back into it.
       */
      const named = (await page.locator('.sheet-player-name').innerText()).trim();
      expect(named, 'the card should be showing a player name to be named after').not.toBe('');
      await expect(page.getByRole('dialog'), 'a player card should be exactly one modal dialog').toHaveCount(1);
      await expect(
        page.getByRole('dialog', { name: named }),
        `the modal is not announced as "${named}"`,
      ).toBeVisible();
      await expect(page.getByTestId('player-sheet')).toHaveAttribute('aria-modal', 'true');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the card overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    };

    await page.goto('/');
    await open(page, 'players');
    test.skip((await present(page, 'player-search-row')) === 0, 'no player list on this deployment');
    await page.getByTestId('player-search-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();
    await card();
    await page.keyboard.press('Escape');

    await open(page, 'trades');
    await exploreMarket(page);
    if ((await present(page, 'trade-row')) === 0) return; // no board today; Players proved the card
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();
    await card();
  });

  /**
   * Swiping the card away, on the deployed build, without the board reloading.
   *
   * A physical-iPhone defect this file is well placed to catch, because it was
   * invisible everywhere else: on Trades and on Team, a player's card would not
   * be swiped away, and the page underneath behaved as though pull-to-refresh
   * were trying to win. It was — React's portals leave a layer's events
   * propagating up the component tree, and every screen with that gesture
   * renders its sheets inside the wrapper it is attached to, so the finger
   * dismissing the card arrived at the list behind it and the pull surface
   * captured the pointer out from under the dismissal.
   *
   * The arbitration lives on the overlay boundary — see `usePullToRefresh`,
   * rule 6 — so what is read back here is that the deployed bundle carries it:
   * the card goes, and nothing behind it armed, moved or fetched.
   *
   * Read-only in the strict sense this file means. Trades reloads with a GET
   * the site already answers to anyone, and the assertion is that even that
   * does not happen. Team is the other screen the defect was reported on and
   * is deliberately not exercised: its refresh is a POST, and a smoke suite
   * that provoked one to prove a gesture would be writing to production.
   */
  test('a card swiped away on Trades takes the board with it, not the network', async ({ page }) => {
    await page.goto('/');
    await open(page, 'trades');
    await exploreMarket(page);
    test.skip((await present(page, 'trade-row')) === 0, 'no trade board on this deployment');

    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();

    const reloads: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/trades')) reloads.push(r.url());
    });
    /* Sampled every frame: a pull that loses is still a pull that started. */
    await page.evaluate(() => {
      const store = { states: [] as string[], maxShift: 0, running: true };
      (window as unknown as { __pulls: typeof store }).__pulls = store;
      const tick = () => {
        if (!store.running) return;
        for (const surface of document.querySelectorAll<HTMLElement>('.pull-surface')) {
          const state = surface.dataset['pullState'];
          if (state && !store.states.includes(state)) store.states.push(state);
          const content = surface.querySelector<HTMLElement>('.pull-content');
          const transform = content ? getComputedStyle(content).transform : 'none';
          if (transform !== 'none') {
            const shift = new DOMMatrixReadOnly(transform).m42;
            if (shift > store.maxShift) store.maxShift = shift;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /*
     * The grip, not the body — the same correction `sheet-vs-pull.spec.ts`
     * already carries and this file was left behind by.
     *
     * `useSheetDrag` rule 1 changed underneath both of them: a sheet is now
     * dismissed by its chrome, and *any* pointerdown inside the scrolling body
     * is a scroll, whatever the body happens to be holding. The local suite was
     * moved onto its own `chromeGrip` in the same change; this one still
     * grabbed the body, and `ci.yml` does not run `e2e-production/`, so the
     * mismatch could only ever surface after a deploy — which is how it did.
     *
     * What the test is for is unchanged and is the half that matters: the card
     * goes, and the pull surface behind it neither arms, moves, nor fetches.
     * Which part of the card the finger starts on was never the subject.
     *
     * The settle is not decoration. A body drag could start anywhere in a large
     * box and did not care that the sheet was still rising; the grip is a few
     * points tall, so a box measured mid-animation puts the press above or
     * below it and the drag lands on nothing.
     */
    await stopsMoving(page, 'sheet-grip');
    const grip = (await page.locator('[data-testid="player-sheet"] .sheet-grip').boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + 4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) await page.mouse.move(x, y + (420 * i) / 14);
    await page.mouse.up();

    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    const seen = await page.evaluate(() => {
      const store = (window as unknown as { __pulls: { states: string[]; maxShift: number; running: boolean } })
        .__pulls;
      store.running = false;
      return { states: store.states, maxShift: store.maxShift };
    });
    expect(seen.states.filter((v) => v !== 'idle'), 'a pull surface armed under an open card').toEqual([]);
    expect(seen.maxShift, 'the board was stretched by the dismissal').toBe(0);
    expect(reloads, 'the board reloaded itself as the card was swiped away').toEqual([]);
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

  /**
   * The one row somebody reaches for when something is wrong.
   *
   * Presence and size only, and deliberately not the tap. Everything else about
   * the affordance is proved in `e2e/support-snapshot.spec.ts` against a dev
   * server whose league is known; capturing here would pull a couple of hundred
   * kilobytes of a real league down on every smoke run and then assert
   * something about whatever draft happened to be loaded that day, which is
   * exactly what this suite's own rules say it may not do.
   *
   * What it *can* say is the thing that would be worst to discover during a
   * draft: that the row a reader was told to look for is not on the deployed
   * screen at all. It is a read either way — the capture route has no write on
   * it — so nothing here can touch the real league.
   */
  test('the support snapshot row is on the deployed Settings screen', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');

    const row = page.getByTestId('setup-support-snapshot');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Copy support snapshot');
    expect((await row.boundingBox())!.height, 'the row is under the 44px floor').toBeGreaterThanOrEqual(44);

    /*
     * And the row above it, which says *which* decision the tap will capture.
     *
     * There is one button for six decisions, so the label alone no longer tells
     * a reader what they are about to send. Being told to tap something that
     * captures the wrong screen is the same failure as the row not being there,
     * one step later, so both are checked here.
     */
    const context = page.getByTestId('setup-support-context');
    await expect(context).toBeVisible();
    expect((await context.boundingBox())!.height, 'the row is under the 44px floor').toBeGreaterThanOrEqual(44);
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

  /**
   * A player is his own page now, and Back is a real Back.
   *
   * This used to assert the opposite — that the file unfolded inside the row it
   * was opened from — and it was right to, until the density pass moved a
   * screen and a half of prose out of a list whose job is being scanned. The
   * subject changed, so the test changed with it; what it must still prove is
   * that nothing was lost on the way, which is why it walks to the ledger
   * rather than stopping at the header.
   *
   * Still one document and no navigation: the app is a single page, and a
   * pushed screen that changed the URL would break the browser's own Back.
   */
  test('a player opens as his own page, carrying his whole file', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const rows = page.getByTestId('player-search-row');
    test.skip((await present(page, 'player-search-row')) === 0, 'no player list on this deployment');

    const before = await rows.count();
    await rows.first().click();

    /*
     * The sheet first, the page second.
     *
     * A tap on a name opens a sheet over the list — the list stays mounted, so
     * its query, its filter and its scroll are simply still true — and the
     * pushed page is what a reader asks for when a skim turns into a study.
     * Both draw the same dossier. This test is about the *page*, so it takes
     * the step that pushes; that the sheet costs the list nothing is asserted
     * in `e2e/density.spec.ts`.
     */
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();
    await page.getByTestId('player-full-profile').click();

    const pushed = page.getByTestId('player-page');
    await expect(pushed).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();

    // The ledger is one tap further in, and it is entire.
    await page.getByTestId('player-page-sections').getByRole('button', { name: 'Evidence' }).click();
    await expect(page.getByTestId('evidence-heading')).toBeVisible();

    // A screen, not a disclosure — and still one document, so the browser's
    // own Back still leaves the app rather than the player.
    await expect(page.getByTestId('back-button')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');

    await page.getByTestId('back-button').click();
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBe(before);
  });

  /**
   * The half of search that runs on the server, against the real dictionary.
   *
   * The suite already proves Draft can be searched — but Draft filters a board
   * it already holds, so it proves nothing about the server. Players is the
   * other path: it asks `/api/players?q=`, which used to run a literal `LIKE`
   * against the raw typed string and therefore could not survive a slipped
   * letter. That is the surface the shared-matcher work changed, and until now
   * nothing checked it against a deployment.
   *
   * The query is derived from a name the live site just showed rather than
   * hardcoded, because production holds real players and this file must not
   * assume which. A surname long enough to mistype has two of its middle
   * letters swapped — the commonest real slip, and one no substring test can
   * absorb.
   */
  test('a mistyped surname still finds the player, on the server', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const rows = page.getByTestId('player-search-row');
    test.skip((await present(page, 'player-search-row')) === 0, 'no player list on this deployment');

    const full = (await rows.first().locator('.player-name').innerText()).trim();
    const surname = full.split(/\s+/).pop() ?? '';
    // Five letters is the shortest that leaves two middle characters to swap
    // and still clears the matcher's own minimum for spending a typo budget.
    test.skip(surname.length < 5, `"${full}" has no surname long enough to mistype`);

    /*
     * A dropped letter, after the opening three.
     *
     * The shape matters. The server recalls candidates on a word's opening
     * characters, so a typo *inside* those characters leaves nothing to recall
     * — see `recallTerms`, which documents that limit and why closing it needs
     * a trigram index rather than a wider LIKE. A dropped letter further along
     * is both the commonest real slip and the one this design is built to
     * absorb, so it is what a smoke test should be asserting.
     */
    const typo = surname.slice(0, 3) + surname.slice(4);
    expect(typo, 'the deletion actually changed the word').not.toBe(surname);

    /*
     * Wait for the search to have *happened* before reading the answer.
     *
     * The first version of this polled the top row's name directly, and it
     * passed against a deliberately broken server — because the poll's first
     * tick read the unfiltered list, whose top row was already the name being
     * asserted. A test that passes before the thing it tests has run is worse
     * than no test.
     *
     * So the wait is on the list having narrowed, which is false until the
     * request lands and stays false if it comes back empty. Only then is the
     * name worth reading.
     */
    const before = await rows.count();
    const field = page.getByTestId('player-search');
    await field.fill(typo);
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(before);

    expect(await rows.count(), `“${typo}” found nobody`).toBeGreaterThan(0);
    expect(await rows.first().locator('.player-name').innerText()).toBe(full);

    // And the guard that stops the above passing for a search that returns
    // everybody: a string no name contains must still find nobody.
    await field.fill('zzzqqqxxx');
    await expect(page.getByText(/Nobody matching/i)).toBeVisible();
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
    await requireDraftBoard(page);
    await open(page, 'draft');

    const rows = page.getByTestId('recommendation-row');
    const before = await present(page, 'recommendation-row');
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
    await requireDraftBoard(page);
    await open(page, 'draft');
    const rows = page.getByTestId('recommendation-row');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

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
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');
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

    /*
     * A lineup is a question about a week, so a deployment mid-draft has none —
     * Team draws the drafted roster instead, and that is the intended state
     * rather than a missing one. Asserted rather than skipped past, the same way
     * the Start/Sit test above handles it: during a draft the starters are gone
     * *and* the drafted roster is there, and only a deployment with neither is
     * genuinely nothing to check.
     */
    const drafting = await midDraft(page);
    if (drafting) {
      await expect(page.getByTestId('starter-row')).toHaveCount(0);
      await expect(page.getByTestId('drafted-line').first()).toBeVisible();
      return;
    }

    test.skip((await present(page, 'starter-row')) === 0, 'no roster on this deployment');

    // Every slot drawn is a slot this league actually starts, and every filled
    // one carries its position tint plus the word.
    const id = await selectedLeagueId(page);
    const lineup = id
      ? await apiJson<{ found: boolean; slots: { slot: string; playerId: string | null }[] }>(
          page,
          `/api/leagues/${id}/lineup`,
        )
      : null;
    test.skip(!lineup?.found, 'no roster on this deployment');

    const drawn = await page
      .getByTestId('starter-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slot')));
    expect(drawn).toEqual(lineup!.slots.map((s) => s.slot));

    /*
     * Starter and bench are said in words — in the accessible name.
     *
     * This used to read `toContainText('Starter')`, and had been failing here
     * ever since the density work took that word off the face of the row: eight
     * rows repeating what the section heading above them already says was the
     * space that pass bought back. The claim it was defending is real and is
     * kept, moved to where the word actually lives.
     *
     * The row still carries the position's hue token — that is what colours the
     * slot chip — but it no longer carries the `card-pos` that paints a fill.
     * Team is a neutral grouped roster and the wash belongs to Draft alone.
     */
    for (const card of await page.locator('[data-testid="starter-row"][data-starter="true"]').all()) {
      const position = (await card.getAttribute('data-position'))!;
      await expect(card).toHaveClass(new RegExp(`card-pos-${position}\\b`));
      await expect(card).not.toHaveClass(/(^|\s)card-pos(\s|$)/);
      await expect(card).toHaveAttribute('aria-label', /recommended starter at/i);
    }
    for (const card of await page.getByTestId('bench-row').all()) {
      await expect(card).not.toHaveClass(/card-pos/);
      await expect(card).toHaveAttribute('aria-label', /bench/i);
    }

    /*
     * The lineup and the bench are one list, on real names.
     *
     * `e2e/row-alignment.spec.ts` makes this claim against the demo roster,
     * which is four players with short names and no defence. Production is
     * where it meets a `DEF`, a hyphenated surname and a full bench — so the
     * column is measured here too, on whatever this deployment actually has.
     *
     * The bench has to be opened first: it is collapsed on arrival and its rows
     * are not rendered while it is, which is the property that makes the fold
     * cost the layout nothing.
     */
    const toggle = page.getByTestId('bench-toggle');
    if (await toggle.count()) {
      await toggle.click();
      await expect(page.getByTestId('bench-row').first()).toBeVisible();
    }
    const columns = await page
      .locator('[data-testid="starter-row"][data-starter="true"], [data-testid="bench-row"]')
      .evaluateAll((rows) =>
        rows.map((row) => {
          const at = (sel: string, edge: 'left' | 'right') => {
            const el = row.querySelector(sel);
            return el ? Math.round(el.getBoundingClientRect()[edge]) : null;
          };
          return {
            pill: at('.pos-pill', 'left'),
            name: at('.player-name', 'left'),
            value: at('.proj', 'right'),
            text: (row.querySelector('.proj')?.textContent ?? '').trim(),
          };
        }),
      );
    if (columns.length > 1) {
      for (const key of ['pill', 'name', 'value'] as const) {
        const edges = columns.map((c) => c[key]);
        expect(edges.every((e) => e != null), `every row draws its ${key}`).toBe(true);
        expect(new Set(edges).size, `the ${key} column runs at ${[...new Set(edges)].join(', ')}`).toBe(1);
      }
      // A real figure or an honest dash — never a zero nobody computed.
      for (const c of columns) expect(c.text).toMatch(/^(—|-?\d+\.\d)$/);
    }
  });

  test('the comparison picker opens and reaches beyond the roster', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    /*
     * Ask the roster, do not read the screen.
     *
     * Compare is a post-draft control: mid-draft Team draws the drafted roster
     * and no comparison at all. Counting the button to decide whether to skip
     * looks equivalent and is not — the count can land before the roster
     * response does, on the render that has not yet learned a draft is running.
     * The test then declines to skip, the roster arrives, the view swaps, and
     * the click fails with `element was detached from the DOM` three times over.
     *
     * That is exactly what it did on a deployment where the same test skipped
     * correctly at another width in the same run: timing, not width. Asking the
     * API which screen this is has no such window, and it is what the Start/Sit
     * test above already does.
     */
    const drafting = await midDraft(page);
    test.skip(drafting === null, 'no league on this deployment');
    if (drafting) {
      // The intended state, asserted rather than skipped past.
      await expect(page.getByTestId('compare-open')).toHaveCount(0);
      return;
    }
    await expect(page.getByTestId('compare-open')).toBeVisible();

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

    const id = await selectedLeagueId(page);
    const data = id
      ? {
          waivers: await apiJson<{
            found: boolean;
            upgrades: { candidates: { playerId: string }[] }[];
            considered: number;
          }>(page, `/api/leagues/${id}/waivers`),
          roster: await apiJson<{ starters: { playerId: string }[]; bench: { playerId: string }[] }>(
            page,
            `/api/leagues/${id}/roster`,
          ),
        }
      : null;
    test.skip(!data?.waivers?.found || !data.roster, 'no roster on this deployment');

    const mine = new Set([
      ...data!.roster!.starters.map((p) => p.playerId),
      ...data!.roster!.bench.map((p) => p.playerId),
    ]);
    for (const upgrade of data!.waivers!.upgrades) {
      for (const candidate of upgrade.candidates) {
        expect(mine.has(candidate.playerId), 'a player already on the roster was offered as an add').toBe(false);
      }
    }

    /*
     * Whatever it says, it says it is advice.
     *
     * Matched on word boundaries rather than as substrings, which is what this
     * was doing and why it stood red. Every waiver row is itself a button — the
     * whole row opens the detail — so `allInnerTexts` returns the row's *content*,
     * and a row describing the competition as `1 likely bidder` contains the
     * letters of `bid`. A bidder is a person, not a control offering to place a
     * bid, and failing on it taught a reader to ignore a red smoke run.
     *
     * The guarantee is unchanged and still the important one: no control here
     * may read as an action this app does not take. A button labelled `Bid`,
     * `Place bid`, `Add`, `Drop`, `Claim` or `Submit` still fails.
     */
    const card = page.getByTestId('waiver-card');
    if ((await card.count()) > 0) {
      const buttons = (await card.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
      for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
        expect(
          buttons,
          `a control reading "${forbidden}" would imply a transaction`,
        ).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
      }
    }
  });

  /**
   * The claim plan, live: the instructions this app hands somebody to type into
   * Sleeper by hand.
   *
   * Two things are checked against whatever real roster and real wire the
   * deployment is serving, because both are the kind of mistake that costs all
   * the trust the rest of the plan earned. A claim that names a cut the reader
   * does not own is one; a plan that reaches a reader still carrying the
   * planner's machine vocabulary is the other.
   *
   * The screen half is a **separate test** rather than a guarded tail of this
   * one, and that is the whole reason it is separate. The seasonal slot means
   * Waivers is not a destination in preseason, so a `test.skip` at the bottom of
   * a single test would fire after these assertions had already run and passed —
   * and Playwright would report the whole thing as skipped. A production check
   * that reads as "skipped" for the entire feature is the same failure this
   * file's opening comment is about: it looks like coverage and is not. The API
   * half below is true in every season and is never guarded on the season.
   */
  test('the waiver plan cuts only your own players, and says so in English', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    const id = await selectedLeagueId(page);
    const data = id
      ? {
          waivers: await apiJson<{
            found: boolean;
            claimPlan: {
              claims: {
                rank: number;
                addName: string;
                addPosition: string;
                dropPlayerId: string | null;
                bid: number | null;
              }[];
            } | null;
          }>(page, `/api/leagues/${id}/waivers`),
          roster: await apiJson<{ starters: { playerId: string }[]; bench: { playerId: string }[] }>(
            page,
            `/api/leagues/${id}/roster`,
          ),
        }
      : null;
    test.skip(!data?.waivers?.found || !data.roster, 'no roster on this deployment');
    test.skip(!data!.waivers!.claimPlan, 'this deployment produced no plan');

    const plan = data!.waivers!.claimPlan!;
    const mine = new Set([
      ...data!.roster!.starters.map((p) => p.playerId),
      ...data!.roster!.bench.map((p) => p.playerId),
    ]);

    for (const [index, claim] of plan.claims.entries()) {
      expect(claim.rank, 'the ranks are the order to enter the claims in').toBe(index + 1);
      if (claim.dropPlayerId == null) continue;
      expect(mine.has(claim.dropPlayerId), 'the plan named a cut this roster does not hold').toBe(true);
    }

    /*
     * The defence is the DST planner's, on a live deployment as much as on a
     * fixture. Two surfaces recommending different things about one DEF slot is
     * the failure the boundary inside `planWaiverClaims` exists to prevent.
     */
    for (const claim of plan.claims) {
      expect(claim.addPosition, 'the generic plan claimed a defence').not.toBe('DEF');
    }

    const text = JSON.stringify(plan);
    for (const code of ['add_enters_lineup', 'protected_in_lineup', 'drop_covered_by_add', 'net_gain_below_bar']) {
      expect(text, `the reason code "${code}" reached a reader`).not.toContain(code);
    }
    expect(text.toLowerCase(), 'nothing this app produces is optimal').not.toContain('optimal');
  });

  /**
   * The plan on screen: one See Why, and no control that could transact.
   *
   * Skipped out of season, and only this half is — the contract assertions above
   * run in every season. This card is a list of transactions and there is no
   * control on it that performs one, which is the guarantee the whole app is
   * held to and this is the surface closest to breaking it.
   */
  test('the waiver plan offers one See Why, and nothing that would transact', async ({ page }) => {
    await page.goto('/');
    const tabs = await expectedTabs(page);
    test.skip(!tabs.includes('waivers'), 'the season has not started, so there is no waiver board');

    await open(page, 'waivers');
    const card = page.getByTestId('waiver-plan');
    test.skip((await card.count()) === 0, 'this deployment surfaced no plan to draw');

    await expect(card.getByRole('button')).toHaveCount(1);
    const label = (await card.getByRole('button').innerText()).toLowerCase();
    for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
      expect(label, `a control reading "${forbidden}" would imply a transaction`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }

    /* And the claims are not controls, so there is nothing to nest one inside. */
    await expect(card.locator('button button')).toHaveCount(0);
    for (const claim of await card.getByTestId('waiver-plan-claim').all()) {
      await expect(claim.locator('button')).toHaveCount(0);
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

    /*
     * The draft id comes from the league listing, which is where it lives.
     *
     * `/api/overview` reports the selected league as id, name and season and
     * has never carried a draft id, so reading one from it returned undefined
     * every time and skipped this test on every run since it was written --
     * green, and checking nothing. The screen itself reads `/api/leagues`, and
     * so does `draftId` above.
     */
    const draft = await draftId(page);
    const board = draft
      ? await apiJson<{
          recommendations: {
            components: { key: string; contribution: number }[];
            opportunity?: { score: number };
            concentration?: { score: number };
          }[];
        }>(page, `/api/drafts/${draft}/board?limit=25`)
      : null;
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

  /**
   * …once there is a week to optimise for.
   *
   * Balanced, Floor and Ceiling are three definitions of the best *lineup*, and
   * the Team pass withholds them during a draft: there is no week yet and half
   * the roster is unpicked. This deployment may legitimately be mid-draft on any
   * given day, so the absence of the control is checked against the roster's own
   * `live` flag rather than assumed either way — a missing control during a
   * draft is the intended design, and a missing control outside one is a defect.
   */
  test('Start/Sit offers three modes, and asking for one reaches the server', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    const drafting = await midDraft(page);
    test.skip(drafting === null, 'no league selected on this deployment');
    if (drafting) {
      // The intended state, asserted rather than skipped past: during a draft
      // the controls are gone, and the live roster is what stands in their place.
      await expect(page.getByTestId('team-controls')).toHaveCount(0);
      await expect(page.getByTestId('live-draft-card')).toBeVisible();
      return;
    }

    const modes = page.getByTestId('mode-row');
    await expect(modes).toBeVisible();
    for (const mode of ['balanced', 'floor', 'ceiling']) {
      await expect(page.getByTestId(`mode-${mode}`)).toBeVisible();
    }
    await expect(page.getByTestId('mode-balanced')).toHaveAttribute('aria-pressed', 'true');

    // The mode is a question asked of the server, not a client-side sort.
    const id = await selectedLeagueId(page);
    const answered = id
      ? {
          floor: (await apiJson<{ mode?: string }>(page, `/api/leagues/${id}/lineup?mode=floor`))?.mode,
          ceiling: (await apiJson<{ mode?: string }>(page, `/api/leagues/${id}/lineup?mode=ceiling`))?.mode,
        }
      : null;
    test.skip(!answered, 'no league selected on this deployment');
    expect(answered!.floor).toBe('floor');
    expect(answered!.ceiling).toBe('ceiling');
  });

  /**
   * The drafted roster, two players wide, on the deployed bundle.
   *
   * The layout is a grid whose columns are sized against the phone it is drawn
   * on, so it is the kind of thing that can be right in the repository and
   * wrong in production: a font that loads differently, a card that ends up a
   * few pixels narrower, and a name is drawn through the rule into the cell
   * beside it. Two geometric claims, which are the two a reader would notice —
   * two players genuinely share a row, and no name escapes its own cell.
   *
   * Only meaningful while a draft is running, which is the only time this list
   * is drawn. Asked of the roster rather than assumed, for the same reason the
   * Start/Sit test above asks.
   */
  test('draws the drafted roster as one dense column', async ({ page }) => {
    await page.goto('/');
    await open(page, 'team');

    const rows = page.getByTestId('drafted-line');
    const drafted = await rows.count();
    test.skip(drafted === 0, 'this deployment is not mid-draft, so there is no drafted list');

    // Every name inside its own row, at whatever width this deployment drew.
    for (const row of await rows.all()) {
      const [box, name, text] = await Promise.all([
        row.boundingBox(),
        row.locator('.player-name').boundingBox(),
        row.locator('.player-name').innerText(),
      ]);
      expect(name!.x + name!.width, `"${text}" runs past its row`).toBeLessThanOrEqual(box!.x + box!.width + 1);
    }

    /*
     * One column, and denser than a regular-season row.
     *
     * A grid is sized against the phone it is drawn on, so "one column" is
     * exactly the kind of claim that can be right in the repository and wrong
     * in production. Every row sharing a left edge is what says it, and the
     * per-player height is what says the density survived the deployment.
     */
    const boxes = await Promise.all((await rows.all()).map((row) => row.boundingBox()));
    const lefts = new Set(boxes.map((box) => Math.round(box!.x)));
    expect(lefts.size, 'every row starts on the same edge — one column, not two').toBe(1);

    const card = page.locator('.roster-list').first();
    const height = (await card.boundingBox())!.height;
    const players = await card.getByTestId('drafted-line').count();
    expect(height / players, `${players} players in ${Math.round(height)}px`).toBeLessThan(38);

    // And the one line of advice the draft card carries.
    await expect(page.getByTestId('best-move')).toContainText('Best move:');
    // With none of the weekly furniture underneath it.
    await expect(page.getByTestId('starters-title')).toHaveCount(0);
    await expect(page.getByTestId('bench-toggle')).toHaveCount(0);
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
    const id = await selectedLeagueId(page);
    const lineup = id
      ? await apiJson<{
          found: boolean;
          bench: { components: { key: string; label: string; display: string }[]; drivers?: string[] }[];
        }>(page, `/api/leagues/${id}/lineup`)
      : null;
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
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    // The draft id lives on the league listing rather than on the overview, so
    // the board is reached the same way the screen reaches it.
    const draft = await draftId(page);
    const board = draft
      ? await apiJson<{
          dogState: {
            available?: boolean;
            reason?: string;
            sourceType?: string;
            provider?: string;
            freshness?: string;
          } | null;
          marketFormat: { bestBall?: boolean; weights?: Record<string, number> } | null;
          recommendations?: { dogAdp: number | null }[];
        }>(page, `/api/drafts/${draft}/board?limit=60`)
      : null;
    const dog = board
      ? {
          state: board.dogState ?? null,
          format: board.marketFormat ?? null,
          withDog: (board.recommendations ?? []).filter((r) => r.dogAdp != null).length,
        }
      : null;
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
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

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

  /**
   * The `MKT` line, on the deployed board, for each position that has one.
   *
   * The dev server proves the arithmetic against a mock provider whose coverage
   * is fixed and known. Only production can say what the *real* provider prices
   * — which markets a quarterback actually has, whether receptions come through
   * for a tight end — and therefore whether the card a reader opens tonight has
   * the numbers this line was built to carry.
   *
   * Read-only, and it asserts per position rather than in aggregate: a board
   * where every receiver is priced and no quarterback is would satisfy any
   * count-based check and would be exactly the gap worth knowing about.
   *
   * The first draft of this test skipped itself on an unpriced board and passed
   * green while checking nothing at all. It now prints what the deployment
   * holds before it asserts anything, and separates a broken pipeline (a stored
   * snapshot that reaches no card — a failure) from a provider that published
   * nothing to store (a skip that says so). See the comment at the assertion.
   */
  test('carries market context on a quarterback, a back, a receiver and a tight end', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const draft = await draftId(page);
    const data = draft
      ? await apiJson<{
          league?: { scoringLabel?: string };
          marketSource?: { provider: string; season: number; fetchedAt: string } | null;
          recommendations?: Record<string, unknown>[];
        }>(page, `/api/drafts/${draft}/board?limit=250`)
      : null;
    // …and how much is *in* the season-market snapshot, which is a third fact
    // again. A provider can run, store a snapshot, and have published nothing.
    const status = data
      ? await apiJson<{ quotes?: number; players?: number; reason?: string }>(page, '/api/vegas/season')
      : null;
    const board = data
      ? {
          scoringLabel: data.league?.scoringLabel ?? null,
          // Whether the deployment holds a season-market snapshot at all, which
          // is a different fact from a board whose players went unmatched.
          marketSource: data.marketSource ?? null,
          snapshot: status
            ? { quotes: status.quotes ?? null, players: status.players ?? null, reason: status.reason ?? null }
            : null,
          rows: (data.recommendations ?? []).map((r) => ({
            position: r['position'],
            marketProps: r['marketProps'],
            marketBaseline: r['marketBaseline'],
          })),
        }
      : null;
    test.skip(!board || board.rows.length === 0, 'no league selected on this deployment');

    type Row = {
      position: string;
      marketProps: { components: { label: string; value: number; missing: string[] }[] } | null;
      marketBaseline: { points: number | null; coverage: number; contributions: { points: number }[] } | null;
    };
    const rows = board!.rows as Row[];
    const priced = rows.filter((r) => r.marketProps);

    /*
     * What each position actually got, printed before anything is asserted.
     *
     * A real provider's coverage is its own business and varies by week; this
     * suite may not fail because a tight end went unpriced today. What it may
     * do is print the shape of that coverage, so a card that quietly stopped
     * carrying receptions is visible in the run rather than discovered in a
     * draft. Printed first so the diagnosis survives a failure below.
     */
    const summary = ['QB', 'RB', 'WR', 'TE'].map((position) => {
      const forPosition = priced.filter((r) => r.position === position);
      const labels = new Set(forPosition.flatMap((r) => r.marketProps!.components.map((c) => c.label)));
      return `${position}: ${forPosition.length} priced [${[...labels].join(', ') || 'none'}]`;
    });
    const source = board!.marketSource
      ? `${board!.marketSource.provider} ${board!.marketSource.season} @ ${board!.marketSource.fetchedAt}`
      : 'no season-market snapshot on this deployment';
    console.log(
      `market coverage — ${summary.join(' | ')}; ` +
        `${priced.length}/${rows.length} of the board priced; source: ${source}; ` +
        `snapshot: ${board!.snapshot?.quotes ?? '?'} quotes / ${board!.snapshot?.players ?? '?'} players; ` +
        `scoring: ${board!.scoringLabel}`,
    );

    /*
     * Three different facts, and only the last is a defect.
     *
     * 1. **No snapshot at all.** Nothing has been stored, so there is no market
     *    to put on a card.
     * 2. **A snapshot holding nothing.** The provider ran and published no
     *    season markets. `mock` is constructed with an empty slate in
     *    production, and SportsGameOdds publishes no season-long player markets
     *    at all — probed, and asserted in `season.markets.test.ts`. An empty
     *    snapshot is the honest record of that, not a fault.
     * 3. **A snapshot with quotes in it that reach no card.** *That* is a
     *    broken pipeline, and it fails with the counts attached.
     *
     * The middle case is the one this test got wrong. It had only the two-way
     * split, so the day a daily refresh began storing empty snapshots the check
     * went red on every production run for a condition that is not a fault —
     * which is the same "train the reader to ignore a red smoke" failure the
     * two-way split was written to avoid, arrived at from the other side.
     *
     * Both non-defects skip, and both name their cause. The coverage line above
     * has already printed either way.
     */
    const quotes = board!.snapshot?.quotes ?? null;
    test.skip(
      !board!.marketSource,
      `no season-market snapshot on this deployment, so no card can carry a market line (${rows.length} rows on the board)`,
    );
    test.skip(
      quotes === 0,
      `the snapshot is empty — the provider published no season markets (${source}; ` +
        `reason: ${board!.snapshot?.reason ?? 'none given'})`,
    );
    expect(
      priced.length,
      `the deployment holds a snapshot of ${quotes ?? 'an unknown number of'} quotes (${source}) ` +
        `but no player on the live board carries a market line (${rows.length} rows)`,
    ).toBeGreaterThan(0);

    // Whatever is priced has to be priced honestly, whichever position it is.
    for (const row of priced) {
      const labels = row.marketProps!.components.map((c) => c.label);
      expect(new Set(labels).size, 'a component is listed twice').toBe(labels.length);
      for (const component of row.marketProps!.components) {
        expect(component.value, `${row.position} ${component.label} came through as zero`).toBeGreaterThan(0);
      }

      const points = row.marketProps!.components.find((c) => c.label === 'pts');
      if (points) {
        // The compact total and the components behind it are the same number.
        expect(points.value).toBe(row.marketBaseline?.points);
        const summed = (row.marketBaseline?.contributions ?? []).reduce((t, c) => t + c.points, 0);
        expect(Math.round(summed * 100) / 100).toBe(points.value);
      }
    }
  });
  /**
   * The Score board, on the deployed site, per position.
   *
   * The one invariant this whole tier pass exists to protect: **the selected
   * sort decides who appears where, and a tier is punctuation on that
   * sequence.** It was broken in production — a tight end scoring 68 was drawn
   * above two scoring 83 because the market clustered him higher — and the
   * repair is only real if the deployed board obeys it.
   *
   * Checked per position rather than in aggregate, because the report was
   * explicit that quarterbacks looked right while tight ends and backs did not.
   * One position passing says nothing about the pipeline.
   */
  test('never draws a lower Score above a higher one, at any position', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    const summary: string[] = [];
    const violations: string[] = [];

    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      const chip = page.getByRole('button', { name: position, exact: true });
      if ((await chip.count()) === 0) {
        summary.push(`${position}: no filter`);
        continue;
      }
      await chip.click();
      await expect(page.getByTestId('board-list')).toBeVisible();
      // The board this deployment has was established by the gate above; this
      // is waiting for one *position* of it, which may legitimately be empty
      // and must not be remembered as though the board were.
      await settled(page, 'recommendation-row');

      /*
       * Rows and separators in DOM order, so the separators can be checked for
       * placement as well as the rows for ordering.
       */
      const sequence = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="board-list"]');
        const nodes = list?.querySelectorAll('[data-testid="tier-divider"], [data-testid="recommendation-row"]') ?? [];
        return [...nodes].map((n) =>
          n.getAttribute('data-testid') === 'tier-divider'
            ? { kind: 'divider' as const, score: null, name: null }
            : {
                kind: 'row' as const,
                score: Number((n.querySelector('.score-value')?.textContent ?? '').trim()) || null,
                name: n.querySelector('.player-name')?.textContent?.trim() ?? null,
              },
        );
      });

      const rows = sequence.filter((n) => n.kind === 'row');
      const scored = rows.map((r) => r.score).filter((s): s is number => s != null);
      summary.push(`${position}: ${rows.length} rows, ${sequence.length - rows.length} dividers`);

      for (let i = 1; i < scored.length; i++) {
        if (scored[i]! > scored[i - 1]!) {
          const above = rows.find((r) => r.score === scored[i - 1]);
          const below = rows.find((r) => r.score === scored[i]);
          violations.push(
            `${position}: ${below?.name ?? '?'} (${scored[i]}) is drawn below ${above?.name ?? '?'} (${scored[i - 1]})`,
          );
        }
      }

      // A separator may never lead the list, and never follow another.
      if (sequence[0]?.kind === 'divider') violations.push(`${position}: a divider leads the board`);
      for (let i = 1; i < sequence.length; i++) {
        if (sequence[i]!.kind === 'divider' && sequence[i - 1]!.kind === 'divider') {
          violations.push(`${position}: two dividers in a row`);
        }
      }
    }

    console.log(`score ordering — ${summary.join(' | ')}`);
    expect(violations, violations.join('; ')).toEqual([]);
  });

  /**
   * The late-round survival calibration, on the deployed board.
   *
   * Not a threshold on any one player — a real board's percentages are its own
   * business. What is checked is the failure that shipped: every deep player
   * reading as a certainty. A board where nothing late is under 99% is the
   * shape the hazard floor was written to remove.
   */
  test('does not report late-round survival as a certainty', async ({ page }) => {
    await page.goto('/');
    await requireDraftBoard(page);
    await open(page, 'draft');
    test.skip((await present(page, 'recommendation-row')) === 0, 'no draft board on this deployment');

    /*
     * The narrow lookup this test has always used, kept deliberately — and it
     * is not the one `draftId` does.
     *
     * `draftId` prefers the *selected* league's draft. Pointing this test at
     * that board instead is a change of subject rather than a change of
     * plumbing, and it is not this lane's to make: on the smoke run of this
     * branch (33120122127) it made this assertion run for the first time in
     * the runs on record — every prior run skipped it silently — and fail at
     * every width with `pick 1; 235 priced, 136 at ADP 100+; max late 1.000`.
     * At the first pick of a draft every player a hundred picks away *is*
     * safe, so that reads as an unsound premise rather than as the calibration
     * bug this was written for, and deciding between the two means reading the
     * hazard model. Left exactly as it was, and written up for the owner.
     */
    const listing = await apiJson<{ leagues?: { draftId: string | null }[] }>(page, '/api/leagues');
    const draft = (listing?.leagues ?? []).find((l) => l.draftId)?.draftId ?? null;
    const data = draft
      ? await apiJson<{ currentPick?: number; recommendations?: Record<string, unknown>[] }>(
          page,
          `/api/drafts/${draft}/board?limit=250`,
        )
      : null;
    const board = data
      ? {
          currentPick: data.currentPick ?? null,
          rows: (data.recommendations ?? []).map((r) => ({
            adp: r['adp'],
            survival: r['survivalProbability'],
          })),
        }
      : null;
    test.skip(!board || board.rows.length === 0, 'no league selected on this deployment');

    const priced = (board!.rows as { adp: number | null; survival: number | null }[]).filter(
      (r) => r.adp != null && r.survival != null,
    );
    test.skip(priced.length === 0, 'nothing on this board carries a survival estimate');

    const late = priced.filter((r) => r.adp! >= 100);
    console.log(
      `survival — pick ${board!.currentPick}; ${priced.length} priced, ${late.length} at ADP 100+;` +
        ` max late ${late.length ? Math.max(...late.map((r) => r.survival!)).toFixed(3) : 'n/a'}`,
    );

    // Every probability has to be a probability, wherever it came from.
    for (const row of priced) {
      expect(row.survival!).toBeGreaterThanOrEqual(0);
      expect(row.survival!).toBeLessThanOrEqual(1);
    }

    /*
     * And the deep end of the board may not be uniformly certain. Skipped
     * rather than failed when the board has no deep players to look at — that
     * is a fact about the draft, not about the model.
     */
    test.skip(late.length < 5, 'too few deep players on this board to judge late calibration');
    const allCertain = late.every((r) => r.survival! >= 0.99);
    expect(allCertain, 'every deep player reads as a certainty, which is the calibration bug').toBe(false);
  });
});

/**
 * The deployed API answers in JSON, including when it is refusing.
 *
 * The defect this guards was reproduced on a physical iPhone as `JSON Parse
 * error: Unrecognized token '<'` — the client had been handed a page where a
 * payload should have been and parsed it. The client boundary
 * (`src/web/apiResponse.ts`) is what stops that reaching a reader, and it has to
 * exist because the layers above the Worker are not ours to fix.
 *
 * But one source of markup *was* ours, and only a deployed site can prove it is
 * closed: an exception escaping the Worker is answered by Cloudflare with its
 * own HTML error page, on a path under `/api/`. The check that matters is not
 * "does the API work" — the rest of this suite covers that — but "does an
 * `/api/` path *ever* answer in anything other than JSON", which is why the
 * assertions below deliberately ask for answers the app would rather not have:
 * a route that does not exist, and a write from a stranger.
 *
 * Every request here is safe. Two are GETs, and the third is the refusal this
 * suite already exercises above.
 */
/*
 * Which code is this?
 *
 * Every other assertion in this file is about a deployment it assumes is the
 * right one. This is the assertion that earns that assumption: the site names
 * the revision it was built from, and when the caller said which revision it
 * expects — the release workflow does, and passes it in as
 * `EXPECTED_RELEASE_SHA` — the two have to be the same commit.
 *
 * A green suite against the wrong build is the failure this prevents, and it is
 * a quiet one: nothing else here would notice.
 *
 * Run by hand with no expectation set, it asserts only that production can
 * answer the question at all. `unknown` is allowed there and only there,
 * because a local dev server is not a release. The workflow always sets it.
 */
test.describe('the deployed revision', () => {
  test('says which revision it is running, and it is the released one', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok: boolean; release?: { gitSha?: string } };

    expect(body.ok).toBe(true);
    const live = body.release?.gitSha;
    console.log(`production reports revision: ${live}`);
    expect(typeof live, '/api/health must report release.gitSha').toBe('string');

    const expected = process.env.EXPECTED_RELEASE_SHA?.trim();
    if (!expected) {
      // Nothing to compare against: assert the shape and say so in the log.
      expect(live).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
      return;
    }
    expect(live?.toLowerCase(), `production is not running the released revision`).toBe(
      expected.toLowerCase(),
    );
  });
});

test.describe('the API boundary', () => {
  const isJson = (contentType: string | null) => /^application\/json/.test(contentType ?? '');

  test('answers every /api/ path in JSON, including the refusals', async ({ request }) => {
    const cases = [
      { what: 'health', res: await request.get('/api/health', { failOnStatusCode: false }) },
      { what: 'overview', res: await request.get('/api/overview', { failOnStatusCode: false }) },
      // A path no route matches. The single-page-application fallback would
      // answer this one with index.html if `run_worker_first` ever stopped
      // covering /api/*, which is exactly the 200-and-a-page case.
      { what: 'unknown route', res: await request.get('/api/no-such-route', { failOnStatusCode: false }) },
      // A write with no session: refused, and the refusal is JSON too.
      { what: 'unauthorized write', res: await request.post('/api/sleeper/sync-players', { failOnStatusCode: false }) },
    ];

    for (const { what, res } of cases) {
      const contentType = res.headers()['content-type'] ?? null;
      const body = await res.text();
      console.log(`api boundary — ${what}: ${res.status()} ${contentType}`);

      expect(isJson(contentType), `${what} answered ${res.status()} as ${contentType}`).toBe(true);
      expect(body.trimStart().startsWith('<'), `${what} answered with markup`).toBe(false);
      // It says JSON; it has to be JSON.
      expect(() => JSON.parse(body) as unknown, `${what} did not parse`).not.toThrow();
    }

    // And the ones that are refusals are refusals, not pages pretending.
    expect(cases[2]!.res.status()).toBe(404);
    expect([401, 503]).toContain(cases[3]!.res.status());
  });

  test('never shows a reader a parser error on a first, cold load', async ({ page }) => {
    /*
     * A fresh context against the deployed site: the first load is the one the
     * original symptom was reported for, because it is the one that can meet a
     * cold Worker. Nothing is injected here — this is the real site answering.
     */
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('/');
    await expect(page.getByTestId('tab-setup')).toBeVisible();

    const text = await page.locator('body').innerText();
    for (const forbidden of ['Unrecognized token', 'Unexpected token', 'is not valid JSON', 'DOCTYPE']) {
      expect(text, `"${forbidden}" reached the rendered UI`).not.toContain(forbidden);
    }
    expect(pageErrors.join('\n')).not.toMatch(/Unrecognized token|Unexpected token|not valid JSON/);
  });
});
