/**
 * Replaying a snapshot: the real board, the recorded inputs, no network.
 *
 * The one rule this module exists to keep is that **it does not know how a
 * draft board works**. It rebuilds a `DraftBoardSources` out of the recorded
 * reads and hands it to `buildDraftBoard`, which is the same function the
 * server calls and the same one Demo Mode calls. A converter that
 * reimplemented any of the ranking would be measuring its own arithmetic
 * against the app's, which proves nothing about the app.
 *
 * Everything that could reach outside this process is closed off by
 * construction: the sources are Maps, the clock is a fixed instant read out of
 * the snapshot, and the next-pick Monte Carlo was already seeded from draft
 * state rather than from `Math.random`. There is no code path from here to a
 * provider, and `tests/support.api.test.ts` asserts it with `fetch` replaced by
 * something that throws, rather than describing it.
 *
 * ## What "reproduced" means
 *
 * Stated as a list of terms rather than as a deep-equal, because a deep-equal
 * over a whole board is a check that either passes or tells you nothing. Each
 * term below is a separate claim with its own message, so a failing replay says
 * *what* moved:
 *
 *   1. every ranked player id, in order;
 *   2. every recorded component's score, weight and contribution, exactly;
 *   3. the composite total and the 0–100 score, exactly;
 *   4. reasons, counterpoints and warnings, as sets of sentences;
 *   5. the favourite's level and the contribution it spent;
 *   6. unknown/degraded flags and the freshness states behind them.
 *
 * No numeric tolerance is applied to any of them. Every number on this path is
 * produced by the same double arithmetic in the same order from the same
 * inputs, so an exact match is achievable — and a tolerance would be a place for
 * real drift to hide. The single concession is signed zero, which JSON cannot
 * express at all; the reasoning is beside `exact` at the bottom of this file.
 *
 * The two fields that genuinely cannot match, `elapsedMs` and `cached`, are not
 * in the snapshot at all rather than excluded here — a field that cannot be
 * compared should not be in a document whose purpose is comparison. See
 * `DraftBoardOutput.nextPickModel`.
 */

import {
  UNDERDOG_SOURCE_KEY,
  buildDraftBoard,
  type DraftBoardSources,
  type DraftBoardState,
} from '../draft/boardBuilder.ts';
import { DRAFT_ENGINE_VERSION } from '../draft/version.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { PlayerSignal } from '../evidence/types.ts';
import type { InjuryState } from '../injury/model.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';
import { normalizeName } from '../identity/normalize.ts';
import { findRedactionViolations } from './redaction.ts';
import {
  SUPPORT_SNAPSHOT_SCHEMA,
  type DraftBoardPayload,
  type ReplayOutcome,
  type SnapshotPlayer,
  type SupportSnapshot,
} from './schema.ts';

/** One way in which the replay and the capture disagreed. */
export interface ReplayDifference {
  /** Which term of the contract failed — `order`, `components`, `warnings`, … */
  term: string;
  /** Where, in terms a reader can find in the file. */
  at: string;
  captured: unknown;
  replayed: unknown;
}

export interface ReplayReport {
  outcome: ReplayOutcome;
  /** One sentence a person can read before looking at anything else. */
  summary: string;
  schema: { expected: string; found: string; supported: boolean };
  engine: { captured: string; current: string; matches: boolean };
  release: { capturedSha: string };
  /** Rows compared in full, out of the ordering compared in full. */
  compared: { order: number; detailRows: number };
  differences: ReplayDifference[];
  /**
   * Things that are different and are *known* to be, because the snapshot is a
   * distillation rather than a copy of the database.
   *
   * Reported rather than swallowed. `poolHealth.activeEligible` counts every
   * eligible player in the league, including the two thousand below the scoring
   * cap that no snapshot carries, so a replay will always see a smaller number —
   * and a reader has to be able to tell that apart from a board that lost two
   * thousand players.
   */
  distillation: ReplayDifference[];
  /** The board the replay produced, for a caller that wants to look at it. */
  board: DraftBoardState | null;
}

/** Raised when a snapshot cannot be read at all. */
export class SnapshotRejected extends Error {
  /** Plain fields, so type-stripping alone can run this — see the CLI. */
  readonly outcome: Extract<ReplayOutcome, 'schema_unsupported' | 'data_mismatch'>;

  constructor(outcome: Extract<ReplayOutcome, 'schema_unsupported' | 'data_mismatch'>, message: string) {
    super(message);
    this.name = 'SnapshotRejected';
    this.outcome = outcome;
  }
}

