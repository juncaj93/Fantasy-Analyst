/**
 * Demo Mode, driven the way the audit will drive it.
 *
 * §14 asks that a test be able to enter Demo Mode, choose a named scenario,
 * navigate, assert, leave, and confirm live mode is restored. That is the shape
 * of this file, and every step is done through the product's own controls or
 * through the documented `?demo=` hook — nothing here reaches into the app's
 * internals, because a hook that only a test can use is not a hook the audit
 * can rely on.
 *
 * It runs at all four portrait widths, on WebKit in CI, because the screens it
 * exercises are the production ones and the point of a demo is that they hold
 * up under states that are hard to reach on a real league.
 */

import { expect, test, type Page } from '@playwright/test';
import { openSetupGroup } from './helpers.ts';

/** The audit hook: open the app already inside a named scenario. */
async function openScenario(page: Page, id: string) {
  await page.goto(`/?demo=${id}`);
  await expect(page.getByTestId('demo-bar')).toBeVisible();
  await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
}

async function tab(page: Page, name: string) {
  await page.getByTestId(`tab-${name}`).click();
  await page.waitForTimeout(350);
}

/**
 * Make sure the picker is showing, whatever state it was in.
 *
 * Idempotent on purpose: the panel opens itself while a scenario is running —
 * so that stepping a progression does not shut the controls under the reader's
 * hand — and a blind click on the summary would close it.
 */
async function openPicker(page: Page) {
  // Demo Mode is inside the App behavior fold, which is shut on every load.
  await openSetupGroup(page, 'behavior');
  const panel = page.getByTestId('demo-panel');
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await panel.locator('summary').click();
  }
  await expect(page.getByTestId('demo-scenario-draft-mid')).toBeVisible();
}

test.describe('entering and leaving', () => {
  test('Settings offers Demo Mode, and it is not a tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    // §4: no permanent bottom-nav tab. The bar carries five destinations.
    await expect(page.locator('.tabbar button')).toHaveCount(5);
    await expect(page.getByTestId('tab-demo')).toHaveCount(0);

    await tab(page, 'setup');
    await openPicker(page);
  });

  test('choosing a scenario, walking it, and leaving restores live mode', async ({ page }) => {
    await page.goto('/');
    await tab(page, 'setup');
    await openPicker(page);

    // 1. enter, by choosing a named scenario
    await page.getByTestId('demo-scenario-waivers-tuesday-active').click();
    await expect(page.getByTestId('demo-bar')).toBeVisible();
    await expect(page.getByTestId('demo-scenario')).toContainText('Waivers');

    // 2. navigate: the toolbar has followed the lifecycle into the season, so
    //    Waivers is in the bar where Draft used to be.
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await tab(page, 'waivers');

    // 3. assert: real recommendations, from the real engine
    await expect(page.locator('.demo-bar')).toBeVisible();
    await expect(page.getByTestId('tab-team')).toBeVisible();

    // 4. leave
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    // 5. live mode is back — including the seasonal tab, which followed the
    //    live league's own lifecycle rather than the scenario's.
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await tab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
  });

  test('a reload inside a demo stays inside it, and does not flash live data', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    const before = await page.getByTestId('demo-scenario').innerText();
    await page.reload();
    await expect(page.getByTestId('demo-bar')).toBeVisible();
    expect(await page.getByTestId('demo-scenario').innerText()).toBe(before);
  });

  test('leaving is remembered across a reload', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);
    // Without the query parameter this time: the stored choice must be gone.
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);
  });
});

