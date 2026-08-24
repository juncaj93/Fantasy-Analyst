/**
 * The objective facts, normalised — and nothing derived from them.
 *
 * Everything in this file is a translation of something Sleeper published into
 * a shape this app stores. No judgement, no thresholds, no shrinkage: those
 * belong to the profile modules, which read the ledger and can be rewritten
 * without re-fetching a single request.
 *
 * That separation is the whole point of having a ledger. A tendency model that
 * reads Sleeper directly has to re-read four seasons of history every time
 * somebody changes a constant; one that reads a table recomputes in
 * milliseconds and costs nothing.
 *
 * ## Identity is resolved here, once
 *
 * Every fact Sleeper publishes about a manager is roster-shaped — `roster_id`
 * on a pick, `roster_ids` on a transaction — and a roster id means nothing
 * across a season boundary. So identity is resolved at ingest, against the
 * roster map of *the season the event happened in*, and the resolved Sleeper
 * user id is what gets stored. A resolution that fails stores null, and every
 * derivation skips a null rather than guessing.
 */

import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
  SleeperTransaction,
  SleeperUser,
} from '../sleeper/types.ts';

/** The ingest contract these rows were written under. See the migration. */
export const LEDGER_VERSION = 1;

/** One manager, in one season, as that season's roster table had him. */
export interface RosterIdentity {
  sleeperLeagueId: string;
  season: string;
  rosterId: number;
  /** Null for an orphaned roster. Never inferred from another season. */
  userId: string | null;
  displayName: string | null;
  teamName: string | null;
}

/** One historical draft, as a unit of ingest. */
export interface LedgerDraft {
  draftId: string;
  leagueId: string;
  sleeperLeagueId: string;
  season: string;
  status: string;
  draftType: string | null;
  rounds: number | null;
  teams: number | null;
  /** True only for a finished draft: the one-way door on re-fetching. */
  complete: boolean;
  startedAtMs: number | null;
}

/** One pick. The atom of every draft tendency. */
export interface LedgerPick {
  draftId: string;
  pickNo: number;
  leagueId: string;
  sleeperLeagueId: string;
  season: string;
  round: number;
  draftSlot: number | null;
  /** A label. See `manager_draft_picks` in the migration for why never an id. */
  rosterId: number | null;
  userId: string | null;
  playerId: string | null;
  position: string | null;
  yearsExp: number | null;
  isKeeper: boolean;
  pickedAtMs: number | null;
}

/**
 * A transaction, resolved to people.
 *
 * Derived from `league_transactions` rather than stored a second time: the raw
 * payload is already kept verbatim there, and duplicating it into a
 * user-shaped table would be two copies of one fact that can disagree. This is
 * the read-time projection of that row, and `toLedgerTransaction` is the only
 * place the projection happens.
 */
export interface LedgerTransaction {
  transactionId: string;
  season: string;
  week: number;
  /** 'waiver' | 'free_agent' | 'trade' | whatever Sleeper adds next. */
  type: string;
  /** 'complete' | 'failed' | 'pending'. */
  status: string;
  createdAtMs: number | null;
  /** Every roster that took part, resolved to users. Nulls are dropped. */
  userIds: string[];
  rosterIds: number[];
  /** The user who created it, when Sleeper says. Already a user id. */
  creatorUserId: string | null;
  /** user id -> players received. */
  addsByUser: Map<string, string[]>;
  /** user id -> players sent. */
  dropsByUser: Map<string, string[]>;
  /** The winning or losing FAAB bid on a waiver claim. Null elsewhere. */
  waiverBid: number | null;
  /** FAAB moved between rosters in a trade. Not a bid. */
  faabTraded: number;
  draftPicksMoved: number;
}

/**
 * Only finalised transactions describe a stable tendency.
 *
 * A pending claim has not happened yet and a failed one is an intention. Both
 * are stored — a failed waiver is the only supported window onto what somebody
 * else was willing to pay, and `core/faab/bids.ts` reads them for exactly that
 * — but a tendency built on intentions describes a manager who does not exist.
 */