/**
 * Read a parsed JSON value as a snapshot, or refuse it.
 *
 * Two gates, in this order. The schema identity decides whether this build
 * knows the shape at all; a version it has never heard of is not a malformed
 * file and must not be reported as one. Then the redaction scan runs *again* —
 * capture already ran it, and running it here as well is the point: a snapshot
 * is a file that travels, and the copy being replayed is not necessarily the
 * copy that was emitted.
 */
export function readSnapshot(value: unknown): SupportSnapshot<DraftBoardPayload> {
  if (value == null || typeof value !== 'object') {
    throw new SnapshotRejected('data_mismatch', 'not a JSON object');
  }
  const snapshot = value as Partial<SupportSnapshot<DraftBoardPayload>>;

  if (snapshot.schema !== SUPPORT_SNAPSHOT_SCHEMA) {
    throw new SnapshotRejected(
      'schema_unsupported',
      `schema is ${JSON.stringify(snapshot.schema ?? null)}; this build reads ${SUPPORT_SNAPSHOT_SCHEMA}`,
    );
  }

  const decision = snapshot.decision;
  if (!decision || decision.kind !== 'draft-board') {
    throw new SnapshotRejected(
      'schema_unsupported',
      `decision.kind is ${JSON.stringify((decision as { kind?: string } | undefined)?.kind ?? null)}; only draft-board can be replayed today`,
    );
  }

  for (const path of ['request', 'inputs', 'output', 'context'] as const) {
    if (decision[path] == null) throw new SnapshotRejected('data_mismatch', `decision.${path} is missing`);
  }
  if (!Array.isArray(decision.inputs.players) || decision.inputs.players.length === 0) {
    throw new SnapshotRejected('data_mismatch', 'decision.inputs.players is empty, so there is no board to rebuild');
  }
  if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new SnapshotRejected('data_mismatch', 'capturedAt is not an ISO-8601 instant, so the clock cannot be fixed');
  }

  /*
   * A snapshot carrying a secret is refused, not cleaned.
   *
   * Cleaning it would mean writing a file that had contained one, and the
   * person holding it would have no way to know. The honest response to
   * "this file has an API key in it" is to say so and stop.
   */
  const violations = findRedactionViolations(snapshot);
  if (violations.length > 0) {
    throw new SnapshotRejected(
      'data_mismatch',
      `this snapshot carries ${violations.length} field${violations.length === 1 ? '' : 's'} a support snapshot must never contain — ` +
        violations.map((v) => `${v.path} (${v.reason})`).join('; '),
    );
  }

  return snapshot as SupportSnapshot<DraftBoardPayload>;
}

/**
 * Sources that serve one snapshot and nothing else.
 *
 * Every method is a lookup in a Map. There is no fetch, no repository, no
 * database handle and no provider anywhere in the object, which is what makes
 * "replay needs no live provider access" a property of the value rather than a
 * claim about the environment.
 */
