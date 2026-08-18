/**
 * The season, from the morning after the draft to the following March.
 *
 * The same twelve managers and the same roster throughout, so a reader can step
 * a whole year without losing the thread. What changes between scenarios is the
 * clock, the week's market, who is hurt, what the wire holds and how much money
 * is left — and every conclusion drawn from those is the production engine's.
 *
 * Nothing here states a recommendation, a bid, a lineup or a verdict.
 */

import { fixedClock, hoursBefore } from '../clock.ts';
import type { DemoScenario } from '../types.ts';
import type { DemoWeekSpec } from './spec.ts';
import {
  CLEAN_REPAIR,
  DRAFT_TEAMS,
  MESSY_REPAIR,
  collectPlayerState,
  makeAdp,
  makeBudget,
  makeDraft,
  makeLeague,
  makeNflState,
  makeNoFaabBudget,
  makePicks,
  makeRosters,
  makeTrending,
  overrideSpecs,
  type ScenarioData,
  type ScenarioStrategy,
} from './build.ts';
import { DEMO_MANAGERS, MY_ROSTER_ID, WORLD_PLAYERS, adpOrder } from './world.ts';

/**
 * The team the reader is looking after all season.
 *
 * Eight starters and six on the bench, chosen so the lineup has one genuinely
 * close call, one player the market and the ledger disagree about, one
 * fragile starter and one bench player who is plainly not earning his slot.
 */
const MY_ROSTER = [
  'p010', // QB  Trey Halloran
  'p001', // RB  Marcus Vance
  'p023', // RB  Ike Sandoval
  'p003', // WR  Kai Brennan
  'p009', // WR  Emeka Falade
  'p008', // WR  Silas Brandt
  'p016', // TE  Andre Sotelo
  'p025', // FLEX Yusuf Adeyemi
  'p013', // BN  Casey Lindqvist (QB)
  'p028', // BN  Rey Villanueva (RB)
  'p030', // BN  Femi Adebayo (RB)
  'p031', // BN  Karl Ostrowski (WR)
  'p037', // BN  Kwame Boateng (WR) — the other half of the flex argument
  'p019', // BN  Grant Aldous (TE)
];

const MY_STARTERS = ['p010', 'p001', 'p023', 'p003', 'p009', 'p008', 'p016', 'p025'];

/**
 * The wire.
 *
 * Held out of every roster so the waiver scan has something to find. Each one
 * is a different kind of case: the obvious add whose role is measurably rising,
 * a competing name at the same position, a body nobody has measured at all, and
 * two who are simply not better than what the roster holds — which is the
 * answer a waiver page most often has to give and most often does not.
 */
const FREE_AGENTS = ['p039', 'p034', 'p036', 'p033', 'p035', 'p038', 'p040', 'p027', 'p029', 'p032'];

/**
 * Rosters for a season scenario.
 *
 * Mine is the team above. The other eleven are filled from the draft order,
 * skipping mine and skipping the wire, which produces ownership that looks like
 * a real league without anybody having typed a hundred and fifty ids.
 */
function seasonRosters(): Map<number, string[]> {
  const taken = new Set([...MY_ROSTER, ...FREE_AGENTS]);
  const pool = adpOrder()
    .map((p) => p.id)
    .filter((id) => !taken.has(id));

  const out = new Map<number, string[]>();
  out.set(MY_ROSTER_ID, [...MY_ROSTER]);
  const others = DEMO_MANAGERS.filter((m) => !m.isMine);
  for (const manager of others) out.set(manager.rosterId, []);

  let i = 0;
  for (let round = 0; round < 14; round++) {
    for (const manager of others) {
      const id = pool[i++];
      if (!id) break;
      out.get(manager.rosterId)!.push(id);
    }
  }
  return out;
}

// -------------------------------------------------------------- the weeks

/** A settled usage series: eight weeks that say the same thing. */
function steady(primary: number, secondary: number, weeks: number[]): DemoWeekSpec['usage'] {
  return {
    weeks,
    primary: weeks.map((_, i) => primary + (i % 2 === 0 ? -1 : 1)),
    secondary: weeks.map(() => secondary),
    touchdowns: weeks.map((_, i) => (i % 3 === 0 ? 1 : 0)),
  };
}

