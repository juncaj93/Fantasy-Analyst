/**
 * The five in-season decisions, as things a file can carry.
 *
 * Each one has the same four sections the Draft payload has, and for the same
 * reasons: `request` says what was asked for, `context` says which league and
 * which moment, `freshness` says how old the data behind it was, `inputs` is
 * what the engine actually read and `output` is what it concluded. Replay needs
 * `request` and `inputs`; a human reading the file first needs the other three.
 *
 * ## Why `output` is the domain object rather than a flattened copy
 *
 * The Draft payload hand-writes its output — `order`, `rows`, `components`,
 * `nextPickModel` — because a draft board is three hundred players deep and a
 * full copy would be a file nobody can paste anywhere. The in-season outputs are
 * a lineup, a forecast, a claim plan and a handful of offers: small enough to
 * carry whole, and carrying them whole buys something a hand-written list
 * cannot. A flattened output is a list of the fields somebody remembered, and
 * the field they forgot is invisible — it neither travels nor fails to travel,
 * it simply is not compared. That is exactly how the Draft lane nearly lost
 * `injuryLine`.
 *
 * So the in-season outputs are the engines' own types, and the replay compares
 * them structurally: every leaf, by path, exactly, with no tolerance. A field
 * added to `LineupAssembly` next year is compared the day it is added, with
 * nobody remembering anything.
 *
 * That trade has one cost and it is closed elsewhere: a `Map` inside a domain
 * output would become `{}` on both sides and compare equal while carrying
 * nothing. `lossless.ts` refuses a capture containing one, so the completeness
 * is structural rather than hoped for.
 *
 * ## What is *not* in `output`
 *
 * The response envelope. The league's name, the freshness block a screen prints,
 * the FAAB summary, Demo Mode's scenario notes — every one of those is assembled
 * by a caller around the decision, and none of them is the decision. A snapshot
 * that carried the envelope would be comparing the route's JSON rather than the
 * engine's answer, and would start failing the day somebody renamed a key.
 */

import type { LineupAssembly } from '../startsit/assemble.ts';
import type { WaiverAssembly } from '../waivers/assemble.ts';
import type { TradeAssembly } from '../trades/assemble.ts';
import type { MatchupResponse } from '../matchup/build.ts';
import type { DstPlan } from '../dst/planner.ts';
import type { DstPlanRequest } from '../dst/assemble.ts';
import type { ScheduleTeamWeek } from '../nfl/schedule.ts';
import type { TeamForm } from '../dst/outlook.ts';
import type { StartSitMode } from '../startsit/mode.ts';
import type { RosterShape } from '../sleeper/scoring.ts';
import type { SleeperMatchup } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import type { ManagerTradeTendencies } from '../managers/tradeTendencies.ts';
import type { ManagerTransactionProfile, LeagueTransactionBaseline } from '../managers/transactionProfile.ts';
import type { LeagueBudgetState } from '../faab/budget.ts';
import type { BidObservation, PriceSummary } from '../faab/bids.ts';
import type { WaiverPricingContext } from '../waivers/pricing.ts';
import type { TrendingVelocity } from '../market/trending.ts';
import type {
  SnapshotLeague,
  SnapshotLeagueRules,
  SnapshotRoster,
  SnapshotStartSitBundle,
} from './inseason.ts';
import type { SnapshotPlayer } from './schema.ts';

/**
 * The league and the moment, in the terms a person would describe them.
 *
 * Shared by all five, because every in-season decision is about one league in
 * one week and a reader opening a file needs to know it is the right one before
 * reading anything else. Every field is derived from `inputs` and is redundant
 * by construction — which is the point, exactly as it is for the Draft payload.
 */
export interface InSeasonContext {
  league: SnapshotLeague;
  season: string;
  week: number;
  scoringLabel: string;
  rosterShape: RosterShape;
  /** The roster the decision is on behalf of, aliased. Null when none is mine. */
  myRosterId: number | null;
  rosterCounts: Record<string, number>;
}

/**
 * How much of what the engine read was stale, missing or borrowed.
 *
 * Its own section because a large fraction of "this looks wrong" is a freshness
 * story rather than a model story, and a diagnosis should be able to rule that
 * in or out before reading a component. Every field is a *count of a state the
 * inputs are already in* rather than a second measurement — so an unknown can
 * never be flattened to zero on the way into this block, because the block is
 * derived from the same values the replay compares.
 */
export interface InSeasonFreshness {
  /** The betting market's own age, as every screen prints it. */
  props: { fetchedAt: string | null; provider: string | null; events: number };
  /** Sleeper's published week and season type, or null where none was stored. */
  nflState: { season: string | null; week: number | null; seasonType: string | null } | null;
  /** Players the engine was handed with a market, and players without one. */
  priced: { withProps: number; withoutProps: number; stale: number };
  /** What the availability layer knew, by the confidence it knew it with. */
  injury: { known: number; unknown: number; conflicting: number; byFreshness: Record<string, number> };
  /** Players with no game on the slate — a schedule that has not been ingested. */
  withoutGame: number;
  /** Roster spots the player table could not resolve at all. */
  unknownPlayers: number;
}

