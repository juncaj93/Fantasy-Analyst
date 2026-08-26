/**
 * Capturing a Draft board: what it read, what it concluded, and nothing else.
 *
 * The whole design rests on one property of `boardBuilder.ts` — it is handed
 * its facts rather than fetching them. Everything it knows arrives through
 * `DraftBoardSources`, an interface with no writes on it. So a capture is not
 * an inventory somebody maintains by hand; it is a *recording proxy* around
 * that interface, and the board itself decides what goes in the file by asking
 * for it.
 *
 * That matters more than it sounds. The obvious way to build this is a function
 * that reaches into repositories and copies out "the inputs", which is a list
 * that is correct on the day it is written and wrong the first time a component
 * starts reading something new. Here, a source method the board calls is a
 * source method the snapshot has, and a member added to `DraftBoardSources`
 * fails to compile in two files until both have been taught about it.
 *
 * ## Production safety
 *
 * Capture is a read. `DraftBoardSources` has no write on it, so that is a
 * property of the type rather than a promise — the same argument Demo Mode
 * rests on. It also triggers no refresh: it builds a board from the state the
 * app already has, because a diagnostic that goes and fetches fresher data is a
 * diagnostic that changes the thing being diagnosed.
 *
 * ## The one distillation, and why it is bounded rather than complete
 *
 * `players.listAll()` is the Sleeper dictionary: around 2,500 rows, of which
 * the board scores at most 300. Copying all of it would produce a file nobody
 * can paste anywhere and would be the "entire player dictionary" the snapshot
 * principles rule out. So the capture keeps the players who can reach the
 * answer, which is a knowable set:
 *
 *   - **scored** — the exact candidate list, observed rather than guessed: the
 *     board hands it to three different sources, so the recorder sees it;
 *   - **simulated** — the pool the next-pick model drafts from, rebuilt with
 *     `simulationEligible` and `byMarketThenSearch`, the same two exported
 *     helpers the board itself cuts that pool with;
 *   - **priced** — everybody either market has an ADP for, because the
 *     simulator's picture of the market counts them and the "no draft order"
 *     warning is a count of them;
 *   - **drafted** — everybody already off the board, so a pick resolves to a
 *     name rather than to the fallback in its raw payload.
 *
 * What is dropped is counted in `playerCensus` rather than forgotten, and the
 * one board-level number the drop moves — `poolHealth.activeEligible` — is
 * recorded there so the replay can report it as distillation instead of drift.
 */

import {
  MAX_CANDIDATES,
  buildDraftBoard,
  byMarketThenSearch,
  simulationEligible,
  type BoardAdpSnapshot,
  type BoardAdpValue,
  type DraftBoardSources,
  type DraftBoardState,
} from '../draft/boardBuilder.ts';
import { DRAFT_ENGINE_VERSION } from '../draft/version.ts';
import { buildRosterShape, startablePositions } from '../sleeper/scoring.ts';
import { scoringKey, type ProjectionScoring } from '../startWho/scoring.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import { SnapshotAliases, REDACTION_RULES, findRedactionViolations } from './redaction.ts';
import {
  SUPPORT_SNAPSHOT_SCHEMA,
  type DraftBoardInputs,
  type DraftBoardOutput,
  type DraftBoardPayload,
  type SnapshotPick,
  type SnapshotPlayer,
  type SnapshotRecommendation,
  type SnapshotRoster,
  type SupportSnapshot,
} from './schema.ts';

/**
 * How much of the top of the board carries its full argument.
 *
 * A recommendation with every component, weight, contribution and sentence is
 * about three kilobytes, so this number is the file size. Twenty-four is two
 * rounds of a twelve-team draft: the window a disputed recommendation actually
 * lives in, and small enough that the whole snapshot stays inside what a person
 * can paste into a chat window.
 *
 * It is not the whole of the detail set. Every ranked player the reader has
 * marked is included as well, wherever he finished — see `selectDetailRows`.
 * And the *ordering* is complete regardless, at any depth, so "the board came
 * out in a different order" is always detectable even for a player whose
 * argument is not in the file.
 */
export const SNAPSHOT_DETAIL_ROWS = 24;

/**
 * The board limit a capture asks for.
 *
 * Above `MAX_CANDIDATES`, so the ordering recorded is the whole scored board
 * rather than the slice the phone happened to be showing. The screen's own
 * limit is a rendering decision and has no business narrowing a diagnosis.
 */
