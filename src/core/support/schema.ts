/**
 * Support Snapshot v1: a recommendation, and everything it took to make it.
 *
 * The problem this exists for is not "the app is wrong". It is that the app is
 * wrong *once*, on a Tuesday, on somebody's phone, against live Sleeper state,
 * a market snapshot fetched that morning and a newsletter ledger nobody else
 * has — and by the time anybody looks, none of that exists any more. A bug
 * report becomes an archaeology exercise, and the fix is guessed at rather than
 * proven.
 *
 * A snapshot is the state that produced one recommendation, frozen: the inputs
 * exactly as the engine read them, the output exactly as it produced it, and
 * the clock it was standing at. Handed to an agent it replays deterministically
 * with no network at all, which turns "why is Junculator recommending this"
 * into a question with an answer.
 *
 * ## The five properties, and where each is enforced
 *
 * **Deterministic.** Every input the board reads is recorded, including the
 * instant the market's age is measured from. Replay runs the *real*
 * `buildDraftBoard` over the recorded reads — see `replay.ts` — so nothing is
 * reimplemented and nothing can drift. The one genuinely random thing in the
 * pipeline, the next-pick Monte Carlo, is seeded from draft state and was
 * already deterministic; see `draft/nextpick/rng.ts`.
 *
 * **Complete enough to replay.** Enforced structurally rather than by review:
 * the capture is a recording proxy around `DraftBoardSources`, so a source
 * method the board calls is a source method the snapshot has. A future input
 * added to that interface arrives in the snapshot without anybody remembering
 * to add it.
 *
 * **Bounded.** The one unbounded read is `players.listAll()`, which is the
 * whole Sleeper dictionary. It is distilled to the players that can affect the
 * answer — see `draftSnapshot.ts` — and what the distillation dropped is
 * counted rather than hidden.
 *
 * **Versioned.** Two versions, because two different things can move: the
 * schema (this file) and the reasoning (`draft/version.ts`). A replay reports
 * on both.
 *
 * **Redacted.** See `redaction.ts`. Nothing that identifies a person survives
 * capture, and a test asserts it rather than a comment promising it.
 *
 * ## Why `decision.kind`
 *
 * Draft was the first surface, not the only one. Everything above — schema
 * identity, release plumbing, the fixed clock, redaction, the replay harness,
 * the fixture converter — is surface-independent, and the only Draft-specific
 * part is what sits under `decision`.
 *
 * All six kinds are now implemented, and the bill for the other five came in
 * exactly as the design predicted: a payload type, a recorder and a replay
 * adapter each, with no change to this envelope and no second snapshot format.
 * The schema identity is still `@1`, because the contract a reader depends on
 * did not move — an older build handed a `lineup` snapshot reports
 * `schema_unsupported`, which is the honest answer and the one the outcome word
 * was designed to give.
 *
 * See docs/SUPPORT_SNAPSHOT.md for the extension contract, and `payloads.ts` for
 * the five in-season payloads.
 */

import type { DraftBoardState } from '../draft/boardBuilder.ts';
import type {
  DstPlanPayload,
  LineupPayload,
  MatchupPayload,
  TradeOfferPayload,
  WaiverPlanPayload,
} from './payloads.ts';

/** The canonical schema identity. Present in every snapshot, checked on replay. */
export const SUPPORT_SNAPSHOT_SCHEMA = 'junculator/support-snapshot@1' as const;
export type SupportSnapshotSchema = typeof SUPPORT_SNAPSHOT_SCHEMA;

/**
 * The decisions this app makes, named once.
 *
 * All six are implemented. They were all six declared here from the first day
 * the Draft lane shipped, with only `draft-board` behind them — because a union
 * with one member is a union nobody designs against, and writing them all down
 * is what made the envelope, the redaction, the fixed clock, the fixture
 * converter and the CLI surface-independent before there was a second surface
 * to prove it on. Adding the five cost no change to any of them.
 */
export type DecisionKind =
  | 'draft-board'
  | 'lineup'
  | 'matchup'
  | 'waiver-plan'
  | 'dst-plan'
  | 'trade-offer';

export const IMPLEMENTED_KINDS: readonly DecisionKind[] = [
  'draft-board',
  'lineup',
  'matchup',
  'waiver-plan',
  'dst-plan',
  'trade-offer',
];

/**
 * What a reader is told each decision is called.
 *
 * The user-facing name of the screen the decision was made on, so
 * `Current context: Waivers` is a sentence about the app rather than about the
 * schema. Kept beside the union so a new kind cannot be added without one.
 */