// ------------------------------------------------------------------ lineup

export interface LineupPayload {
  kind: 'lineup';
  request: { leagueId: string; mode: StartSitMode };
  context: InSeasonContext;
  freshness: InSeasonFreshness & {
    /** How many shown projections are Rotowire's rather than this app's. */
    borrowedProjections: number;
  };
  inputs: LineupInputs;
  output: LineupAssembly;
  warnings: string[];
}

export interface LineupInputs {
  /** The instant the decision was made at. Replay pins to this. */
  now: string;
  /**
   * The league's own published rules, from which the shape and the scoring are
   * derived at replay. See `SnapshotLeagueRules` for why the derived values are
   * not carried instead.
   */
  rules: SnapshotLeagueRules;
  currentStarterIds: string[];
  mode: StartSitMode;
  startSit: SnapshotStartSitBundle;
  /**
   * Rotowire's published weekly figures, by player id.
   *
   * Display only — nothing that decides a lineup reads it — but it is captured
   * because it decides what a *column* says, and "the number under his name is
   * somebody else's" is a report this lane will get.
   */
  published: Record<string, number>;
  unknownPlayers: number;
  rosters: SnapshotRoster[];
}

// ----------------------------------------------------------------- matchup

export interface MatchupPayload {
  kind: 'matchup';
  request: { leagueId: string; week: number | null };
  context: InSeasonContext & { opponentRosterId: number | null };
  freshness: InSeasonFreshness & {
    /** True when no forecast could be produced and only the scoreboard stands. */
    degraded: boolean;
    /** Which games are over, so a settled score is never re-simulated. */
    settled: number;
  };
  inputs: MatchupInputs;
  output: MatchupResponse;
  warnings: string[];
}

export interface MatchupInputs {
  now: string;
  league: SnapshotLeague;
  rosters: SnapshotRoster[];
  /**
   * Sleeper's own matchup rows for the week. The scoreboard, never recomputed.
   *
   * `players_points` and `starters_points` are settled truth and the model reads
   * them as such, so they travel exactly as Sleeper published them.
   */
  matchups: SleeperMatchup[];
  nflState: NflState | null;
  startSit: SnapshotStartSitBundle;
  /** The player ids the assembly asked for inputs about, in order. */
  startSitRequested: string[];
  published: Record<string, number>;
  /**
   * Whether the source implements the published fallback at all.
   *
   * Null and an empty map are different sources: the first cannot quote a
   * published figure and the second looked and found none.
   */
  publishedAvailable: boolean;
  /** What the last forecast said, so "changed since you looked" is answerable. */
  previousForecast: Record<string, unknown> | null;
}

// ------------------------------------------------------------- waiver plan

export interface WaiverPlanPayload {
  kind: 'waiver-plan';
  request: { leagueId: string; week: number };
  context: InSeasonContext & {
    /** How the wire was bounded, so a thin answer is never a mystery. */
    pool: { scanned: number; perPosition: number };
  };
  freshness: InSeasonFreshness & {
    /** Whether the league publishes a budget, and whether any of it was read. */
    faab: { rule: string | null; bidsObserved: number; weeksRead: number | null };
    /** Managers the ledger has a transaction profile for. */
    managerProfiles: number;
  };
  inputs: WaiverPlanInputs;
  output: WaiverAssembly;
  warnings: string[];
}

export interface WaiverPlanInputs {
  now: string;
  generatedAt: string;
  rules: SnapshotLeagueRules;
  season: string;
  week: number;
  /** The user's own players. */
  roster: SnapshotStartSitBundle;
  /** The bounded free-agent scan. */
  candidates: SnapshotStartSitBundle;
  /** Every player on every roster in the league. The hard exclusion. */
  rosteredIds: string[];
  currentStarterIds: string[];
  reserveIds: string[];
  rosters: SnapshotRoster[];
  /**
   * The player table, distilled to the players who can reach the answer.
   *
   * `waiverLeagueIntel` reads exactly three fields — id, position and status —
   * and only for the players somebody in this league holds, because what it
   * answers is "who else needs this position and is he ruled out". The Sleeper
   * dictionary is around 2,500 rows and a league holds a couple of hundred, so
   * copying it would be the "entire player dictionary" the snapshot principles
   * rule out. What was dropped is counted in {@link playerCensus} rather than
   * forgotten.
   */
  players: SnapshotPlayer[];
  playerCensus: { listed: number; captured: number; keptBecause: Record<string, number> };
  /**
   * The pricing context, with its own `Map` hoisted.
   *
   * `WaiverPricingContext.trending` is how many managers added each player in
   * the last capture window — a `Map`, and through the wire an empty object. A
   * snapshot that carried it verbatim would replay every bid with the market's
   * own attention removed, which is exactly the input somebody complaining
   * about a price is complaining about.
   */
  strategy: (Omit<WaiverPricingContext, 'trending'> & { trending: [string, TrendingVelocity][] }) | null;
  budgets: LeagueBudgetState | null;
  prices: PriceSummary | null;
  observations: BidObservation[];
  /**
   * What the ledger knows about the rivals, with its `Map` hoisted.
   *
   * `profiles` is keyed by *current* roster id, which is the direction the intel
   * pass wants: a profile keyed the other way would follow a roster slot to its
   * next occupant.
   */
  history: {
    profiles: [number, ManagerTransactionProfile][];
    baseline: LeagueTransactionBaseline | null;
    week: number;
    finalWeek: number;
  } | null;
  /** The defence planner's three reads, recorded. Null when it was not run. */
  dst: DstReads | null;
  bestBall: boolean;
  draftComplete: boolean;
  playoff: { weeks: number[]; emphasis: number };
}

