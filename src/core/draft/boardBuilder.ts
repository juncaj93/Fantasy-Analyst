/**
 * Draft board assembly: combine live draft state, the frozen ADP snapshot, the
 * Underdog market, the user's roster and the evidence signal into a ranked,
 * explained board.
 *
 * This module NEVER makes a pick. It only reads what it is handed and returns
 * rankings.
 *
 * **It is handed its facts rather than fetching them.** Everything arrives
 * through `DraftBoardSources` — an interface the server satisfies with
 * repositories over D1, and Demo Mode satisfies with versioned fixtures. That
 * is what makes a rehearsed board and a live one the same board: one assembly,
 * one ranking, one market blend, one set of warnings, and the only difference
 * between them is where the rows came from. A second implementation for the
 * demo would be a demonstration of something the product does not do.
 */

import { rosterAlerts, type MyGuyLevel, type RosterAlert } from './decisions.ts';
import { DEFAULT_WEIGHTS, DEFENCE_WEIGHTS, rankAvailablePlayers, type DraftRecommendation } from './engine.ts';
import {
  SIGNAL_BALANCE_DEFAULT,
  personalScale,
  weightsForSignalBalance,
  type SignalBalance,
} from './signalBalance.ts';
import { computeNeed } from './need.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { PlayerSignal } from '../evidence/types.ts';
import type { SeasonMarketKey } from '../vegas/types.ts';
import { offersFlexFilter, orderPositions, positionMatchesFilter } from '../sleeper/eligibility.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../sleeper/scoring.ts';
import { isDraftable } from './draftable.ts';
import { buildLiveRoster } from './liveRoster.ts';
import { demandBetweenPicks } from './demandAhead.ts';
import { injuryStatusTag } from './injury.ts';
import { injuryLine, type InjuryState } from '../injury/model.ts';
import { tierContextLine } from './tierContext.ts';
import { nextPickForSlot, slotForRoster, slotFromPicks } from '../sleeper/transform.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';
import type { DraftPickRecord, DraftRecord, LeagueRecord, RosterRecord } from '../sleeper/types.ts';
/*
 * The two market-facing decisions this board makes, both read from data rather
 * than assumed: what kind of league this is, and how old the Underdog numbers
 * are. Neither has any opinion about a player.
 */
import { detectBestBall, marketFormatOf } from '../sleeper/bestBall.ts';
import { blendWeights } from './marketBaseline.ts';
import { projectionScoringFrom, type ProjectionScoring } from '../startWho/scoring.ts';
import { dogFreshness, dogIsUsable } from '../adp/underdog.ts';
import {
  buildPickOwnership,
  estimateNextPickAvailability,
  MANAGER_HISTORY_CEILING,
  positionsInPlay,
  readManagerPrior,
  slotsAheadOf,
  type NextPickAvailability,
  type SimCandidate,
  type TradedPick,
} from './nextpick/index.ts';
import { buildPositionTierMap, type PositionTierMap } from './tiers.ts';

/**
 * Where a board's facts come from.
 *
 * Deliberately the narrowest set of reads the assembly below actually performs,
 * expressed as plain shapes rather than as repository classes. The server's
 * repositories satisfy it structurally, so nothing had to change on that side;
 * a fixture set satisfies it by returning the same shapes from memory.
 *
 * Every member is a *read*. There is no write anywhere in this interface, which
 * is what makes "the demo cannot mutate anything" a property of the type rather
 * than a promise in a comment.
 */
export interface DraftBoardSources {
  leagues: {
    getDraft(id: string): Promise<(DraftRecord & { adpSnapshotId: number | null }) | null>;
    getLeague(id: string): Promise<LeagueRecord | null>;
    listRosters(leagueId: string): Promise<RosterRecord[]>;
    listPicks(draftId: string): Promise<DraftPickRecord[]>;
  };
  players: {
    listAll(): Promise<CanonicalPlayer[]>;
  };
  adp: {
    get(id: number): Promise<BoardAdpSnapshot | null>;
    /** The newest snapshot of the market the user is drafting in. */
    latestPlatformSnapshot(): Promise<BoardAdpSnapshot | null>;
    /** The newest snapshot filed under one source — how DOG is found. */
    latestForSource(source: string): Promise<BoardAdpSnapshot | null>;
    valuesByPlayer(snapshotId: number): Promise<Map<string, BoardAdpValue>>;
  };
  evidence: {
    getSignals(playerIds: string[]): Promise<Map<string, PlayerSignal>>;
  };
  /**
   * The user's own hearts and stars, for every player carrying one.
   *
   * Takes the draft because half of it is draft-scoped and half of it is not:
   * My Guy is an opinion about a player and is global, the ★ queue belongs to
   * this draft and to no other. The source composes the two; a board cannot ask
   * for "the queue" without saying whose. See `repos/draftQueue.ts`.
   */
  flags(draftId: string): Promise<Map<string, BoardPlayerFlag>>;
  /** Season-long market lines for the scored pool, from the newest snapshot. */
  /**
   * Imported preseason projections for these players, under this league's own
   * scoring. Empty when no snapshot matches the league's rules — a snapshot
   * captured under other rules is not a worse answer, it is not an answer.
   */
  preseasonPoints(
    playerIds: string[],
    scoring: ProjectionScoring,
  ): Promise<Map<string, number>>;
  seasonMarkets(
    playerIds: string[],
  ): Promise<Map<string, { market: SeasonMarketKey; line: number | null; bookCount?: number }[]>>;
  /**
   * Who priced the season markets and when, from the same snapshot the lines
   * came from.
   *
   * Snapshot-level rather than per-player because it is the same answer for
   * every row, and repeating a provider name and a timestamp across 250
   * recommendations would be 250 copies of one fact. The expanded card reads it
   * from here.
   */
  marketSnapshot(): Promise<{ provider: string; season: string; fetchedAt: string } | null>;
  /**
   * Historical draft tendencies for this league's managers, by current roster id.
   *
   * Optional: a source that does not supply it produces exactly the board that
   * existed before manager history did. Empty is the honest answer for a
   * league in its first season, one whose history has not been synced, or one
   * whose managers are all new. See `core/managers/managerTendencies.ts`.
   */
  managerTendencies?(leagueId: string): Promise<Map<number, ManagerTendencies>>;
  /** Unresolved newsletter names, for the draft-day readiness warning. */
  repairStatus(): Promise<BoardRepairStatus>;
  /** Normalized availability for the ranked page. May reject; the caller catches. */
  injuryStates(players: { playerId: string; status: string | null }[]): Promise<Map<string, InjuryState>>;
  /**
   * The instant "how old is this Underdog file" is measured from.
   *
   * The one piece of time this assembly needs. It is a source rather than a
   * call to `new Date()` for the same reason everything else here is: a board
   * rehearsed at a fixed instant has to age its market from that instant, or a
   * scenario about a stale DOG snapshot would quietly become a scenario about
   * a *very* stale one the next month.
   */
  now(): Date;
}

/**
 * The `source` a raw Underdog snapshot is filed under.
 *
 * Declared here rather than imported from the repository so the assembly names
 * the market it is asking for without depending on anything that stores one.
 * `repos/adp.ts` exports the same constant and a test holds the two together,
 * because the single worst outcome available here is a Sleeper snapshot read as
 * DOG or the reverse.
 */
export const UNDERDOG_SOURCE_KEY = 'underdog';

/** The snapshot metadata a board reads. A superset is accepted. */
export interface BoardAdpSnapshot {
  id: number;
  label: string;
  capturedAt: string;
  matchedCount: number;
  rowCount: number;
  importedAt: string;
  /** Which provider served it. Null for snapshots imported by hand. */
  provider: string | null;
  /** What kind of number this is. Only `raw_adp` may be shown as DOG. */
  sourceType: string;
  /** When the source says the numbers are effective, if it says. */
  snapshotAt: string | null;
  /** When this app fetched them, which is a different question. */
  fetchedAt: string | null;
}

/** One player's place in that snapshot. */
export interface BoardAdpValue {
  adp: number | null;
  rank: number | null;
}

export interface BoardPlayerFlag {
  /** My Guy, global: he is still your guy in next year's league. */
  level: MyGuyLevel;
  /** Starred **in this draft**. Never carried in from another one. */
  queued: boolean;
  /**
   * Where the reader dragged him in their own queue, sparsely ranked.
   *
   * Null for a player who has never been ordered by hand. It changes the
   * sequence the queue chip lists and nothing else — see `queueOrder.ts`.
   */
  queueOrder: number | null;
}

/** Only the summary is read here; the full report lives in Setup. */
export interface BoardRepairStatus {
  summary: { names: number; net: number; headline: string };
}

/**
 * A ranked player plus whether the user bookmarked him.
 *
 * The queue is deliberately bolted on out here rather than passed into the
 * engine. It is a bookmark: it says where to look, not how good the player is,
 * and the ranking must come out identical whether or not the star is lit. The
 * engine cannot accidentally read what it is never given.
 */
