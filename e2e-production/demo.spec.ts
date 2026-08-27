/**
 * Demo Mode, on the deployed site.
 *
 * The unit and browser suites prove Demo Mode against a dev server with seeded
 * data. This proves the same thing about the bundle a user actually downloads,
 * which is a different claim: the fixtures are lazily imported chunks, the
 * write refusal is a middleware in the deployed Worker, and both are things
 * that can be correct in the repository and wrong in production.
 *
 * Three properties, in the order they matter:
 *
 *   1. **Entry and exit work**, through the documented `?demo=` hook and the
 *      indicator's own control — so the audit can drive the deployed site the
 *      same way it drives a local one.
 *   2. **Representative scenarios render the production screens** — a draft
 *      board, a Sunday lineup, a waiver bid and a matchup — from fixture data,
 *      with real rows on them rather than an empty shell.
 *   3. **Live truth is untouched.** The overview is read before a demo, after
 *      one, and after leaving, and the real numbers must be identical. This is
 *      the assertion the whole feature rests on, and it is the one that can
 *      only really be made against a deployment with a real database behind it.
 *
 * It writes nothing. The one write it attempts is the one that has to be
 * refused, and it is attempted from inside a demo precisely because that is
 * where a mistake would be most damaging.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * Scenarios chosen to cover a different production surface each.
 *
 * `rows` is the repeated element that proves the screen reached its engine
 * rather than rendering an empty shell — which is exactly what a lazily
 * imported fixture chunk failing to load in production would look like.
 *
 * `label` is what the indicator must be naming, because "a screen rendered" and
 * "the screen this scenario asked for rendered" are different claims. The
 * league name is deliberately *not* used for this: Draft and Team print it,
 * Waivers and Matchup have no reason to, and asserting it everywhere would be
 * testing the fixture's name rather than the scenario's identity.
 */
const REPRESENTATIVE = [
  { id: 'draft-mid', tab: 'draft', rows: 'recommendation-row', label: 'Draft · round 6' },
  { id: 'sunday-pregame', tab: 'team', rows: 'starter-row', label: 'Sunday, 11:40am' },
  { id: 'waivers-tuesday-active', tab: 'waivers', rows: 'waiver-row', label: 'Waivers · Tuesday night' },
  { id: 'matchup-live-close', tab: 'matchup', rows: 'matchup-row', label: 'Matchup · one point in it' },
] as const;

/**
 * Tap a destination, and wait for the screen behind it rather than for a clock.
 *
 * The same outcome-based wait `smoke.spec.ts` uses, and for the same reason: a
 * fixed 400ms is a race this suite's `retries: 2` would quietly cover for. The
 * destination becomes current, its screen draws its navigation bar, and that
 * screen's first read is back — the skeletons and the spinner are what say it
 * is not. Tolerant of a screen that is still loading after twenty seconds,
 * which the caller's own assertions then report.
 */
async function open(page: Page, tab: string) {
  await page.getByTestId(`tab-${tab}`).click();
  await expect(page.getByTestId(`tab-${tab}`), `${tab} did not become the current destination`).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.nav-bar').first(), `${tab} drew no screen`).toBeVisible();
  await expect(page.locator('.app-main .skeleton, .app-main .spinner'))
    .toHaveCount(0, { timeout: 20_000 })
    .catch(() => {
      /* Still loading; the caller's own assertions decide what that means. */
    });
}