export const SNAPSHOT_BOARD_LIMIT = MAX_CANDIDATES;

export interface CaptureOptions {
  draftId: string;
  /** The deployed revision, from the same plumbing `/api/health` reports. */
  gitSha: string;
  position?: string | null;
  queuedOnly?: boolean;
  /** Override for tests and for a support conversation that needs more depth. */
  detailRows?: number;
}

/** Raised when a capture would have emitted something it must not. */
export class SnapshotRedactionError extends Error {
  /*
   * A plain field rather than a constructor parameter property.
   *
   * Parameter properties are a TypeScript *transform*, not a type annotation,
   * and Node's `--experimental-strip-types` refuses them. The replay CLI runs
   * the shipped modules through exactly that loader — see
   * `scripts/support-fixture.ts` — so anything on this path stays inside what
   * type-stripping alone can erase.
   */
  readonly violations: { path: string; reason: string }[];

  constructor(violations: { path: string; reason: string }[]) {
    super(
      `refusing to emit a support snapshot: ${violations.length} field${violations.length === 1 ? '' : 's'} must not be in one — ` +
        violations.map((v) => `${v.path} (${v.reason})`).join('; '),
    );
    this.name = 'SnapshotRedactionError';
    this.violations = violations;
  }
}

/**
 * Capture a Draft board.
 *
 * Builds the board once, through a recorder, and turns what the recorder saw
 * into a snapshot. Throws `SnapshotRedactionError` rather than emitting a file
 * that carries something it should not — a partially redacted snapshot is worse
 * than none, because it looks safe.
 */
export async function captureDraftSnapshot(
  sources: DraftBoardSources,
  options: CaptureOptions,
): Promise<SupportSnapshot<DraftBoardPayload>> {
  const recorder = recordDraftBoardSources(sources);
  const request = {
    draftId: options.draftId,
    limit: SNAPSHOT_BOARD_LIMIT,
    position: options.position ?? null,
    queuedOnly: options.queuedOnly === true,
  };

  const board = await buildDraftBoard(recorder.sources, request.draftId, {
    limit: request.limit,
    position: request.position,
    queuedOnly: request.queuedOnly,
  });

  const seen = recorder.seen();
  const aliases = new SnapshotAliases();
  const inputs = distilInputs(seen, board, aliases);
  /*
   * The request names the aliased draft, because that is the draft in the file.
   *
   * Replay looks the draft up by the id in `request`, so leaving the real one
   * here would both leak it and fail to find anything.
   */
  const aliasedRequest = { ...request, draftId: inputs.draft.id };
  const detailRows = Math.max(0, options.detailRows ?? SNAPSHOT_DETAIL_ROWS);

  const snapshot: SupportSnapshot<DraftBoardPayload> = {
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt: inputs.now,
    release: {
      gitSha: options.gitSha,
      surface: 'draft-board',
      engineVersion: DRAFT_ENGINE_VERSION,
    },
    redaction: {
      replaced: {
        'manager id': aliases.counts.ids,
        'manager name': aliases.counts.names,
        'league or draft id': aliases.counts.scopes,
        'raw sleeper pick payload': seen.picks.length,
      },
      rules: [...REDACTION_RULES],
    },
    decision: {
      kind: 'draft-board',
      request: aliasedRequest,
      context: contextOf(board, seen),
      freshness: {
        dog: board.dogState,
        marketSource: board.marketSource,
        adpSnapshot: board.adpSnapshot,
        marketFormat: board.marketFormat,
      },
      inputs,
      output: outputOf(board, detailRows),
      warnings: board.warnings,
    },
  };

  const violations = findRedactionViolations(snapshot);
  if (violations.length > 0) throw new SnapshotRedactionError(violations);
  return snapshot;
}

// ------------------------------------------------------------- the recorder