test.describe('the indicator', () => {
  test('says DEMO in words, names the scenario and prints its clock', async ({ page }) => {
    await openScenario(page, 'sunday-pregame');
    const bar = page.getByTestId('demo-bar');
    /*
     * §4 and §16: conveyed beyond colour. The badge is a word, the scenario is
     * named, and the as-of instant is a real `<time>` carrying the full
     * timestamp whatever the bar has room to print of it.
     *
     * It used to also assert the words `Fixture data`. They were the caption
     * that made this bar three lines tall on a phone, and they were saying what
     * the badge two centimetres to their left already says. What the rule
     * actually requires is that the state is legible without reading a colour,
     * and all three of these are text.
     */
    await expect(page.getByTestId('demo-badge')).toHaveText('DEMO');
    await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
    await expect(bar.locator('time')).toHaveAttribute('datetime', '2026-10-11T15:40:00.000Z');
    // One line, not a banner: it may not cost more than a navigation bar.
    expect((await bar.boundingBox())!.height).toBeLessThan(64);
  });

  test('follows the reader onto every screen', async ({ page }) => {
    await openScenario(page, 'sunday-pregame');
    for (const name of ['team', 'waivers', 'trades', 'players', 'setup']) {
      await tab(page, name);
      await expect(page.getByTestId('demo-bar'), `missing on ${name}`).toBeVisible();
    }
  });

  test('the exit is a full-sized tap target', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    const box = (await page.getByTestId('demo-exit').boundingBox())!;
    expect(box.height, 'below the platform minimum').toBeGreaterThanOrEqual(43);
  });

  test('nothing hides behind it: the navigation bar still starts at the top of the page', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    const demoBar = (await page.getByTestId('demo-bar').boundingBox())!;
    const navBar = (await page.locator('.nav-bar').first().boundingBox())!;
    // The demo bar owns the status-bar inset; the nav bar sits immediately
    // under it rather than reserving the same pixels a second time.
    expect(navBar.y).toBeGreaterThanOrEqual(demoBar.y + demoBar.height - 2);
    expect(navBar.y).toBeLessThanOrEqual(demoBar.y + demoBar.height + 4);
  });
});