export const DECISION_LABELS: Record<DecisionKind, string> = {
  'draft-board': 'Draft',
  lineup: 'Team',
  matchup: 'Matchup',
  'waiver-plan': 'Waivers',
  'dst-plan': 'Defence',
  'trade-offer': 'Trades',
};

/**
 * Where this snapshot came from, in the two senses that matter.
 *
 * `gitSha` is the deployment — the same string `/api/health` reports, from the
 * same Release Safety plumbing, so a snapshot can be tied to a revision that
 * actually shipped. `engineVersion` is the reasoning. They answer different
 * questions and a replay reads both: a matching SHA means the code is
 * identical, and a matching engine version means the code that *matters here*
 * is identical even when the SHA has moved on.
 */
export interface SnapshotRelease {
  /** The deployed revision, or `unknown` where none was injected. */
  gitSha: string;
  /** Which decision this snapshot is about. Mirrors `decision.kind`. */
  surface: DecisionKind;
  engineVersion: string;
}

/**
 * The instant everything in this snapshot is measured from.
 *
 * Not decoration. The board ages the Underdog file against it, and a snapshot
 * replayed a week later without it would quietly become a snapshot about a
 * *stale* market — the DOG column would disappear, the baseline would
 * renormalise onto Sleeper alone, and every score would move for a reason
 * nothing on screen mentioned. Replay pins `sources.now()` to this value.
 */
export interface SnapshotClock {
  /** ISO-8601, from the same `sources.now()` the board itself read. */
  capturedAt: string;
}

/**
 * The envelope. Everything outside `decision` is surface-independent.
 *
 * A reader — human or agent — should be able to answer "what is this, which
 * code made it, when, and is it safe to look at" from the envelope alone,
 * without knowing what a draft board is.
 */
export interface SupportSnapshot<Payload extends DecisionPayload = DecisionPayload> {
  schema: SupportSnapshotSchema;
  /** ISO-8601. Also the fixed clock the replay pins to — see `SnapshotClock`. */
  capturedAt: string;
  release: SnapshotRelease;
  /**
   * What was redacted and how, so a reader can tell an alias from a real
   * identifier without guessing at the shape of a Sleeper user id.
   */
  redaction: RedactionReport;
  decision: Payload;
}

/**
 * One of six, and the only surface-dependent thing in the file.
 *
 * The Draft payload is defined below because it was the first and because its
 * output has to be hand-written — a three-hundred-player board copied whole is
 * a file nobody can paste anywhere. The five in-season payloads are in
 * `payloads.ts`, where the note explains why their outputs are the engines' own
 * types instead.
 */
export type DecisionPayload =
  | DraftBoardPayload
  | LineupPayload
  | MatchupPayload
  | WaiverPlanPayload
  | DstPlanPayload
  | TradeOfferPayload;

/** The payload for one kind, so an adapter can be typed by the word. */
export type PayloadFor<K extends DecisionKind> = Extract<DecisionPayload, { kind: K }>;

// ---------------------------------------------------------------- redaction

export interface RedactionReport {
  /**
   * What was replaced, by kind, and how many of each.
   *
   * Counts rather than a mapping: a mapping back to the real values is the
   * thing this removes. `manager` covers Sleeper user ids and display names,
   * which are aliased consistently across rosters, picks and manager profiles
   * so the board's slot → roster → owner chain still resolves.
   */
  replaced: Record<string, number>;
  /** The rules applied, in plain language, so the reader can check the list. */
  rules: string[];
}

// ------------------------------------------------------------- draft payload

/**
 * A draft board, taken apart.
 *
 * `request` says what was asked for, `context` says what league and what
 * moment, `freshness` says how old the data behind it was, `inputs` is what
 * the engine actually read, and `output` is what it concluded. Replay needs
 * `request` and `inputs`; a human reading the file needs the other three, and
 * they are derived from the same values rather than restated independently.
 */
export interface DraftBoardPayload {
  kind: 'draft-board';
  request: DraftBoardRequest;
  context: DraftBoardContext;
  freshness: DraftBoardFreshness;
  inputs: DraftBoardInputs;
  output: DraftBoardOutput;
  /**
   * What the board said about itself — degraded markets, an unidentified
   * roster, an unresolved name. Lifted out of `output` because "what was
   * already known to be wrong" is the first thing a diagnosis should read.
   */
  warnings: string[];
}

/** The exact arguments `buildDraftBoard` was called with. */
export interface DraftBoardRequest {
  draftId: string;
  limit: number | null;
  position: string | null;
  queuedOnly: boolean;
}