// ---------------------------------------------------------------- dst plan

/** Everything `DstPlanSources` answered, in the shapes it answered in. */
export interface DstReads {
  fixturesForWeek: ScheduleTeamWeek[];
  /** Keyed by `season|from|to`, because the planner asks for one range. */
  scheduleForTeams: { season: string; teams: string[]; from: number; to: number; rows: ScheduleTeamWeek[] }[];
  /** `impliedTotals` is a `Map`, hoisted to entries. */
  impliedTotals: [string, TeamForm][];
}

export interface DstPlanPayload {
  kind: 'dst-plan';
  request: { leagueId: string; week: number; season: string };
  context: InSeasonContext & {
    /** Whether this league starts a defence at all, and how many. */
    defenceSlots: number;
    bestBall: boolean;
    draftComplete: boolean;
  };
  freshness: InSeasonFreshness & {
    /**
     * Which anchor each planned week got, counted.
     *
     * The planner will not invent a line: a priced future game gets the real
     * anchor, an unpriced one gets the opponent's own season average clearly
     * marked as such, and a week with neither gets nothing. Distinguishing the
     * three is the whole of a "why is it telling me to stream him" report.
     */
    anchors: Record<string, number>;
    fixturesStored: number;
    teamsWithForm: number;
  };
  inputs: DstPlanInputs;
  output: DstPlan | null;
  warnings: string[];
}

export interface DstPlanInputs {
  now: string;
  rules: SnapshotLeagueRules;
  season: string;
  week: number;
  bestBall: boolean;
  draftComplete: boolean;
  reserveIds: string[];
  playoff: { weeks: number[]; emphasis: number };
  /** The rostered defences and the bounded pool, as the planner received them. */
  roster: SnapshotStartSitBundle;
  candidates: SnapshotStartSitBundle;
  /**
   * The lineup the bench cost is measured against.
   *
   * Captured rather than recomputed at replay for the same reason the shape and
   * the scoring are: a value the planner actually used is evidence, and one the
   * replay rebuilt is an assumption.
   */
  lineup: DstPlanRequest['lineup'];
  reads: DstReads;
}

// ------------------------------------------------------------- trade offer

export interface TradeOfferPayload {
  kind: 'trade-offer';
  request: { leagueId: string; limit: number | null };
  context: InSeasonContext & {
    /** Whether this league can trade at all, and why not when it cannot. */
    tradeable: boolean;
    partners: number;
  };
  freshness: InSeasonFreshness & {
    /**
     * Whether the ledger was read, and what it held.
     *
     * `measured: false` means there was no league to read history *for*; every
     * count under it is meaningless. Anything else has looked, and
     * `profiles: 0` then means the league genuinely has none — which is a
     * warning on the board and not a silence.
     */
    history: { measured: boolean; profiles: number; seasonsComplete: string[]; complete: boolean };
  };
  inputs: TradeOfferInputs;
  output: TradeAssembly;
  warnings: string[];
}

export interface TradeOfferInputs {
  now: string;
  leagueSettings: Record<string, unknown>;
  rules: SnapshotLeagueRules;
  rosters: SnapshotRoster[];
  /** Every rostered player, evaluated once for the whole league. */
  pool: SnapshotStartSitBundle;
  limit: number | null;
  /**
   * The behavioural half, with both of its `Map`s hoisted and keyed by alias.
   *
   * Keyed by Sleeper user id in the engine, which is what follows a person
   * between seasons — so the keys here are the *aliases* of those ids, and the
   * roster chain resolves exactly as it did without any of them being real.
   */
  history: {
    measured: boolean;
    tendencies: [string, ManagerTradeTendencies][];
    seasonsByUser: [string, { observed: number; complete: boolean }][];
    seasonsComplete: string[];
    profiles: number;
    complete: boolean;
    leagueRate: number | null;
  };
}