export function isFinalised(status: string): boolean {
  return status === 'complete';
}

/** Resolve one season's rosters into the identity rows the ledger stores. */
export function toRosterIdentities(opts: {
  sleeperLeagueId: string;
  season: string;
  rosters: SleeperRoster[];
  users?: SleeperUser[];
}): RosterIdentity[] {
  const nameOf = new Map((opts.users ?? []).map((u) => [u.user_id, u]));
  return opts.rosters.map((roster) => {
    const user = roster.owner_id ? nameOf.get(roster.owner_id) : undefined;
    const metadata = (roster.settings ?? {}) as Record<string, unknown>;
    return {
      sleeperLeagueId: opts.sleeperLeagueId,
      season: opts.season,
      rosterId: roster.roster_id,
      userId: roster.owner_id ?? null,
      displayName: user?.display_name ?? user?.username ?? null,
      teamName: typeof metadata['team_name'] === 'string' ? metadata['team_name'] : null,
    };
  });
}

/**
 * A draft's own row.
 *
 * `complete` is read from Sleeper's status and nothing else. A `pre_draft` or
 * `drafting` draft carries an empty or partial pick list, and a partial draft
 * is worse evidence than no draft: it is every manager's *first* few picks with
 * none of the rest, which reads as a room that only ever takes running backs.
 */
export function toLedgerDraft(opts: {
  leagueId: string;
  sleeperLeagueId: string;
  draft: SleeperDraft;
}): LedgerDraft {
  const settings = (opts.draft.settings ?? {}) as Record<string, unknown>;
  return {
    draftId: opts.draft.draft_id,
    leagueId: opts.leagueId,
    sleeperLeagueId: opts.sleeperLeagueId,
    season: opts.draft.season,
    status: opts.draft.status,
    draftType: opts.draft.type ?? null,
    rounds: numberOrNull(settings['rounds']),
    teams: numberOrNull(settings['teams']),
    complete: opts.draft.status === 'complete',
    startedAtMs: typeof opts.draft.start_time === 'number' ? opts.draft.start_time : null,
  };
}

/**
 * A completed draft's picks, with identity resolved.
 *
 * `picked_by` is present on every historical pick this was verified against
 * (320 of them, two completed drafts) and is the preferred answer. The roster
 * map is the fallback, and it is *that season's* map — never carried across a
 * season boundary, for the reason the migration spells out.
 *
 * `positionOf` is injected because this module has no database. A pick whose
 * position cannot be resolved keeps a null rather than an invented one; the
 * tendency reader already drops picks with no position.
 */
export function toLedgerPicks(opts: {
  draft: LedgerDraft;
  picks: SleeperDraftPick[];
  /** That season's roster id -> user id. */
  userByRoster: Map<number, string>;
  positionOf?: (playerId: string) => string | null;
}): LedgerPick[] {
  return opts.picks.map((pick) => {
    const meta = (pick.metadata ?? {}) as Record<string, unknown>;
    const rosterId =
      typeof pick.roster_id === 'number'
        ? pick.roster_id
        : pick.roster_id != null && Number.isFinite(Number(pick.roster_id))
          ? Number(pick.roster_id)
          : null;

    return {
      draftId: opts.draft.draftId,
      pickNo: pick.pick_no,
      leagueId: opts.draft.leagueId,
      sleeperLeagueId: opts.draft.sleeperLeagueId,
      season: opts.draft.season,
      round: pick.round,
      draftSlot: typeof pick.draft_slot === 'number' ? pick.draft_slot : null,
      rosterId,
      userId: pick.picked_by ?? (rosterId != null ? (opts.userByRoster.get(rosterId) ?? null) : null),
      playerId: pick.player_id ?? null,
      position:
        typeof meta['position'] === 'string' && meta['position']
          ? meta['position']
          : pick.player_id
            ? (opts.positionOf?.(pick.player_id) ?? null)
            : null,
      yearsExp: numberOrNull(meta['years_exp']),
      /*
       * Sleeper marks a keeper on the pick's metadata, inconsistently and only
       * in leagues that use them. Anything other than an explicit truth is read
       * as "not a keeper", which is the direction that under-claims.
       */
      isKeeper: meta['is_keeper'] === true || meta['is_keeper'] === 'true',
      pickedAtMs: opts.draft.startedAtMs,
    };
  });
}

