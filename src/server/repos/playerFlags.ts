/**
 * "My Guy" — the user's own opinion about a player.
 *
 * Deliberately not evidence. The ledger records what newsletters said; this
 * records what the user wants, and the two are shown separately because a
 * player can easily be +8 in the ledger and unstarred, or unwritten-about and
 * ★★★. Folding one into the other would make both unreadable.
 */

import { MAX_BOUND_PARAMS, chunk, nowIso, type Database } from '../db.ts';
import { toMyGuyLevel, type MyGuyLevel } from '../../core/draft/decisions.ts';

export class PlayerFlagsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Set or clear the flag.
   *
   * Level 0 deletes the row rather than storing a zero, so the table holds only
   * decisions the user actually made and "unflagged" has exactly one
   * representation.
   */
  async set(playerId: string, level: MyGuyLevel): Promise<MyGuyLevel> {
    if (level <= 0) {
      await this.db.prepare('DELETE FROM player_flags WHERE player_id = ?').bind(playerId).run();
      return 0;
    }
    await this.db
      .prepare(
        `INSERT INTO player_flags (player_id, level, updated_at) VALUES (?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      )
      .bind(playerId, level, nowIso())
      .run();
    return level;
  }

  async get(playerId: string): Promise<MyGuyLevel> {
    const row = await this.db
      .prepare('SELECT level FROM player_flags WHERE player_id = ?')
      .bind(playerId)
      .first<{ level: number }>();
    return toMyGuyLevel(row?.level);
  }

  /** Every flag the user has set. Small by nature — this is a shortlist. */
  async all(): Promise<Map<string, MyGuyLevel>> {
    const rows = await this.db
      .prepare('SELECT player_id, level FROM player_flags ORDER BY level DESC, player_id')
      .all<{ player_id: string; level: number }>();
    return new Map(rows.results.map((r) => [String(r.player_id), toMyGuyLevel(r.level)]));
  }

  /** Flags for a known set of players, chunked to stay inside D1's bound-parameter cap. */
  async forPlayers(playerIds: string[]): Promise<Map<string, MyGuyLevel>> {
    const unique = [...new Set(playerIds)].filter(Boolean);
    const out = new Map<string, MyGuyLevel>();
    if (unique.length === 0) return out;
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT player_id, level FROM player_flags WHERE player_id IN (${placeholders})`)
        .bind(...batch)
        .all<{ player_id: string; level: number }>();
      for (const r of rows.results) out.set(String(r.player_id), toMyGuyLevel(r.level));
    }
    return out;
  }
}
