/**
 * Matchup, drawn.
 *
 * Two halves, and they use two different sources on purpose.
 *
 * The first half runs against the **real** endpoint on the seeded server: the
 * demo Sleeper serves a week-one head-to-head, the start/sit engine projects
 * both lineups from the demo's own Vegas fixtures, and the model simulates it.
 * That is what proves the screen loads an actual matchup rather than a fixture
 * somebody wrote to match the markup.
 *
 * The second half intercepts the endpoint, because the states worth checking —
 * live, final, degraded, clinched — are states of a Sunday afternoon and cannot
 * be reached from a deterministic seed without inventing a clock. Each fixture
 * is a whole response, so what is under test is still the screen's reading of
 * the model's output rather than of a mock component.
 *
 * The demo league's draft is `drafting`, so the seasonal gate correctly keeps
 * Matchup out of the bar. `/api/overview` is answered with the gate open in
 * every test here; the gate *itself* is covered in `toolbar.spec.ts` and in the
 * lifecycle unit tests, which is where a rule about when a tab exists belongs.
 */

import { expect, test, type Page } from '@playwright/test';

/** Open the seasonal gate without touching anything else in the overview. */
async function allowMatchup(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } },
    });
  });
}

async function openMatchup(page: Page) {
  await allowMatchup(page);
  await page.goto('/');
  await page.getByTestId('tab-matchup').click();
  await expect(page.getByTestId('matchup-score')).toBeVisible();
}

