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

  test('shows one hero insight card', async ({ page }) => {
    await expect(page.getByTestId('hero-card')).toHaveCount(1);
    await expect(page.getByTestId('hero-headline')).not.toBeEmpty();
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
   * Two insights means a carousel; one means a card.
   *
   * Both directions are checked, because a control that offers paging through a
   * single slide is a control that lies about having more to say.
   */
  test('pages between insights when there is more than one', async ({ page }) => {
    await serve(page, response());
    await expect(page.getByTestId('hero-dot')).toHaveCount(2);
    const first = await page.getByTestId('hero-headline').innerText();
    await page.getByTestId('hero-next').click();
    await expect(page.getByTestId('hero-headline')).not.toHaveText(first);
  });

  test('shows no pager at all when there is only one insight', async ({ page }) => {
    const body = response();
    (body.forecast.insights as unknown[]).length = 1;
    await serve(page, body);
    await expect(page.getByTestId('hero-card')).toBeVisible();
    await expect(page.getByTestId('hero-pager')).toHaveCount(0);
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
    await expect(page.getByTestId('hero-headline')).toHaveText('What decided it');
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
   * The confidence line appears when the forecast is weak, and only then.
   *
   * §32 asks for exactly this shape: quiet when there is nothing to say, and
   * present when a reader would otherwise take a thin number at face value.
   */
  test('names weak confidence, and stays silent when it is strong', async ({ page }) => {
    await serve(page, response());
    await expect(page.getByTestId('matchup-confidence')).toContainText('medium confidence');

    await page.unroute('**/api/leagues/*/matchup*');
    await serve(
      page,
      response({}, { freshness: { unresolvedAvailability: 0, missingProjection: 0, unknownKickoff: 0, level: 'high', detail: null } }),
    );
    await expect(page.getByTestId('matchup-confidence')).toHaveCount(0);
  });
});