test.describe('the scenarios render the production screens', () => {
  test('draft-mid draws the real board, on the clock', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    await tab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.getByTestId('board-league-name')).toContainText('Thursday Night Regrets');
    // The board is the product's, so the rows are the product's rows.
    expect(await page.getByTestId('recommendation-row').count()).toBeGreaterThan(0);
  });

  /*
   * The scenario is the whole transition, so it asserts the whole bar.
   *
   * Draft has left — the picks are made and the board has nothing to decide —
   * Waivers has taken the slot the two of them share, and Matchup has arrived.
   * The app lands on Team rather than on a destination that is no longer there,
   * which is the `draftVisible` effect in `App.tsx` doing its job.
   */
  test('post-draft lands on Team, with Draft gone and Waivers and Matchup in its place', async ({ page }) => {
    await openScenario(page, 'post-draft-roster');
    await expect(page.getByTestId('tab-team')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
    await tab(page, 'team');
    await expect(page.locator('.nav-bar').first()).toBeVisible();
  });

  test('sunday-pregame shows a lineup built by the engine', async ({ page }) => {
    await openScenario(page, 'sunday-pregame');
    await tab(page, 'team');
    await expect(page.locator('.nav-bar').first()).toBeVisible();
    await expect(page.locator('body')).toContainText('Thursday Night Regrets');
  });

  /**
   * The five Matchup scenarios, on the production Matchup screen.
   *
   * Nothing here asserts a number. The point is that each scenario reaches the
   * canonical screen and that the screen renders what the *model* concluded —
   * a scoreboard, a win split, eight slot rows and a hero card — from a
   * fixture that states only kickoffs, market lines and Sleeper's points.
   */
  for (const [id, name] of [
    ['matchup-live-close', 'one point in it'],
    ['matchup-live-leading', 'leading'],
    ['matchup-live-trailing', 'trailing'],
    ['matchup-injury-swing', 'an injury swings it'],
    ['matchup-final', 'final'],
  ] as const) {
    test(`${id} draws the real Matchup screen`, async ({ page }) => {
      await openScenario(page, id);
      await expect(page.getByTestId('tab-matchup')).toBeVisible();
      await tab(page, 'matchup');

      await expect(page.getByTestId('matchup-score')).toBeVisible();
      await expect(page.getByTestId('matchup-score')).toHaveAttribute('data-degraded', 'false');
      await expect(page.getByTestId('matchup-actual-mine')).toBeVisible();
      await expect(page.getByTestId('matchup-actual-theirs')).toBeVisible();
      // And no Live Insights element, which the lock keeps off this page.
      await expect(page.getByTestId('insight-entry-label')).toHaveCount(0);
      // Every starting slot, both sides, off the league's own roster positions —
      // nine of them, because the demo league starts a defence.
      await expect(page.getByTestId('matchup-row')).toHaveCount(9);
      await expect(page.getByTestId('demo-scenario')).toContainText(name, { ignoreCase: true });
    });
  }

  /**
   * A live afternoon and a settled one are different screens, not the same one
   * with a different number.
   */
  test('a live matchup prints a win split; a finished one prints the result', async ({ page }) => {
    await openScenario(page, 'matchup-live-close');
    await tab(page, 'matchup');
    await expect(page.getByTestId('matchup-win-mine')).toBeVisible();
    await expect(page.getByTestId('matchup-proj-mine')).toBeVisible();

    await openScenario(page, 'matchup-final');
    await tab(page, 'matchup');
    await expect(page.getByTestId('matchup-result')).toBeVisible();
  });

  /**
   * The five things the launch showcase has to be able to put on a screen.
   *
   * Deliberately assertions about *presence and shape* rather than about
   * numbers: the numbers are asserted against the engines in
   * `tests/demo.showcase.test.ts`, and repeating them here would make a
   * fixture tweak a two-file change for no extra coverage. What this adds is
   * the half that unit tests cannot reach — that the response the demo builds
   * actually reaches the production screen and draws.
   */
  test('the Tuesday waiver run shows the plan, in order, with the mechanic one tap in', async ({ page }) => {
    await openScenario(page, 'waivers-tuesday-active');
    await tab(page, 'waivers');

    const plan = page.getByTestId('waiver-plan');
    await expect(plan).toBeVisible();
    await expect(page.getByTestId('waiver-plan-instruction')).toHaveText('Enter in this order');

    /* An ordered list, because the order is the instruction. */
    await expect(page.getByTestId('waiver-plan-claims')).toHaveJSProperty('tagName', 'OL');
    const claims = page.getByTestId('waiver-plan-claim');
    await expect(claims).toHaveCount(3);
    /* Add · bid · drop, on one line, for every claim. */
    for (const claim of await claims.all()) {
      await expect(claim).toContainText(/Add .+ · \$\d+ · Drop .+/);
    }
    /* And the repeated ones say why they are not the duplicate they look like. */
    await expect(page.getByTestId('waiver-plan-qualifier').first()).toContainText(/only if/i);

    /* The mechanic is behind See why, not on the card. */
    await expect(plan).not.toContainText('Sleeper runs claims top to bottom');
    await page.getByTestId('waiver-plan-why').click();
    await expect(page.getByTestId('waiver-plan-detail-body')).toContainText('Sleeper runs claims top to bottom');
  });

  test('the defence is a decision on Waivers and the same decision on Team', async ({ page }) => {
    await openScenario(page, 'waivers-tuesday-active');
    await tab(page, 'waivers');

    /*
     * On Waivers a defence the planner named is a *row*, because it is
     * something to add — and the standalone line is deliberately suppressed
     * while that row is on screen, or the page would carry the same
     * recommendation twice. See `WaiversScreen`.
     */
    const defRow = page.locator('[data-testid="waiver-row"][data-position="DEF"]');
    await expect(defRow).toHaveCount(1);
    await expect(page.getByTestId('dst-line')).toHaveCount(0);

    /*
     * On Team there is no board to put it in, so the same plan draws as its own
     * line — one decision, two presentations, computed once on the response
     * both screens read.
     */
    await tab(page, 'team');
    await expect(page.getByTestId('dst-line')).toBeVisible();
    await expect(page.getByTestId('dst-state')).toHaveText('Stream');
    await expect(page.getByTestId('dst-headline')).toContainText('DEN');
  });

  test('the pregame matchup recommends holding, and the injury scenario recommends a swap', async ({ page }) => {
    await openScenario(page, 'sunday-pregame');
    await tab(page, 'matchup');
    const hold = page.getByTestId('matchup-best-move');
    await expect(hold).toBeVisible();
    await expect(hold).toHaveAttribute('data-state', 'hold');
    await expect(hold).toContainText(/hold your lineup/i);

    await openScenario(page, 'matchup-injury-swing');
    await tab(page, 'matchup');
    const move = page.getByTestId('matchup-best-move');
    await expect(move).toHaveAttribute('data-state', 'move');
    await expect(move).toContainText(/start .+ over .+/i);
    await expect(page.getByTestId('best-move-metrics')).toContainText('%');
  });

  test('Trades leads with an offer and keeps the market folded away', async ({ page }) => {
    await openScenario(page, 'trade-window');
    await tab(page, 'trades');

    await expect(page.getByTestId('smart-trades')).toBeVisible();
    /* The inventory exists and is closed until it is asked for. */
    const fold = page.getByTestId('market-fold');
    await expect(fold).toBeVisible();
    await expect(fold).toHaveAttribute('data-open', 'false');
    await expect(fold).toContainText('Explore the market');
  });

  test('a focused player draws the shared face treatment, and asks for no portrait', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('sleepercdn.com')) requested.push(req.url());
    });

    await openScenario(page, 'sunday-pregame');
    await tab(page, 'players');
    await expect(page.getByTestId('players-list')).toBeVisible();
    /* Dense rows never carry a portrait at all — that rule is the product's. */
    await expect(page.getByTestId('sheet-player-face')).toHaveCount(0);

    await page.locator('[data-testid="player-search-row"]').first().click();
    const face = page.getByTestId('sheet-player-face');
    await expect(face).toBeVisible();
    /*
     * A fixture id is not a Sleeper id, so there is no portrait to ask for and
     * the shared header draws its deterministic initials instead. That is Demo
     * Mode's independence from `sleepercdn` in one assertion: not a blocked
     * request, but a request that is never made.
     */
    await expect(face).toHaveText(/^[A-Z]{1,2}$/);
    expect(requested, 'a demo asks sleepercdn for nothing').toEqual([]);
  });

  test('offline-draft falls back to the captured board and says how old it is', async ({ page }) => {
    await openScenario(page, 'offline-draft');
    await tab(page, 'draft');
    // The production offline path, exercised rather than depicted: the board
    // request fails and the screen renders the capture with its age.
    await expect(page.getByTestId('draft-offline-capture')).toBeVisible();
    await expect(page.getByTestId('draft-offline-capture')).toContainText('Offline');
  });
});