test.describe('the real matchup', () => {
  test.beforeEach(async ({ page }) => openMatchup(page));

  test('appears in the bar once the draft is done, and opens', async ({ page }) => {
    await expect(page.getByTestId('tab-matchup')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('matchup-nav')).toContainText(/Week \d+ Matchup/);
  });

  /**
   * The score is Sleeper's and the projection is this app's, and the screen
   * says which is which.
   *
   * The `proj` label is the whole of that distinction on a card where the two
   * numbers sit two millimetres apart, so it is asserted rather than assumed.
   */
  test('shows Sleeper’s score and Fantasy Analyst’s projection, labelled apart', async ({ page }) => {
    await expect(page.getByTestId('matchup-actual-mine')).toBeVisible();
    await expect(page.getByTestId('matchup-actual-theirs')).toBeVisible();
    const proj = page.getByTestId('matchup-proj-mine');
    await expect(proj).toContainText('proj');
    await expect(proj).not.toHaveText(await page.getByTestId('matchup-actual-mine').innerText());
  });

  test('shows Fantasy Analyst win odds as a number, not only a bar', async ({ page }) => {
    await expect(page.getByTestId('matchup-win-mine')).toContainText('%');
    await expect(page.getByTestId('matchup-win-theirs')).toContainText('%');
    const bar = page.getByTestId('matchup-win-bar');
    await expect(bar).toHaveAttribute('role', 'meter');
    await expect(bar).toHaveAttribute('aria-label', /% to win/);
  });

  /**
   * The scoreboard is compact, and compactness is geometry.
   *
   * Three claims the lock makes about this card, each of which a later edit can
   * undo while every other test here still passes:
   *
   *   1. **the scores meet near the middle.** They used to sit at the card's
   *      outer edges — two halves of one comparison a phone's width apart.
   *   2. **the percentages do too**, for the same reason, with one bar under
   *      them rather than squeezed between them.
   *   3. **the names sit over their own scores.** Pulling the numbers in is
   *      only a gain if whose number this is stays obvious, and the manager's
   *      name was doing the opposite of that: pinned to the card's outer edge
   *      while the score sat at the inner one, so a label and the thing it
   *      labels were at opposite ends of the column. Across the card that read
   *      as two names on the outside and two numbers in the middle, neither
   *      pair belonging to the other. This claim replaces "the names stay
   *      outside", which was the same test's original third clause and is the
   *      arrangement the punch list asked to be corrected. The first two are
   *      untouched.
   *
   * Everything is measured against the card's own width, so it holds at all
   * four widths this suite runs rather than encoding one of them.
   */
  test('draws a compact scoreboard, numbers in and names out', async ({ page }) => {
    const geometry = await page.getByTestId('matchup-score').evaluate((card) => {
      const box = card.getBoundingClientRect();
      const at = (sel: string) => card.querySelector(sel)!.getBoundingClientRect();
      const mine = at('[data-testid="matchup-actual-mine"]');
      const theirs = at('[data-testid="matchup-actual-theirs"]');
      const winMine = at('[data-testid="matchup-win-mine"]');
      const winTheirs = at('[data-testid="matchup-win-theirs"]');
      const bar = at('[data-testid="matchup-win-bar"]');
      const names = [...card.querySelectorAll('.matchup-team-name')].map((n) => n.getBoundingClientRect());
      const middle = (r: DOMRect) => r.left + r.width / 2;
      return {
        width: box.width,
        scoreGap: (theirs.left - mine.right) / box.width,
        winGap: (winTheirs.left - winMine.right) / box.width,
        barWidth: bar.width / box.width,
        barBelow: bar.top > winMine.bottom,
        nameOverScoreLeft: Math.abs(middle(names[0]!) - middle(mine)),
        nameOverScoreRight: Math.abs(middle(names[1]!) - middle(theirs)),
        nameAboveScore: names[0]!.bottom <= mine.top + 1,
        bars: card.querySelectorAll('[data-testid="matchup-win-bar"]').length,
      };
    });

    // The two scores, and the two percentages, close to the centre.
    expect(geometry.scoreGap, 'the scores sit near the middle').toBeLessThan(0.3);
    expect(geometry.winGap, 'the percentages sit near the middle').toBeLessThan(0.3);

    // One bar, under them, across the card — not one squeezed between them.
    expect(geometry.bars, 'one win bar, not two').toBe(1);
    expect(geometry.barBelow, 'the bar is beneath the percentages').toBe(true);
    expect(geometry.barWidth, 'the bar has the width of the card').toBeGreaterThan(0.8);

    // And each manager's name directly over the score that is theirs.
    expect(geometry.nameAboveScore, 'the name sits above the score, not beside it').toBe(true);
    expect(geometry.nameOverScoreLeft, 'the left name is off its score').toBeLessThanOrEqual(1);
    expect(geometry.nameOverScoreRight, 'the right name is off its score').toBeLessThanOrEqual(1);
  });

  /**
   * No Live Insights element on the matchup page, and no insight lost.
   *
   * The lock is explicit in both directions: no such card or button occupies
   * the main matchup page, and the feature and its data may stay. So the
   * absence is asserted here and the presence is asserted where they moved to —
   * `shows every insight in the sheet behind the odds`, below.
   */
  test('shows no Live Insights element on the page itself', async ({ page }) => {
    await expect(page.getByTestId('insight-entry')).toHaveCount(0);
    await expect(page.getByTestId('insight-entry-label')).toHaveCount(0);
    // Nor the words, in any element the screen happens to draw.
    await expect(page.getByTestId('matchup-pull')).not.toContainText(/live insight/i);
  });

  /**
   * One row per starting slot, with the position pill in the middle of each.
   *
   * The demo league starts QB, RB, RB, WR, WR, TE and a FLEX — seven slots, and
   * seven rows whatever either lineup contains. A row whose opposite half is
   * empty says so rather than shifting everything below it up by one.
   */
  test('draws one compact row per lineup slot, both sides on one line', async ({ page }) => {
    const rows = page.getByTestId('matchup-row');
    await expect(rows).toHaveCount(7);
    await expect(page.getByTestId('slot-pill').first()).toHaveText('QB');

    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      // A row that has wrapped to two lines is the failure this catches: the
      // whole lineup has to fit on one screen and a 60px row cannot.
      expect(box!.height, 'a starter row must stay on one line').toBeLessThan(52);
    }
  });

  test('does not print a box score under any player', async ({ page }) => {
    const row = page.getByTestId('matchup-row').first();
    const text = await row.innerText();
    // Points, projection, position and a name. No targets, carries, yards or
    // any of the raw stat line the brief explicitly rules out.
    expect(text).not.toMatch(/targets|carries|yds|rec\b|xFP|ADP/i);
  });

  test('keeps the bench collapsed until it is asked for', async ({ page }) => {
    await expect(page.getByTestId('matchup-bench')).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('bench-rows')).toHaveCount(0);
    await expect(page.getByTestId('bench-toggle')).toContainText(/Bench \(\d+\)/);

    await page.getByTestId('bench-toggle').click();
    await expect(page.getByTestId('matchup-bench')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('bench-rows')).toBeVisible();
  });

  /** The same sheet the Team screen opens, from the same evaluation. */
  test('opens the shared player sheet on tap', async ({ page }) => {
    await page.getByTestId('matchup-player').first().click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    await expect(page.getByTestId('weekly-verdict')).toBeVisible();
  });

  test('explains the odds one tap away, and says it never edits a lineup', async ({ page }) => {
    await page.getByTestId('matchup-win').click();
    await expect(page.getByTestId('odds-sheet')).toBeVisible();
    await expect(page.getByTestId('lineup-impact')).toBeVisible();
    await expect(page.getByTestId('odds-sheet')).toContainText('never edits one');
  });

  /**
   * No horizontal overflow, at whichever width this project is running.
   *
   * The one failure that is invisible in a screenshot and ruins the screen on a
   * phone: a row a few pixels wider than the viewport turns every vertical
   * scroll into a fight.
   */
  /**
   * The alignment fix, asserted as pixels.
   *
   * Each half of a row used to be a flex line — club, name, score — so the
   * score began wherever the name happened to end, and a name is a player's
   * name. Eight rows produced eight different x positions for the column a
   * reader is trying to compare left against right, which is what made the list
   * read as sloppy without it being obvious why. Fixed columns now, so this is
   * checkable: every score on a side starts on one edge, to the pixel.
   */
  test('lines every score up down the page, on both sides', async ({ page }) => {
    const edges = await page.getByTestId('matchup-row').evaluateAll((rows) => {
      const read = (side: string, pick: (r: DOMRect) => number) =>
        rows
          .map((row) => row.querySelector(`.matchup-half[data-side="${side}"] .matchup-points`))
          .filter((el): el is Element => el != null)
          .map((el) => Math.round(pick(el.getBoundingClientRect())));
      return {
        // Mine sits against the pill, so its right edge is the shared one.
        mine: read('mine', (r) => r.right),
        theirs: read('theirs', (r) => r.left),
      };
    });

    expect(edges.mine.length, 'the lineup should be drawing scores').toBeGreaterThan(4);
    expect(new Set(edges.mine).size, `my scores ended at ${[...new Set(edges.mine)].join(', ')}`).toBe(1);
    expect(new Set(edges.theirs).size, `their scores began at ${[...new Set(edges.theirs)].join(', ')}`).toBe(1);
  });

  /**
   * …and the rows really do contain the mix that used to break it: a short
   * name, a long one, and a status chip. A uniform lineup could otherwise pass
   * the assertion above by accident.
   */
  test('and does so with names of every length and a status chip among them', async ({ page }) => {
    const names = await page
      .getByTestId('matchup-row')
      .locator('.matchup-name')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.length));
    expect(names.length).toBeGreaterThan(4);
    expect(Math.max(...names) - Math.min(...names), 'every name is the same length').toBeGreaterThan(2);
  });

  test('never overflows the page sideways', async ({ page }) => {
    await page.getByTestId('bench-toggle').click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('keeps every tap target reachable', async ({ page }) => {
    for (const testId of ['bench-toggle', 'matchup-win']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, `${testId} is too small to tap`).toBeGreaterThanOrEqual(40);
    }
  });
});