/** Everything the board asked its sources for, in the shapes they answered in. */
export interface RecordedReads {
  now: Date | null;
  draft: (Awaited<ReturnType<DraftBoardSources['leagues']['getDraft']>>) | null;
  league: (Awaited<ReturnType<DraftBoardSources['leagues']['getLeague']>>) | null;
  rosters: Awaited<ReturnType<DraftBoardSources['leagues']['listRosters']>>;
  picks: Awaited<ReturnType<DraftBoardSources['leagues']['listPicks']>>;
  players: CanonicalPlayer[];
  adpSnapshots: Map<number, BoardAdpSnapshot>;
  platformSnapshotId: number | null;
  underdogSnapshotId: number | null;
  adpValues: Map<number, Map<string, BoardAdpValue>>;
  /** The exact list the board scored — observed, not reconstructed. */
  candidateIds: string[];
  signals: Map<string, unknown>;
  flags: Map<string, { level: 0 | 1 | 2 | 3; queued: boolean; queueOrder: number | null }>;
  seasonMarkets: Map<string, { market: string; line: number | null; bookCount?: number }[]>;
  marketSnapshot: { provider: string; season: string; fetchedAt: string } | null;
  preseasonPoints: Map<string, number>;
  preseasonScoring: Record<string, unknown> | null;
  /** `null` when the source does not implement the optional member at all. */
  managerTendencies: Map<number, Record<string, unknown>> | null;
  repairStatus: { summary: { names: number; net: number; headline: string } } | null;
  injuryStates: Map<string, unknown>;
}

/**
 * Wrap sources so that using them records them.
 *
 * Every method delegates and then remembers. `now()` is remembered on first
 * call and re-served from that instant for the rest of the capture — the board
 * reads the clock more than once (the market's age, and `resolveDog`'s own
 * freshness pass) and a capture whose two readings straddled a millisecond
 * boundary would record one instant and have been built against two.
 */
export function recordDraftBoardSources(inner: DraftBoardSources): {
  sources: DraftBoardSources;
  seen(): RecordedReads;
} {
  const seen: RecordedReads = {
    now: null,
    draft: null,
    league: null,
    rosters: [],
    picks: [],
    players: [],
    adpSnapshots: new Map(),
    platformSnapshotId: null,
    underdogSnapshotId: null,
    adpValues: new Map(),
    candidateIds: [],
    signals: new Map(),
    flags: new Map(),
    seasonMarkets: new Map(),
    marketSnapshot: null,
    preseasonPoints: new Map(),
    preseasonScoring: null,
    managerTendencies: null,
    repairStatus: null,
    injuryStates: new Map(),
  };

  const noteSnapshot = (snapshot: BoardAdpSnapshot | null): BoardAdpSnapshot | null => {
    if (snapshot) seen.adpSnapshots.set(snapshot.id, snapshot);
    return snapshot;
  };

  const sources: DraftBoardSources = {
    leagues: {
      getDraft: async (id) => (seen.draft = await inner.leagues.getDraft(id)),
      getLeague: async (id) => (seen.league = await inner.leagues.getLeague(id)),
      listRosters: async (leagueId) => (seen.rosters = await inner.leagues.listRosters(leagueId)),
      listPicks: async (draftId) => (seen.picks = await inner.leagues.listPicks(draftId)),
    },
    players: {
      listAll: async () => (seen.players = await inner.players.listAll()),
    },
    adp: {
      get: async (id) => noteSnapshot(await inner.adp.get(id)),
      latestPlatformSnapshot: async () => {
        const snapshot = noteSnapshot(await inner.adp.latestPlatformSnapshot());
        seen.platformSnapshotId = snapshot?.id ?? null;
        return snapshot;
      },
      latestForSource: async (source) => {
        const snapshot = noteSnapshot(await inner.adp.latestForSource(source));
        seen.underdogSnapshotId = snapshot?.id ?? null;
        return snapshot;
      },
      valuesByPlayer: async (snapshotId) => {
        const values = await inner.adp.valuesByPlayer(snapshotId);
        seen.adpValues.set(snapshotId, values);
        return values;
      },
    },
    evidence: {
      getSignals: async (playerIds) => {
        /*
         * The one call that reveals the scored pool.
         *
         * `candidateIds` is what the board decided to rank, after every filter
         * and after the cap, and it is handed to this method verbatim. Reading
         * it here is what lets the distillation keep exactly the right players
         * without a second copy of the pool logic living in this file.
         */
        seen.candidateIds = [...playerIds];
        const signals = await inner.evidence.getSignals(playerIds);
        seen.signals = signals as unknown as Map<string, unknown>;
        return signals;
      },
    },
    flags: async (draftId) => {
      const flags = await inner.flags(draftId);
      seen.flags = flags;
      return flags;
    },
    preseasonPoints: async (playerIds, scoring) => {
      seen.preseasonScoring = scoring as unknown as Record<string, unknown>;
      const points = await inner.preseasonPoints(playerIds, scoring);
      seen.preseasonPoints = points;
      return points;
    },
    seasonMarkets: async (playerIds) => {
      const lines = await inner.seasonMarkets(playerIds);
      seen.seasonMarkets = lines as unknown as RecordedReads['seasonMarkets'];
      return lines;
    },
    marketSnapshot: async () => (seen.marketSnapshot = await inner.marketSnapshot()),
    repairStatus: async () => (seen.repairStatus = await inner.repairStatus()),
    injuryStates: async (list) => {
      const states = await inner.injuryStates(list);
      seen.injuryStates = states as unknown as Map<string, unknown>;
      return states;
    },
    /*
     * One instant, read once.
     *
     * The recorder pins it rather than passing the call through, because the
     * snapshot writes down a single `capturedAt` and the replay pins to that
     * one value. A capture whose second reading of the clock differed from its
     * first would be recording a board that never existed.
     */
    now: () => (seen.now ??= inner.now()),
  };

  /*
   * The optional member, forwarded only where the real source has one.
   *
   * `managerTendencies` absent and `managerTendencies` returning nothing are
   * different boards — the first cannot have a manager prior and the second
   * could have had one and did not — so the snapshot has to be able to say
   * which, and that starts with not inventing the method.
   */
  if (inner.managerTendencies) {
    sources.managerTendencies = async (leagueId) => {
      const tendencies = await inner.managerTendencies!(leagueId);
      seen.managerTendencies = tendencies as unknown as Map<number, Record<string, unknown>>;
      return tendencies;
    };
  }

  return { sources, seen: () => seen };
}

