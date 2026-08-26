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

import { fixedClock, hoursBefore, type Clock } from '../clock.ts';
import type { DemoScenario } from '../types.ts';
import type { DemoWeekSpec } from './spec.ts';
import {
  CLEAN_REPAIR,
  DRAFT_TEAMS,
  MESSY_REPAIR,
  collectPlayerState,
  makeAdp,
  makeBudget,
  makeDog,
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
import {
  DEMO_MANAGERS,
  DEMO_SEASON,
  MY_ROSTER_ID,
  WORLD_DEFENCES,
  WORLD_PLAYERS,
  adpOrder,
  worldPlayer,
} from './world.ts';
import { collectBids, losingBidNote, summarisePrices } from '../../faab/bids.ts';
import { LEDGER_WEEKS, demoTransactions, spendByRosterId } from './ledger.ts';
import { teamWeek } from './slate.ts';
import {
  MATCHUP_INJURY,
  MATCHUP_OPPONENT_ROSTER_ID,
  OPPONENT_ROSTER,
  isMatchupScenario,
  matchupRows,
} from './matchup.ts';

/**
 * Who holds which defence.
 *
 * Twelve of the sixteen are rostered, one apiece, because that is what a DEF
 * slot looks like in October: everybody has one and nobody is attached to it.
 * The four left over are the wire, and they are the only reason a streaming
 * recommendation is possible at all — a league where every defence is owned has
 * no defence question, only a defence.
 *
 * Written down rather than dealt from the draft order, because the arrangement
 * *is* the demonstration: the reader's own unit and the best one available have
 * to be the two the schedule separates, or the planner is being asked a
 * question with no interesting answer.
 */
export const MY_DEFENCE = 'd08';

/** What the week-seven run added, and what it cost a roster spot. */
const RUN_LANDED = 'p039';
const RUN_DROPPED = 'p030';

/** Roster id → the defence that roster holds. Mine is nine. */
const DEFENCE_BY_ROSTER_ID = new Map<number, string>([
  [1, 'd01'], [2, 'd02'], [3, 'd03'], [4, 'd05'], [5, 'd06'], [6, 'd07'],
  [7, 'd09'], [8, 'd10'], [MY_ROSTER_ID, MY_DEFENCE], [10, 'd11'], [11, 'd12'], [12, 'd14'],
]);

/** The defences on the wire, in board order. */
const WIRE_DEFENCES = ['d04', 'd13', 'd15', 'd16'];

/**
 * The team the reader is looking after all season.
 *
 * Nine starters and six on the bench, chosen so the lineup has one genuinely
 * close call, one player the market and the ledger disagree about, one
 * fragile starter and one bench player who is plainly not earning his slot.
 *
 * The ninth starter is a defence, and it is not decoration. Denver draws a
 * comfortable home game in week six and a road trip to the best offence on the
 * slate in week seven, which is the whole of the streaming question in two
 * fixtures: the same unit, worth starting one week and worth replacing the
 * next, with the decision left to `core/dst/planner.ts`.
 */
const MY_ROSTER = [
  'p010', // QB  Colton Reeves
  'p001', // RB  Jalen Whitmore
  'p023', // RB  Ike Sandoval
  'p003', // WR  Amari Sellers
  'p009', // WR  Rashad Bellinger
  'p008', // WR  Micah Stallworth
  'p016', // TE  Chase Delgado
  'p025', // FLEX Josiah Adeyemi
  MY_DEFENCE, // DEF Denver
  'p013', // BN  Wyatt Kessler (QB)
  'p028', // BN  Rey Villanueva (RB)
  'p030', // BN  Femi Adebayo (RB)
  'p031', // BN  Karl Ostrowski (WR)
  'p037', // BN  Kwame Boateng (WR) — the other half of the flex argument
  'p019', // BN  Grant Halsey (TE)
];

const MY_STARTERS = ['p010', 'p001', 'p023', 'p003', 'p009', 'p008', 'p016', 'p025', MY_DEFENCE];

/**
 * The wire.
 *
 * Held out of every roster so the waiver scan has something to find. Each one
 * is a different kind of case: the obvious add whose role is measurably rising,
 * a competing name at the same position, a body nobody has measured at all, and
 * two who are simply not better than what the roster holds — which is the
 * answer a waiver page most often has to give and most often does not.
 *
 * `p052` is the last of them and the only tight end, which is the point of him.
 * Three rivals in this league carry one tight end apiece and are `thin` at the
 * position by the league-intelligence read, so he is the one add on this wire
 * that anybody else is competing for. Without a tight end held out, that column
 * would be honestly computed and uniformly uncontested — a working feature the
 * demo never actually shows working.
 */
const FREE_AGENTS = [
  'p039', 'p034', 'p036', 'p033', 'p035', 'p038', 'p040', 'p027', 'p029', 'p032', 'p052',
  /*
   * And four defences nobody owns.
   *
   * One of them — Philadelphia — is a five-and-a-half-point home favourite in
   * week seven while the reader's own unit is a touchdown-and-a-half underdog
   * in Kansas City. That is a streaming decision with a real gap in it, and it
   * is the fixture's whole contribution: whether the gap is worth a roster
   * move is the planner's to decide and it is decided nowhere in this file.
   */
  ...WIRE_DEFENCES,
];

/**
 * Rosters for a season scenario.
 *
 * Mine is the team above. The other eleven are filled from the draft order,
 * skipping mine, the wire and anybody pinned, which produces ownership that
 * looks like a real league without anybody having typed a hundred and fifty
 * ids.
 *
 * `pinned` is how a roster somebody is going to *read* gets written down. The
 * matchup opponent is the only one so far, and pinning him is not a special
 * case: he is held out of the pool exactly as my own roster is, so no player
 * ends up on two teams.
 */
function seasonRosters(opts: { pinned?: Map<number, string[]>; afterRun?: boolean } = {}): Map<number, string[]> {
  const pinned = opts.pinned;
  /*
   * The claim that landed, on the roster it landed on.
   *
   * Every scenario after the Wednesday run holds the player the Tuesday plan
   * recommended and has cut the player it named — same add, same drop, same
   * price as the plan and the ledger. A demo that recommended a claim on one
   * screen and showed the roster unchanged on the next would be telling two
   * stories about one week.
   */
  const mine = opts.afterRun
    ? [...MY_ROSTER.filter((id) => id !== RUN_DROPPED), RUN_LANDED]
    : [...MY_ROSTER];
  const wire = opts.afterRun
    ? [...FREE_AGENTS.filter((id) => id !== RUN_LANDED), RUN_DROPPED]
    : [...FREE_AGENTS];

  const pinnedIds = [...(pinned?.values() ?? [])].flat();
  const taken = new Set([...mine, ...wire, ...pinnedIds]);
  /*
   * Defences are dealt by name and never from the pool.
   *
   * Ownership of a defence is a fact this fixture states — see
   * `DEFENCE_BY_ROSTER_ID` — so every one of them is held out of the
   * skill-position deal below and handed to its roster afterwards.
   */
  for (const id of DEFENCE_BY_ROSTER_ID.values()) taken.add(id);

  const pool = adpOrder()
    .map((p) => p.id)
    .filter((id) => !taken.has(id));

  const out = new Map<number, string[]>();
  out.set(MY_ROSTER_ID, mine);
  const others = DEMO_MANAGERS.filter((m) => !m.isMine);
  for (const manager of others) out.set(manager.rosterId, []);
  for (const [rosterId, ids] of pinned ?? []) out.set(rosterId, [...ids]);

  let i = 0;
  for (let round = 0; round < 14; round++) {
    for (const manager of others) {
      if (pinned?.has(manager.rosterId)) continue;
      const id = pool[i++];
      if (!id) break;
      out.get(manager.rosterId)!.push(id);
    }
  }

  for (const [rosterId, defence] of DEFENCE_BY_ROSTER_ID) {
    const roster = out.get(rosterId);
    if (roster && !roster.includes(defence)) roster.push(defence);
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
 * What the market expects of a player in a week, and what is known about how he
 * got there.
 *
 * Deliberately *not* a `DemoWeekSpec`. A week spec carries an opponent, a
 * spread, a total and a kickoff — and those belong to the **game**, which is
 * `slate.ts`'s to state. Writing them here as well is how week six came to be
 * written down twice, with a tight end on a bye in one telling and playing in
 * the other. So a market entry is only the part that is about the player: what
 * a book thinks he scores, what it thought last week, how his role has gone and
 * what the injury report says.
 */
interface DemoMarketEntry {
  /** In this league's points. Null means no market at all — see the expander. */
  points: number | null;
  previousPoints?: number;
  usage?: DemoWeekSpec['usage'];
  injury?: NonNullable<DemoWeekSpec['injury']>;
}

/**
 * Week six, for everybody the week is about.
 *
 * One table for the reader's roster, the matchup opponent's roster and the
 * wire, because they are all in the same week: the Sunday the lineup scenarios
 * are read on **is** the Sunday the matchup scenarios are read on, and the two
 * used to disagree about what the market thought of the same player.
 *
 * The flex is the argument the lineup screen is built around: `p025` is a
 * steady, high-floor target hog whose market number is unspectacular, and
 * `p037` is priced almost identically off a far more concentrated role. Floor
 * and Ceiling are being asked to disagree, and the engine — not this file —
 * decides whether they do.
 */
const WEEK_SIX_MARKET: Record<string, DemoMarketEntry> = {
  // ------------------------------------------------------- the reader's team
  p010: { points: 21.0, previousPoints: 18.2, usage: steady(34, 4, W6) },
  p001: { points: 18.5, previousPoints: 17.1, usage: steady(19, 4, W6) },
  p023: { points: 13.1, previousPoints: 12.6, usage: steady(13, 3, W6) },
  p003: { points: 16.2, previousPoints: 15.4, usage: steady(9, 0.26, W6) },
  p009: { points: 14.8, previousPoints: 12.8, usage: rising(6, 11, 0.17, 0.29, W6) },
  p008: { points: 15.5, previousPoints: 13.9, usage: steady(8, 0.22, W6) },
  p016: {
    points: 9.6,
    previousPoints: 9.1,
    usage: steady(7, 0.19, W6),
    // Questionable in the report, and he practised in full on Friday. Those two
    // facts together are the most useful thing either source said.
    injury: { designation: 'Questionable', bodyPart: 'ankle', practice: ['DNP', 'Limited', 'Full'], reportHoursAgo: 19 },
  },
  p025: { points: 12.4, previousPoints: 11.2, usage: steady(8, 0.23, W6) },
  /*
   * The bench, and it is priced to be a bench.
   *
   * These four are the reason the lineup screen has anything to say: a backup
   * quarterback who is not close, a fourth receiver who is plainly not earning
   * his slot, and two backs behind him. A bench priced like a starting lineup
   * would leave every waiver upgrade looking marginal and every drop looking
   * expensive, which is a fixture quietly deciding the answer.
   */
  p013: { points: 15.2, usage: steady(31, 2, W6) },
  p028: { points: 8.9, usage: steady(9, 2, W6) },
  p030: { points: 6.4, usage: steady(6, 1, W6) },
  p031: { points: 7.8, usage: steady(5, 0.13, W6) },
  /* Except this one, who is the other half of the flex argument. */
  p037: { points: 12.9, previousPoints: 10.1, usage: spike(4, 13, W6) },
  p019: { points: 6.3 },

  // ------------------------------------------------------------ the opponent
  p011: { points: 20.2 },
  p004: { points: 17.9 },
  p006: { points: 15.4 },
  p002: { points: 17.1 },
  p005: { points: 16.6 },
  p024: { points: 14.2 },
  p017: { points: 10.3 },
  p021: { points: 13.8 },
  p007: { points: 11.4 },
  p026: { points: 8.7 },
  p012: { points: 16.1 },
  p014: { points: 14.9 },
  p018: { points: 5.8 },
  p022: { points: 12.2 },

  // ----------------------------------------------------------------- the wire
  p039: { points: 15.2, previousPoints: 8.4, usage: rising(4, 10, 0.11, 0.27, W6) },
  p034: { points: 10.1, previousPoints: 9.7, usage: steady(11, 3, W6) },
  // Nobody has measured him. Every role-dependent number must decline to answer.
  p036: { points: 9.4 },
  p033: { points: 7.1, usage: steady(4, 0.11, W6) },
  p035: { points: 6.8, usage: steady(4, 0.1, W6) },
  p038: { points: 5.9, usage: steady(5, 1, W6) },
  p040: { points: 5.2, usage: steady(4, 1, W6) },
  p027: { points: 6.1, usage: steady(5, 0.12, W6) },
  p029: { points: 5.4, usage: steady(4, 0.1, W6) },
  p032: { points: 4.8, usage: steady(4, 1, W6) },
  /*
   * The contested add: a tight end whose role has genuinely moved.
   *
   * Worth about four points a week more than the tight end this roster starts,
   * which is what puts him on the board at all — and three other rosters are
   * thin at the position, which is what makes the competition read on his card
   * say something other than "nobody else needs him".
   */
  p052: { points: 11.3, previousPoints: 6.2, usage: rising(3, 9, 0.09, 0.24, W6) },
};

/**
 * Eight minutes before the one o'clock kickoff, a starter is downgraded.
 *
 * The only thing this scenario states that its predecessor does not. Everything
 * else that makes it a *pivot* is the clock moving from 11:40 to 12:52 against
 * a fixed slate: the morning game in London is over, so a bench receiver can no
 * longer be moved; the early games are minutes away, so the injured starter
 * still can be; and the wire's beneficiary is in the afternoon window, so
 * claiming him would still buy something. None of that is written down here,
 * because a fixture that stated it could state it inconsistently.
 */
const LATE_PIVOT: Record<string, Partial<DemoMarketEntry>> = {
  p003: {
    injury: {
      designation: 'Doubtful',
      bodyPart: 'hamstring',
      practice: ['Limited', 'Limited', 'DNP'],
      reportHoursAgo: 0.4,
      sleeperSays: 'Doubtful',
    },
  },
  /* The wire is about to be very interested in him. */
  p039: { points: 16.5 },
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

/** Week seven: the same market, a week of role history further on. */
const WEEK_SEVEN_MARKET: Record<string, DemoMarketEntry> = Object.fromEntries(
  Object.entries(WEEK_SIX_MARKET).map(([id, entry]) => [
    id,
    { ...entry, usage: playedAnotherWeek(entry.usage), injury: undefined },
  ]),
);

/**
 * A week, assembled from the slate and the market.
 *
 * The one place a `DemoWeekSpec` is built, so the opponent, the spread, the
 * total and the kickoff on every player in every scenario came out of
 * `slate.ts` and cannot contradict each other. A club that is not playing gets
 * the bye state the whole app has language for — no market, no projection, and
 * never a zero — and that is decided here by the absence of a fixture rather
 * than stated per player.
 *
 * Defences are included whether or not the market has an entry for them,
 * because a defence never has one: the prop expander has no shape for a defence
 * and its projection comes from the game line. See `core/dst/dstProjection.ts`.
 */
function weekFromSlate(
  week: number,
  market: Record<string, DemoMarketEntry>,
  clock: Clock,
  overrides: Record<string, Partial<DemoMarketEntry>> = {},
): Record<string, DemoWeekSpec> {
  const out: Record<string, DemoWeekSpec> = {};
  const ids = new Set([...Object.keys(market), ...WORLD_DEFENCES.map((d) => d.id)]);

  for (const id of ids) {
    const spec = worldPlayer(id);
    const entry: DemoMarketEntry = { ...(market[id] ?? { points: null }), ...(overrides[id] ?? {}) };
    const game = teamWeek(week, spec.team, clock.now());

    if (!game) {
      out[id] = { points: null, kickoffInHours: null, opponent: null };
      continue;
    }

    out[id] = {
      /* A defence's number is the game's, never a prop's. */
      points: spec.position === 'DEF' ? null : entry.points,
      ...(entry.previousPoints == null ? {} : { previousPoints: entry.previousPoints }),
      kickoffInHours: game.kickoffInHours,
      opponent: game.opponent,
      spread: game.spread,
      total: game.total,
      home: game.home,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.injury ? { injury: entry.injury } : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------- the money

/**
 * What the room has spent, and what it paid — both read off the ledger.
 *
 * Neither is stated here any more. `fixtures/ledger.ts` writes down the
 * season's transactions in Sleeper's own shape, and the same two functions the
 * live app runs turn them into a spend per roster and a price summary for the
 * league: `buildBudgetState` reads the spend off each roster's
 * `waiver_budget_used`, and `collectBids` + `summarisePrices` read the bids.
 *
 * That is worth the indirection for one reason. The old fixture stated a spend
 * table *and* a price summary — sample sixteen, median eleven — and nothing
 * connected them: a demo could show a league whose managers had spent $500
 * between them while claiming its typical winning bid was $2, and no test would
 * have noticed. Now the wallet, the price and the named rivals are three
 * readings of one list.
 */
function pricesFor(week: number): { prices: ReturnType<typeof summarisePrices>; losingBids: string } {
  const history = collectBids(demoTransactions(DEMO_SEASON, { throughWeek: week - 1 }), LEDGER_WEEKS);
  const prices = summarisePrices(history);
  return { prices, losingBids: losingBidNote(prices) };
}

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

/**
 * The record each roster carries into the week.
 *
 * Sleeper publishes wins and losses on the roster, and `playoffEmphasis` reads
 * them to decide whether December is worth planning for yet — so a fixture
 * without them is a fixture in which a playoff stash can never be recommended.
 * Deterministic from the week and the seat: the reader is a game over .500 and
 * the room is spread around them.
 */
function recordsFor(week: number): Map<number, { wins: number; losses: number }> {
  const played = Math.max(0, week - 1);
  const out = new Map<number, { wins: number; losses: number }>();
  for (const manager of DEMO_MANAGERS) {
    const lean = ((manager.rosterId * 5) % 7) - 3;
    const wins = Math.min(played, Math.max(0, Math.round(played * 0.5 + lean * 0.35)));
    out.set(manager.rosterId, { wins, losses: played - wins });
  }
  return out;
}

// ---------------------------------------------------------------- builder

function weekFor(scenario: DemoScenario, clock: Clock): Record<string, DemoWeekSpec> {
  /*
   * Every in-season scenario reads the same slate.
   *
   * Which is the whole of §14: the Sunday the lineup scenarios are read on is
   * the Sunday the matchup scenarios are read on, the Tuesday waiver run is
   * bidding into the week that follows it, and the defence being started in one
   * is the defence being replaced in the other. A scenario chooses a week and a
   * market; the games come from `slate.ts` and are the same games for
   * everybody.
   */
  switch (scenario.id) {
    case 'sunday-pregame':
    case 'matchup-pregame':
    case 'matchup-live-close':
    case 'matchup-live-leading':
    case 'matchup-live-trailing':
    case 'matchup-final':
      return weekFromSlate(6, WEEK_SIX_MARKET, clock);
    case 'late-injury-pivot':
      return weekFromSlate(6, WEEK_SIX_MARKET, clock, LATE_PIVOT);
    /*
     * The starter ruled out of the night game, and the only fixture difference
     * between this scenario and `matchup-live-close`.
     *
     * He is in the night game, so his slot is still changeable — which is what
     * makes this an alert rather than a regret, and is why the insight engine
     * can price the swap in win probability instead of merely reporting it.
     */
    case 'matchup-injury-swing':
      return weekFromSlate(6, WEEK_SIX_MARKET, clock, MATCHUP_INJURY);
    case 'waivers-tuesday-active':
    case 'waivers-thin-data':
    case 'waivers-processed':
      return weekFromSlate(7, WEEK_SEVEN_MARKET, clock);
    /*
     * A playoff week is played on the same generated schedule as every other
     * week past seven — which carries no line, because a book prices the coming
     * Sunday and not December. That is not a gap in the fixture: it is the
     * state the defence outlook exists to report honestly.
     */
    case 'playoff-week':
      return weekFromSlate(scenario.week ?? 15, WEEK_SEVEN_MARKET, clock);
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
    { playerId: 'p052', rank: 6, count: 22_800, heat: 0.63, acceleration: 2.1 },
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
    case 'waivers-processed':
    case 'trade-window':
    case 'playoff-week': {
      /*
       * One reading of one ledger, whatever week the scenario is in.
       *
       * The Tuesday scenario is bidding into a run that has not happened, so
       * its prices are the six weeks behind it; by Wednesday morning that run
       * is history and the sample is one week longer. Both come out of
       * `pricesFor`, so the two scenarios cannot disagree about a league they
       * share.
       */
      const { prices, losingBids } = pricesFor(spentThroughWeek(scenario));
      return {
        week,
        finalWeek: 14,
        budget: makeBudget(spendByRosterId({ throughWeek: spentThroughWeek(scenario) })),
        prices,
        trending,
        trendingCapturedAt: hoursBefore(clock, scenario.id === 'waivers-tuesday-active' ? 3 : 2),
        losingBids,
        notes: [],
      };
    }
    default:
      return null;
  }
}

/**
 * How much of the season's transaction history a scenario has behind it.
 *
 * Week seven's run is the hinge: on Tuesday night it has not processed, so the
 * ledger stops at week six and the wallet still holds what the plan is about to
 * spend. From Wednesday morning on it has, and every later scenario inherits
 * the claim that landed, the money that left and the roster that changed.
 */
function spentThroughWeek(scenario: DemoScenario): number {
  return RUN_PROCESSED.has(scenario.id) ? 7 : 6;
}

/** The scenarios that are read *after* the week-seven waiver run. */
const RUN_PROCESSED = new Set(['waivers-processed', 'trade-window', 'playoff-week', 'season-complete']);

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
  const week = weekFor(scenario, clock);

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

  /*
   * The opponent is pinned only for the scenarios that put him on screen.
   *
   * Elsewhere roster two is dealt from the draft order like the other ten,
   * because pinning him everywhere would quietly rewrite the league the waiver
   * and trade scenarios are played in for the sake of a screen they never open.
   */
  const matchupWeekend = isMatchupScenario(scenario.id);
  const throughWeek = spentThroughWeek(scenario);
  const byRosterId = rollover
    ? new Map<number, string[]>()
    : seasonRosters({
        pinned: matchupWeekend ? new Map([[MATCHUP_OPPONENT_ROSTER_ID, OPPONENT_ROSTER]]) : undefined,
        afterRun: throughWeek > 6,
      });
  /* Underdog is a draft-season market; out of season there is nothing current. */
  const dog = makeDog(specs, clock, {
    available: scenario.freshness.dogAdp === 'fresh',
    ageHours: 6,
  });

  const adp = makeAdp(specs, {
    available: scenario.freshness.adp !== 'unavailable',
    capturedAt: '2026-08-24T06:00:00.000Z',
  });

  const spent = spendByRosterId({ throughWeek });

  return {
    scenario,
    clock,
    specs,
    players,
    league: makeLeague({
      season: leagueSeason,
      status: leagueStatusFor(scenario),
      name: scenario.format.name,
      bestBall: scenario.format.bestBall,
    }),
    rosters: makeRosters({
      byRosterId,
      starters: rollover ? [] : MY_STARTERS,
      reserve: [],
      spentByRosterId: rollover ? new Map() : spent,
      recordByRosterId: rollover ? new Map() : recordsFor(scenario.week ?? 1),
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
    dogSnapshot: dog.snapshot,
    dogValues: dog.values,
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
    matchups: matchupWeekend
      ? matchupRows(scenario, {
          mineRosterId: MY_ROSTER_ID,
          minePlayers: MY_ROSTER,
          mineStarters: MY_STARTERS,
        })
      : null,
    strategy: rollover ? null : strategyFor(scenario, clock),
    /*
     * The league's own history, and the one scenario that has none.
     *
     * `waivers-thin-data` is a league that has never published a bid, and that
     * has to stay true all the way down: handing it a ledger would give it
     * named rivals and a spending profile for a room the scenario says nothing
     * is known about.
     */
    transactions:
      rollover || scenario.id === 'waivers-thin-data'
        ? []
        : demoTransactions(DEMO_SEASON, { throughWeek }),
    notes: rollover
      ? [
          'No league has been created for this season yet, so there is nothing to advise on.',
        ]
      : [],
  };
}