/**
 * The league and the moment, in the terms a person would describe them.
 *
 * Every field here is derived from `inputs` and is redundant by construction.
 * That is the point: a support snapshot is read by a human before it is
 * replayed by a machine, and "12-team half-PPR, pick 49, round 5" is the
 * sentence that tells them whether they are looking at the right file.
 */
export interface DraftBoardContext {
  season: string;
  /** The scoring identity the projections were read under. */
  scoringKey: string;
  scoringLabel: string;
  rosterShape: {
    starters: Record<string, number>;
    flex: { slot: string; positions: string[] }[];
    benchSlots: number;
    totalStarters: number;
    superflex: boolean;
    /** `roster_positions` exactly as Sleeper published it, which is the input. */
    positions: string[];
  };
  draftState: {
    status: string;
    type: string;
    teams: number;
    rounds: number;
    round: number;
    currentPick: number;
    picksMade: number;
    mySlot: number | null;
    /** The pick every "will he last" number is measured against. */
    waitHorizonPick: number | null;
    onTheClock: boolean;
  };
  rosterCounts: Record<string, number>;
}

/**
 * How old the data behind the board was, at `capturedAt`.
 *
 * Its own section because a large fraction of "the recommendation looks wrong"
 * reports are a freshness story rather than a model story, and a diagnosis
 * should be able to rule that in or out before reading a single component.
 */
export interface DraftBoardFreshness {
  dog: DraftBoardState['dogState'];
  marketSource: DraftBoardState['marketSource'];
  adpSnapshot: DraftBoardState['adpSnapshot'];
  marketFormat: DraftBoardState['marketFormat'];
}

// ------------------------------------------------------------- draft inputs

/**
 * A canonical player, reduced to what the board actually reads.
 *
 * Seven fields out of fifteen. The rest — aliases, external ids, height,
 * weight, age — are read by the player profile and by the identity ladder, and
 * neither of those is on the path from a draft request to a ranked board.
 * `tests/support.snapshot.test.ts` proves the reduction is lossless by
 * replaying a board through it and comparing byte for byte, which is the only
 * assurance worth having: a list in a comment would go stale the first time
 * somebody adds a component.
 */
export interface SnapshotPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  active: boolean;
  status: string | null;
  searchRank: number | null;
}

/**
 * What the distillation kept, and what it dropped.
 *
 * The board reads the whole Sleeper dictionary — around 2,500 rows — and
 * scores at most 300 of them. Capturing all of it would be the "entire player
 * dictionary" the snapshot principles rule out, so the capture keeps the
 * players that can reach the answer and counts the rest.
 *
 * `activeEligible` is the one board-level number the distillation cannot
 * reproduce: it counts every eligible player, including the two thousand below
 * the scoring cap that no snapshot needs. It is recorded here so a replay can
 * report the difference as *distillation* rather than as drift — see
 * `replay.ts`, which compares against this value and not against silence.
 */
export interface SnapshotPlayerCensus {
  /** Rows in the live player table at capture. */
  listed: number;
  /** Rows kept in this snapshot. */
  captured: number;
  /** `poolHealth.activeEligible` as the live board computed it. */
  activeEligible: number;
  /** Why each captured player was kept, counted. Diagnostics only. */
  keptBecause: Record<string, number>;
}

/**
 * One ADP snapshot's numbers, as a plain object keyed by player id.
 *
 * Keyed by snapshot id rather than merged, because the two markets must never
 * become one table: `boardBuilder.ts` says why at length, and a snapshot that
 * flattened them would replay a board whose DOG column was Sleeper's numbers.
 */
export interface SnapshotAdpValues {
  snapshotId: number;
  byPlayer: Record<string, { adp: number | null; rank: number | null }>;
}

/**
 * Everything `DraftBoardSources` returned, recorded.
 *
 * The field names track the interface deliberately. When `DraftBoardSources`
 * grows a member, the compiler points at `draftSnapshot.ts` and `replay.ts`
 * until both have been taught about it — which is a far better guarantee than
 * a reviewer noticing that a new input is missing from a JSON file.
 */