export type BoardRecommendation = DraftRecommendation & {
  queued: boolean;
  /**
   * The injury designation worth showing — `Questionable`, `Out`, `IR` — or
   * null.
   *
   * Filtered here rather than in the card. The canonical `status` field falls
   * back to Sleeper's *roster* status when there is no injury, so it reads
   * `Active` for almost everybody and `DNR` for a long tail; sending that
   * meant every one of two hundred players arrived carrying a "status" the
   * board must then know to ignore. The rule for what counts lives in
   * `injury.ts`, so it is applied once and cannot drift between the wire and
   * the screen.
   */
  status: string | null;
  /**
   * One line of market context, or null when the board has nothing to say.
   *
   * Attached out here rather than produced by the engine, because half of it —
   * who picks before you do again and what they still need — is live draft
   * state the engine is deliberately never given. Nothing about the ranking
   * depends on it; it is read by the card and by nothing else.
   */
  tierContext: string | null;
  /**
   * One line about his availability: `Q · hamstring · practised fully`.
   *
   * Resolved from the same normalized state Start/Sit and Trades read, so a
   * player cannot be Questionable on one screen and fine on another. Null for
   * the overwhelming majority, which is what keeps the badge meaning something.
   */
  injuryLine: string | null;
  /**
   * The `Next` model's own workings for this player.
   *
   * `survivalProbability` on the recommendation is the number the card shows and
   * is unchanged in shape; this is everything behind it — what the market alone
   * would have said, which drivers were found, and how much to trust it. Nothing
   * on screen reads it today. It exists so the probe can print the reasoning and
   * so a future card can adopt the explanation without another round of wiring.
   */
  nextPick: {
    probability: number | null;
    marketBaseline: number | null;
    /**
     * The same probability with historical manager behaviour removed.
     *
     * Null wherever no history applied, which is every league that has not
     * synced one. Where it is present it is also the number the *ranking* used:
     * `Score` is deliberately computed without this signal. See `survivalFor`.
     */
    historyBaseline: number | null;
    /** The bounded adjustment history contributed, in probability units. */
    historyAdjustment: number | null;
    drivers: string[];
    confidence: 'high' | 'medium' | 'low';
    degraded: string[];
  } | null;
};

export interface DraftBoardState {
  draftId: string;
  status: string;
  type: string;
  teams: number;
  rounds: number;
  currentPick: number;
  picksMade: number;
  mySlot: number | null;
  myNextPick: number | null;
  picksUntilMyTurn: number | null;
  onTheClock: boolean;
  /**
   * The pick every "will he last" number on this board is measured against —
   * your next selection *after* the one on the clock.
   *
   * The same as `myNextPick` while you are waiting for your turn, and one pick
   * further on once it arrives. Sent so the board can name it rather than
   * leaving the reader to work out which pick "next pick" meant.
   */
  waitHorizonPick: number | null;
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  rosterCounts: Record<string, number>;
  myRoster: { playerId: string; name: string; position: string; team: string; pickNo: number }[];
  /** Starting slots with nobody to fill them yet. */
  openStarters: { slot: string; count: number; accepts: string[] }[];
  /**
   * Every starting slot the league has, filled out of required.
   *
   * The draft header states this and nothing else about the roster: `0/1 QB ·
   * 1/2 RB · 3/3 WR`. What to do about it is the ranked list's job.
   */
  rosterProgress: { slot: string; filled: number; required: number; accepts: string[] }[];
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  /**
   * Who priced the season markets on this board, and when.
   *
   * The provenance behind every `MKT` line, said once. A card's own components
   * carry their lines and book counts; the provider and the time it was fetched
   * belong to the snapshot they all came from, and a reader deciding whether to
   * trust a number needs both halves.
   */
  marketSource: { provider: string; season: string; fetchedAt: string } | null;
  /**
   * Where the `DOG` column stands: which provider, how old, and — when it is
   * absent — why.
   *
   * Sent whether or not DOG is available, because "Underdog has not priced this
   * player" and "we stopped trusting the Underdog file two days ago" produce an
   * identical blank on a card and are entirely different facts. The reason
   * string is the difference, and it is the reason a stale snapshot can never
   * be presented as a fresh one.
   */
  dogState: {
    available: boolean;
    provider: string | null;
    sourceType: string | null;
    /** When the source says the numbers are effective. */
    snapshotAt: string | null;
    /** When this app fetched them, which is a different question. */
    fetchedAt: string | null;
    freshness: 'fresh' | 'aging' | 'stale' | 'unknown';
    ageHours: number | null;
    /** How many canonical players the snapshot resolved to. */
    matched: number;
    reason: string;
  };
  /**
   * How the market baseline is weighted for this league, and where that came
   * from.
   *
   * `confident: false` is the degraded case the brief calls for: Sleeper has
   * not published a best-ball flag, so the ordinary 60/40 blend applies and the
   * board says so rather than guessing from the league's name.
   */
  marketFormat: {
    format: 'standard' | 'best_ball';
    bestBall: boolean;
    confident: boolean;
    basis: string;
    /** The blend actually in force, as fractions. */
    weights: { dog: number; sleeper: number };
    reason: string;
  };
  recommendations: BoardRecommendation[];
  /** What the shape of the live roster is saying, given how late it is. */
  rosterAlerts: RosterAlert[];
  /** 1-based round currently on the clock. */
  round: number;
  /**
   * Positions this league actually starts, in a sensible reading order.
   *
   * The board already hides positions the league does not use; sending the
   * list means the filter row can stop offering chips that are guaranteed to
   * return nothing — which is what a DEF chip does in a league with no defence
   * slot, and what a K chip did everywhere.
   */
  startablePositions: string[];
  /**
   * Whether the W/R/T flex view is worth a chip in this league.
   *
   * The same rule as every other chip: a filter that can only ever return
   * nothing is worse than no filter. A league that starts none of RB, WR or TE
   * has nothing for FLX to show.
   */
  offersFlex: boolean;
  /**
   * Where the player count stands at each stage that can lose one.
   *
   * A completeness report rather than a statistic. The board silently ending
   * near ADP 78 was possible because no stage said how many players it had
   * dropped; these numbers make the next such regression visible immediately,
   * in the response itself.
   */
  poolHealth: {
    /** Active, startable, not already drafted — before any cap. */
    activeEligible: number;
    drafted: number;
    /** How many of those were actually scored (bounded by `cap`). */
    scored: number;
    /** How many were sent, after the caller's own limit. */
    returned: number;
    withAdp: number;
    /** Kept rather than deleted — the whole point of the repair. */
    withoutAdp: number;
    deepestAdp: number | null;
    byPosition: Record<string, number>;
    cap: number;
  };
  /**
   * The drafting managers, one per seat, in column order.
   *
   * Presentation only, and read by the draft-board overlay alone. Nothing about
   * a ranking, a score or an availability estimate depends on it — it exists so
   * a board that already knows every pick can also say whose column each one
   * belongs to, instead of printing twelve columns called `Team 4`.
   */
  managers: { slot: number; name: string; isMine: boolean }[];
  /**
   * Every completed pick, in pick order, with the manager who actually made it.
   *
   * The same pick stream the rest of this service already read, projected into
   * the four facts a board cell shows. It travels with the board response
   * deliberately: the board overlay must never become a second thing polling
   * Sleeper, so it consumes exactly what the existing live refresh already
   * rebuilds and adds no request of its own.
   *
   * `ownerSlot` is Sleeper's answer, not the snake's — see `ownerSlotOf`.
   */
  boardPicks: { pickNo: number; playerId: string; name: string; position: string; team: string; ownerSlot: number }[];
  /**
   * Who owns each future pick, indexed from pick 1 — but only in a draft that
   * has published a trade.
   *
   * Null in the overwhelmingly common case, where every seat makes its own
   * picks and snake arithmetic is the whole answer. Sending it only when it
   * differs from the snake keeps one ownership model in force: the client
   * either has Sleeper's word or it has the arithmetic, and never has to choose
   * between two plausible answers.
   */
  pickOwners: number[] | null;
  /** Diagnostics for `Next`. Read by the probe and by nothing on screen. */
  nextPickModel: {
    targetPick: number | null;
    picksSimulated: number;
    simulations: number;
    slotsAhead: number[];
    needAhead: Record<string, number>;
    roomSample: number;
    dispersion: number;
    positionRuns: Record<string, number>;
    positionBias: Record<string, number>;
    roomNotes: string[];
    /** NFL teams this room is configured to take early. Usually empty. */
    localTeams: string[];
    /**
     * What previous seasons said about the managers picking before you.
     *
     * Null in a league with no history, no matched identity or no returning
     * manager with enough of a sample. `entries` carries the sample behind each
     * multiplier and the positions whose history was overruled by what the
     * manager already holds today, so the adjustment can be audited against the
     * pick stream rather than believed.
     */
    managerHistory: {
      managersWithHistory: number;
      /** Slots picking ahead whose manager had no usable history. Neutral. */
      unknownSlots: number[];
      entries: {
        slot: number;
        displayName: string | null;
        draftsObserved: number;
        picksObserved: number;
        multipliers: Record<string, number>;
        suppressed: string[];
      }[];
      notes: string[];
      /** Largest bounded movement on this board, in percentage points. */
      largestMovePoints: number;
      /** Players whose raw movement had to be clamped. Zero is healthy. */
      ceilingHits: number;
      /** The hard ceiling in force, in percentage points. */
      ceilingPoints: number;
    } | null;
    /**
     * What the local-team prior applied, and what it was measured from.
     *
     * Null in every league that has not named a local team, which is every
     * league until somebody does. `basis` says whether the number came from
     * what this room has actually done, from the bounded assumption, or from
     * both — and `observed` carries the sample behind it, so the effect can be
     * audited against the pick stream rather than believed.
     */
    teamPrior: {
      basis: string;
      multipliers: Record<string, number>;
      observed: Record<string, { picks: number; meanPicksEarly: number; shrinkage: number }>;
      notes: string[];
      /**
       * The measured effect on survival, in percentage points.
       *
       * `local` and `others` are each the mean of `simulated - market` for
       * their group, so the `difference` between them isolates what the prior
       * contributed — every other term in the model applies to both. Negative
       * means the room's local players are being taken sooner than the rest of
       * the board relative to ADP, which is the whole claim.
       */
      survivalEffect: { local: number; others: number; difference: number; sample: number } | null;
    } | null;
    marketOnly: boolean;
    degraded: string[];
    /** What drew every random sample. Same board, same seed, same numbers. */
    seed: number;
    elapsedMs: number;
    cached: boolean;
  };
  warnings: string[];
}