/** A role that has genuinely changed: three recent games well above the five before. */
function rising(from: number, to: number, secondaryFrom: number, secondaryTo: number, weeks: number[]): DemoWeekSpec['usage'] {
  const cut = weeks.length - 3;
  return {
    weeks,
    primary: weeks.map((_, i) => (i < cut ? from : to)),
    secondary: weeks.map((_, i) => (i < cut ? secondaryFrom : secondaryTo)),
    touchdowns: weeks.map((_, i) => (i >= cut ? 1 : 0)),
  };
}

/** One enormous week and nothing either side. The trap a bid must not pay for. */
function spike(base: number, peak: number, weeks: number[]): DemoWeekSpec['usage'] {
  return {
    weeks,
    primary: weeks.map((_, i) => (i === weeks.length - 2 ? peak : base)),
    secondary: weeks.map(() => 0.1),
    touchdowns: weeks.map((_, i) => (i === weeks.length - 2 ? 3 : 0)),
  };
}

const W6 = [1, 2, 3, 4, 5];
const W7 = [1, 2, 3, 4, 5, 6];

/**
 * Week six, Sunday morning.
 *
 * The flex is the argument: `p025` is a steady, high-floor target hog whose
 * market number is unspectacular, and `p037` is priced almost identically off a
 * far more concentrated role. Floor and Ceiling are being asked to disagree,
 * and the engine — not this file — decides whether they do.
 */
const WEEK_SIX: Record<string, DemoWeekSpec> = {
  p010: { points: 19.4, previousPoints: 18.2, kickoffInHours: 1.3, opponent: 'CLE', spread: -3.5, total: 44.5,
    usage: steady(34, 4, W6) },
  p001: { points: 17.8, previousPoints: 17.1, kickoffInHours: 1.3, opponent: 'LV', spread: -6.5, total: 47.5,
    usage: steady(19, 4, W6) },
  p023: { points: 11.2, previousPoints: 12.6, kickoffInHours: 1.3, opponent: 'CHI', spread: 1.5, total: 41,
    usage: steady(13, 3, W6) },
  p003: { points: 16.1, previousPoints: 15.4, kickoffInHours: 1.3, opponent: 'NYJ', spread: -4.5, total: 46,
    usage: steady(9, 0.26, W6) },
  p009: { points: 14.9, previousPoints: 12.8, kickoffInHours: 4.3, opponent: 'IND', spread: 2.5, total: 48.5,
    usage: rising(6, 11, 0.17, 0.29, W6) },
  p008: { points: 12.3, previousPoints: 13.9, kickoffInHours: 1.3, opponent: 'GB', spread: 3, total: 43,
    usage: steady(8, 0.22, W6) },
  p016: { points: 9.6, previousPoints: 9.1, kickoffInHours: 1.3, opponent: 'PHI', spread: 2.5, total: 45,
    usage: steady(7, 0.19, W6),
    // Questionable in the report, and he practised in full on Friday. Those two
    // facts together are the most useful thing either source said.
    injury: { designation: 'Questionable', bodyPart: 'ankle', practice: ['DNP', 'Limited', 'Full'], reportHoursAgo: 19 } },
  p025: { points: 11.4, previousPoints: 11.2, kickoffInHours: 1.3, opponent: 'ATL', spread: -1, total: 44,
    usage: steady(8, 0.23, W6) },
  p037: { points: 11.6, previousPoints: 10.1, kickoffInHours: 4.3, opponent: 'PIT', spread: -2.5, total: 40.5,
    usage: spike(4, 13, W6) },
  p013: { points: 15.2, kickoffInHours: 1.3, opponent: 'SEA', spread: 2, total: 43.5, usage: steady(31, 2, W6) },
  p028: { points: 8.9, kickoffInHours: 1.3, opponent: 'TEN', spread: -1.5, total: 42, usage: steady(9, 2, W6) },
  p030: { points: 6.4, kickoffInHours: 1.3, opponent: 'MIN', spread: 4.5, total: 40, usage: steady(6, 1, W6) },
  p031: { points: 7.8, kickoffInHours: 1.3, opponent: 'BAL', spread: 5.5, total: 41.5, usage: steady(5, 0.13, W6) },
  // No market at all. A bye, and the app has to say so rather than score a zero.
  p019: { points: null, kickoffInHours: null, opponent: null },

  // ------------------------------------------------------------- the wire
  p039: { points: 12.8, previousPoints: 8.4, kickoffInHours: 1.3, opponent: 'NE', spread: -3, total: 45,
    usage: rising(4, 10, 0.11, 0.27, W6) },
  p034: { points: 10.1, previousPoints: 9.7, kickoffInHours: 1.3, opponent: 'DAL', spread: 6, total: 44,
    usage: steady(11, 3, W6) },
  // Nobody has measured him. Every role-dependent number must decline to answer.
  p036: { points: 9.4, kickoffInHours: 1.3, opponent: 'ARI', spread: 2.5, total: 43 },
  p033: { points: 7.1, kickoffInHours: 1.3, opponent: 'HOU', spread: 3.5, total: 42.5, usage: steady(4, 0.11, W6) },
  p035: { points: 6.8, kickoffInHours: 1.3, opponent: 'DEN', spread: 7, total: 39, usage: steady(4, 0.1, W6) },
  p038: { points: 5.9, kickoffInHours: 1.3, opponent: 'CAR', spread: -1, total: 41, usage: steady(5, 1, W6) },
  p040: { points: 5.2, kickoffInHours: 1.3, opponent: 'JAX', spread: 4, total: 40, usage: steady(4, 1, W6) },
  p027: { points: 6.1, kickoffInHours: 1.3, opponent: 'LAC', spread: 2, total: 44, usage: steady(5, 0.12, W6) },
  p029: { points: 5.4, kickoffInHours: 1.3, opponent: 'NO', spread: 1, total: 41, usage: steady(4, 0.1, W6) },
  p032: { points: 4.8, kickoffInHours: 1.3, opponent: 'TB', spread: 5, total: 42, usage: steady(4, 1, W6) },
};