// ----------------------------------------------------------- distillation

function distilInputs(seen: RecordedReads, board: DraftBoardState, aliases: SnapshotAliases): DraftBoardInputs {
  const draft = seen.draft;
  const league = seen.league;
  if (!draft || !league) throw new Error('cannot capture a snapshot: the board built without a draft or a league');

  /*
   * Aliases are allocated in one deterministic pass before anything is written.
   *
   * Roster order first, because that is the order a reader sees managers in and
   * it makes `manager-3` mean the same person across two captures of the same
   * league. Picks then contribute anyone the roster list somehow missed.
   */
  for (const roster of seen.rosters) aliases.id(roster.ownerId);
  for (const pick of seen.picks) aliases.id(pick.pickedBy);
  for (const roster of seen.rosters) aliases.name(roster.ownerName, roster.ownerId);
  /*
   * And the two ids that are identities in disguise.
   *
   * `league.id` is the Sleeper league id, and one public URL turns it back into
   * every manager's username — which would undo every alias allocated above.
   * See the note on `SnapshotAliases`.
   */
  const leagueAlias = aliases.scope('league', league.id)!;
  const draftAlias = aliases.scope('draft', draft.id)!;

  const platformValues = seen.platformSnapshotId == null ? null : seen.adpValues.get(seen.platformSnapshotId) ?? null;
  const dogValues = seen.underdogSnapshotId == null ? null : seen.adpValues.get(seen.underdogSnapshotId) ?? null;
  const kept = selectPlayers(seen, board, platformValues, dogValues);

  const keptIds = new Set(kept.players.map((p) => p.id));
  const values = [...seen.adpValues.entries()].map(([snapshotId, byPlayer]) => ({
    snapshotId,
    byPlayer: pickEntries(byPlayer, (id) => keptIds.has(id)),
  }));

  return {
    now: (seen.now ?? new Date(0)).toISOString(),
    draft: {
      id: draftAlias,
      leagueId: leagueAlias,
      status: draft.status,
      type: draft.type,
      season: draft.season,
      rounds: draft.rounds,
      teams: draft.teams,
      slotToRosterId: draft.slotToRosterId,
      settings: draft.settings,
      adpSnapshotId: draft.adpSnapshotId,
      // Set to the alias rather than dropped, so the rehydrated record is
      // structurally whole and says plainly that the real one is not here.
      sleeperDraftId: draftAlias,
      lastSyncedAt: draft.lastSyncedAt,
    },
    league: {
      id: leagueAlias,
      sleeperLeagueId: leagueAlias,
      /*
       * The name is the commissioner's own words and frequently somebody's
       * name in them. Nothing in the ranking reads it — the board only echoes
       * it back for a header — so there is nothing to weigh against removing
       * it, and the person who captured the file knows which league it is.
       */
      name: leagueAlias,
      season: league.season,
      totalRosters: league.totalRosters,
      scoringSettings: league.scoringSettings,
      rosterPositions: league.rosterPositions,
      leagueSettings: league.leagueSettings,
      draftId: league.draftId == null ? null : draftAlias,
      status: league.status ?? null,
      localTeams: league.localTeams ?? [],
      lastSyncedAt: league.lastSyncedAt,
    },
    rosters: seen.rosters.map(
      (roster): SnapshotRoster => ({
        leagueId: leagueAlias,
        rosterId: roster.rosterId,
        ownerId: aliases.id(roster.ownerId),
        ownerName: aliases.name(roster.ownerName, roster.ownerId),
        playerIds: roster.playerIds,
        starterIds: roster.starterIds,
        reserveIds: roster.reserveIds,
        isMine: roster.isMine,
        settings: roster.settings ?? null,
      }),
    ),
    picks: seen.picks.map(
      (pick): SnapshotPick => ({
        draftId: draftAlias,
        pickNo: pick.pickNo,
        round: pick.round,
        pickInRound: pick.pickInRound,
        draftSlot: pick.draftSlot,
        sleeperPlayerId: pick.sleeperPlayerId,
        playerId: pick.playerId,
        rosterId: pick.rosterId,
        pickedBy: aliases.id(pick.pickedBy),
        raw: reduceRawPick(pick.raw),
      }),
    ),
    players: kept.players,
    playerCensus: {
      listed: seen.players.length,
      captured: kept.players.length,
      activeEligible: board.poolHealth.activeEligible,
      keptBecause: kept.keptBecause,
    },
    adp: {
      snapshots: [...seen.adpSnapshots.values()].map((s) => ({ ...s })),
      platformSnapshotId: seen.platformSnapshotId,
      underdogSnapshotId: seen.underdogSnapshotId,
      values,
    },
    signals: mapToObject(seen.signals),
    flags: mapToObject(seen.flags),
    seasonMarkets: mapToObject(seen.seasonMarkets),
    marketSnapshot: seen.marketSnapshot,
    preseasonPoints: mapToObject(seen.preseasonPoints),
    preseasonScoring: seen.preseasonScoring,
    managerTendencies:
      seen.managerTendencies == null
        ? null
        : [...seen.managerTendencies.entries()].map(([rosterId, tendencies]) => ({
            rosterId,
            tendencies: aliasTendencies(tendencies, aliases),
          })),
    repairStatus: seen.repairStatus ?? { summary: { names: 0, net: 0, headline: '' } },
    injuryStates: mapToObject(seen.injuryStates),
  };
}