/** Enter a named scenario through the audit hook, and wait for it to be live. */
async function enter(page: Page, id: string) {
  await page.goto(`/?demo=${id}`);
  await expect(page.getByTestId('demo-bar')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
}

/**
 * The live overview, as a comparable fingerprint.
 *
 * Deliberately the fields that would move if a fixture had leaked into the
 * database — how many players are stored, which league is selected, what the
 * app thinks the season is doing — rather than the whole payload, which
 * legitimately carries timestamps that differ between two reads a minute apart.
 */
async function liveFingerprint(page: Page) {
  await page.goto('/');
  return page.evaluate(async () => {
    const res = await fetch('/api/overview');
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const league = body['selectedLeague'] as Record<string, unknown> | null;
    const lifecycle = body['lifecycle'] as Record<string, unknown> | null;
    return JSON.stringify({
      players: body['players'] ?? null,
      leagueId: league?.['id'] ?? null,
      leagueName: league?.['name'] ?? null,
      lifecycle: lifecycle?.['lifecycle'] ?? null,
    });
  });
}

test.describe('Demo Mode on the deployed site', () => {
  test('enters through the documented hook, names itself, and leaves', async ({ page }) => {
    // Nothing before: an ordinary visit is an ordinary visit.
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    await enter(page, 'draft-mid');

    /*
     * §4: conveyed beyond colour, and carrying the scenario's own clock.
     *
     * The words `Fixture data` used to be asserted here too. They were the
     * caption that made this bar three lines tall on a phone, above every
     * navigation bar in the app, and they said what the badge beside them
     * already says. The rule is that the state is legible without reading a
     * colour; the badge, the scenario's name and a real `<time>` are all text.
     */
    await expect(page.getByTestId('demo-badge')).toHaveText('DEMO');
    await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
    await expect(page.getByTestId('demo-bar').locator('time')).toHaveAttribute(
      'datetime',
      '2026-08-31T00:04:00.000Z',
    );
    // A status bar, not a banner.
    expect((await page.getByTestId('demo-bar').boundingBox())!.height).toBeLessThan(64);

    // …and it is not a tab, on the deployed bundle as much as locally.
    await expect(page.getByTestId('tab-demo')).toHaveCount(0);

    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    // Leaving is remembered: a fresh visit with no parameter is live.
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);
  });

  for (const scenario of REPRESENTATIVE) {
    test(`${scenario.id} renders the production ${scenario.tab} screen`, async ({ page }) => {
      await enter(page, scenario.id);

      // The scenario the hook asked for, not merely some demo.
      await expect(page.getByTestId('demo-scenario')).toContainText(scenario.label);

      await expect(page.getByTestId(`tab-${scenario.tab}`)).toBeVisible();
      await open(page, scenario.tab);

      // Real rows from the real engine, not an empty shell that happens to have
      // rendered. A lazily imported fixture chunk that failed to load in
      // production would show up exactly here.
      await expect(page.getByTestId(scenario.rows).first()).toBeVisible({ timeout: 20_000 });
      expect(await page.getByTestId(scenario.rows).count()).toBeGreaterThan(0);

      // And the indicator followed the reader onto the screen.
      await expect(page.getByTestId('demo-bar')).toBeVisible();
    });
  }

  /**
   * The matchup scenario, on the numbers rather than on the rows.
   *
   * `matchup-live-close` exists to be close, and closeness is the simulator's
   * conclusion rather than the fixture's claim. If the deployed bundle shipped
   * a different model — or the fixture chunk and the engine chunk disagreed —
   * the scoreboard would still render and this would still catch it.
   */
  test('matchup-live-close forecasts a genuinely close game in production', async ({ page }) => {
    await enter(page, 'matchup-live-close');
    await open(page, 'matchup');

    await expect(page.getByTestId('matchup-score')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('matchup-score')).toHaveAttribute('data-degraded', 'false');
    await expect(page.getByTestId('matchup-win-mine')).toBeVisible();
    /* Nine: the eight skill slots and the defence the demo league starts. */
    await expect(page.getByTestId('matchup-row')).toHaveCount(9);

    /*
     * No Live Insights element, and the insights themselves still reachable.
     *
     * Both halves matter in production and they fail differently: a stale
     * bundle would still draw the entry point, and a wrongly-pruned one would
     * drop the data. So the page is checked for the element's absence and the
     * sheet behind the odds for the rows' presence.
     */
    await expect(page.getByTestId('insight-entry')).toHaveCount(0);
    await expect(page.getByTestId('insight-entry-label')).toHaveCount(0);
    await page.getByTestId('matchup-win').click();
    await expect(page.getByTestId('odds-sheet')).toBeVisible();
    await expect(page.getByTestId('odds-sheet').getByTestId('insight-row').first()).toBeVisible();

    /*
     * And the scoreboard is the compact one: the two scores meet near the
     * middle rather than sitting at the card's outer edges. Measured as the gap
     * between them against the card's own width, so it holds at any width the
     * suite runs — a stale bundle drawing the old layout puts them a whole card
     * apart and fails this.
     */
    await page.getByTestId('odds-sheet').getByRole('button', { name: /done/i }).click();
    const gap = await page.getByTestId('matchup-score').evaluate((card) => {
      const mine = card.querySelector('[data-testid="matchup-actual-mine"]')!.getBoundingClientRect();
      const theirs = card.querySelector('[data-testid="matchup-actual-theirs"]')!.getBoundingClientRect();
      return (theirs.left - mine.right) / card.getBoundingClientRect().width;
    });
    expect(gap, 'the two scores sit near the middle of the card').toBeLessThan(0.3);
  });

  /**
   * The promise the whole feature rests on, made against a real database.
   *
   * Read live, run a demo, come back, read live again. Every number that would
   * move if a fixture had reached the database must be identical.
   */
  test('changes nothing about live truth', async ({ page }) => {
    const before = await liveFingerprint(page);
    test.skip(before === null, 'the overview did not answer on this deployment');

    for (const scenario of REPRESENTATIVE) {
      await enter(page, scenario.id);
      await open(page, scenario.tab);
    }
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    expect(await liveFingerprint(page), 'a demo changed live truth').toBe(before);
  });

  /**
   * The server refuses a write from a demo browser, on the deployment.
   *
   * Sent by hand, straight past the UI and past the API client, because the
   * point of the cookie is that it covers requests the app would never make.
   *
   * Exactly 403, deliberately, rather than "401 or 403". The middleware runs
   * before the passphrase check and regardless of it, so a demo browser gets
   * the demo refusal whether or not it is unlocked. A 401 here would mean the
   * request was stopped by the ordinary auth gate instead — which is still
   * closed, but would mean the demo cookie never reached the deployment, and
   * that is a fault worth failing on rather than accepting.
   */
  test('refuses a hand-made write while a demo is running', async ({ page }) => {
    await enter(page, 'draft-mid');

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/players/1001/my-guy', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 3 }),
      });
      return { status: res.status, body: (await res.text()).slice(0, 200) };
    });

    expect(result.status, `a demo write returned ${result.status}: ${result.body}`).toBe(403);
    expect(result.body).toContain('read-only');
  });
});