/**
 * Project one stored transaction into the user-shaped form profiles read.
 *
 * The mapping direction matters and is the reason this is a function rather
 * than a join. Sleeper gives roster ids; a profile needs users; and the map
 * between them is only valid inside one season. So the caller supplies the map
 * for the season the row belongs to, and a row whose season was never
 * identity-mapped comes back with empty `userIds` — visible as unattributable
 * rather than attributed to whoever holds the slot today.
 */
export function toLedgerTransaction(opts: {
  txn: SleeperTransaction;
  season: string;
  /** That season's roster id -> user id. */
  userByRoster: Map<number, string>;
}): LedgerTransaction {
  const { txn, userByRoster } = opts;
  const rosterIds = txn.roster_ids ?? [];

  const addsByUser = new Map<string, string[]>();
  const dropsByUser = new Map<string, string[]>();
  for (const [playerId, rosterId] of Object.entries(txn.adds ?? {})) {
    const userId = userByRoster.get(Number(rosterId));
    if (userId) push(addsByUser, userId, playerId);
  }
  for (const [playerId, rosterId] of Object.entries(txn.drops ?? {})) {
    const userId = userByRoster.get(Number(rosterId));
    if (userId) push(dropsByUser, userId, playerId);
  }

  const userIds: string[] = [];
  for (const rosterId of rosterIds) {
    const userId = userByRoster.get(rosterId);
    if (userId && !userIds.includes(userId)) userIds.push(userId);
  }

  return {
    transactionId: txn.transaction_id,
    season: opts.season,
    week: typeof txn.leg === 'number' ? txn.leg : 0,
    type: txn.type,
    status: txn.status,
    createdAtMs: typeof txn.created === 'number' ? txn.created : null,
    userIds,
    rosterIds: [...rosterIds],
    creatorUserId: txn.creator ?? null,
    addsByUser,
    dropsByUser,
    /*
     * A bid of zero is a real bid — the standard way to claim a player nobody
     * else wants — so only an absent field becomes null.
     */
    waiverBid: typeof txn.settings?.['waiver_bid'] === 'number' ? txn.settings['waiver_bid'] : null,
    faabTraded: (txn.waiver_budget ?? []).reduce((sum, m) => sum + (Number(m.amount) || 0), 0),
    draftPicksMoved: (txn.draft_picks ?? []).length,
  };
}

/**
 * A cheap digest of what a unit of ingest contained.
 *
 * FNV-1a over the fields that define the unit, rather than a cryptographic
 * hash: this is a "did anything change" marker for diagnostics and for spotting
 * a re-ingest that was a no-op, and nothing security-shaped depends on it. It
 * is deterministic, which is the only property that matters — the same picks in
 * the same order always produce the same string, so a stable hash across two
 * runs is evidence the second run wrote nothing new.
 */
export function sourceHash(parts: readonly (string | number | null | undefined)[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = part == null ? ' ' : String(part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The digest of a whole draft's picks, in pick order. */
export function draftSourceHash(picks: readonly LedgerPick[]): string {
  return sourceHash(
    [...picks]
      .sort((a, b) => a.pickNo - b.pickNo)
      .flatMap((p) => [p.pickNo, p.playerId, p.userId, p.rosterId, p.position]),
  );
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