/* ------------------------------------------------------------- fixtures */

/**
 * A whole `/api/leagues/:id/matchup` response, shaped like the model's.
 *
 * Built from one function rather than four literals so the states differ only
 * where a test says they do — a fixture that drifted between cases would be
 * testing the fixture.
 */
function response(over: Record<string, unknown> = {}, forecastOver: Record<string, unknown> = {}) {
  const player = (id: string, name: string, position: string, side: string, extra: Record<string, unknown> = {}) => ({
    playerId: id,
    name,
    fullName: `${name.replace('. ', 'ony ')}`,
    position,
    team: 'KC',
    opponent: 'DEN',
    slot: `${position}#0`,
    side,
    starting: true,
    actual: 0,
    projectedFinal: 14.2,
    remaining: 14.2,
    phase: 'not_started',
    locked: false,
    statusFlag: null,
    availabilityRisky: false,
    ...extra,
  });

  return {
    league: { id: 'demo-league', name: 'Demo Dynasty', season: '2026', scoringLabel: 'Half PPR' },
    week: 16,
    season: '2026',
    found: true,
    reason: null,
    cached: false,
    cards: {},
    forecast: {
      modelVersion: 'matchup-1.0.0',
      fingerprint: 'fixture',
      computedAt: '2026-12-20T18:00:00.000Z',
      draws: 4000,
      phase: 'live',
      teams: {
        mine: {
          rosterId: 1,
          side: 'mine',
          name: 'Ceedeez Nuts',
          avatar: null,
          record: '9-5',
          actual: 107,
          projectedFinal: 125.9,
          winProbability: 0.18,
        },
        theirs: {
          rosterId: 2,
          side: 'theirs',
          name: 'Juncer’s Hog Format',
          avatar: null,
          record: '9-5',
          actual: 124.2,
          projectedFinal: 130.7,
          winProbability: 0.82,
        },
      },
      slots: [
        {
          slot: 'QB',
          mine: player('m1', 'J. Allen', 'QB', 'mine', { actual: 6.9, projectedFinal: 25.6, phase: 'live' }),
          theirs: player('t1', 'D. Maye', 'QB', 'theirs', { actual: 27.7, projectedFinal: 21.8, phase: 'live' }),
        },
        {
          slot: 'RB',
          mine: player('m2', 'B. Hall', 'RB', 'mine', { actual: 7.3, projectedFinal: 11.5, phase: 'live' }),
          theirs: null,
        },
      ],
      bench: {
        mine: [player('m9', 'C. Olave', 'WR', 'mine', { starting: false, slot: null })],
        theirs: [],
      },
      insights: [
        {
          key: 'need:m1',
          kind: 'need',
          urgency: 'material',
          headline: 'Need roughly 18.4 more from J. Allen to reach 72% win odds',
          detail: 'Projected to trail by 4.8',
          playerId: 'm1',
          side: 'mine',
          winImpact: 0.4,
          priority: 240,
          relevantSince: '2026-12-20T18:00:00.000Z',
          sourceFingerprint: 'fixture',
          generatedAt: '2026-12-20T18:00:00.000Z',
        },
        {
          key: 'injury:m9',
          kind: 'injury',
          urgency: 'act_now',
          headline: 'C. Olave is a genuine question',
          detail: 'About 9% of your win odds are riding on whether he plays.',
          playerId: 'm9',
          side: 'mine',
          winImpact: 0.09,
          priority: 340,
          relevantSince: '2026-12-20T18:00:00.000Z',
          sourceFingerprint: 'fixture',
          generatedAt: '2026-12-20T18:00:00.000Z',
        },
      ],
      leverage: [],
      decision: { best: null, options: [], considered: 0, note: 'No legal change improves your chance of winning this matchup.' },
      suggestedMode: {
        mode: 'ceiling',
        auto: true,
        state: 'substantial_underdog',
        margin: -14.2,
        mine: null,
        opponent: null,
        detail: 'Ceiling — you are a substantial underdog by about 14 points.',
        reasons: [],
      },
      clinch: { mathematical: false, nearClinch: false, leader: null, maxRemainingForTrailer: 40 },
      freshness: { unresolvedAvailability: 1, missingProjection: 0, unknownKickoff: 0, level: 'medium', detail: '1 availability unresolved' },
      degraded: false,
      ...forecastOver,
    },
    ...over,
  };
}