/**
 * How many available players the board scores.
 *
 * Comfortably more than any draft reaches (a 12-team, 16-round draft is 192
 * picks), while keeping the request small enough to answer quickly.
 */
export const MAX_CANDIDATES = 300;

/**
 * The position the board has no opinion about.
 *
 * Named once so the two places that treat defences differently — the ranking
 * split below, and nothing else — cannot drift apart on the spelling. Sleeper
 * calls them `DEF`; `DST` never reaches here, because `toCanonicalPlayers`
 * normalises the dump before any of this sees it.
 */
export const DEFENCE = 'DEF';

/**
 * Draft order first, `search_rank` to break a tie, name to break that.
 *
 * The order both pools are cut at `MAX_CANDIDATES` in, so which players get
 * scored and which get simulated is one comparator rather than two copies of
 * one. Exported because a support snapshot has to reproduce the same cut from
 * a distilled player list — see `core/support/draftSnapshot.ts` — and a second
 * copy of these three lines living over there is exactly how a replay starts
 * quietly scoring a different three hundred players.
 *
 * `search_rank` is emphatically not ADP (it measures who gets looked up) and is
 * never allowed to set the board's order; it orders thirty-two defences nobody
 * prices better than accident does, and that is the whole of its job here.
 */
export function byMarketThenSearch(
  rankOf: (player: CanonicalPlayer) => number | null,
): (a: CanonicalPlayer, b: CanonicalPlayer) => number {
  return (a, b) =>
    (rankOf(a) ?? Infinity) - (rankOf(b) ?? Infinity) ||
    (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
    a.fullName.localeCompare(b.fullName);
}

/**
 * Who the room could still draft: active, not yet taken, at a position this
 * league starts.
 *
 * Deliberately *not* `eligible` — no `draftable` gate and no position chip.
 * The simulator drafts from the room's board rather than from the reader's
 * filter, and the reasoning for that is beside `simulationPool` below.
 * Exported for the same reason the comparator is.
 */
export function simulationEligible(
  player: CanonicalPlayer,
  takenIds: ReadonlySet<string>,
  startable: ReadonlySet<string>,
): boolean {
  return player.active && !takenIds.has(player.id) && (startable.size === 0 || startable.has(player.position));
}

/**
 * Build the board.
 *
 * `sources` decides where the facts come from; everything else here is the
 * product's own reasoning and is identical in every environment.
 */
export async function buildDraftBoard(
  sources: DraftBoardSources,
  draftId: string,
  opts: {
    limit?: number;
    position?: string | null;
    queuedOnly?: boolean;
    /**
     * The `Next%` simulation seed, supplied rather than derived.
     *
     * For replaying a support snapshot and for nothing else. The draft id is
     * hashed into the seed, so a snapshot that aliases it — as one must, since
     * a Sleeper draft id is one public URL away from every manager's username —
     * would otherwise draw different samples and disagree with the board it was
     * captured from. See `nextpick/simulate.ts`.
     */
    nextPickSeed?: number;
    /**
     * How loudly the owner's own research argues with the market price.
     *
     * Absent means `balanced`, which returns `DEFAULT_WEIGHTS` itself — so a
     * caller that does not know this exists builds the board this app has
     * always built. See `signalBalance.ts`.
     */
    signalBalance?: SignalBalance;
  } = {},
): Promise<DraftBoardState> {
  const draft = await sources.leagues.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  const league = await sources.leagues.getLeague(draft.leagueId);
  if (!league) throw new Error(`league ${draft.leagueId} not found`);

  const warnings: string[] = [];
  const picks = await sources.leagues.listPicks(draftId);
  const rosters = await sources.leagues.listRosters(league.id);
  const myRosterRecord = rosters.find((r) => r.isMine) ?? null;
  if (!myRosterRecord) warnings.push('your roster could not be identified in this league; roster need is disabled');

  const teams = draft.teams || league.totalRosters || 12;
  const rounds = draft.rounds || 15;
  const picksMade = picks.filter((p) => p.playerId).length;
  const currentPick = picksMade + 1;
  // Round drives how loudly an unfilled starting slot is said: no tight end in
  // round three is a plan, and no tight end in round twelve is a problem.
  const round = Math.max(1, Math.ceil(currentPick / teams));

  const mySlot =
    slotForRoster(draft.slotToRosterId, myRosterRecord?.rosterId ?? null) ??
    slotFromPicks(picks, myRosterRecord?.rosterId ?? null, myRosterRecord?.ownerId ?? null);
  /*
   * Two different questions about the same snake order.
   *
   * `next` is "when is my turn", which is what the header says: on the clock
   * it is this pick, and the screen reads YOUR PICK.
   *
   * `horizon` is "when could I next take him if I pass", which is what every
   * wait-flavoured number is measured against — survival, positional
   * scarcity, and how urgent a tier cliff is. Off the clock they are the same
   * pick. On the clock they are not, and using `next` there asked whether a
   * player available now would still be available now: true of everybody, so
   * the entire board read 100% at the one moment the number was being used to
   * decide something.
   *
   * `horizon` comes from the ownership model rather than from snake
   * arithmetic, because "which pick is mine" and "whose pick is that" are the
   * same question and answering them in two places is how they drift apart.
   * Sleeper publishes traded picks in some drafts and not others; a draft
   * without them behaves exactly as the snake always did, and a draft with
   * them stops attributing a pick to a manager who no longer owns it.
   */
  const ownership = buildPickOwnership({
    teams,
    rounds,
    type: draft.type,
    slotToRosterId: draft.slotToRosterId,
    tradedPicks: tradedPicksFrom(draft.settings),
  });
  const next = mySlot == null ? null : nextPickForSlot(mySlot, teams, rounds, draft.type, currentPick);
  const horizonPick = mySlot == null ? null : ownership.nextOwnedPickAfter(mySlot, currentPick);
  const horizon = horizonPick == null ? null : { pickNo: horizonPick, picksUntil: horizonPick - currentPick };
  // Without a slot there is no "your next pick", so survival and scarcity are
  // both computed against an unknown horizon. Say so rather than let the board
  // look confident about numbers it could not work out.
  if (myRosterRecord && mySlot == null) {
    warnings.push(
      'your draft slot is unknown — Sleeper has not published one and you have not picked yet, so "who lasts until your next pick" is guesswork',
    );
  }

  // Players already taken.
  const takenIds = new Set(picks.map((p) => p.playerId).filter((id): id is string => !!id));

  // Draft order comes from an imported ADP snapshot. A draft can be pinned to
  // a specific one so a board opened mid-draft does not shift under the user
  // when a fresher snapshot lands; otherwise the newest applies.
  /*
   * The platform market: everything that is not Underdog.
   *
   * Not `latest()`, which is "the newest snapshot of anything" and was
   * correct only while one market existed. With two, it returns the Underdog
   * board on any day Underdog was fetched last — putting Underdog's numbers
   * in the `ADP` column and behind `Val`, the tier ladders and the survival
   * model, with nothing on screen saying so.
   */
  const snapshotMeta = draft.adpSnapshotId
    ? await sources.adp.get(draft.adpSnapshotId)
    : await sources.adp.latestPlatformSnapshot();
  const importedValues = snapshotMeta ? await sources.adp.valuesByPlayer(snapshotMeta.id) : new Map();

  /*
   * The second market: raw Underdog ADP, on its own snapshot.
   *
   * Read separately and kept separate. It is never merged into
   * `importedValues`, never used to fill a gap in the Sleeper column, and
   * never allowed to become "the ADP" — the whole value of having two markets
   * is that they can disagree, and a single merged table would silently
   * resolve every disagreement in favour of whichever was loaded last.
   *
   * Three things have to be true before a DOG number reaches a player: a
   * snapshot exists, it says it is raw ADP rather than a ranking, and it is
   * recent enough to describe the market as it stands. Any of them failing
   * costs the DOG column and nothing else — the board carries on with
   * Sleeper alone, renormalised, and says why in `dogState`.
   */
  const dogMeta = await sources.adp.latestForSource(UNDERDOG_SOURCE_KEY);
  const dog = await resolveDog(sources, dogMeta);
  if (dog.warning) warnings.push(dog.warning);

  /*
   * Which blend the market baseline uses, decided by Sleeper and nobody else.
   *
   * `detectBestBall` reads the league's own settings; it cannot be moved by
   * the league's name, by anything the user typed, or by the date. When
   * Sleeper has not published the flag the detection is not confident and the
   * ordinary 60/40 blend applies — stated in the diagnostics rather than
   * assumed silently, because "we do not know" and "it is not best ball"
   * price the same and mean different things.
   */
  const format = detectBestBall({
    leagueSettings: league.leagueSettings,
    draftSettings: draft.settings,
    leagueMetadata: (league.leagueSettings?.['metadata'] as Record<string, unknown> | undefined) ?? null,
  });

  const allPlayers = await sources.players.listAll();
  // Only a real ranking counts. Sleeper's search_rank measures who gets
  // looked up rather than who gets picked — using it here put Drake Maye near
  // the top of the board and retired players on it at all.
  const rankOf = (player: CanonicalPlayer): number | null =>
    importedValues.get(player.id)?.adp ?? null;
  /*
   * Raw Underdog ADP for one player, or null.
   *
   * Symmetrical with `rankOf` and deliberately never a fallback for it. A
   * player Underdog has priced and Sleeper has not keeps a null here and a
   * number there, and the market baseline renormalises — see
   * `marketBaseline.ts`. Neither function can ever return the other's number.
   */
  const dogOf = (player: CanonicalPlayer): number | null => dog.values.get(player.id)?.adp ?? null;
  const rankedCount = allPlayers.filter((p) => p.active && rankOf(p) != null).length;
  if (rankedCount === 0) {
    warnings.push(
      'no draft order yet — players are ranked by news and roster need only, which is a poor substitute. Sleeper ADP for this league is fetched each morning; import a ranking file if you need one before then.',
    );
  }
  const byId = new Map(allPlayers.map((p) => [p.id, p]));

  // Roster need comes from the same reconstruction the Team page shows, so the
  // two can never disagree about what has been drafted.
  const shapeForRoster = buildRosterShape(league.rosterPositions);
  const live = buildLiveRoster({
    picks,
    rosterId: myRosterRecord?.rosterId ?? null,
    ownerId: myRosterRecord?.ownerId ?? null,
    sleeperPlayerIds: myRosterRecord?.playerIds ?? [],
    byId,
    shape: shapeForRoster,
    draftStatus: draft.status,
  });
  const rosterCounts = live.counts;
  const myRoster = live.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    team: p.team,
    pickNo: p.pickNo ?? 0,
  }));

  // Candidate pool: ranked players who are still available. Unranked players
  // are included only when nothing is ranked at all, so the board degrades to
  // "everyone" rather than to nothing.
  const positionFilter = opts.position ? opts.position.toUpperCase() : null;
  /*
   * The queue, when that is what was asked for.
   *
   * Read before the pool is cut rather than after: a player you queued in the
   * eleventh round is exactly the one you want the filter to surface, and
   * scoring only the top of the board would hide him. Both marks are shortlists
   * by nature, so reading all of them costs nothing.
   *
   * Scoped to this draft, which is the whole of the queue's correctness: the ★
   * list belongs to the draft it was written in, and `draftId` is the only way
   * to ask for it.
   */
  const allFlags = await sources.flags(draftId);
  const queuedOnly = opts.queuedOnly === true;
  // Only positions this league starts. A league with no kicker slot should
  // never be shown a kicker, however Sleeper ranks them.
  const startable = startablePositions(buildRosterShape(league.rosterPositions));
  /*
   * Is this somebody you could actually draft?
   *
   * Sleeper's dictionary cannot answer it — Chris Carson, who last played in
   * 2021, and Kareem Hunt, who carried the ball two hundred times last season,
   * are recorded identically, and `search_rank` puts Carson ahead. What
   * separates them is that somebody prices Hunt. See `draftable.ts` for the
   * sampled evidence and why every simpler rule fails.
   *
   * Bounds the *recommendation* pool only. Deep Players search reads the player
   * table directly and is untouched.
   */
  const draftable = (player: CanonicalPlayer): boolean =>
    isDraftable({ team: player.team, sleeperAdp: rankOf(player), dogAdp: dogOf(player) });

  const eligible = (player: CanonicalPlayer): boolean =>
    player.active &&
    draftable(player) &&
    !takenIds.has(player.id) &&
    (startable.size === 0 || startable.has(player.position)) &&
    // `FLX` narrows to RB/WR/TE; every other value is the exact position it
    // names. One helper, shared with the player list and the compare picker.
    positionMatchesFilter(player.position, positionFilter) &&
    (!queuedOnly || allFlags.get(player.id)?.queued === true);

  /*
   * Everyone eligible, whether or not the market has priced him.
   *
   * This used to keep a player only if his position had no ranking at all or
   * he personally had an ADP — which sounds like tidiness and was in fact the
   * ceiling on the whole board. The published ADP file covers about two
   * hundred players; every other active quarterback, back, receiver and tight
   * end in the league was being deleted from the draft universe for the crime
   * of not appearing in it. That is precisely backwards: a player nobody has
   * ranked is a player you might get late, which is the one thing a draft
   * assistant is for in the eleventh round.
   *
   * Missing ADP is now unknown rather than disqualifying. It costs the player
   * nothing he has earned: `marketValueComponent` already returns `unknown`
   * with a zero contribution when ADP is null, scarcity is flagged the same
   * way, `Val` is null and the row is marked degraded — so an unpriced player
   * is ranked on what is actually known about him and shows `ADP —` rather
   * than a number the app made up.
   *
   * The sort below puts every priced player first, so nothing about the top
   * of the board moves; unranked players fill the tail in `search_rank` order,
   * and `MAX_CANDIDATES` still bounds how many are scored.
   */
  const pool: CanonicalPlayer[] = allPlayers.filter(eligible);
  /*
   * Draft order first. Within a position nobody ranks, `search_rank` breaks
   * the tie — it is emphatically not ADP (it measures who gets looked up) and
   * is never allowed to set the board's order, but ordering thirty-two
   * defences by how often they are searched beats ordering them by accident.
   * Their market-value component is still `unknown` and they are still marked
   * degraded, so nothing here pretends to a draft position it does not have.
   */
  pool.sort(byMarketThenSearch(rankOf));

  /*
   * No warning for a position the ranking does not cover.
   *
   * This said "no draft order covers DEF in this ranking, so they are listed on
   * news and roster need alone", above the board, in every league that starts a
   * defence — which is most of them. It was accurate, and it was an apology for
   * a behaviour that has been removed rather than explained: defences are now
   * ranked on the market alone and on nothing else, so there is no news and no
   * roster need to disclose. See `DEFENCE_WEIGHTS` and the split ranking pass
   * below.
   *
   * DEF is the only position this ever fired for. Every other startable
   * position is covered by every published draft order this app imports, and if
   * one somehow were not, the row itself already says so — `ADP —` rather than a
   * number, and `degraded` set — which is the honest place for it: on the player
   * it is about, rather than in a banner over a board it mostly does not
   * describe.
   */

  // Sleeper ranks ~2,500 players; scoring all of them on every request is
  // work nobody reads, and it is far more than any draft will reach. The cap
  // is applied after the position filter, so filtering by QB still considers
  // the best quarterbacks rather than whoever survived a global cut.
  /*
   * Capped silently, and deliberately so.
   *
   * This used to push a warning saying how many players were below the cut.
   * That was reasonable when the pool was two hundred priced players and the
   * cut meant something; now that every eligible player is a candidate it
   * reads "2,764 further down the order are not scored", which is a true
   * sentence about three hundred players nobody will draft, sitting at the
   * top of the screen during a draft. The counts belong in `poolHealth`,
   * where the probe reads them, not in the two lines above the board.
   */
  const candidates = pool.slice(0, MAX_CANDIDATES);
  if (queuedOnly && pool.length === 0) {
    warnings.push('your queue is empty — tap the star beside a player to add them');
  }

  // Non-blocking draft-day readiness: unresolved names are research the user
  // did that is not reaching the board. Say so here rather than only in Setup,
  // because this is the screen they are looking at when it matters.
  const repair = await sources.repairStatus();
  /*
   * Historical tendencies, if this deployment has any.
   *
   * A source that does not implement it, a league in its first season, and a
   * sync that has not run yet all arrive here as an empty map, and an empty map
   * produces the board exactly as it was before this feature existed.
   */
  const managerTendencies = (await sources.managerTendencies?.(league.id)) ?? new Map<number, ManagerTendencies>();
  if (repair.summary.names > 0 && Math.abs(repair.summary.net) >= 2) {
    warnings.push(
      `${repair.summary.headline} — fix it under Help my scores in Setup; the board is usable meanwhile`,
    );
  }

  const candidateIds = candidates.map((c) => c.id);
  const signals = await sources.evidence.getSignals(candidateIds);
  // Season-long market lines, read from the newest stored snapshot. Nothing is
  // fetched here: the draft board must never wait on a provider, and the
  // refresh has its own slow clock.
  const seasonLines = await sources.seasonMarkets(candidateIds);
  const marketSnapshot = await sources.marketSnapshot();
  // The user's own shortlist, already read above.
  const flags = allFlags;
  const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
  const shape = buildRosterShape(league.rosterPositions);
  /*
   * Read for this league's own scoring, which is what makes the number usable
   * at all: a projection computed under six-point passing touchdowns is fifty
   * points wrong on every quarterback in a four-point league.
   */
  const preseasonPoints = await sources.preseasonPoints(
    candidateIds,
    projectionScoringFrom(profile),
  );

  /*
   * `Next`: how likely the room is to leave each of these players alone.
   *
   * Run out here rather than inside the engine because the answer needs live
   * draft state the engine is deliberately never given — the exact managers
   * picking before the user's next selection, what each of them is short of,
   * and what this room has been doing all draft. One simulation of the
   * interval settles every candidate at once, so this costs once per board
   * state and not once per player, and repeats of an unchanged state are
   * served from a cache keyed by that state.
   *
   * Nothing user-specific is passed in. `My Guy`, the newsletter tally and the
   * betting market are all absent from the call by construction: they say
   * something about whether *you* should want him, and nothing about whether
   * somebody else will take him.
   */
  const positionOf = (id: string) => byId.get(id)?.position ?? null;
  const ownerSlotOf = (pick: { rosterId: number | null; draftSlot: number }) =>
    slotForRoster(draft.slotToRosterId, pick.rosterId) ?? pick.draftSlot;

  /*
   * The whole available board, not the part of it the reader is looking at.
   *
   * This deliberately ignores the position chip and the queue filter, and it
   * has to. `candidates` is what gets drawn — filter to QB and it holds
   * quarterbacks — and handing that to the simulator would have every
   * simulated manager drafting quarterbacks, one after another, until the
   * position ran out. Every quarterback would then read close to zero for the
   * sole reason that the reader tapped QB, which is both wrong and invisible:
   * the numbers stay plausible, they just quietly answer a different question.
   *
   * The room drafts from the room's board. What the reader has chosen to see
   * is not part of it.
   */
  const simulationPool = allPlayers
    .filter((player) => simulationEligible(player, takenIds, startable))
    .sort(byMarketThenSearch(rankOf))
    .slice(0, MAX_CANDIDATES);
  const simCandidates: SimCandidate[] = simulationPool.map((player) => ({
    playerId: player.id,
    position: player.position,
    adp: rankOf(player),
    /*
     * DOG reaches the simulator for exactly one thing: tail risk.
     *
     * The survival prior is still Sleeper's and only Sleeper's — the room
     * drafts against the ADP of the platform it is on, and DOG says nothing
     * about what eleven other managers will do. What a large DOG-vs-Sleeper
     * gap does say is that sharp drafters like him more than this room's ADP
     * implies, so the board should be *less sure he lasts*. It widens the
     * early tail and cannot move the central estimate. See
     * `idiosyncraticHazard`.
     */
    dogAdp: dogOf(player),
    /*
     * Read by the local-team prior alone, which multiplies opponent demand.
     */
    team: player.team,
    order: player.searchRank ?? Number.MAX_SAFE_INTEGER,
  }));

  // What every manager already holds, from the pick stream — the only roster
  // that exists mid-draft. Keyed by the slot that will actually pick.
  const rostersBySlot = new Map<number, Record<string, number>>();
  for (let slot = 1; slot <= teams; slot++) rostersBySlot.set(slot, {});
  for (const pick of picks) {
    if (!pick.playerId) continue;
    const position = positionOf(pick.playerId);
    if (!position) continue;
    const counts = rostersBySlot.get(ownerSlotOf(pick));
    if (!counts) continue;
    counts[position] = (counts[position] ?? 0) + 1;
  }

  const tierMaps = buildTierMaps(simCandidates, currentPick, horizon?.pickNo ?? null);

  /*
   * What the managers between you and your next pick have drafted before.
   *
   * Assembled here rather than inside the model because it needs two things the
   * model does not have: which Sleeper user holds each seat in *this* draft, and
   * the profiles keyed by that user. The chain is slot → roster → owner, and it
   * is followed in that order every time — a roster id is a seat, and seats
   * change hands between seasons.
   *
   * `slotsAheadOf` is the same function the simulator uses to decide whose picks
   * it walks, so "only managers picking before you" holds by construction: a
   * manager with no intervening selection is never in this list to begin with.
   */
  const ownerBySlot = new Map<number, string | null>();
  for (let slot = 1; slot <= teams; slot++) {
    const rosterId = draft.slotToRosterId?.[String(slot)] ?? null;
    const roster = rosterId == null ? null : rosters.find((r) => r.rosterId === rosterId);
    ownerBySlot.set(slot, roster?.ownerId ?? null);
  }
  const tendenciesByUser = new Map<string, ManagerTendencies>();
  for (const [rosterId, tendencies] of managerTendencies) {
    const roster = rosters.find((r) => r.rosterId === rosterId);
    /*
     * Filed by roster, read by user — and only when the two still agree.
     *
     * A profile stored before the roster changed hands carries the *previous*
     * owner's user id, so matching it against the current owner is what stops a
     * new manager inheriting it between a sync and a re-sync.
     */
    if (roster?.ownerId && tendencies.userId === roster.ownerId) {
      tendenciesByUser.set(roster.ownerId, tendencies);
    }
  }
  const managerPrior =
    mySlot == null || horizon == null || tendenciesByUser.size === 0
      ? undefined
      : readManagerPrior({
          tendencies: tendenciesByUser,
          userBySlot: ownerBySlot,
          slotsAhead: slotsAheadOf(ownership, currentPick, horizon.pickNo, mySlot),
          rosters: rostersBySlot,
          shape,
          positions: positionsInPlay(shape),
          displayNames: new Map(
            [...ownerBySlot.entries()].map(([slot, userId]) => [
              slot,
              rosters.find((r) => r.ownerId === userId)?.ownerName ?? null,
            ]),
          ),
        });

  const nextPick = estimateNextPickAvailability({
    managerPrior,
    draftId,
    ...(opts.nextPickSeed === undefined ? {} : { seed: opts.nextPickSeed }),
    currentPick,
    targetPick: horizon?.pickNo ?? null,
    mySlot,
    ownership,
    shape,
    candidates: simCandidates,
    rosters: rostersBySlot,
    totalPicks: teams * rounds,
    tiers: tierMaps,
    alternatives: alternativesByPosition(simCandidates, horizon?.pickNo ?? null),
    // Which NFL teams this room takes early, if it has been told any.
    localTeams: league.localTeams ?? [],
    teamsInLeague: teams,
    completed: picks
      .filter((pick) => pick.playerId)
      .map((pick) => ({
        pickNo: pick.pickNo,
        slot: ownerSlotOf(pick),
        position: positionOf(pick.playerId!),
        // What the room actually did with the local team, which is the
        // measurement the prior defers to as soon as there is enough of it.
        team: byId.get(pick.playerId!)?.team ?? null,
        adp: importedValues.get(pick.playerId!)?.adp ?? null,
      })),
    // The market's own picture of the board, drafted players included — what
    // the room "should" have been doing, to measure what it did.
    universe: allPlayers.flatMap((player) => {
      const adp = rankOf(player);
      return adp == null ? [] : [{ position: player.position, adp }];
    }),
  });

  const rankInput = (player: CanonicalPlayer) => ({
    player,
    adp: rankOf(player),
    dogAdp: dogOf(player),
    adpRank: importedValues.get(player.id)?.rank ?? null,
    signal: signals.get(player.id) ?? null,
    myGuyLevel: flags.get(player.id)?.level ?? 0,
    seasonMarkets: seasonLines.get(player.id) ?? [],
    preseasonPoints: preseasonPoints.get(player.id) ?? null,
    nextPickSurvival: survivalFor(nextPick.byPlayer.get(player.id)),
  });

  const rankingContext = {
      currentPick,
      nextPick: horizon?.pickNo ?? null,
      shape,
      profile,
      rosterCounts,
      totalPicks: teams * rounds,
      /*
       * The same reconstruction `rosterCounts` is derived from, but keeping
       * the NFL team — which a count per position throws away and the
       * concentration component needs. Sent only when the roster is actually
       * known: with no identified roster the component scores nothing rather
       * than reporting a well-spread team the user has not drafted.
       */
      rosterPlayers: myRosterRecord
        ? live.players.map((p) => ({ position: p.position, team: p.team }))
        : undefined,
    // 60/40, or 75/25 in a best-ball league. Sleeper's own settings decide.
    marketFormat: marketFormatOf(format),
  };

  /*
   * The owner's own reading, at whatever volume he set in Settings.
   *
   * `balanced` hands `rankAvailablePlayers` the same `DEFAULT_WEIGHTS` object
   * its own default parameter would have supplied, so the default position is
   * not a near-miss of today's board — it is today's board.
   *
   * The defence pass below is deliberately not given this: a defence is ranked
   * on the market and nothing else, so there is nothing here to turn up.
   */
  const balance = opts.signalBalance ?? SIGNAL_BALANCE_DEFAULT;
  const fieldWeights = weightsForSignalBalance(balance, DEFAULT_WEIGHTS);
  if (personalScale(balance) !== 1) {
    warnings.push(
      personalScale(balance) > 1
        ? 'your own research is set louder than usual in Settings, so your ♥, AVOIDs and newsletter tally ' +
          'move these rankings further than the board’s default'
        : 'your own research is set quieter than usual in Settings, so your ♥, AVOIDs and newsletter tally ' +
          'move these rankings less than the board’s default',
    );
  }

  /*
   * DEFENCES ARE RANKED APART, ON THE MARKET AND NOTHING ELSE.
   *
   * The board used to score them like everybody else and then apologise for it
   * above the list: "no draft order covers DEF in this ranking, so they are
   * listed on news and roster need alone". That sentence was accurate, and what
   * it described is the problem — with no published draft order for defences,
   * the only live inputs left were a news tally and a roster slot, so a
   * newsletter sentence could float a defence up a draft board.
   *
   * A defence is an afterthought, and the app has no opinion about one: no news
   * rule reads them, no Vegas market covers them, no preseason projection
   * includes them. So they are ranked on the draft market alone, in a pass of
   * their own with `DEFENCE_WEIGHTS`, and ordered strictly by Sleeper ADP —
   * ascending, unpriced last, name to break the tie so the order is stable
   * between two polls of an unchanged board.
   *
   * **A separate pass, not a filter inside the shared one.** Every pool-relative
   * thing the engine computes — scarcity, the tier ladder, separation,
   * opportunity cost — is grouped by position, so a defence never entered a
   * non-defence player's arithmetic and removing it cannot change one. Ranking
   * them apart makes that a fact about the call graph rather than a property to
   * be re-checked: the field's ranking is the same call, on the same inputs, in
   * the same context it always had. `tests/draft.defence.test.ts` asserts the
   * field's output is byte-for-byte identical with the defences present and
   * absent.
   *
   * Defences then follow the field, which is where an afterthought belongs and
   * is also where they already were: with no ADP their composite sat near zero
   * and the engine's own sort puts an unpriced player after every priced one.
   */
  const rankedField = rankAvailablePlayers(
    candidates.filter((player) => player.position !== DEFENCE).map(rankInput),
    rankingContext,
    fieldWeights,
  );

  const rankedDefence = rankAvailablePlayers(
    candidates
      .filter((player) => player.position === DEFENCE)
      .map((player) => ({
        ...rankInput(player),
        /*
         * Stripped as well as unweighted, so the *card* says what the ordering
         * says. A zero weight already stops these moving a defence, but the
         * expanded card prints components and a DOG column, and a row whose
         * numbers imply a reading the order does not use is worse than a row
         * with fewer numbers on it.
         */
        dogAdp: null,
        signal: null,
        myGuyLevel: 0 as const,
        seasonMarkets: [],
        preseasonPoints: null,
      })),
    /*
     * The roster is withheld as well as unweighted.
     *
     * `team_concentration` carries a weight of its own rather than reading the
     * table above, so zeroing the table would leave your own drafted roster
     * still nudging a defence — a roster-derived adjustment, which is precisely
     * the kind this is meant to stop applying. With no roster the component
     * scores nothing and says so, which is the same answer it gives before your
     * first pick.
     */
    { ...rankingContext, rosterPlayers: undefined },
    DEFENCE_WEIGHTS,
  ).sort(
    (a, b) =>
      Number(a.adp == null) - Number(b.adp == null) ||
      (a.adp ?? 0) - (b.adp ?? 0) ||
      a.name.localeCompare(b.name),
  );

  const ranked = [...rankedField, ...rankedDefence].slice(0, opts.limit ?? 50);

  /*
   * How short the teams picking before your next turn are, per position.
   *
   * Computed once for the whole board from the pick stream, the actual snake
   * order and the league's own starting slots — never from ADP or from how
   * many are left. It is attached to the tier line below and read nowhere
   * else; no score, weight or ordering sees it.
   */
  const demand = demandBetweenPicks({
    picks,
    positionOf: (id) => byId.get(id)?.position ?? null,
    currentPick,
    horizonPick: horizon?.pickNo ?? null,
    mySlot,
    teams,
    type: draft.type,
    shape,
  });

  /*
   * Availability for the ranked page only.
   *
   * Forty rows, one query, and it never blocks the board: a failure of the
   * injury store costs the extra line and leaves Sleeper's own designation —
   * which is what the board showed before this existed — exactly in place.
   */
  const injuries = await sources
    .injuryStates(ranked.map((rec) => ({ playerId: rec.playerId, status: byId.get(rec.playerId)?.status ?? null })))
    .catch(() => new Map<string, InjuryState>());

  /*
   * Inside the queue filter, the reader's order wins.
   *
   * This is the one list in the app the model does not get to sort. The
   * ranking is still computed, still on every card, and still what the ★
   * chip's rows say about each player — what changes is the sequence, which
   * is the reader's and is stored. Everywhere else on this board the order is
   * the composite's, untouched.
   *
   * Applied after ranking rather than instead of it, so a queued player's
   * Score, Val, Next and tier are identical whether he is read on the queue
   * or on the full board. See `queueOrder.ts`.
   */
  const orderedRanked = queuedOnly ? applyQueueOrder(ranked, allFlags) : ranked;

  const recommendations = orderedRanked.map((rec) => {
    const availability = nextPick.byPlayer.get(rec.playerId);
    return {
      ...rec,
      /*
       * The card's number, substituted after the ranking is finished.
       *
       * The engine was given `historyBaseline` — the simulation without
       * historical manager behaviour — because whatever it receives reaches
       * `Score` through two channels: the `survivalUrgency` component, and the
       * separation and cost-of-waiting pass that reads `survivalProbability`
       * off the finished recommendation. Both are ranking machinery, and the
       * brief puts manager history out of bounds for both.
       *
       * The reader, though, should see the model's best estimate of whether the
       * player survives, which is the adjusted one. So it is put back here,
       * once the ordering and every component are already fixed. Nothing
       * downstream of this line scores anything — `applyBoardComponents` has
       * long since run inside the engine.
       *
       * Where no history applied, `historyBaseline` is absent and this is the
       * same number the engine already had.
       */
      survivalProbability: availability?.probability ?? rec.survivalProbability,
      queued: allFlags.get(rec.playerId)?.queued === true,
      status: designationOf(byId.get(rec.playerId)?.status ?? null),
      tierContext: tierContextLine(rec.position, rec.tierCliff, demand.get(rec.position) ?? null),
      injuryLine: injuryLineFor(injuries.get(rec.playerId)),
      nextPick: nextPickDetail(availability),
    };
  });

  return {
    draftId,
    status: draft.status,
    type: draft.type,
    teams,
    rounds,
    currentPick,
    picksMade,
    mySlot,
    myNextPick: next?.pickNo ?? null,
    picksUntilMyTurn: next?.picksUntil ?? null,
    onTheClock: next?.pickNo === currentPick,
    waitHorizonPick: horizon?.pickNo ?? null,
    league: {
      id: league.id,
      name: league.name,
      scoringLabel: profile.label,
      notes: leagueFitNotes(profile, shape),
    },
    rosterCounts,
    myRoster,
    openStarters: live.openStarters,
    rosterProgress: live.progress,
    adpSnapshot: snapshotMeta
      ? {
          id: snapshotMeta.id,
          label: snapshotMeta.label,
          capturedAt: snapshotMeta.capturedAt,
          matched: snapshotMeta.matchedCount,
        }
      : null,
    dogState: dog.state,
    marketSource: marketSnapshot,
    marketFormat: {
      format: marketFormatOf(format),
      bestBall: format.bestBall,
      confident: format.confident,
      basis: format.basis,
      weights: blendWeights(marketFormatOf(format)),
      reason: format.reason,
    },
    recommendations,
    rosterAlerts: rosterAlerts({
      shape,
      counts: rosterCounts,
      needs: computeNeed(shape, rosterCounts),
      round,
      totalRounds: rounds,
    }),
    round,
    startablePositions: orderPositions(startable),
    offersFlex: offersFlexFilter(startable),
    /*
     * The board-as-a-board, assembled from what is already in hand.
     *
     * Three read-only projections of state this method loaded pages ago: the
     * rosters it already fetched, the pick stream it already walked, and the
     * ownership model it already built for the `Next` horizon. No query, no
     * poll and no second ownership model — see boardGrid.ts for what is done
     * with them.
     */
    managers: managerColumns({
      teams,
      slotToRosterId: draft.slotToRosterId,
      picks,
      rosters,
      mySlot,
      myRosterId: myRosterRecord?.rosterId ?? null,
    }),
    boardPicks: picks
      .filter((pick) => pick.playerId)
      .map((pick) => {
        const player = byId.get(pick.playerId!);
        const fallback = pickMetadata(pick.raw);
        return {
          pickNo: pick.pickNo,
          playerId: pick.playerId!,
          name: player?.fullName ?? fallback.name ?? 'Unknown player',
          position: player?.position ?? fallback.position ?? '',
          team: player?.team ?? fallback.team ?? '',
          ownerSlot: ownerSlotOf(pick),
        };
      })
      .sort((a, b) => a.pickNo - b.pickNo),
    pickOwners: ownership.hasTrades
      ? Array.from({ length: teams * rounds }, (_, i) => ownership.ownerAt(i + 1) ?? ownership.slotAt(i + 1))
      : null,
    /*
     * What the `Next` model did, for the probe and for anybody debugging a
     * number that looks wrong.
     *
     * Not read by any screen. `Next` is one percentage on a card and it has
     * to stay one percentage on a card; this is where the twenty numbers
     * behind it live, so that "why is he 18%" can be answered from the
     * response rather than by reading the simulator.
     */
    nextPickModel: {
      targetPick: nextPick.targetPick,
      picksSimulated: nextPick.picksSimulated,
      simulations: nextPick.simulations,
      slotsAhead: nextPick.slotsAhead,
      needAhead: Object.fromEntries(nextPick.needAhead),
      roomSample: nextPick.room.sample,
      dispersion: nextPick.room.dispersion,
      positionRuns: Object.fromEntries(nextPick.room.runs),
      positionBias: Object.fromEntries(nextPick.room.bias),
      roomNotes: nextPick.room.notes,
      /*
       * The local-team prior, and what it actually did.
       *
       * The brief asks for diagnostics showing the real survival effect, and
       * this is where they go: the multiplier applied per team, how many
       * picks it was measured from, how far this room has actually been
       * taking them ahead of the market, and how much of the answer is
       * measurement rather than assumption. Read by the probe and by nobody
       * on screen — `Next` is one percentage on a card and has to stay one.
       */
      localTeams: league.localTeams ?? [],
      managerHistory:
        nextPick.managerPrior && nextPick.managerPrior.entries.length > 0
          ? {
              managersWithHistory: nextPick.managerPrior.entries.length,
              unknownSlots: nextPick.managerPrior.unknownSlots,
              entries: nextPick.managerPrior.entries.map((e) => ({
                slot: e.slot,
                displayName: e.displayName,
                draftsObserved: e.draftsObserved,
                picksObserved: e.picksObserved,
                multipliers: Object.fromEntries(e.multipliers),
                suppressed: e.suppressed,
              })),
              notes: nextPick.managerPrior.notes,
              largestMovePoints: nextPick.historyLargestMovePoints,
              ceilingHits: nextPick.historyCeilingHits,
              ceilingPoints: MANAGER_HISTORY_CEILING * 100,
            }
          : null,
      teamPrior: nextPick.teamPrior
        ? {
            basis: nextPick.teamPrior.basis,
            multipliers: Object.fromEntries(nextPick.teamPrior.multipliers),
            observed: Object.fromEntries(nextPick.teamPrior.observed),
            notes: nextPick.teamPrior.notes,
            /*
             * What the prior did to survival, in percentage points.
             *
             * Every player carries two numbers: what the market alone says
             * about his chances, and what the simulation says. The gap
             * between them is everything the simulation knows that ADP does
             * not — the room, the rosters ahead, the tiers, and the local
             * prior. Measured for the favoured teams and for everybody else
             * on the same board, the *difference between those two gaps* is
             * the prior's own contribution, because every other term in the
             * model applies to both groups.
             *
             * Not a controlled experiment — a Lions-heavy tier would show up
             * here too — but it is the honest read of a live board, and it
             * answers "is this doing anything, and how much" without running
             * the simulation twice.
             */
            survivalEffect: measureSurvivalEffect(recommendations, league.localTeams ?? []),
          }
        : null,
      // True when the board was too thin to simulate, so these percentages
      // are the ADP model's rather than the simulation's.
      marketOnly: nextPick.marketOnly,
      degraded: nextPick.degraded,
      /*
       * The seed, so the determinism claim is checkable from the response.
       *
       * `Next%` is a Monte Carlo estimate that must not move when nothing has
       * moved, and it is seeded from the board state for exactly that reason.
       * Two polls of an unchanged board reporting the same seed is what makes
       * "the same numbers, forever" something a reader can verify rather than
       * take on trust — and it is what lets a support snapshot reproduce the
       * draws without carrying the draft id that produced them.
       */
      seed: nextPick.seed,
      elapsedMs: nextPick.elapsedMs,
      cached: nextPick.cached,
    },
    /*
     * The counts, so a truncated board can never look healthy again.
     *
     * This board once ended near ADP 78 and said nothing about it, because
     * every stage was individually reasonable and nothing reported what it
     * had thrown away. These are the numbers that would have made it obvious
     * in one glance, and they are computed from the same variables the board
     * was built from rather than recounted afterwards.
     */
    poolHealth: {
      activeEligible: pool.length,
      drafted: takenIds.size,
      scored: candidates.length,
      returned: recommendations.length,
      withAdp: recommendations.filter((r) => r.adp != null).length,
      withoutAdp: recommendations.filter((r) => r.adp == null).length,
      deepestAdp: recommendations.reduce<number | null>(
        (deepest, r) => (r.adp == null ? deepest : Math.max(deepest ?? r.adp, r.adp)),
        null,
      ),
      byPosition: recommendations.reduce<Record<string, number>>((counts, r) => {
        counts[r.position] = (counts[r.position] ?? 0) + 1;
        return counts;
      }, {}),
      cap: MAX_CANDIDATES,
    },
    warnings,
  };
}