export function snapshotDraftBoardSources(snapshot: SupportSnapshot<DraftBoardPayload>): DraftBoardSources {
  const inputs = snapshot.decision.inputs;
  const players = inputs.players.map(rehydratePlayer);
  const snapshots = new Map(
    inputs.adp.snapshots.map((s) => [Number((s as { id: number }).id), s as unknown as never]),
  );
  const values = new Map(
    inputs.adp.values.map((entry) => [entry.snapshotId, new Map(Object.entries(entry.byPlayer))]),
  );
  /*
   * The clock, frozen.
   *
   * A new `Date` object each call rather than one shared instance, because the
   * board is entitled to do whatever it likes with what it is handed and a
   * mutated shared date would be a bug that only appeared on replay.
   */
  const fixedClock = Date.parse(snapshot.capturedAt);

  return {
    leagues: {
      getDraft: async (id) => (inputs.draft.id === id ? (inputs.draft as unknown as never) : null),
      getLeague: async (id) => (inputs.league.id === id ? (inputs.league as unknown as never) : null),
      listRosters: async (leagueId) =>
        inputs.league.id === leagueId ? (inputs.rosters as unknown as never) : ([] as never),
      listPicks: async (draftId) =>
        inputs.draft.id === draftId ? (inputs.picks as unknown as never) : ([] as never),
    },
    players: { listAll: async () => players },
    adp: {
      get: async (id) => snapshots.get(id) ?? null,
      latestPlatformSnapshot: async () =>
        inputs.adp.platformSnapshotId == null ? null : snapshots.get(inputs.adp.platformSnapshotId) ?? null,
      /*
       * The source it was asked for, and only that one.
       *
       * The capture records the Underdog snapshot because that is the one the
       * board asks for; answering *every* source with it would be the single
       * worst thing available here — a second market's numbers served under
       * Underdog's name, which `boardBuilder.ts` spends four paragraphs
       * explaining must never happen. Same shape the demo's own sources use.
       */
      latestForSource: async (source) =>
        source !== UNDERDOG_SOURCE_KEY || inputs.adp.underdogSnapshotId == null
          ? null
          : snapshots.get(inputs.adp.underdogSnapshotId) ?? null,
      valuesByPlayer: async (snapshotId) => (values.get(snapshotId) ?? new Map()) as never,
    },
    evidence: {
      getSignals: async (playerIds) => {
        const out = new Map<string, PlayerSignal>();
        for (const id of playerIds) {
          const signal = inputs.signals[id];
          if (signal) out.set(id, signal as PlayerSignal);
        }
        return out;
      },
    },
    flags: async () => new Map(Object.entries(inputs.flags)),
    preseasonPoints: async (playerIds) => {
      const out = new Map<string, number>();
      for (const id of playerIds) {
        const points = inputs.preseasonPoints[id];
        if (points != null) out.set(id, points);
      }
      return out;
    },
    seasonMarkets: async (playerIds) => {
      const out = new Map<string, { market: never; line: number | null; bookCount?: number }[]>();
      for (const id of playerIds) {
        const lines = inputs.seasonMarkets[id];
        if (lines) out.set(id, lines as never);
      }
      return out;
    },
    marketSnapshot: async () => inputs.marketSnapshot,
    /*
     * Present only when the capture recorded that the live source had it.
     *
     * Assigned below rather than here, because an optional member that always
     * exists is not optional — and a board that could not read manager history
     * would replay as one that read it and found nothing, which is a different
     * board with the same shape.
     */
    repairStatus: async () => inputs.repairStatus,
    injuryStates: async (list) => {
      const out = new Map<string, InjuryState>();
      for (const entry of list) {
        const state = inputs.injuryStates[entry.playerId];
        if (state) out.set(entry.playerId, state as InjuryState);
      }
      return out;
    },
    now: () => new Date(fixedClock),
    /*
     * `managerTendencies` is deliberately absent.
     *
     * The interface declares it optional, and a source that does not implement
     * it produces a different board from one that implements it and returns
     * nothing: the first cannot have a manager prior, the second could have had
     * one and did not. `replayDraftSnapshot` attaches it only where the capture
     * recorded that the live source had it.
     */
  };
}

/**
 * Rebuild a `CanonicalPlayer` from the seven fields a snapshot keeps.
 *
 * The absent fields are the ones no path from a draft request to a ranked board
 * touches — aliases, external ids, height, weight, age, experience. They are
 * filled with the honest empty value rather than a plausible one, so a
 * component that started reading `age` tomorrow would replay as "Sleeper did
 * not say" rather than as a made-up number, and the replay comparison would
 * fail loudly instead of quietly agreeing with itself.
 *
 * `normalizedName` is derived with the app's own normaliser rather than stored,
 * because it is a pure function of the name and storing it would be a second
 * copy that could disagree with the first.
 */
function rehydratePlayer(player: SnapshotPlayer): CanonicalPlayer {
  const [firstName = '', ...rest] = player.name.split(' ');
  return {
    id: player.id,
    sleeperPlayerId: player.id,
    fullName: player.name,
    firstName,
    lastName: rest.join(' '),
    team: player.team,
    position: player.position,
    status: player.status,
    active: player.active,
    normalizedName: normalizeName(player.name),
    aliases: [],
    searchRank: player.searchRank,
    jerseyNumber: null,
    heightInches: null,
    weightPounds: null,
    age: null,
    yearsExp: null,
  };
}

/**
 * Rebuild the board and compare it with what was captured.
 *
 * Never throws for a difference — a replay that disagrees is a *result*, and
 * the whole point is to hand back which of the six named outcomes it was.
 * `SnapshotRejected` is still thrown by `readSnapshot`, because a file that
 * cannot be read has no board to compare.
 */