/**
 * Which players the file keeps, and the reason each one is in it.
 *
 * The four reasons are the four ways a player can reach the answer. They are
 * counted rather than merely applied, so a snapshot whose capture set has
 * quietly collapsed — no simulated players, say, because a filter changed
 * shape — says so in `playerCensus` instead of replaying a smaller board and
 * looking healthy doing it.
 */
function selectPlayers(
  seen: RecordedReads,
  board: DraftBoardState,
  platformValues: Map<string, BoardAdpValue> | null,
  dogValues: Map<string, BoardAdpValue> | null,
): { players: SnapshotPlayer[]; keptBecause: Record<string, number> } {
  const byId = new Map(seen.players.map((p) => [p.id, p]));
  const keep = new Map<string, string>();
  const mark = (id: string, why: string) => {
    if (!byId.has(id)) return;
    if (!keep.has(id)) keep.set(id, why);
  };

  for (const id of seen.candidateIds) mark(id, 'scored');
  for (const pick of board.boardPicks) mark(pick.playerId, 'drafted');

  const rankOf = (player: CanonicalPlayer): number | null => platformValues?.get(player.id)?.adp ?? null;
  for (const player of seen.players) {
    if (rankOf(player) != null || dogValues?.get(player.id)?.adp != null) mark(player.id, 'priced');
  }

  /*
   * The simulation pool, cut exactly as the board cuts it.
   *
   * Both halves are the board's own exported helpers rather than a copy: the
   * eligibility test and the comparator. A snapshot that reconstructed either
   * would be reproducing a different three hundred players the first time
   * somebody changed one of them, and the failure would be invisible — the
   * replay would still produce a plausible board.
   */
  const takenIds = new Set(seen.picks.map((p) => p.playerId).filter((id): id is string => !!id));
  const startable = startablePositions(buildRosterShape(seen.league?.rosterPositions ?? []));
  seen.players
    .filter((player) => simulationEligible(player, takenIds, startable))
    .sort(byMarketThenSearch(rankOf))
    .slice(0, MAX_CANDIDATES)
    .forEach((player) => mark(player.id, 'simulated'));

  const keptBecause: Record<string, number> = {};
  for (const why of keep.values()) keptBecause[why] = (keptBecause[why] ?? 0) + 1;

  /*
   * Emitted in the player table's own order, not in selection order.
   *
   * `listAll()` is stable, and preserving it means a capture of an unchanged
   * league produces a byte-identical file — which is what makes two snapshots
   * of the same draft diffable and a committed fixture stable in review.
   */
  const players = seen.players.filter((p) => keep.has(p.id)).map(toSnapshotPlayer);
  return { players, keptBecause };
}