export interface DraftBoardInputs {
  /** The instant the board's own clock returned. Replay pins to this. */
  now: string;
  draft: SnapshotDraft;
  league: SnapshotLeague;
  rosters: SnapshotRoster[];
  picks: SnapshotPick[];
  players: SnapshotPlayer[];
  playerCensus: SnapshotPlayerCensus;
  adp: {
    /** Snapshot metadata, by id — `adp.get`, `latestPlatformSnapshot`, `latestForSource`. */
    snapshots: Record<string, unknown>[];
    platformSnapshotId: number | null;
    underdogSnapshotId: number | null;
    values: SnapshotAdpValues[];
  };
  /** Newsletter tallies for the scored pool. Numeric aggregates only. */
  signals: Record<string, unknown>;
  /** The user's own ♥ and ★ — the favourite state, and the thing this lane was opened for. */
  flags: Record<string, { level: 0 | 1 | 2 | 3; queued: boolean; queueOrder: number | null }>;
  seasonMarkets: Record<string, { market: string; line: number | null; bookCount?: number }[]>;
  marketSnapshot: { provider: string; season: string; fetchedAt: string } | null;
  preseasonPoints: Record<string, number>;
  /** The scoring the projections were asked for under, so replay asks the same. */
  preseasonScoring: Record<string, unknown> | null;
  /**
   * Historical manager tendencies, keyed by roster id, user ids aliased.
   *
   * Null where the source does not implement it at all, which is a different
   * board from one where it returned nothing: the first cannot have a manager
   * prior and the second could have had one and did not.
   */
  managerTendencies: { rosterId: number; tendencies: Record<string, unknown> }[] | null;
  repairStatus: { summary: { names: number; net: number; headline: string } };
  injuryStates: Record<string, unknown>;
}

/** Draft record with the ADP pin the board reads off it. */
export interface SnapshotDraft {
  id: string;
  leagueId: string;
  status: string;
  type: string;
  season: string;
  rounds: number;
  teams: number;
  slotToRosterId: Record<string, number>;
  settings: Record<string, unknown>;
  adpSnapshotId: number | null;
  /**
   * Sleeper's own draft id and the last sync time are kept because a support
   * conversation frequently needs to say *which* draft, and neither identifies
   * a person.
   */
  sleeperDraftId: string;
  lastSyncedAt: string;
}

export interface SnapshotLeague {
  id: string;
  sleeperLeagueId: string;
  name: string;
  season: string;
  totalRosters: number;
  scoringSettings: Record<string, number>;
  rosterPositions: string[];
  leagueSettings: Record<string, unknown>;
  draftId: string | null;
  status: string | null;
  localTeams: string[];
  lastSyncedAt: string;
}

export interface SnapshotRoster {
  leagueId: string;
  rosterId: number;
  /** Aliased — `manager-3`, never a Sleeper user id. */
  ownerId: string | null;
  /** Aliased — `Manager 3`, never a Sleeper username. */
  ownerName: string | null;
  playerIds: string[];
  starterIds: string[];
  reserveIds: string[];
  isMine: boolean;
  settings: Record<string, unknown> | null;
}

export interface SnapshotPick {
  draftId: string;
  pickNo: number;
  round: number;
  pickInRound: number;
  draftSlot: number;
  sleeperPlayerId: string | null;
  playerId: string | null;
  rosterId: number | null;
  /** Aliased. */
  pickedBy: string | null;
  /**
   * The raw Sleeper pick, reduced to the four metadata fields the board reads
   * as a fallback name for a player it cannot resolve. Everything else in the
   * blob — `picked_by`, the rest of the metadata — is dropped.
   */
  raw: string;
}

// ------------------------------------------------------------- draft output

/**
 * The domain output, not the pixels.
 *
 * Two halves, and the split is about size rather than importance. `order` is
 * every ranked player id in board order and costs a few bytes each, so it is
 * complete — which is what makes "the ordered player IDs match" a claim about
 * the *whole* board. `rows` carries every component, weight, contribution and
 * sentence, which is roughly a kilobyte a player, so it is bounded to the top
 * of the board where an argument about a recommendation actually happens.
 *
 * The bound is stated in `detailRows` and compared explicitly. A snapshot that
 * silently detailed forty players and claimed to describe three hundred would
 * be exactly the loose assertion this is built to avoid.
 */
