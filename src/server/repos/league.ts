/** League, roster, draft and pick persistence. */

import type {
  DraftPickRecord,
  DraftRecord,
  LeagueRecord,
  RosterRecord,
} from '../../core/sleeper/types.ts';
import { chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

export class LeagueRepo {
  constructor(private readonly db: Database) {}

  async upsertLeague(league: LeagueRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO leagues (
           id, sleeper_league_id, name, season, total_rosters, scoring_settings_json,
           roster_positions_json, league_settings_json, draft_id, is_selected, last_synced_at
         ) VALUES (?,?,?,?,?,?,?,?,?,COALESCE((SELECT is_selected FROM leagues WHERE id = ?), 0),?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           season = excluded.season,
           total_rosters = excluded.total_rosters,
           scoring_settings_json = excluded.scoring_settings_json,
           roster_positions_json = excluded.roster_positions_json,
           league_settings_json = excluded.league_settings_json,
           draft_id = excluded.draft_id,
           last_synced_at = excluded.last_synced_at`,
      )
      .bind(
        league.id,
        league.sleeperLeagueId,
        league.name,
        league.season,
        league.totalRosters,
        toJson(league.scoringSettings),
        toJson(league.rosterPositions),
        toJson(league.leagueSettings),
        league.draftId,
        league.id,
        league.lastSyncedAt,
      )
      .run();
  }

  async listLeagues(): Promise<(LeagueRecord & { isSelected: boolean })[]> {
    const rows = await this.db
      .prepare('SELECT * FROM leagues ORDER BY season DESC, name ASC')
      .all<Record<string, unknown>>();
    return rows.results.map(rowToLeague);
  }

  async getLeague(id: string): Promise<(LeagueRecord & { isSelected: boolean }) | null> {
    const row = await this.db.prepare('SELECT * FROM leagues WHERE id = ?').bind(id).first<Record<string, unknown>>();
    return row ? rowToLeague(row) : null;
  }

  async getSelectedLeague(): Promise<(LeagueRecord & { isSelected: boolean }) | null> {
    const row = await this.db
      .prepare('SELECT * FROM leagues WHERE is_selected = 1 LIMIT 1')
      .first<Record<string, unknown>>();
    return row ? rowToLeague(row) : null;
  }

  async selectLeague(id: string): Promise<void> {
    await this.db.prepare('UPDATE leagues SET is_selected = 0').run();
    await this.db.prepare('UPDATE leagues SET is_selected = 1 WHERE id = ?').bind(id).run();
  }

  async replaceRosters(leagueId: string, rosters: RosterRecord[]): Promise<void> {
    const now = nowIso();
    await this.db.prepare('DELETE FROM rosters WHERE league_id = ?').bind(leagueId).run();
    for (const batch of chunk(rosters, 50)) {
      await this.db.batch(
        batch.map((r) =>
          this.db
            .prepare(
              `INSERT INTO rosters (league_id, roster_id, owner_id, owner_name, players_json, starters_json, reserve_json, is_mine, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              leagueId,
              r.rosterId,
              r.ownerId,
              r.ownerName,
              toJson(r.playerIds),
              toJson(r.starterIds),
              toJson(r.reserveIds),
              r.isMine ? 1 : 0,
              now,
            ),
        ),
      );
    }
  }

  async listRosters(leagueId: string): Promise<RosterRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM rosters WHERE league_id = ? ORDER BY roster_id')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      leagueId: String(r['league_id']),
      rosterId: Number(r['roster_id']),
      ownerId: (r['owner_id'] as string | null) ?? null,
      ownerName: (r['owner_name'] as string | null) ?? null,
      playerIds: parseJson<string[]>(r['players_json'], []),
      starterIds: parseJson<string[]>(r['starters_json'], []),
      reserveIds: parseJson<string[]>(r['reserve_json'], []),
      isMine: Number(r['is_mine'] ?? 0) === 1,
    }));
  }

  async upsertDraft(draft: DraftRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO drafts (
           id, sleeper_draft_id, league_id, status, type, season, rounds, teams,
           slot_to_roster_json, settings_json, last_synced_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           type = excluded.type,
           rounds = excluded.rounds,
           teams = excluded.teams,
           slot_to_roster_json = excluded.slot_to_roster_json,
           settings_json = excluded.settings_json,
           last_synced_at = excluded.last_synced_at`,
      )
      .bind(
        draft.id,
        draft.sleeperDraftId,
        draft.leagueId,
        draft.status,
        draft.type,
        draft.season,
        draft.rounds,
        draft.teams,
        toJson(draft.slotToRosterId),
        toJson(draft.settings),
        draft.lastSyncedAt,
      )
      .run();
  }

  async getDraft(id: string): Promise<(DraftRecord & { adpSnapshotId: number | null }) | null> {
    const row = await this.db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      id: String(row['id']),
      sleeperDraftId: String(row['sleeper_draft_id']),
      leagueId: String(row['league_id']),
      status: String(row['status']),
      type: String(row['type']),
      season: String(row['season']),
      rounds: Number(row['rounds'] ?? 0),
      teams: Number(row['teams'] ?? 0),
      slotToRosterId: parseJson<Record<string, number>>(row['slot_to_roster_json'], {}),
      settings: parseJson<Record<string, unknown>>(row['settings_json'], {}),
      lastSyncedAt: String(row['last_synced_at'] ?? ''),
      adpSnapshotId: row['adp_snapshot_id'] == null ? null : Number(row['adp_snapshot_id']),
    };
  }

  async listDraftsForLeague(leagueId: string): Promise<DraftRecord[]> {
    const rows = await this.db
      .prepare('SELECT id FROM drafts WHERE league_id = ? ORDER BY season DESC')
      .bind(leagueId)
      .all<{ id: string }>();
    const out: DraftRecord[] = [];
    for (const r of rows.results) {
      const d = await this.getDraft(r.id);
      if (d) out.push(d);
    }
    return out;
  }

  /** Attach a frozen ADP snapshot to a draft. */
  async setDraftSnapshot(draftId: string, snapshotId: number | null): Promise<void> {
    await this.db.prepare('UPDATE drafts SET adp_snapshot_id = ? WHERE id = ?').bind(snapshotId, draftId).run();
  }

  /** Upsert picks. Sleeper picks are append-only, so conflicts are no-ops. */
  async upsertPicks(picks: DraftPickRecord[]): Promise<{ inserted: number }> {
    if (picks.length === 0) return { inserted: 0 };
    const now = nowIso();
    for (const batch of chunk(picks, 100)) {
      await this.db.batch(
        batch.map((p) =>
          this.db
            .prepare(
              `INSERT INTO draft_picks (draft_id, pick_no, round, pick_in_round, draft_slot, player_id, roster_id, picked_by, raw_json, picked_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(draft_id, pick_no) DO UPDATE SET
                 player_id = excluded.player_id,
                 roster_id = excluded.roster_id,
                 picked_by = excluded.picked_by,
                 raw_json = excluded.raw_json`,
            )
            .bind(
              p.draftId,
              p.pickNo,
              p.round,
              p.pickInRound,
              p.draftSlot,
              p.playerId,
              p.rosterId,
              p.pickedBy,
              p.raw,
              now,
            ),
        ),
      );
    }
    return { inserted: picks.length };
  }

  async listPicks(draftId: string): Promise<DraftPickRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_no')
      .bind(draftId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      draftId: String(r['draft_id']),
      pickNo: Number(r['pick_no']),
      round: Number(r['round']),
      pickInRound: Number(r['pick_in_round']),
      draftSlot: Number(r['draft_slot']),
      sleeperPlayerId: (r['player_id'] as string | null) ?? null,
      playerId: (r['player_id'] as string | null) ?? null,
      rosterId: r['roster_id'] == null ? null : Number(r['roster_id']),
      pickedBy: (r['picked_by'] as string | null) ?? null,
      raw: String(r['raw_json'] ?? '{}'),
    }));
  }
}

function rowToLeague(row: Record<string, unknown>): LeagueRecord & { isSelected: boolean } {
  return {
    id: String(row['id']),
    sleeperLeagueId: String(row['sleeper_league_id']),
    name: String(row['name']),
    season: String(row['season']),
    totalRosters: Number(row['total_rosters'] ?? 0),
    scoringSettings: parseJson<Record<string, number>>(row['scoring_settings_json'], {}),
    rosterPositions: parseJson<string[]>(row['roster_positions_json'], []),
    leagueSettings: parseJson<Record<string, unknown>>(row['league_settings_json'], {}),
    draftId: (row['draft_id'] as string | null) ?? null,
    lastSyncedAt: String(row['last_synced_at'] ?? ''),
    isSelected: Number(row['is_selected'] ?? 0) === 1,
  };
}