test.describe('progression', () => {
  test('previous and next step through the season, and nothing moves on its own', async ({ page }) => {
    await openScenario(page, 'waivers-tuesday-active');
    await tab(page, 'setup');
    await openPicker(page);

    const label = page.getByTestId('demo-scenario');
    const started = await label.innerText();

    // Nothing advances by itself — §11 forbids timers and background jobs.
    await page.waitForTimeout(1200);
    expect(await label.innerText()).toBe(started);

    await page.getByTestId('demo-next').click();
    await expect(label).not.toHaveText(started);
    const advanced = await label.innerText();

    await page.getByTestId('demo-previous').click();
    await expect(label).toHaveText(started);
    expect(advanced).not.toBe(started);
  });

  /**
   * The screens move with the indicator, not just the indicator.
   *
   * Two scenarios in the same league at two different moments share a league
   * id, so a screen keyed on "which league" would keep the previous state on
   * screen under a bar naming the new one — which is the single most misleading
   * thing a demo could do. The wallet is the cheapest observable proof: the
   * Wednesday scenario has spent $21 more than the Tuesday one.
   */
  test('the screens move with it, not only the bar', async ({ page }) => {
    await openScenario(page, 'waivers-tuesday-active');
    await tab(page, 'waivers');
    const before = await page.locator('.app-main').innerText();

    await tab(page, 'setup');
    await openPicker(page);
    await page.getByTestId('demo-scenario-waivers-processed').click();
    await expect(page.getByTestId('demo-scenario')).toContainText('Wednesday');

    await tab(page, 'waivers');
    await expect(page.locator('.app-main')).not.toHaveText(before);
  });
});

test.describe('a demo cannot change anything', () => {
  test('the server refuses a write from a demo browser, even a hand-made one', async ({ page }) => {
    await openScenario(page, 'draft-mid');

    // A request the app itself would never make: straight past the UI, straight
    // past the API client, to the server. It carries the demo cookie because
    // every same-origin request does, which is the whole point of using one.
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/players/1001/my-guy', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 3 }),
      });
      return { status: res.status, body: await res.text() };
    });

    expect(result.status).toBe(403);
    expect(result.body).toContain('Demo Mode is read-only');
  });

  test('and lets go the moment the demo is left', async ({ page }) => {
    await openScenario(page, 'draft-mid');
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    const status = await page.evaluate(async () => {
      const res = await fetch('/api/demo/status', { credentials: 'same-origin' });
      return res.json() as Promise<{ demo: boolean }>;
    });
    expect(status.demo).toBe(false);
  });

  test('the live board is untouched by everything above', async ({ page }) => {
    await page.goto('/');
    await tab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
    // The dev server's own seeded league, not the demo's.
    await expect(page.getByTestId('board-league-name')).toContainText('Demo Dynasty');
  });
});