export interface DraftBoardOutput {
  /** Every recommendation's player id, in board order. */
  order: string[];
  /** How many of them carry full detail below, and how those were chosen. */
  detailRows: number;
  detailSelection: {
    /** The top of the board, always included. */
    topRows: number;
    /**
     * Ranked players carrying a ♥ or a ★, included wherever they finished.
     *
     * The reason this exists is the first report this lane was built for: a
     * favourite that appeared not to move. He was ranked eightieth, which is
     * exactly where a bound on the top of the board would have dropped his
     * argument — and his argument is the entire question. Both marks are
     * shortlists by nature, so including all of them costs a handful of rows.
     */
    marked: number;
  };
  rows: SnapshotRecommendation[];
  /**
   * What each component key is called, said once.
   *
   * The label is a constant function of the key and repeating it on every row
   * cost twenty kilobytes to say `Roster need` three hundred times. Hoisted
   * here it is both smaller and more useful: a reader gets the whole component
   * vocabulary in one place before reading a single row.
   */
  componentLabels: Record<string, string>;
  rosterAlerts: { key: string; severity: string; message: string; positions: string[] }[];
  poolHealth: DraftBoardState['poolHealth'];
  startablePositions: string[];
  offersFlex: boolean;
  /**
   * The next-pick model's own workings, minus the two fields that measure the
   * machine rather than the answer.
   *
   * `elapsedMs` and `cached` are how long it took and whether it came from a
   * process-local cache. Both are true statements about a run and neither is a
   * property of the board, so they are dropped at capture rather than excluded
   * at comparison — a field that cannot be compared should not be in a file
   * whose purpose is comparison.
   */
  nextPickModel: Omit<DraftBoardState['nextPickModel'], 'elapsedMs' | 'cached'>;
}

/**
 * One ranked player, with the whole argument behind him.
 *
 * `myGuy` is carried in full — level, label, normalised score and the
 * contribution the component actually spent — because the first case this lane
 * was opened for is a favourite that appeared not to matter, and "the boost
 * reached the ranking" has to be checkable from the file rather than inferred
 * from a total.
 */
export interface SnapshotRecommendation {
  rank: number;
  playerId: string;
  name: string;
  position: string;
  team: string;
  adp: number | null;
  dogAdp: number | null;
  adpValue: number | null;
  total: number;
  score: number | null;
  survivalProbability: number | null;
  degraded: boolean;
  status: string | null;
  queued: boolean;
  myGuy: { level: number; label: string; marks: string; score: number; contribution: number };
  /** `label` lives once in `componentLabels`; `key` is the identity. */
  components: { key: string; display: string; score: number; weight: number; contribution: number; unknown: boolean }[];
  reasons: string[];
  counterpoints: string[];
  tierCliff: { severity: string; message: string | null };
  wait: { state: string; survivalProbability: number | null };
  newsLifetimeNet: number;
  news30Net: number;
  news7Net: number;
  /**
   * The lines on the card that no component score stands behind.
   *
   * Every field above is either the ranking or an input to it, so a matching
   * set of components is very strong evidence that they matched too. These four
   * are not: they are the *only* thing several sources produce.
   * `injuryStates` reaches the board through `injuryLine` and nothing else;
   * `preseasonPoints` is read by a component but also printed on its own;
   * `tierContext` comes from the demand model, which reads the pick stream
   * through a path no score touches; `marketHeadline` is the season market said
   * as a sentence.
   *
   * Without them a snapshot could reproduce every number on the board and
   * silently lose the availability line under a player's name — which is
   * exactly the kind of report this feature exists to answer.
   */
  injuryLine: string | null;
  tierContext: string | null;
  marketHeadline: string | null;
  preseasonPoints: number | null;
  /**
   * The `Next%` model's own workings for this player.
   *
   * `survivalProbability` above is the number the card shows; this is what is
   * behind it — what the market alone would have said, what historical manager
   * behaviour moved it by, and which drivers were found. It is the only
   * per-player evidence that a manager prior applied at all, which makes it the
   * thing to read when a survival percentage is the complaint.
   */
  nextPick: {
    probability: number | null;
    marketBaseline: number | null;
    historyBaseline: number | null;
    historyAdjustment: number | null;
    drivers: string[];
    confidence: string;
    degraded: string[];
  } | null;
}

// ------------------------------------------------------------ replay verdict

/**
 * What a replay concluded, as one of six words.
 *
 * Deliberately a closed set. "It looks a bit different" is not a diagnosis, and
 * an agent triaging a report needs to branch on something. The order below is
 * the order they are checked in: a snapshot the current code cannot read at all
 * is not a data mismatch, and a data mismatch is not an output difference.
 */
export type ReplayOutcome =
  /** Every term of the reproduction contract held. */
  | 'reproduced'
  /** The schema identity is not one this build knows how to read. */
  | 'schema_unsupported'
  /** The snapshot is malformed, or carries something it should not. */
  | 'data_mismatch'
  /** The reasoning has moved since capture; a difference is expected. */
  | 'engine_version_mismatch'
  /** Same order and same numbers, but the market's age is being read differently. */
  | 'freshness_difference'
  /** The board reproduced a different answer. */
  | 'output_difference';