export async function replayDraftSnapshot(snapshot: SupportSnapshot<DraftBoardPayload>): Promise<ReplayReport> {
  const { request, inputs, output } = snapshot.decision;
  const sources = snapshotDraftBoardSources(snapshot);
  if (inputs.managerTendencies != null) {
    const byRoster = new Map<number, ManagerTendencies>(
      inputs.managerTendencies.map((entry) => [entry.rosterId, entry.tendencies as unknown as ManagerTendencies]),
    );
    sources.managerTendencies = async () => byRoster;
  }

  const board = await buildDraftBoard(sources, request.draftId, {
    limit: request.limit ?? undefined,
    position: request.position,
    queuedOnly: request.queuedOnly,
    /*
     * The seed the live board drew with, handed back.
     *
     * The draft id is hashed into that seed, and the snapshot replaces it with
     * an alias — because a Sleeper draft id is one public URL away from every
     * manager's username, which would undo every alias in the file. Without
     * this the replay would draw a different sample and disagree with the
     * captured board by a point of `Next%` on a handful of players, and there
     * would be no way to tell that apart from a regression.
     *
     * Absent in a snapshot written before the seed travelled, which replays as
     * it always did: the alias seeds it, and the difference shows up as an
     * honest `output_difference` rather than as a silent one.
     */
    ...(output.nextPickModel.seed === undefined ? {} : { nextPickSeed: output.nextPickModel.seed }),
  });

  const differences: ReplayDifference[] = [];
  const distillation: ReplayDifference[] = [];

  compareOrder(output.order, board.recommendations.map((r) => r.playerId), differences);
  compareComponentLabels(output.componentLabels, board, differences);
  /*
   * The seed is compared as well as supplied.
   *
   * It is what every survival percentage on the board was drawn from, so a
   * replay whose seed differs is not reproducing the board even if the numbers
   * happen to land in the same place. Checking it turns "the samples matched"
   * from a coincidence into a consequence.
   */
  exact('nextPickModel.seed', 'the Next% simulation', output.nextPickModel.seed, board.nextPickModel.seed, differences);
  compareRows(snapshot, board, differences);
  compareSets('warnings', snapshot.decision.warnings, board.warnings, differences);
  compareFreshness(snapshot, board, differences);
  comparePoolHealth(snapshot, board, differences, distillation);

  const engineMatches = snapshot.release.engineVersion === DRAFT_ENGINE_VERSION;
  const outcome = classify(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot, board),
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: DRAFT_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: { order: output.order.length, detailRows: output.detailRows },
    differences,
    distillation,
    board,
  };
}

// ------------------------------------------------------------- the contract

function compareOrder(captured: string[], replayed: string[], into: ReplayDifference[]): void {
  if (captured.length !== replayed.length) {
    into.push({ term: 'order', at: 'length', captured: captured.length, replayed: replayed.length });
  }
  const limit = Math.min(captured.length, replayed.length);
  for (let i = 0; i < limit; i++) {
    if (captured[i] !== replayed[i]) {
      into.push({ term: 'order', at: `rank ${i + 1}`, captured: captured[i], replayed: replayed[i] });
      /*
       * Ten is enough to see the shape of a reordering.
       *
       * A board that moved one player reports one line; a board whose whole
       * ordering shifted reports ten and then says so, rather than three
       * hundred lines that say the same thing once each.
       */
      if (into.filter((d) => d.term === 'order').length >= 10) {
        into.push({ term: 'order', at: 'further ranks', captured: 'not listed', replayed: 'not listed' });
        return;
      }
    }
  }
}

/**
 * The component vocabulary, compared once.
 *
 * `label` was hoisted out of every row for size, so this is where it is
 * checked. A renamed component is a real difference — the label is what the
 * expanded card prints — and hoisting it must not be a way for it to stop being
 * compared.
 */
function compareComponentLabels(
  captured: Record<string, string>,
  board: DraftBoardState,
  into: ReplayDifference[],
): void {
  const replayed: Record<string, string> = {};
  for (const rec of board.recommendations) {
    for (const component of rec.components) replayed[component.key] ??= component.label;
  }
  for (const [key, label] of Object.entries(captured)) {
    exact(`componentLabels.${key}`, 'legend', label, replayed[key], into);
  }
}

