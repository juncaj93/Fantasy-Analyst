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
import type { PlayerSignal } from '../evidence/types.ts';
import type { InjuryState } from '../injury/model.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';
import { rehydratePlayer } from './players.ts';
import {
  classifyOutcome,
  compareSets,
  compareStructural,
  describeDifference,
  exact,
  expectKind,
  readSnapshot,
  SnapshotRejected,
  type ComparedCount,
  type ReplayDifference,
  type ReplayReport,
} from './contract.ts';
import {
  SUPPORT_SNAPSHOT_SCHEMA,
  type DraftBoardPayload,
  type ReplayOutcome,
  type SupportSnapshot,
} from './schema.ts';

/*
 * Re-exported so every existing caller keeps the import it has.
 *
 * `readSnapshot` and the outcome machinery became surface-independent when the
 * in-season lanes arrived and moved to `contract.ts`, which is where the
 * structural half of the reproduction contract is stated. Nothing about the
 * Draft contract below moved with them.
 */
export { readSnapshot, SnapshotRejected, compareStructural };
export type { ReplayDifference, ReplayReport, ComparedCount };

/**
 * What the Draft replay produced, for a caller that wants to look at it.
 *
 * The board itself, on top of the surface-independent report. It is megabytes
 * and is deliberately not part of what `--json` prints; everything that
 * describes the *verdict* is on `ReplayReport`.
 */
export interface DraftReplayReport extends ReplayReport {
  board: DraftBoardState | null;
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
 * A manager profile, with its `byPosition` Map put back.
 *
 * `JSON.stringify` turns a Map into `{}`, so the profile crosses the wire as a
 * plain object and has to become a Map again before `readManagerPrior` reads
 * it. Handing back the object instead would produce a board with every manager
 * prior neutralised — a different board, arrived at silently, in exactly the
 * leagues that have a history to be wrong about.
 */
function rehydrateTendencies(tendencies: Record<string, unknown>): ManagerTendencies {
  const byPosition = tendencies['byPosition'];
  return {
    ...(tendencies as unknown as ManagerTendencies),
    byPosition:
      byPosition instanceof Map
        ? byPosition
        : new Map(Object.entries((byPosition ?? {}) as Record<string, never>)),
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
export async function replayDraftSnapshot(value: SupportSnapshot): Promise<DraftReplayReport> {
  /*
   * Narrowed here rather than by the caller.
   *
   * `readSnapshot` reads any of the six kinds, so every adapter has to say which
   * one it is. Doing it inside means a caller that hands this a waiver plan gets
   * a `data_mismatch` naming both kinds, instead of a crash somewhere inside the
   * board builder.
   */
  const snapshot = expectKind(value, 'draft-board');
  const { request, inputs, output } = snapshot.decision;
  const sources = snapshotDraftBoardSources(snapshot);
  if (inputs.managerTendencies != null) {
    const byRoster = new Map<number, ManagerTendencies>(
      inputs.managerTendencies.map((entry) => [entry.rosterId, rehydrateTendencies(entry.tendencies)]),
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
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot, board),
    kind: 'draft-board',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: DRAFT_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    ...(snapshot.rehearsal ? { rehearsal: snapshot.rehearsal } : {}),
    compared: [
      { what: 'ranked players', count: output.order.length },
      { what: 'arguments in full', count: output.detailRows },
    ],
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
     * The four lines no component stands behind, and the model behind `Next%`.
     *
     * Compared explicitly because they are the only output of several sources:
     * lose the injury round trip and every score still matches while the
     * availability line under a player's name quietly disappears. See
     * `SnapshotRecommendation.injuryLine`.
     */
    exact('injuryLine', where, row.injuryLine, rec.injuryLine, into);
    exact('tierContext', where, row.tierContext, rec.tierContext, into);
    exact('marketHeadline', where, row.marketHeadline, rec.marketHeadline, into);
    exact('preseasonPoints', where, row.preseasonPoints, rec.preseasonPoints, into);

    if (row.nextPick == null || rec.nextPick == null) {
      exact('nextPick', where, row.nextPick == null, rec.nextPick == null, into);
    } else {
      exact('nextPick.probability', where, row.nextPick.probability, rec.nextPick.probability, into);
      exact('nextPick.marketBaseline', where, row.nextPick.marketBaseline, rec.nextPick.marketBaseline, into);
      exact('nextPick.historyBaseline', where, row.nextPick.historyBaseline, rec.nextPick.historyBaseline, into);
      exact('nextPick.historyAdjustment', where, row.nextPick.historyAdjustment, rec.nextPick.historyAdjustment, into);
      exact('nextPick.confidence', where, row.nextPick.confidence, rec.nextPick.confidence, into);
      compareSets(`nextPick.drivers · ${where}`, row.nextPick.drivers, rec.nextPick.drivers, into);
      compareSets(`nextPick.degraded · ${where}`, row.nextPick.degraded, rec.nextPick.degraded, into);
    }

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

// -------------------------------------------------------------- the verdict

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
      return `The board reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