/**
 * The Underdog column, or an honest reason there is not one.
 *
 * Three gates, in the order that makes the failure legible. A snapshot that
 * does not exist is not the same as one that turned out to be a ranking,
 * which is not the same as one that is a fortnight old — and a board that
 * showed a blank DOG column for all three would leave the reader unable to
 * tell "Underdog has not priced him" from "we stopped trusting the file".
 *
 * Nothing here ever falls back to Sleeper. A missing DOG is a missing DOG;
 * the market baseline renormalises around it and says it did.
 */
async function resolveDog(
  sources: DraftBoardSources,
  meta: BoardAdpSnapshot | null,
): Promise<{
  values: Map<string, { adp: number | null }>;
  state: DraftBoardState['dogState'];
  warning: string | null;
}> {
  const none = new Map<string, { adp: number | null }>();

  if (!meta) {
    return {
      values: none,
      state: {
        available: false,
        provider: null,
        sourceType: null,
        snapshotAt: null,
        fetchedAt: null,
        freshness: 'unknown',
        ageHours: null,
        matched: 0,
        reason: 'no Underdog ADP snapshot has been imported',
      },
      warning: null,
    };
  }

  /*
   * A snapshot that is not raw ADP cannot be shown as DOG, at any age.
   *
   * This is the rule the whole Underdog path exists to enforce: rankings,
   * expert ranks and projections all sort like ADP and none of them is one.
   * The importer already refuses to write such a snapshot; this is the second
   * gate, at the point of use, because a row that got in by some other route
   * must still never reach a column labelled DOG.
   */
  if (meta.sourceType !== 'raw_adp') {
    return {
      values: none,
      state: {
        available: false,
        provider: meta.provider,
        sourceType: meta.sourceType,
        snapshotAt: meta.snapshotAt,
        fetchedAt: meta.fetchedAt,
        freshness: 'unknown',
        ageHours: null,
        matched: 0,
        reason: `the newest Underdog snapshot is ${meta.sourceType}, not raw ADP — it cannot be shown as DOG`,
      },
      warning:
        'the newest Underdog file is not raw ADP, so DOG is unavailable and the market baseline is Sleeper alone',
    };
  }

  const freshness = dogFreshness(
    { fetchedAt: meta.fetchedAt ?? meta.importedAt, snapshotAt: meta.snapshotAt },
    sources.now(),
  );

  if (!dogIsUsable(freshness.state)) {
    return {
      values: none,
      state: {
        available: false,
        provider: meta.provider,
        sourceType: meta.sourceType,
        snapshotAt: meta.snapshotAt,
        fetchedAt: meta.fetchedAt,
        freshness: freshness.state,
        ageHours: freshness.ageHours,
        matched: 0,
        reason: `Underdog ADP is ${freshness.note}`,
      },
      // Said out loud. A stale DOG presented as a fresh one is the specific
      // dishonesty this path is built to prevent, and silence would be it.
      warning: `Underdog ADP is ${freshness.note} — DOG is not being used and the market baseline is Sleeper alone`,
    };
  }

  const values = await sources.adp.valuesByPlayer(meta.id);

  /*
   * A snapshot that resolved to nobody is not a usable market.
   *
   * It happens: a provider changes its name format, or the file arrives for a
   * season the player table has not synced yet, and every row fails to match.
   * The snapshot is real, raw and fresh, and it prices exactly zero players —
   * so calling DOG "available" would light the column, tighten the card
   * layout to make room for it and offer a DOG sort that puts the entire
   * board in the unpriced tail. Reported as unavailable, with the count, so
   * the reason is a matching problem rather than a mystery.
   */
  if (values.size === 0) {
    return {
      values: new Map(),
      state: {
        available: false,
        provider: meta.provider,
        sourceType: meta.sourceType,
        snapshotAt: meta.snapshotAt,
        fetchedAt: meta.fetchedAt,
        freshness: freshness.state,
        ageHours: freshness.ageHours,
        matched: 0,
        reason: `the Underdog snapshot has ${meta.rowCount} rows but none of them resolved to a known player`,
      },
      warning:
        'the Underdog ADP file did not match any players, so DOG is unavailable — check the unresolved rows in Setup',
    };
  }

  return {
    values,
    state: {
      available: true,
      provider: meta.provider,
      sourceType: meta.sourceType,
      snapshotAt: meta.snapshotAt,
      fetchedAt: meta.fetchedAt,
      freshness: freshness.state,
      ageHours: freshness.ageHours,
      matched: values.size,
      reason: freshness.note,
    },
    warning: null,
  };
}