/** Ten to eight minutes before kickoff, a starter is downgraded. */
const LATE_PIVOT: Record<string, Partial<DemoWeekSpec>> = {
  p003: {
    kickoffInHours: 0.13,
    injury: {
      designation: 'Doubtful',
      bodyPart: 'hamstring',
      practice: ['Limited', 'Limited', 'DNP'],
      reportHoursAgo: 0.4,
      sleeperSays: 'Doubtful',
    },
  },
  // Already playing, so no longer a swap however good he looks.
  p008: { kickoffInHours: -0.7 },
  p016: { kickoffInHours: -0.7 },
  // His direct beneficiary is on the wire and about to be very popular.
  p039: { points: 14.2, kickoffInHours: 3.9 },
};

/**
 * A usage series with week six played and in the book.
 *
 * The last value repeated rather than invented: what week six actually
 * *produced* is not something this fixture has an opinion about, and adding a
 * number pulled out of the air would move a role trend the reader is being
 * shown. Repeating the most recent game is the smallest honest extension of a
 * series, and it leaves every trend saying what it said on Sunday.
 */
function playedAnotherWeek(usage: DemoWeekSpec['usage']): DemoWeekSpec['usage'] {
  if (!usage) return undefined;
  return {
    weeks: W7,
    primary: [...usage.primary, usage.primary.at(-1)!],
    secondary: usage.secondary ? [...usage.secondary, usage.secondary.at(-1)!] : undefined,
    touchdowns: usage.touchdowns ? [...usage.touchdowns, 0] : undefined,
  };
}

/** Week seven, the following Tuesday night, with byes biting. */
const WEEK_SEVEN: Record<string, DemoWeekSpec> = Object.fromEntries(
  Object.entries(WEEK_SIX).map(([id, week]) => [
    id,
    {
      ...week,
      // Two days out, so nothing is locked and the wire is the whole story.
      kickoffInHours: 110,
      usage: playedAnotherWeek(week.usage),
    },
  ]),
);

/* On a bye in week seven, which is what makes the wire urgent rather than nice. */
WEEK_SEVEN['p008'] = { points: null, kickoffInHours: null, opponent: null };
WEEK_SEVEN['p025'] = { points: null, kickoffInHours: null, opponent: null };

// ------------------------------------------------------------- the money

/**
 * What the room has spent by week seven.
 *
 * Deliberately uneven. Two managers have almost nothing left, four are
 * comfortable, and the reader is in the middle with $37 — which is the position
 * in which the difference between "what he will go for" and "what he is worth
 * to you" actually decides something.
 */
