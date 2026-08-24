/**
 * The manager-history ledger: objective facts in, derived profiles out.
 *
 * Every write here is idempotent, and that is not a nicety — it is what makes
 * the backfill resumable. A batch that dies after writing a draft's picks and
 * before advancing its checkpoint re-writes the same picks on the next run and
 * changes nothing, because the primary key is the pick and not the attempt.
 *
 * The tables are described in `migrations/0031_manager_intelligence_ledger.sql`.
 * The short version: raw picks and the previous-league chain live in their own
 * tables, transactions reuse `league_transactions` from migration 0020, and
 * everything derived lives in `manager_intel_profiles` keyed by Sleeper user id
 * so a profile can be rebuilt from the ledger without a single request.
 */

import { chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';
import {
  LEDGER_VERSION,
  type LedgerDraft,
  type LedgerPick,
  type RosterIdentity,
} from '../../core/managers/ledger.ts';
import type { DatasetName } from '../../core/managers/backfillPlan.ts';

export interface StoredSeasonLink {
  leagueId: string;
  sleeperLeagueId: string;
  season: string;
  previousLeagueId: string | null;
  status: string | null;
  resolved: boolean;
  discoveredAt: string;
}

export interface StoredCheckpoint {
  leagueId: string;
  dataset: DatasetName;
  sleeperLeagueId: string;
  season: string;
  cursor: number | null;
  completed: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  requestsUsed: number;
  version: number;
}

export interface StoredDraft {
  draftId: string;
  leagueId: string;
  sleeperLeagueId: string;
  season: string;
  status: string;
  rounds: number | null;
  teams: number | null;
  picksIngested: number;
  complete: boolean;
  sourceHash: string | null;
  ingestedAt: string;
}

export interface StoredIntelProfile<T> {
  userId: string;
  displayName: string | null;
  sample: number;
  usable: boolean;
  seasons: string[];
  coverage: Record<string, unknown>;
  profile: T;
  version: number;
  derivedAt: string;
}

export type IntelProfileKind = 'draft' | 'trade' | 'transaction';
export type BaselineKind = 'transaction' | 'trade';

export class ManagerLedgerRepo {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------- the chain --

  /**
   * Record one season of the previous-league chain.
   *
   * `resolved` says the league itself was read, which is a different claim from
   * "we know a previous league exists": a season with a null
   * `previous_league_id` and `resolved = 1` is the end of the chain, and the
   * same row unresolved is a season nobody has looked at yet.
   */
  async saveSeasonLink(link: Omit<StoredSeasonLink, 'discoveredAt'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO manager_history_seasons (
           league_id, sleeper_league_id, season, previous_league_id, status, resolved, discovered_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(league_id, sleeper_league_id) DO UPDATE SET
           season = excluded.season,
           previous_league_id = excluded.previous_league_id,
           status = excluded.status,
           -- Resolution is a one-way door: a league that has been read stays read.
           resolved = MAX(manager_history_seasons.resolved, excluded.resolved)`,
      )
      .bind(
        link.leagueId,
        link.sleeperLeagueId,
        link.season,
        link.previousLeagueId,
        link.status,
        link.resolved ? 1 : 0,
        nowIso(),
      )
      .run();
  }

  async seasonLinks(leagueId: string): Promise<StoredSeasonLink[]> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_history_seasons WHERE league_id = ? ORDER BY season DESC')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      leagueId: String(r['league_id']),
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      previousLeagueId: (r['previous_league_id'] as string | null) ?? null,
      status: (r['status'] as string | null) ?? null,
      resolved: Number(r['resolved'] ?? 0) === 1,
      discoveredAt: String(r['discovered_at']),
    }));
  }

  // ---------------------------------------------------------- identity map --

  /**
   * Store one season's roster-to-user map.
   *
   * Keyed on the *Sleeper* league id rather than the app's, because that is
   * what makes the map season-local by construction: two seasons cannot
   * overwrite each other's roster 4, which is the exact failure this whole
   * subsystem exists to avoid.
   */
  async saveRosterIdentities(leagueId: string, identities: RosterIdentity[]): Promise<number> {
    if (identities.length === 0) return 0;
    const fetchedAt = nowIso();
    for (const batch of chunk(identities, 12)) {
      await this.db.batch(
        batch.map((identity) =>
          this.db
            .prepare(
              `INSERT INTO manager_history_rosters (
                 league_id, sleeper_league_id, season, roster_id, sleeper_user_id,
                 display_name, team_name, fetched_at
               ) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(sleeper_league_id, roster_id) DO UPDATE SET
                 season = excluded.season,
                 sleeper_user_id = excluded.sleeper_user_id,
                 display_name = excluded.display_name,
                 team_name = excluded.team_name,
                 fetched_at = excluded.fetched_at`,
            )
            .bind(
              leagueId,
              identity.sleeperLeagueId,
              identity.season,
              identity.rosterId,
              identity.userId,
              identity.displayName,
              identity.teamName,
              fetchedAt,
            ),
        ),
      );
    }
    return identities.length;
  }

  /** Every identity row for a league, across every season it has stored. */
  async rosterIdentities(leagueId: string): Promise<RosterIdentity[]> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_history_rosters WHERE league_id = ?')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      rosterId: Number(r['roster_id']),
      userId: (r['sleeper_user_id'] as string | null) ?? null,
      displayName: (r['display_name'] as string | null) ?? null,
      teamName: (r['team_name'] as string | null) ?? null,
    }));
  }

  /**
   * Roster id to user id, for one season.
   *
   * The lookup every derivation makes, built per season rather than pooled —
   * pooling it is the bug, not an optimisation.
   */
  static identityMapFor(identities: readonly RosterIdentity[], season: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const identity of identities) {
      if (identity.season === season && identity.userId) out.set(identity.rosterId, identity.userId);
    }
    return out;
  }

  // ---------------------------------------------------------- draft ledger --

  /**
   * Record that a draft exists, and what Sleeper currently says about it.
   *
   * Deliberately does not touch `picks_ingested` or `source_hash`. Re-reading
   * the index is how this app notices a live draft has finished, and it happens
   * on a season that may already have its picks stored — resetting the count to
   * zero there would make an ingested draft look pending for ever, which is a
   * loop rather than a stale number.
   */
  async saveDraftIndex(draft: LedgerDraft): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO manager_history_drafts (
           draft_id, league_id, sleeper_league_id, season, status, draft_type,
           rounds, teams, picks_ingested, complete, source_hash, ingested_at
         ) VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?)
         ON CONFLICT(draft_id) DO UPDATE SET
           status = excluded.status,
           rounds = excluded.rounds,
           teams = excluded.teams,
           -- A finished draft never reopens.
           complete = MAX(manager_history_drafts.complete, excluded.complete),
           ingested_at = excluded.ingested_at`,
      )
      .bind(
        draft.draftId,
        draft.leagueId,
        draft.sleeperLeagueId,
        draft.season,
        draft.status,
        draft.draftType,
        draft.rounds,
        draft.teams,
        draft.complete ? 1 : 0,
        nowIso(),
      )
      .run();
  }

  /** Mark a draft's picks stored, with the digest of what was stored. */
  async recordDraftPicks(draftId: string, picksIngested: number, sourceHash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE manager_history_drafts
            SET picks_ingested = ?, source_hash = ?, ingested_at = ?
          WHERE draft_id = ?`,
      )
      .bind(picksIngested, sourceHash, nowIso(), draftId)
      .run();
  }

  async drafts(leagueId: string): Promise<StoredDraft[]> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_history_drafts WHERE league_id = ? ORDER BY season DESC')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      draftId: String(r['draft_id']),
      leagueId: String(r['league_id']),
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      status: String(r['status']),
      rounds: r['rounds'] == null ? null : Number(r['rounds']),
      teams: r['teams'] == null ? null : Number(r['teams']),
      picksIngested: Number(r['picks_ingested'] ?? 0),
      complete: Number(r['complete'] ?? 0) === 1,
      sourceHash: (r['source_hash'] as string | null) ?? null,
      ingestedAt: String(r['ingested_at']),
    }));
  }

  /**
   * Store a draft's picks.
   *
   * Keyed on `(draft_id, pick_no)`, which is Sleeper's own identity for a pick
   * and is stable for ever once the draft is over. Re-ingesting the same draft
   * therefore writes the same rows a second time and produces the same table —
   * which is what "same draft twice, one event set" means in practice.
   */
  async savePicks(picks: LedgerPick[]): Promise<number> {
    if (picks.length === 0) return 0;
    const ingestedAt = nowIso();
    for (const batch of chunk(picks, 10)) {
      await this.db.batch(
        batch.map((pick) =>
          this.db
            .prepare(
              `INSERT INTO manager_draft_picks (
                 draft_id, pick_no, league_id, sleeper_league_id, season, round,
                 draft_slot, roster_id, sleeper_user_id, player_id, position,
                 years_exp, is_keeper, picked_at_ms, ingested_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(draft_id, pick_no) DO UPDATE SET
                 round = excluded.round,
                 draft_slot = excluded.draft_slot,
                 roster_id = excluded.roster_id,
                 sleeper_user_id = excluded.sleeper_user_id,
                 player_id = excluded.player_id,
                 position = excluded.position,
                 years_exp = excluded.years_exp,
                 is_keeper = excluded.is_keeper,
                 ingested_at = excluded.ingested_at`,
            )
            .bind(
              pick.draftId,
              pick.pickNo,
              pick.leagueId,
              pick.sleeperLeagueId,
              pick.season,
              pick.round,
              pick.draftSlot,
              pick.rosterId,
              pick.userId,
              pick.playerId,
              pick.position,
              pick.yearsExp,
              pick.isKeeper ? 1 : 0,
              pick.pickedAtMs,
              ingestedAt,
            ),
        ),
      );
    }
    return picks.length;
  }

  /** Every stored pick for a league, oldest season first. */
  async picks(leagueId: string): Promise<LedgerPick[]> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_draft_picks WHERE league_id = ? ORDER BY season ASC, pick_no ASC')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      draftId: String(r['draft_id']),
      pickNo: Number(r['pick_no']),
      leagueId: String(r['league_id']),
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      round: Number(r['round']),
      draftSlot: r['draft_slot'] == null ? null : Number(r['draft_slot']),
      rosterId: r['roster_id'] == null ? null : Number(r['roster_id']),
      userId: (r['sleeper_user_id'] as string | null) ?? null,
      playerId: (r['player_id'] as string | null) ?? null,
      position: (r['position'] as string | null) ?? null,
      yearsExp: r['years_exp'] == null ? null : Number(r['years_exp']),
      isKeeper: Number(r['is_keeper'] ?? 0) === 1,
      pickedAtMs: r['picked_at_ms'] == null ? null : Number(r['picked_at_ms']),
    }));
  }

  // ------------------------------------------------------------ checkpoints --

  async checkpoints(leagueId: string): Promise<StoredCheckpoint[]> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_history_checkpoints WHERE league_id = ?')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      leagueId: String(r['league_id']),
      dataset: String(r['dataset']) as DatasetName,
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      cursor: r['cursor'] == null ? null : Number(r['cursor']),
      completed: Number(r['completed'] ?? 0) === 1,
      lastSuccessAt: (r['last_success_at'] as string | null) ?? null,
      lastAttemptAt: (r['last_attempt_at'] as string | null) ?? null,
      lastError: (r['last_error'] as string | null) ?? null,
      requestsUsed: Number(r['requests_used'] ?? 0),
      version: Number(r['version'] ?? LEDGER_VERSION),
    }));
  }

  /**
   * Move a checkpoint forward after a unit succeeded.
   *
   * Called *after* the write it vouches for, never before. `requests_used`
   * accumulates rather than being replaced, so the number is a lifetime cost of
   * this dataset and not the cost of the last batch — the former is what says
   * whether a league is expensive, and the latter is already in the batch
   * report.
   */
  async recordSuccess(opts: {
    leagueId: string;
    dataset: DatasetName;
    sleeperLeagueId: string;
    season: string;
    cursor: number | null;
    completed: boolean;
    requestsUsed: number;
  }): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO manager_history_checkpoints (
           league_id, dataset, sleeper_league_id, season, cursor, completed,
           last_success_at, last_attempt_at, last_error, requests_used, version
         ) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)
         ON CONFLICT(league_id, dataset, sleeper_league_id) DO UPDATE SET
           season = excluded.season,
           cursor = excluded.cursor,
           -- Completion is a one-way door within a version. A dataset that has
           -- run out of work does not un-finish because a later batch looked
           -- again and found nothing.
           completed = MAX(manager_history_checkpoints.completed, excluded.completed),
           last_success_at = excluded.last_success_at,
           last_attempt_at = excluded.last_attempt_at,
           last_error = NULL,
           requests_used = manager_history_checkpoints.requests_used + excluded.requests_used,
           version = excluded.version`,
      )
      .bind(
        opts.leagueId,
        opts.dataset,
        opts.sleeperLeagueId,
        opts.season,
        opts.cursor,
        opts.completed ? 1 : 0,
        now,
        now,
        opts.requestsUsed,
        LEDGER_VERSION,
      )
      .run();
  }

  /**
   * Record that a unit was attempted and failed.
   *
   * Deliberately does not touch `cursor` or `completed`. One failed week must
   * not corrupt the weeks around it, and the way to guarantee that is for the
   * failure path to be unable to write the fields that say what is done.
   */
  async recordFailure(opts: {
    leagueId: string;
    dataset: DatasetName;
    sleeperLeagueId: string;
    season: string;
    error: string;
    requestsUsed: number;
  }): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO manager_history_checkpoints (
           league_id, dataset, sleeper_league_id, season, cursor, completed,
           last_success_at, last_attempt_at, last_error, requests_used, version
         ) VALUES (?,?,?,?,NULL,0,NULL,?,?,?,?)
         ON CONFLICT(league_id, dataset, sleeper_league_id) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at,
           last_error = excluded.last_error,
           requests_used = manager_history_checkpoints.requests_used + excluded.requests_used`,
      )
      .bind(
        opts.leagueId,
        opts.dataset,
        opts.sleeperLeagueId,
        opts.season,
        now,
        // Truncated: a stack trace in a status column helps nobody and a
        // 40KB error body would be stored on every failing tick.
        opts.error.slice(0, 500),
        opts.requestsUsed,
        LEDGER_VERSION,
      )
      .run();
  }

  // ------------------------------------------------------- derived profiles --

  async saveProfile(
    leagueId: string,
    kind: IntelProfileKind,
    profile: StoredIntelProfile<unknown>,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO manager_intel_profiles (
           league_id, sleeper_user_id, kind, display_name, sample, usable,
           seasons_json, coverage_json, profile_json, profile_version, derived_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(league_id, sleeper_user_id, kind) DO UPDATE SET
           display_name = excluded.display_name,
           sample = excluded.sample,
           usable = excluded.usable,
           seasons_json = excluded.seasons_json,
           coverage_json = excluded.coverage_json,
           profile_json = excluded.profile_json,
           profile_version = excluded.profile_version,
           derived_at = excluded.derived_at`,
      )
      .bind(
        leagueId,
        profile.userId,
        kind,
        profile.displayName,
        profile.sample,
        profile.usable ? 1 : 0,
        toJson(profile.seasons),
        toJson(profile.coverage),
        toJson(profile.profile),
        profile.version,
        nowIso(),
      )
      .run();
  }

  async profiles<T>(leagueId: string, kind: IntelProfileKind): Promise<Map<string, StoredIntelProfile<T>>> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_intel_profiles WHERE league_id = ? AND kind = ?')
      .bind(leagueId, kind)
      .all<Record<string, unknown>>();

    const out = new Map<string, StoredIntelProfile<T>>();
    for (const row of rows.results) {
      const userId = String(row['sleeper_user_id']);
      out.set(userId, {
        userId,
        displayName: (row['display_name'] as string | null) ?? null,
        sample: Number(row['sample'] ?? 0),
        usable: Number(row['usable'] ?? 0) === 1,
        seasons: parseJson<string[]>(row['seasons_json'], []),
        coverage: parseJson<Record<string, unknown>>(row['coverage_json'], {}),
        profile: parseJson<T>(row['profile_json'], {} as T),
        version: Number(row['profile_version'] ?? 1),
        derivedAt: String(row['derived_at']),
      });
    }
    return out;
  }

  /**
   * Remove profiles for users the ledger no longer describes.
   *
   * A manager who left the league keeps his row until a rebuild finds nothing
   * for him; this is what finally removes it. Written as "delete what the
   * rebuild did not just write" rather than "delete everything then insert", so
   * a rebuild that fails half way leaves the previous profiles standing instead
   * of emptying the table.
   */
  async pruneProfiles(leagueId: string, kind: IntelProfileKind, keepUserIds: readonly string[]): Promise<number> {
    const rows = await this.db
      .prepare('SELECT sleeper_user_id FROM manager_intel_profiles WHERE league_id = ? AND kind = ?')
      .bind(leagueId, kind)
      .all<{ sleeper_user_id: string }>();

    const keep = new Set(keepUserIds);
    const stale = rows.results.map((r) => r.sleeper_user_id).filter((id) => !keep.has(id));
    for (const batch of chunk(stale, 20)) {
      await this.db.batch(
        batch.map((userId) =>
          this.db
            .prepare('DELETE FROM manager_intel_profiles WHERE league_id = ? AND kind = ? AND sleeper_user_id = ?')
            .bind(leagueId, kind, userId),
        ),
      );
    }
    return stale.length;
  }

  async saveBaseline(
    leagueId: string,
    kind: BaselineKind,
    baseline: { sample: number; seasons: string[]; value: unknown; version?: number },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO league_intel_baselines (
           league_id, kind, sample, seasons_json, baseline_json, profile_version, derived_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(league_id, kind) DO UPDATE SET
           sample = excluded.sample,
           seasons_json = excluded.seasons_json,
           baseline_json = excluded.baseline_json,
           profile_version = excluded.profile_version,
           derived_at = excluded.derived_at`,
      )
      .bind(leagueId, kind, baseline.sample, toJson(baseline.seasons), toJson(baseline.value), baseline.version ?? 1, nowIso())
      .run();
  }

  async baseline<T>(leagueId: string, kind: BaselineKind): Promise<{ sample: number; seasons: string[]; value: T; derivedAt: string } | null> {
    const row = await this.db
      .prepare('SELECT * FROM league_intel_baselines WHERE league_id = ? AND kind = ?')
      .bind(leagueId, kind)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      sample: Number(row['sample'] ?? 0),
      seasons: parseJson<string[]>(row['seasons_json'], []),
      value: parseJson<T>(row['baseline_json'], {} as T),
      derivedAt: String(row['derived_at']),
    };
  }
}