function toSnapshotPlayer(player: CanonicalPlayer): SnapshotPlayer {
  return {
    id: player.id,
    name: player.fullName,
    position: player.position,
    team: player.team,
    active: player.active,
    status: player.status,
    searchRank: player.searchRank ?? null,
  };
}

/**
 * The raw Sleeper pick, cut down to what the board reads out of it.
 *
 * `pickMetadata` in `boardBuilder.ts` reads four strings and nothing else, and
 * it only reads them at all for a player the canonical table cannot resolve.
 * The rest of the blob carries `picked_by` and whatever else Sleeper felt like
 * sending, so it is dropped rather than aliased — there is no reason to reason
 * about the contents of a field nobody consumes.
 */
function reduceRawPick(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { metadata?: Record<string, unknown> };
    const meta = parsed?.metadata;
    if (!meta || typeof meta !== 'object') return '';
    const keep: Record<string, unknown> = {};
    for (const key of ['first_name', 'last_name', 'position', 'team']) {
      if (typeof meta[key] === 'string') keep[key] = meta[key];
    }
    return Object.keys(keep).length === 0 ? '' : JSON.stringify({ metadata: keep });
  } catch {
    return '';
  }
}

/**
 * Manager tendencies, with the user id and the display name aliased.
 *
 * The profile is keyed by roster and carries the Sleeper user it was built for,
 * which the board checks against the roster's current owner before trusting it
 * — so the alias has to be the *same* alias the roster got, or a replay would
 * silently drop every manager prior and produce a subtly different board with
 * no warning at all.
 */
function aliasTendencies(
  tendencies: Record<string, unknown>,
  aliases: SnapshotAliases,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tendencies };
  if (typeof out['userId'] === 'string') out['userId'] = aliases.id(out['userId'] as string);
  if (typeof out['displayName'] === 'string') {
    out['displayName'] = aliases.name(out['displayName'] as string, tendencies['userId'] as string | undefined);
  }
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value === 'string' && key !== 'userId' && key !== 'displayName') out[key] = aliases.scrub(value);
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = (value as string[]).map((v) => aliases.scrub(v));
    }
  }
  return out;
}

// ------------------------------------------------------------ context/output

function contextOf(board: DraftBoardState, seen: RecordedReads): DraftBoardPayload['context'] {
  const shape = buildRosterShape(seen.league?.rosterPositions ?? []);
  return {
    season: seen.draft?.season ?? seen.league?.season ?? '',
    /*
     * The scoring identity the projections were read under, taken from the
     * argument the board actually passed rather than recomputed here. A key
     * derived a second time is a key that can disagree with the one the
     * snapshot was built with, which is the whole failure this field exists
     * to make visible.
     */
    scoringKey: seen.preseasonScoring
      ? scoringKey(seen.preseasonScoring as unknown as ProjectionScoring)
      : 'unknown',
    scoringLabel: board.league.scoringLabel,
    rosterShape: {
      starters: shape.starters,
      flex: shape.flex,
      benchSlots: shape.benchSlots,
      totalStarters: shape.totalStarters,
      superflex: shape.superflex,
      positions: seen.league?.rosterPositions ?? [],
    },
    draftState: {
      status: board.status,
      type: board.type,
      teams: board.teams,
      rounds: board.rounds,
      round: board.round,
      currentPick: board.currentPick,
      picksMade: board.picksMade,
      mySlot: board.mySlot,
      waitHorizonPick: board.waitHorizonPick,
      onTheClock: board.onTheClock,
    },
    rosterCounts: board.rosterCounts,
  };
}