function compareRows(
  snapshot: SupportSnapshot<DraftBoardPayload>,
  board: DraftBoardState,
  into: ReplayDifference[],
): void {
  const replayedById = new Map(board.recommendations.map((rec) => [rec.playerId, rec]));

  for (const row of snapshot.decision.output.rows) {
    const rec = replayedById.get(row.playerId);
    if (!rec) {
      into.push({ term: 'rows', at: `${row.name} (${row.playerId})`, captured: 'ranked', replayed: 'absent' });
      continue;
    }
    const where = `${row.name} (${row.playerId})`;

    exact('total', where, row.total, rec.total, into);
    exact('score', where, row.score, rec.score, into);
    exact('adp', where, row.adp, rec.adp, into);
    exact('adpValue', where, row.adpValue, rec.adpValue, into);
    exact('survival', where, row.survivalProbability, rec.survivalProbability, into);
    exact('degraded', where, row.degraded, rec.degraded, into);
    exact('status', where, row.status, rec.status, into);
    exact('tierCliff', where, row.tierCliff.severity, rec.tierCliff.severity, into);
    exact('wait', where, row.wait.state, rec.wait.state, into);

    /*
     * The favourite, compared as its own term.
     *
     * It would be caught by the component sweep below, and it is called out
     * separately anyway: "the ♥ boost survived the round trip" is the claim the
     * first support case in this app's history turned on, and a term with its
     * own name is a term a person reading a failure will understand
     * immediately.
     */
    exact('myGuy.level', where, row.myGuy.level, rec.myGuy.level, into);
    exact('myGuy.score', where, row.myGuy.score, rec.myGuy.score, into);
    exact(
      'myGuy.contribution',
      where,
      row.myGuy.contribution,
      rec.components.find((c) => c.key === 'my_guy')?.contribution ?? 0,
      into,
    );

    const replayedComponents = new Map(rec.components.map((c) => [c.key, c]));
    for (const component of row.components) {
      const found = replayedComponents.get(component.key);
      if (!found) {
        into.push({ term: 'components', at: `${where} · ${component.key}`, captured: 'present', replayed: 'absent' });
        continue;
      }
      exact(`component.${component.key}.score`, where, component.score, found.score, into);
      exact(`component.${component.key}.weight`, where, component.weight, found.weight, into);
      exact(`component.${component.key}.contribution`, where, component.contribution, found.contribution, into);
      exact(`component.${component.key}.unknown`, where, component.unknown, found.unknown, into);
      exact(`component.${component.key}.display`, where, component.display, found.display, into);
    }

    compareSets(`reasons · ${where}`, row.reasons, rec.reasons, into);
    compareSets(`counterpoints · ${where}`, row.counterpoints, rec.counterpoints, into);
  }
}

/**
 * Sentences, compared as sets rather than as an ordered list.
 *
 * "Semantically" in the reproduction contract means this and no more: the same
 * sentences, whatever order they were assembled in. It is not a fuzzy match —
 * a changed word is a difference — because a reason that reads differently is a
 * reason that argues differently, and a comparison that forgave it would hide
 * exactly the drift somebody replaying a snapshot is looking for.
 */
function compareSets(term: string, captured: string[], replayed: string[], into: ReplayDifference[]): void {
  const a = [...captured].sort();
  const b = [...replayed].sort();
  if (a.length === b.length && a.every((line, i) => line === b[i])) return;

  /*
   * The sorted lists, compared as sequences rather than as memberships.
   *
   * A `missing`/`added` diff over set membership alone would report *nothing*
   * for a card that said the same sentence twice where it used to say it once —
   * both sides contain it, so neither list is populated, and a real change to
   * the argument would pass as a match. Reporting the two lists is still the
   * useful output when they are non-empty, so both are said.
   */
  const missing = a.filter((line) => !b.includes(line));
  const added = b.filter((line) => !a.includes(line));
  into.push({
    term,
    at: 'set',
    captured: missing.length > 0 || added.length > 0 ? missing : a,
    replayed: missing.length > 0 || added.length > 0 ? added : b,
  });
}

function compareFreshness(
  snapshot: SupportSnapshot<DraftBoardPayload>,
  board: DraftBoardState,
  into: ReplayDifference[],
): void {
  const captured = snapshot.decision.freshness;
  exact('freshness.dog.available', 'dogState', captured.dog.available, board.dogState.available, into);
  exact('freshness.dog.state', 'dogState', captured.dog.freshness, board.dogState.freshness, into);
  exact('freshness.dog.ageHours', 'dogState', captured.dog.ageHours, board.dogState.ageHours, into);
  exact('freshness.dog.matched', 'dogState', captured.dog.matched, board.dogState.matched, into);
  exact('freshness.dog.reason', 'dogState', captured.dog.reason, board.dogState.reason, into);
  exact('freshness.marketFormat', 'marketFormat', captured.marketFormat.format, board.marketFormat.format, into);
  exact(
    'freshness.adpSnapshot',
    'adpSnapshot',
    captured.adpSnapshot?.id ?? null,
    board.adpSnapshot?.id ?? null,
    into,
  );
}