const SPENT_BY_WEEK_SEVEN = new Map<number, number>([
  [1, 12], [2, 71], [3, 44], [4, 8], [5, 93], [6, 30],
  [7, 55], [8, 22], [MY_ROSTER_ID, 63], [10, 4], [11, 88], [12, 41],
]);

/** After the Wednesday run, the winning claim has come out of the wallet. */
const SPENT_AFTER_RUN = new Map(SPENT_BY_WEEK_SEVEN);
SPENT_AFTER_RUN.set(MY_ROSTER_ID, 63 + 21);
SPENT_AFTER_RUN.set(2, 71 + 9);
SPENT_AFTER_RUN.set(6, 30 + 17);

/**
 * The league's own bid history, summarised.
 *
 * Sixteen winning claims is a real distribution and the pricing model leads
 * with it rather than with a generic prior — which is the difference between
 * advising in a league where waivers go for two dollars and one where they go
 * for forty.
 */
const PRICES = {
  sample: 16,
  median: 11,
  low: 5,
  high: 19,
  max: 44,
  highestLosing: 14,
  losingBidsComplete: false,
  confidence: 'medium' as const,
};

/** A league that has never published a single bid. */
const NO_PRICES = {
  sample: 0,
  median: null,
  low: null,
  high: null,
  max: null,
  highestLosing: null,
  losingBidsComplete: false,
  confidence: 'none' as const,
};

const LOSING_BIDS =
  'Sleeper publishes the winning bid and, for failed claims on the same player, the amounts that lost. 6 of 16 runs here had a visible losing bid.';

// ---------------------------------------------------------------- builder

function weekFor(scenario: DemoScenario): Record<string, DemoWeekSpec> {
  switch (scenario.id) {
    case 'sunday-pregame':
      return WEEK_SIX;
    case 'late-injury-pivot':
      return Object.fromEntries(
        Object.entries(WEEK_SIX).map(([id, week]) => [id, { ...week, ...(LATE_PIVOT[id] ?? {}) }]),
      );
    case 'waivers-tuesday-active':
    case 'waivers-thin-data':
    case 'waivers-processed':
      return WEEK_SEVEN;
    case 'playoff-week':
      return WEEK_SEVEN;
    default:
      return {};
  }
}

function strategyFor(scenario: DemoScenario, clock: ReturnType<typeof fixedClock>): ScenarioStrategy | null {
  const week = scenario.week ?? 1;
  const trending = makeTrending([
    { playerId: 'p039', rank: 2, count: 41_500, heat: 0.86, acceleration: 3.4 },
    { playerId: 'p034', rank: 9, count: 14_200, heat: 0.52 },
    { playerId: 'p036', rank: 28, count: 3_100, heat: 0.19, entered: true },
  ]);

  switch (scenario.id) {
    case 'waivers-thin-data':
      /*
       * A priority league. There is no budget to spend, so no dollar advice is
       * given at all — and the upgrades are unaffected, because whether a player
       * would improve the lineup is true whatever the league's waiver rule is.
       */
      return {
        week,
        finalWeek: 14,
        budget: makeNoFaabBudget(),
        prices: NO_PRICES,
        trending: new Map(),
        trendingCapturedAt: null,
        losingBids: 'This league does not bid, so there are no prices to read.',
        notes: [],
      };
    case 'waivers-tuesday-active':
    case 'late-injury-pivot':
    case 'sunday-pregame':
      return {
        week,
        finalWeek: 14,
        budget: makeBudget(SPENT_BY_WEEK_SEVEN),
        prices: PRICES,
        trending,
        trendingCapturedAt: hoursBefore(clock, 3),
        losingBids: LOSING_BIDS,
        notes: [],
      };
    case 'waivers-processed':
    case 'trade-window':
    case 'playoff-week':
      return {
        week,
        finalWeek: 14,
        budget: makeBudget(SPENT_AFTER_RUN),
        prices: { ...PRICES, sample: 19, median: 12 },
        trending,
        trendingCapturedAt: hoursBefore(clock, 2),
        losingBids: LOSING_BIDS,
        notes: [],
      };
    default:
      return null;
  }
}