/**
 * Which ranked players carry their full argument into the file.
 *
 * The top of the board, plus everybody the reader has marked. The second half
 * is the one that matters: a support snapshot is usually taken *because* of a
 * specific player, and the player somebody is arguing about is very often the
 * one they hearted — who may be nowhere near the top, precisely because that is
 * the complaint. A bound that kept only the top of the board would drop his
 * components on exactly the reports this feature exists to answer.
 *
 * Returned in board order rather than in selection order, so the file reads
 * down the board and a reader can see where a marked player actually landed.
 */
function selectDetailRows(
  recommendations: DraftBoardState['recommendations'],
  topRows: number,
): { rows: DraftBoardState['recommendations']; topRows: number; marked: number } {
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(topRows, recommendations.length); i++) keep.add(i);
  const top = keep.size;

  recommendations.forEach((rec, i) => {
    if (rec.myGuy.level > 0 || rec.queued) keep.add(i);
  });

  const rows = recommendations.filter((_, i) => keep.has(i));
  return { rows, topRows: top, marked: keep.size - top };
}

function outputOf(board: DraftBoardState, detailRows: number): DraftBoardOutput {
  const { elapsedMs: _elapsed, cached: _cached, ...nextPickModel } = board.nextPickModel;
  const detail = selectDetailRows(board.recommendations, detailRows);
  const rankOf = new Map(board.recommendations.map((rec, i) => [rec.playerId, i]));
  const componentLabels: Record<string, string> = {};
  for (const rec of detail.rows) {
    for (const component of rec.components) componentLabels[component.key] ??= component.label;
  }

  return {
    order: board.recommendations.map((rec) => rec.playerId),
    detailRows: detail.rows.length,
    detailSelection: { topRows: detail.topRows, marked: detail.marked },
    rows: detail.rows.map((rec) => toSnapshotRecommendation(rec, rankOf.get(rec.playerId)!)),
    componentLabels,
    rosterAlerts: board.rosterAlerts.map((alert) => ({
      key: alert.key,
      severity: alert.severity,
      message: alert.message,
      positions: alert.positions,
    })),
    poolHealth: board.poolHealth,
    startablePositions: board.startablePositions,
    offersFlex: board.offersFlex,
    nextPickModel,
  };
}

function toSnapshotRecommendation(
  rec: DraftBoardState['recommendations'][number],
  index: number,
): SnapshotRecommendation {
  const myGuyComponent = rec.components.find((c) => c.key === 'my_guy') ?? null;
  return {
    rank: index + 1,
    playerId: rec.playerId,
    name: rec.name,
    position: rec.position,
    team: rec.team,
    adp: rec.adp,
    dogAdp: rec.dogAdp,
    adpValue: rec.adpValue,
    total: rec.total,
    score: rec.score,
    survivalProbability: rec.survivalProbability,
    degraded: rec.degraded,
    status: rec.status,
    queued: rec.queued,
    /*
     * The favourite, spelled out rather than left to be inferred from a total.
     *
     * `contribution` is the number that answers the question this whole lane
     * was opened for — did the boost reach the ranking — and it is the
     * component's own, so it cannot disagree with what the board actually
     * spent. Carried for every row, including the zeroes: "he is not flagged"
     * is the answer as often as "he is", and a field that only appeared when
     * non-zero would make the two indistinguishable from a missing capture.
     */
    myGuy: {
      level: rec.myGuy.level,
      label: rec.myGuy.label,
      marks: rec.myGuy.marks,
      score: rec.myGuy.score,
      contribution: myGuyComponent?.contribution ?? 0,
    },
    components: rec.components.map((c) => ({
      key: c.key,
      display: c.display,
      score: c.score,
      weight: c.weight,
      contribution: c.contribution,
      unknown: c.unknown,
    })),
    reasons: rec.reasons,
    counterpoints: rec.counterpoints,
    tierCliff: { severity: rec.tierCliff.severity, message: rec.tierCliff.message },
    wait: { state: rec.wait.state, survivalProbability: rec.wait.survivalProbability },
    newsLifetimeNet: rec.newsLifetimeNet,
    news30Net: rec.news30Net,
    news7Net: rec.news7Net,
  };
}

// ------------------------------------------------------------------ helpers

function mapToObject<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function pickEntries<V>(map: Map<string, V>, keep: (key: string) => boolean): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of [...map.keys()].sort((a, b) => a.localeCompare(b))) {
    if (keep(key)) out[key] = map.get(key)!;
  }
  return out;
}
