/** Player + alias persistence, and construction of the in-memory PlayerIndex. */

import { PlayerIndex } from '../../core/identity/index.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { MAX_BOUND_PARAMS, chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

interface PlayerRow {
  id: string;
  sleeper_player_id: string | null;
  full_name: string;
  first_name: string;
  last_name: string;
  team: string;
  position: string;
  status: string | null;
  active: number;
  normalized_name: string;
  aliases_json: string;
  external_ids_json: string;
  draft_rank: number | null;
}

function toPlayer(row: PlayerRow, extraAliases: string[] = []): CanonicalPlayer {
  return {
    id: row.id,
    sleeperPlayerId: row.sleeper_player_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    team: row.team,
    position: row.position,
    status: row.status,
    active: row.active === 1,
    normalizedName: row.normalized_name,
    aliases: [...parseJson<string[]>(row.aliases_json, []), ...extraAliases],
    externalIds: parseJson<Record<string, string>>(row.external_ids_json, {}),
    draftRank: row.draft_rank ?? null,
  };
}

export class PlayerRepo {
  constructor(private readonly db: Database) {}

  async count(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM players').first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** How many active players Sleeper gives a draft-order rank. */
  async countRanked(): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM players WHERE active = 1 AND draft_rank IS NOT NULL')
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async listAll(): Promise<CanonicalPlayer[]> {
    const [players, aliases] = await Promise.all([
      this.db.prepare('SELECT * FROM players').all<PlayerRow>(),
      this.db.prepare('SELECT player_id, alias FROM player_aliases').all<{ player_id: string; alias: string }>(),
    ]);
    const aliasesByPlayer = new Map<string, string[]>();
    for (const a of aliases.results) {
      const list = aliasesByPlayer.get(a.player_id);
      if (list) list.push(a.alias);
      else aliasesByPlayer.set(a.player_id, [a.alias]);
    }
    return players.results.map((r) => toPlayer(r, aliasesByPlayer.get(r.id) ?? []));
  }

  async buildIndex(): Promise<PlayerIndex> {
    return new PlayerIndex(await this.listAll());
  }

  async getById(id: string): Promise<CanonicalPlayer | null> {
    const row = await this.db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<PlayerRow>();
    return row ? toPlayer(row) : null;
  }

  /**
   * Fetch a known set of players in one query.
   *
   * A whole roster is 15-20 ids. Looking them up one at a time is 15-20 round
   * trips, and loading the full 3,300-row table to pick 15 out of it is worse.
   * Ids that do not exist are simply absent from the result.
   */
  async listByIds(ids: string[]): Promise<Map<string, CanonicalPlayer>> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const found = new Map<string, CanonicalPlayer>();
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM players WHERE id IN (${placeholders})`)
        .bind(...batch)
        .all<PlayerRow>();
      for (const r of rows.results) found.set(r.id, toPlayer(r));
    }
    return found;
  }

  /**
   * Upsert the Sleeper player dump.
   * Deterministic aliases are refreshed; user-supplied aliases in
   * `player_aliases` are untouched.
   */
  async upsertMany(players: CanonicalPlayer[]): Promise<{ written: number }> {
    const now = nowIso();
    let written = 0;
    for (const batch of chunk(players, 200)) {
      const statements = batch.map((p) =>
        this.db
          .prepare(
            `INSERT INTO players (
               id, sleeper_player_id, full_name, first_name, last_name, team, position,
               status, active, normalized_name, aliases_json, external_ids_json, draft_rank,
               created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               sleeper_player_id = excluded.sleeper_player_id,
               full_name         = excluded.full_name,
               first_name        = excluded.first_name,
               last_name         = excluded.last_name,
               team              = excluded.team,
               position          = excluded.position,
               status            = excluded.status,
               active            = excluded.active,
               normalized_name   = excluded.normalized_name,
               aliases_json      = excluded.aliases_json,
               external_ids_json = excluded.external_ids_json,
               draft_rank        = excluded.draft_rank,
               updated_at        = excluded.updated_at`,
          )
          .bind(
            p.id,
            p.sleeperPlayerId,
            p.fullName,
            p.firstName,
            p.lastName,
            p.team,
            p.position,
            p.status,
            p.active ? 1 : 0,
            p.normalizedName,
            toJson(p.aliases),
            toJson(p.externalIds ?? {}),
            p.draftRank ?? null,
            now,
            now,
          ),
      );
      await this.db.batch(statements);
      written += batch.length;
    }
    return { written };
  }

  /** Add a user- or source-supplied alias. Idempotent. */
  async addAlias(playerId: string, alias: string, normalizedAlias: string, source: string, confidence = 1): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO player_aliases (player_id, alias, normalized_alias, source, confidence, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(player_id, normalized_alias) DO UPDATE SET
           alias = excluded.alias, source = excluded.source, confidence = excluded.confidence`,
      )
      .bind(playerId, alias, normalizedAlias, source, confidence, nowIso())
      .run();
  }

  /**
   * The nicknames stored for a player.
   *
   * `getById` reports the deterministic ones derived from the name ("M. Vance");
   * these are the ones somebody actually taught the app, which is what the
   * nickname UI needs to show and be able to remove.
   */
  async listAliases(playerId: string): Promise<{ alias: string; normalized: string; source: string }[]> {
    const rows = await this.db
      .prepare('SELECT alias, normalized_alias, source FROM player_aliases WHERE player_id = ? ORDER BY alias')
      .bind(playerId)
      .all<{ alias: string; normalized_alias: string; source: string }>();
    return rows.results.map((r) => ({ alias: r.alias, normalized: r.normalized_alias, source: r.source }));
  }

  /**
   * Forget a nickname.
   *
   * Scoped to one player so removing a nickname cannot disturb another player
   * who legitimately uses the same normalized key.
   */
  async removeAlias(playerId: string, normalizedAlias: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM player_aliases WHERE player_id = ? AND normalized_alias = ?')
      .bind(playerId, normalizedAlias)
      .run();
  }

  /** Search by name fragment for the Players screen. */
  async search(query: string, limit = 40): Promise<CanonicalPlayer[]> {
    const like = `%${query.toLowerCase()}%`;
    const rows = await this.db
      .prepare(
        `SELECT * FROM players
          WHERE active = 1 AND (LOWER(full_name) LIKE ? OR normalized_name LIKE ?)
          ORDER BY LENGTH(full_name), full_name
          LIMIT ?`,
      )
      .bind(like, like, limit)
      .all<PlayerRow>();
    return rows.results.map((r) => toPlayer(r));
  }
}