/**
 * Pool health, with the one number the distillation moves separated out.
 *
 * `activeEligible` counts every eligible player in the league; a snapshot keeps
 * the few hundred that can reach the answer. So a smaller number on replay is
 * the distillation working, and it is reported as such — with both values, so a
 * reader can see it rather than take it on trust. Every other field here counts
 * something the snapshot carries in full, and a difference in one of those is
 * real.
 */
function comparePoolHealth(
  snapshot: SupportSnapshot<DraftBoardPayload>,
  board: DraftBoardState,
  into: ReplayDifference[],
  distillation: ReplayDifference[],
): void {
  const captured = snapshot.decision.output.poolHealth;
  const replayed = board.poolHealth;

  if (captured.activeEligible !== replayed.activeEligible) {
    distillation.push({
      term: 'poolHealth.activeEligible',
      at: 'the snapshot keeps the players that can reach the answer, not the whole league',
      captured: captured.activeEligible,
      replayed: replayed.activeEligible,
    });
  }
  for (const key of ['scored', 'returned', 'withAdp', 'withoutAdp', 'deepestAdp', 'cap'] as const) {
    exact(`poolHealth.${key}`, 'poolHealth', captured[key], replayed[key], into);
  }
}

/**
 * Equal, with the one concession JSON forces and no others.
 *
 * `Object.is` rather than `===` so that two `NaN`s compare equal — a component
 * that could not be computed should replay as the same thing it captured — and
 * so that nothing is coerced. The single exception is **signed zero**.
 *
 * JSON has no `-0`: `JSON.stringify(-0)` is `"0"`, and there is no way to write
 * one. The engine does produce them — a component scoring exactly zero against
 * a negative weight rounds to `-0` — so a board captured with `-0` becomes `0`
 * in the file and replays as `-0` again, and `Object.is` calls that a
 * difference on every board with a zero-scoring component on it. It is an
 * artifact of the wire format and not a fact about the ranking: `-0` and `0`
 * are the same contribution, sort identically, and print the same everywhere a
 * reader can see.
 *
 * This is the *only* tolerance anywhere in the contract, and it is not a
 * numeric one — nothing here forgives a difference of any magnitude, however
 * small. See the module note.
 */
function exact(term: string, at: string, captured: unknown, replayed: unknown, into: ReplayDifference[]): void {
  if (Object.is(captured, replayed)) return;
  if (captured === 0 && replayed === 0) return;
  into.push({ term, at, captured, replayed });
}

// -------------------------------------------------------------- the verdict

/**
 * One of six words, chosen in a fixed order of precedence.
 *
 * A moved engine version explains a difference and is therefore reported ahead
 * of the difference itself — otherwise every replay after a legitimate weight
 * change reads `output_difference`, and a real regression becomes
 * indistinguishable from Tuesday's calibration commit.
 *
 * `freshness_difference` sits between the two for the same reason at a smaller
 * scale: a board whose *only* disagreements are about how old the market is has
 * a specific, checkable cause — a clock that did not get pinned — and calling
 * that an output difference sends the reader to the ranking code for a problem
 * that is not there.
 */
function classify(differences: ReplayDifference[], engineMatches: boolean): ReplayOutcome {
  if (differences.length === 0) return 'reproduced';
  if (!engineMatches) return 'engine_version_mismatch';
  if (differences.every((d) => d.term.startsWith('freshness.'))) return 'freshness_difference';
  return 'output_difference';
}

function summarise(
  outcome: ReplayOutcome,
  differences: ReplayDifference[],
  snapshot: SupportSnapshot<DraftBoardPayload>,
  board: DraftBoardState,
): string {
  const rows = snapshot.decision.output.order.length;
  switch (outcome) {
    case 'reproduced':
      return `Reproduced: ${rows} ranked players, in the same order, with identical components — from ${board.currentPick === snapshot.decision.context.draftState.currentPick ? 'the same' : 'a different'} pick ${snapshot.decision.context.draftState.currentPick}.`;
    case 'engine_version_mismatch':
      return `The engine has moved since capture (${snapshot.release.engineVersion} → ${DRAFT_ENGINE_VERSION}) and the board came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every ranking term matched; only the market's own age read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The board reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describe(differences[0]!)}.`;
  }
}

function describe(difference: ReplayDifference): string {
  return `${difference.term} at ${difference.at} — captured ${JSON.stringify(difference.captured)}, replayed ${JSON.stringify(difference.replayed)}`;
}