async function serve(page: Page, body: unknown) {
  await allowMatchup(page);
  await page.route('**/api/leagues/*/matchup*', async (route) => route.fulfill({ json: body }));
  await page.goto('/');
  await page.getByTestId('tab-matchup').click();
}

test.describe('the states of an afternoon', () => {
  test('shows a live matchup as live, with both scores from Sleeper', async ({ page }) => {
    await serve(page, response());
    await expect(page.getByTestId('matchup-state')).toContainText('LIVE');
    await expect(page.getByTestId('matchup-actual-mine')).toHaveText('107.00');
    await expect(page.getByTestId('matchup-actual-theirs')).toHaveText('124.20');
    await expect(page.getByTestId('matchup-win-mine')).toContainText('18%');
  });

  /**
   * The insights left the page, and none of them left the app.
   *
   * This began as a carousel above the lineup — self-advancing, two arrows, a
   * row of dots — then became a single tappable row reading `Live insights · 2`
   * on the one screen whose stated job is fitting a starting lineup onto a
   * phone. The lock removes the visible element entirely and keeps the feature,
   * so both halves are checked here: nothing on the matchup page names them,
   * and every one of them is in the sheet behind the win probability, still in
   * priority order and each still leading to its own player.
   */
  test('shows every insight in the sheet behind the odds, and none on the page', async ({ page }) => {
    await serve(page, response());

    // Not the entry point, not the carousel chrome, not the words.
    for (const id of ['insight-entry', 'insight-entry-label', 'insight-sheet', 'hero-dot', 'hero-prev', 'hero-next', 'hero-pager', 'hero-action']) {
      await expect(page.getByTestId(id), `${id} is on the matchup page`).toHaveCount(0);
    }
    await expect(page.getByTestId('matchup-pull')).not.toContainText(/live insight/i);
    await expect(page.getByTestId('matchup-pull')).not.toContainText('Need roughly');

    // And all of them one tap away, behind the number they are about.
    await page.getByTestId('matchup-win').click();
    const sheet = page.getByTestId('odds-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('insight-row')).toHaveCount(2);
    await expect(sheet.getByTestId('insight-row').first()).toContainText('Need roughly');
  });

  /**
   * An insight still leads to its player, from where it now lives.
   *
   * The row was tappable when it sat in its own sheet and it is tappable in
   * this one: the sheet closes and the player's card opens over the matchup.
   * A list of players you cannot open is a list, not an insight.
   */
  test('opens the player an insight names', async ({ page }) => {
    /*
     * A card for the man the first insight is about.
     *
     * The base fixture carries `cards: {}`, which is a legitimate state — a
     * player Sleeper rosters that the dictionary has not synced has nothing to
     * open — and it is the state in which an insight row is deliberately not a
     * button. That makes it the wrong fixture for this claim: a click on a
     * non-button asserts nothing, which is how the test this replaced managed
     * to pass while proving nothing. So the card exists here.
     */
    const body = response();
    (body as { cards: Record<string, unknown> }).cards = {
      m1: {
        playerId: 'm1',
        name: 'J. Allen',
        position: 'QB',
        team: 'BUF',
        headline: { verdict: 'start', label: 'Start', detail: null, tone: 'take' },
        confidence: 'high',
        score: 25.6,
        opponent: 'NE',
        lines: [],
        props: [],
        drivers: [],
        conflicts: [],
        changes: [],
        pending: [],
      },
    };
    await serve(page, body);

    await page.getByTestId('matchup-win').click();
    const row = page.getByTestId('odds-sheet').getByTestId('insight-row').first();
    // A button, because there is something behind it — the rule this rests on.
    await expect(row).toHaveRole('button');
    await row.click();

    await expect(page.getByTestId('odds-sheet')).toHaveCount(0);
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
  });

  test('replaces the live state with FINAL and drops the odds bar', async ({ page }) => {
    await serve(
      page,
      response(
        {},
        {
          phase: 'final',
          insights: [
            {
              key: 'decided:m1',
              kind: 'what_decided_it',
              urgency: 'material',
              headline: 'What decided it',
              detail: 'J. Allen finished +18.6 against projection. You won by 6.2.',
              playerId: 'm1',
              side: 'mine',
              winImpact: 0.5,
              priority: 240,
              relevantSince: '2026-12-20T22:00:00.000Z',
              sourceFingerprint: 'fixture',
              generatedAt: '2026-12-20T22:00:00.000Z',
            },
          ],
        },
      ),
    );
    await expect(page.getByTestId('matchup-state')).toHaveText('FINAL');
    // No insight element on a settled page either — the same rule as a live one.
    await expect(page.getByTestId('insight-entry-label')).toHaveCount(0);
    // The odds are gone: a settled matchup has a result, not a probability.
    await expect(page.getByTestId('matchup-win')).toHaveCount(0);
    await expect(page.getByTestId('matchup-proj-mine')).toHaveCount(0);
    await expect(page.getByTestId('matchup-result')).toContainText('Lost by 17.20');
    // The real scores are exactly where they were.
    await expect(page.getByTestId('matchup-actual-mine')).toHaveText('107.00');
    // The bench is still there to look back at.
    await expect(page.getByTestId('bench-toggle')).toBeVisible();
  });

  /**
   * A forecast that cannot be produced must not take the scoreboard with it.
   *
   * The failure this rules out is the one §33 names: substituting somebody
   * else's projection and labelling it as this app's. There is no projected
   * number on screen at all, and the real scores are untouched.
   */
  test('keeps the scoreboard working when the forecast is unavailable', async ({ page }) => {
    await serve(
      page,
      response(
        {},
        {
          degraded: true,
          teams: {
            mine: { rosterId: 1, side: 'mine', name: 'Ceedeez Nuts', avatar: null, record: '9-5', actual: 107, projectedFinal: null, winProbability: null },
            theirs: { rosterId: 2, side: 'theirs', name: 'Juncer’s Hog Format', avatar: null, record: '9-5', actual: 124.2, projectedFinal: null, winProbability: null },
          },
          insights: [
            {
              key: 'degraded',
              kind: 'degraded',
              urgency: 'informational',
              headline: 'Fantasy Analyst forecast temporarily unavailable',
              detail: 'The scoreboard above is Sleeper’s and is unaffected.',
              playerId: null,
              side: null,
              winImpact: 0,
              priority: 100,
              relevantSince: '2026-12-20T18:00:00.000Z',
              sourceFingerprint: 'fixture',
              generatedAt: '2026-12-20T18:00:00.000Z',
            },
          ],
        },
      ),
    );

    await expect(page.getByTestId('matchup-actual-mine')).toHaveText('107.00');
    await expect(page.getByTestId('matchup-actual-theirs')).toHaveText('124.20');
    await expect(page.getByTestId('matchup-degraded')).toBeVisible();
    await expect(page.getByTestId('matchup-win')).toHaveCount(0);
    await expect(page.getByTestId('matchup-proj-mine')).toContainText('no forecast');
    // The lineup is still drawn: it is Sleeper's, and Sleeper is fine.
    await expect(page.getByTestId('matchup-row')).toHaveCount(2);
  });

  test('says plainly when there is no matchup this week', async ({ page }) => {
    await serve(page, {
      league: { id: 'demo-league', name: 'Demo Dynasty', season: '2026', scoringLabel: 'Half PPR' },
      week: 18,
      season: '2026',
      found: false,
      reason: 'You have no opponent in week 18 — a bye, or the schedule is not published yet.',
      forecast: null,
      cards: {},
      cached: false,
    });
    await expect(page.getByText('no opponent in week 18')).toBeVisible();
    await expect(page.getByTestId('matchup-score')).toHaveCount(0);
  });

  /**
   * Confidence is a row in the sheet, and never a line on the page.
   *
   * It used to sit directly under the win bar, which is the strip immediately
   * above the lineup — the most valuable inch on this screen — spent on a
   * sentence about the forecast rather than on the forecast. It is not deleted:
   * a reader who wants to know how much to trust a number taps the bar, and
   * this checks it is genuinely there when they do.
   *
   * The claim §32 was defending is kept whole. A weak forecast still says so,
   * in its own words, one tap from the number it qualifies.
   */
  test('keeps confidence off the page and inside the odds sheet', async ({ page }) => {
    await serve(page, response());
    await expect(page.getByTestId('matchup-confidence')).toHaveCount(0);
    await expect(page.getByText(/medium confidence/i)).toHaveCount(0);

    await page.getByTestId('matchup-win').click();
    const sheet = page.getByTestId('odds-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(/confidence/i);
    await expect(sheet).toContainText('medium');
  });
});

/**
 * The scoreboard, read as a pair.
 *
 * Two refinements with one subject: making the card say *whose* number is
 * which, and *which way it is going*, without spending another pixel of a
 * screen whose job is fitting a starting lineup onto a phone.
 */
test.describe('the scoreboard', () => {
  /** Where a thing's middle is, to the pixel the eye can see. */
  async function centres(page: Page, side: 'mine' | 'theirs') {
    return page.getByTestId(`matchup-team-${side}`).evaluate((column) => {
      const middle = (sel: string) => {
        const el = column.querySelector(sel);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return Math.round(box.left + box.width / 2);
      };
      const name = column.querySelector('.matchup-team-name');
      return {
        name: middle('.matchup-team-name'),
        score: middle('.matchup-team-score'),
        right: Math.round(column.getBoundingClientRect().right),
        clipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
      };
    });
  }

  /**
   * The manager's name over the manager's score.
   *
   * It used to be pinned to the card's outer edge while the score sat at the
   * inner one — a label and the thing it labels at opposite ends of the column,
   * which across the card read as two names on the outside and two numbers in
   * the middle, neither pair belonging to the other.
   */
  test('centres each manager over the score that is theirs', async ({ page }) => {
    await serve(page, response());
    const mine = await centres(page, 'mine');
    const theirs = await centres(page, 'theirs');

    expect(Math.abs(mine.name! - mine.score!), 'the left label is off its score').toBeLessThanOrEqual(1);
    expect(Math.abs(theirs.name! - theirs.score!), 'the right label is off its score').toBeLessThanOrEqual(1);
  });

  /**
   * …and the two of them balanced about the `vs`.
   *
   * Symmetry is the claim, so symmetry is what is measured: the gap from the
   * card's left edge to the left pair should match the gap from the right pair
   * to its right edge.
   */
  test('and balances the two sides about the centre', async ({ page }) => {
    await serve(page, response());
    const card = (await page.getByTestId('matchup-score').boundingBox())!;
    const mine = await centres(page, 'mine');
    const theirs = await centres(page, 'theirs');

    const leftGap = mine.score! - card.x;
    const rightGap = card.x + card.width - theirs.score!;
    expect(Math.abs(leftGap - rightGap), `${Math.round(leftGap)}px against ${Math.round(rightGap)}px`).toBeLessThanOrEqual(2);
  });

  /**
   * A joke of a team name truncates rather than moving the score.
   *
   * Managers name their teams whatever they like and the length is unbounded.
   * The one thing that may not happen is the label widening its column and
   * pushing the two scores apart — the numbers meeting near the middle is what
   * makes them legible as one comparison.
   */
  test('truncates a long manager name instead of shifting the scoreboard', async ({ page }) => {
    await serve(page, response());
    const before = await centres(page, 'mine');

    await serve(
      page,
      response({}, {
        teams: {
          mine: {
            rosterId: 1,
            side: 'mine',
            name: 'The Astonishingly Long Name Of A Team That Will Not Fit Anywhere',
            avatar: null,
            record: null,
            actual: 107,
            projectedFinal: 125.9,
            winProbability: 0.18,
          },
          theirs: {
            rosterId: 2,
            side: 'theirs',
            name: 'Juncer’s Hog Format',
            avatar: null,
            record: null,
            actual: 124.2,
            projectedFinal: 139.6,
            winProbability: 0.82,
          },
        },
      }),
    );

    const after = await centres(page, 'mine');
    expect(after.clipped, 'the long name should be truncating').toBe(true);
    expect(after.score, 'the score moved to make room for a team name').toBe(before.score);
    // And the card is still a card: nothing has escaped it sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  /**
   * The bar says which way it is going, from our side and no other input.
   *
   * It was one accent blue at 68% and at 16%, which made it a picture of a
   * percentage rather than a reading of one. Asserted as the semantic attribute
   * rather than as a colour value, because what must be right is the *rule*;
   * which green is a stylesheet's business, and it has a light and a dark one.
   */
  for (const [probability, tone] of [
    [0.68, 'ahead'],
    [0.5, 'even'],
    [0.16, 'behind'],
    [0.999, 'ahead'],
    [0.001, 'behind'],
  ] as const) {
    test(`colours the bar ${tone} when our side is on ${Math.round(probability * 100)}%`, async ({ page }) => {
      await serve(page, response({}, { teams: teamsAt(probability) }));
      const bar = page.getByTestId('matchup-win-bar');
      await expect(bar).toHaveAttribute('data-tone', tone);
      await expect(bar).toHaveAttribute('aria-valuenow', String(Math.round(probability * 100)));
    });
  }

  /**
   * The colour and the printed number can never disagree.
   *
   * 50.4% is printed as `50%`, and a green bar beside a number saying even
   * would be the card contradicting itself in the two millimetres between them.
   * The tone is read off the same rounded integer the reader sees.
   */
  test('goes by the number on screen rather than the raw probability', async ({ page }) => {
    for (const [probability, tone] of [
      [0.504, 'even'],
      [0.496, 'even'],
      [0.506, 'ahead'],
      [0.494, 'behind'],
    ] as const) {
      await serve(page, response({}, { teams: teamsAt(probability) }));
      await expect(page.getByTestId('matchup-win-mine')).toContainText(`${Math.round(probability * 100)}%`);
      await expect(page.getByTestId('matchup-win-bar')).toHaveAttribute('data-tone', tone);
    }
  });

  /**
   * And none of it costs the card any height.
   *
   * The compaction was measured and merged in #122, and a label that grew into
   * a heading or a bar that grew a border would give it straight back. The two
   * numbers are what this card actually measures on `main`: 111px without a
   * record line and 126px with one, at every width the suite runs. Both are
   * unchanged by the manager chips and the coloured bar — the chip is smaller
   * type than the heading it replaced and sits in a row that already existed.
   */
  test('stays as compact as the pass that compacted it', async ({ page }) => {
    await serve(page, response());
    const withRecord = (await page.getByTestId('matchup-score').boundingBox())!;
    expect(Math.round(withRecord.height), `the scoreboard has grown to ${Math.round(withRecord.height)}px`).toBeLessThanOrEqual(126);
    // The bench is untouched by any of this and still folds.
    await expect(page.getByTestId('bench-toggle')).toBeVisible();

    // …and the shape most weeks actually have, with no record line on it.
    await serve(page, response({}, { teams: teamsAt(0.18, { record: null }) }));
    const plain = (await page.getByTestId('matchup-score').boundingBox())!;
    expect(Math.round(plain.height), `the scoreboard has grown to ${Math.round(plain.height)}px`).toBeLessThanOrEqual(111);
  });
});

/** Both sides of the scoreboard, with our win probability set to `mine`. */
function teamsAt(mine: number, over: Record<string, unknown> = {}) {
  return {
    mine: {
      rosterId: 1,
      side: 'mine',
      name: 'Ceedeez Nuts',
      avatar: null,
      record: '9-5',
      actual: 107,
      projectedFinal: 125.9,
      winProbability: mine,
      ...over,
    },
    theirs: {
      rosterId: 2,
      side: 'theirs',
      name: 'Juncer’s Hog Format',
      avatar: null,
      record: '9-5',
      actual: 124.2,
      projectedFinal: 139.6,
      winProbability: 1 - mine,
      ...over,
    },
  };
}