function seasonTypeFor(scenario: DemoScenario): 'pre' | 'regular' | 'post' | 'off' {
  switch (scenario.lifecycle) {
    case 'offseason':
      return 'off';
    case 'preseason':
    case 'draft_open':
    case 'draft_live':
    case 'post_draft':
      return 'pre';
    case 'playoffs':
    case 'season_complete':
      return 'post';
    default:
      return 'regular';
  }
}

function leagueStatusFor(scenario: DemoScenario): string {
  if (scenario.lifecycle === 'season_complete') return 'complete';
  if (scenario.lifecycle === 'post_draft') return 'in_season';
  if (scenario.lifecycle === 'offseason') return 'complete';
  if (scenario.lifecycle === 'preseason') return 'pre_draft';
  return 'in_season';
}

export function buildSeasonScenario(scenario: DemoScenario): ScenarioData {
  const clock = fixedClock(scenario.asOf);
  const week = weekFor(scenario);

  /*
   * A new season is a league with nobody in it yet.
   *
   * The rollover scenarios are the one case where the roster is genuinely
   * empty: last season's league belongs to last season, and this one has not
   * drafted. Everything downstream is then exercising the real "no roster yet"
   * paths rather than a special demo state.
   */
  const rollover = scenario.lifecycle === 'offseason' || scenario.season !== '2026';

  /*
   * Whose season the *league* belongs to.
   *
   * In March there is no 2027 league yet — what exists is the 2026 one,
   * finished, while Sleeper's own state has moved on to 2027. That gap is
   * precisely what `resolveSeasonPhase` reads to say "offseason", so the
   * fixture states the gap rather than stating the conclusion. By July the new
   * league exists and the two agree again.
   */
  const leagueSeason = scenario.lifecycle === 'offseason' ? '2026' : scenario.season;

  const specs = overrideSpecs(
    WORLD_PLAYERS,
    Object.fromEntries(Object.entries(week).map(([id, w]) => [id, { week: w }])),
  );

  const { players, signals, flags, seasonMarkets, injuries } = collectPlayerState(specs, clock, {
    injuriesAvailable: scenario.freshness.injuries !== 'unavailable',
  });

  const byRosterId = rollover ? new Map<number, string[]>() : seasonRosters();
  const adp = makeAdp(specs, {
    available: scenario.freshness.adp !== 'unavailable',
    capturedAt: '2026-08-24T06:00:00.000Z',
  });

  const spent =
    scenario.id === 'waivers-processed' || scenario.id === 'trade-window' || scenario.id === 'playoff-week'
      ? SPENT_AFTER_RUN
      : SPENT_BY_WEEK_SEVEN;

  return {
    scenario,
    clock,
    specs,
    players,
    league: makeLeague({
      season: leagueSeason,
      status: leagueStatusFor(scenario),
      name: scenario.format.name,
    }),
    rosters: makeRosters({
      byRosterId,
      starters: rollover ? [] : MY_STARTERS,
      reserve: [],
      spentByRosterId: rollover ? new Map() : spent,
    }),
    /*
     * The draft still exists after it has finished, which is what keeps the
     * board reachable as history and keeps `post_draft` distinguishable from
     * `preseason`. A brand-new season has none yet.
     */
    draft: rollover ? null : makeDraft({ status: 'complete', season: '2026' }),
    picks: rollover ? [] : makePicks(DRAFT_TEAMS * 14),
    adpSnapshot: adp.snapshot,
    adpValues: adp.values,
    signals,
    flags,
    seasonMarkets,
    injuries,
    repair: scenario.id === 'trade-window' ? MESSY_REPAIR : CLEAN_REPAIR,
    nflState: makeNflState({
      season: scenario.season,
      seasonType: seasonTypeFor(scenario),
      week: scenario.week,
      clock,
    }),
    freshness: scenario.freshness,
    vegas: {
      fetchedAt: scenario.freshness.vegas === 'unavailable' ? null : hoursBefore(clock, scenario.freshness.vegas === 'stale' ? 61 : 2),
      events: scenario.freshness.vegas === 'unavailable' ? 0 : 14,
    },
    strategy: rollover ? null : strategyFor(scenario, clock),
    notes: rollover
      ? [
          'No league has been created for this season yet, so there is nothing to advise on.',
        ]
      : [],
  };
}