/**
 * How far the simulation moved survival away from the market, for the room's
 * local players against everybody else.
 *
 * Both figures are `simulated - market`, in percentage points, so they share
 * every term of the model except the one being measured. A negative
 * `difference` means the local players are being taken sooner than the rest of
 * the board relative to what ADP alone predicted, which is what the prior is
 * for; a difference near zero means it is not doing anything worth the setting.
 *
 * Null when there is nothing to compare — no local teams named, or no priced
 * player on one side of the line.
 */
function measureSurvivalEffect(
  recommendations: { team: string; survivalProbability: number | null; nextPick: { marketBaseline: number | null } | null }[],
  localTeams: readonly string[],
): { local: number; others: number; difference: number; sample: number } | null {
  const favoured = new Set(localTeams.map((t) => t.trim().toUpperCase()));
  if (favoured.size === 0) return null;

  const gaps = { local: [] as number[], others: [] as number[] };
  for (const rec of recommendations) {
    const simulated = rec.survivalProbability;
    const market = rec.nextPick?.marketBaseline ?? null;
    if (simulated == null || market == null) continue;
    const bucket = favoured.has((rec.team ?? '').toUpperCase()) ? gaps.local : gaps.others;
    bucket.push((simulated - market) * 100);
  }
  if (gaps.local.length === 0 || gaps.others.length === 0) return null;

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const local = round1(mean(gaps.local));
  const others = round1(mean(gaps.others));
  return { local, others, difference: round1(local - others), sample: gaps.local.length };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * The queue's rows, in the order the reader put them in.
 *
 * A player with no stored rank sorts after every player who has one, in board
 * order — which is where somebody the reader has never placed belongs, and
 * which keeps a queue built entirely on an older client behaving exactly as it
 * did before this existed.
 *
 * Deliberately a pure reordering of the array it is handed: no recommendation
 * is copied or modified, so a queued player's numbers cannot differ from the
 * same player's numbers on the unfiltered board.
 */
function applyQueueOrder<T extends { playerId: string }>(
  ranked: T[],
  flags: Map<string, { queueOrder: number | null }>,
): T[] {
  const rankOf = (id: string) => flags.get(id)?.queueOrder ?? null;
  const boardPosition = new Map(ranked.map((rec, i) => [rec.playerId, i]));
  return [...ranked].sort((a, b) => {
    const ao = rankOf(a.playerId);
    const bo = rankOf(b.playerId);
    if (ao == null && bo == null) return boardPosition.get(a.playerId)! - boardPosition.get(b.playerId)!;
    if (ao == null) return 1;
    if (bo == null) return -1;
    return ao - bo || boardPosition.get(a.playerId)! - boardPosition.get(b.playerId)!;
  });
}

/**
 * The simulated answer, in the shape the engine's survival component expects.
 *
 * The note carries the drivers *after* the headline: the component already says
 * "18% chance to last to pick 68", so repeating "Unlikely to last to pick 68"
 * next to it would be the same sentence twice. What is worth appending is the
 * reasoning — who needs the position, how many are left in the tier, what the
 * room has been doing.
 *
 * Returns undefined when the simulation had nothing to say about this player, so
 * the engine falls back to its own ADP estimate rather than showing a blank.
 */
function survivalFor(availability: NextPickAvailability | undefined):
  | { probability: number | null; note: string }
  | undefined {
  if (!availability) return undefined;
  if (availability.probability == null && availability.drivers.length === 0) return undefined;
  return {
    /*
     * The ranking reads the number *without* historical manager behaviour.
     *
     * This is the one place the two versions of `Next%` are told apart, and the
     * reason they exist. Survival is not merely displayed — it is a scored
     * component, `survivalUrgency`, at 0.22 of the composite: a player likelier
     * to be taken is more urgent, which is right, and which means anything that
     * moves survival moves `Score`.
     *
     * For the room's own behaviour in this draft, that is the mechanism working:
     * a run at the position is public, everyone can see it, and a player caught
     * in one really is more urgent. Historical manager tendency is different in
     * kind. It is the weakest evidence the model carries — two drafts, shrunk
     * hard, about people rather than about football — and the brief draws the
     * line there explicitly: it may change the estimate of whether somebody
     * takes him, and it may not change how good he is or where he ranks.
     *
     * So the composite is fed `historyBaseline`, the counterfactual the paired
     * run computed, and the card is shown `probability`, which carries the
     * adjustment. `Score`, `Val`, the tier ladders and the ordering are then
     * identical whether or not a league has ever synced its history —
     * `nextpick.managerHistory.board.test.ts` asserts exactly that, field by
     * field, over the whole board.
     */
    probability: availability.historyBaseline ?? availability.probability,
    note: availability.drivers.slice(1).join(' · '),
  };
}

/** The same answer, in full, for the wire. */
function nextPickDetail(availability: NextPickAvailability | undefined): BoardRecommendation['nextPick'] {
  if (!availability) return null;
  return {
    probability: availability.probability,
    marketBaseline: availability.marketBaseline,
    // Present only where history actually applied, so the card and the probe can
    // show what it did without having to run the model a second time.
    historyBaseline: availability.historyBaseline ?? null,
    historyAdjustment: availability.historyAdjustment ?? null,
    drivers: availability.drivers,
    confidence: availability.confidence,
    degraded: availability.degraded,
  };
}

/**
 * Tier ladders for the simulator, from the same engine the board's tier chips
 * use.
 *
 * Built here rather than reused from the ranking pass because the two run in
 * that order — the simulation feeds the ranking — and because this file is the
 * only place that has both the candidate pool and the horizon. It consumes the
 * tier engine and does not redefine it: if a position has no usable ladder the
 * simulator loses a nudge and keeps working.
 */
function buildTierMaps(
  candidates: SimCandidate[],
  currentPick: number,
  targetPick: number | null,
): Map<string, PositionTierMap> {
  const adpsByPosition = new Map<string, number[]>();
  for (const candidate of candidates) {
    if (candidate.adp == null) continue;
    const list = adpsByPosition.get(candidate.position);
    if (list) list.push(candidate.adp);
    else adpsByPosition.set(candidate.position, [candidate.adp]);
  }
  const picksUntilNext = targetPick == null ? 0 : Math.max(0, targetPick - currentPick);
  const out = new Map<string, PositionTierMap>();
  for (const [position, adps] of adpsByPosition) {
    out.set(position, buildPositionTierMap(position, adps, { picksUntilNext }));
  }
  return out;
}

/**
 * How many comparable players are left at each position, for the explanation.
 *
 * "Comparable" means within reach of the pick being measured to — a receiver
 * ninety picks below the board is not an alternative to one going now, and
 * counting him would turn every position into a deep one. Used only to decide
 * whether a driver line is worth printing; the model's own supply effect comes
 * out of the simulation, not out of this count.
 */
function alternativesByPosition(candidates: SimCandidate[], targetPick: number | null): Map<string, number> {
  const out = new Map<string, number>();
  if (targetPick == null) return out;
  const reach = targetPick + 30;
  for (const candidate of candidates) {
    if (candidate.adp == null || candidate.adp > reach) continue;
    out.set(candidate.position, (out.get(candidate.position) ?? 0) + 1);
  }
  return out;
}

/**
 * One named manager per seat, in column order.
 *
 * Sleeper publishes `slot_to_roster_id` for most drafts and, occasionally, for
 * none of them — a league that has not started yet has seats but no mapping. So
 * the pick stream is read as a second source: a manager who has picked has
 * proved which seat they are sitting in, which is a fact rather than an
 * inference. Anything still unresolved is `Team 4`, said plainly, because a
 * column with a made-up name is worse than a column with a number.
 *
 * The seat mapping used here is the same one the pick stream and the `Next`
 * horizon already use. Nothing new is decided about who owns what.
 */
function managerColumns(input: {
  teams: number;
  slotToRosterId: Record<string, number>;
  picks: { draftSlot: number; rosterId: number | null; playerId: string | null }[];
  rosters: { rosterId: number; ownerName: string | null; isMine: boolean }[];
  mySlot: number | null;
  myRosterId: number | null;
}): { slot: number; name: string; isMine: boolean }[] {
  const rosterOfSlot = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(input.slotToRosterId ?? {})) {
    const seat = Number(slot);
    if (Number.isFinite(seat) && Number.isFinite(rosterId)) rosterOfSlot.set(seat, Number(rosterId));
  }
  for (const pick of input.picks) {
    if (pick.rosterId == null || !pick.draftSlot) continue;
    if (!rosterOfSlot.has(pick.draftSlot)) rosterOfSlot.set(pick.draftSlot, pick.rosterId);
  }

  const nameOfRoster = new Map<number, string>();
  for (const roster of input.rosters) {
    const name = (roster.ownerName ?? '').trim();
    if (name) nameOfRoster.set(roster.rosterId, name);
  }

  return Array.from({ length: Math.max(1, input.teams) }, (_, i) => {
    const slot = i + 1;
    const rosterId = rosterOfSlot.get(slot) ?? null;
    return {
      slot,
      name: (rosterId == null ? null : nameOfRoster.get(rosterId)) ?? `Team ${slot}`,
      /*
       * Two ways of being the reader's seat, and both are needed.
       *
       * The roster mapping is the direct answer. `mySlot` is the one the rest
       * of this service already worked out — including from the reader's own
       * completed picks — and it is what makes the board emphasise the right
       * column in a draft Sleeper never published an order for.
       */
      isMine: (rosterId != null && rosterId === input.myRosterId) || (input.mySlot != null && input.mySlot === slot),
    };
  });
}

/**
 * The player a pick names, when the player table does not know him.
 *
 * Sleeper stores the drafted player's name on the pick itself, which is the
 * only description that survives a player disappearing from the canonical
 * table. Used as a fallback and never in preference: the canonical row is the
 * one every other screen reads.
 */
function pickMetadata(raw: string | null | undefined): { name: string | null; position: string | null; team: string | null } {
  const empty = { name: null, position: null, team: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as { metadata?: Record<string, unknown> };
    const meta = parsed?.metadata;
    if (!meta || typeof meta !== 'object') return empty;
    const first = typeof meta['first_name'] === 'string' ? (meta['first_name'] as string) : '';
    const last = typeof meta['last_name'] === 'string' ? (meta['last_name'] as string) : '';
    const name = `${first} ${last}`.trim();
    return {
      name: name || null,
      position: typeof meta['position'] === 'string' ? (meta['position'] as string) : null,
      team: typeof meta['team'] === 'string' ? (meta['team'] as string) : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Traded picks, if this draft's settings carry any.
 *
 * Sleeper exposes them on a separate endpoint that this app does not yet sync,
 * so in practice the list is usually empty and every pick belongs to its seat —
 * which is what the snake said all along. The path exists because reading them
 * from the wrong place is worse than not reading them: a pick attributed to the
 * manager who traded it away invents demand from a roster that is not picking.
 * Anything malformed is ignored rather than guessed at.
 */
function tradedPicksFrom(settings: Record<string, unknown> | null | undefined): TradedPick[] {
  const raw = settings?.['traded_picks'] ?? settings?.['tradedPicks'];
  if (!Array.isArray(raw)) return [];
  const out: TradedPick[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const round = Number(row['round']);
    const rosterId = Number(row['roster_id'] ?? row['rosterId']);
    const ownerRosterId = Number(row['owner_id'] ?? row['ownerId'] ?? row['ownerRosterId']);
    if (!Number.isFinite(round) || !Number.isFinite(rosterId) || !Number.isFinite(ownerRosterId)) continue;
    out.push({ round, rosterId, ownerRosterId });
  }
  return out;
}

/**
 * The injury line, but only when it adds to the badge already on the row.
 *
 * A card that says `Q` and then says `Q` again underneath is noise. This
 * returns a line only when the report contributed something the designation
 * alone does not carry — the body part, or how the week's practice went.
 */
function injuryLineFor(state: InjuryState | undefined): string | null {
  if (!state) return null;
  if (!state.bodyPart && !state.practice.label) return null;
  return injuryLine(state);
}

/** The status only when it is a designation a drafter acts on. */
function designationOf(status: string | null): string | null {
  return injuryStatusTag(status) ? status : null;
}

/** Conventional reading order, with anything unexpected kept and put last. */
