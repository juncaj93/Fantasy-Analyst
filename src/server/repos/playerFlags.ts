/**
 * My Guy: the user's own opinion of a player, kept apart from the evidence.
 *
 * ♥ / ♥♥ / ♥♥♥ on the players list, and it moves the ranking by a bounded
 * amount. It is a fact about a *player* — he is still your guy in next year's
 * league — so it is global, keyed by player id and by nothing else.
 *
 * **The ★ queue used to live here too, and that was the bug.** A queue is not
 * an opinion about a player; it is "remind me about him in this draft", which
 * stops meaning anything outside the draft it was written in. Keyed by player
 * id alone it was one global list shown by whichever draft was open, so a
 * finished best-ball shortlist turned up in the next league's draft. It has its
 * own table now, keyed by draft — see `draftQueue.ts` and migration 0028.
 *
 * Neither mark is evidence. The ledger records what newsletters said; this
 * records what the user thinks, and the two are shown separately because a
 * player can easily be +8 in the ledger and unrated.
 */

import { MAX_BOUND_PARAMS, chunk, nowIso, type Database } from '../db.ts';
import { toMyGuyLevel, type MyGuyLevel } from '../../core/draft/decisions.ts';

export interface PlayerFlag {
  level: MyGuyLevel;
}

const EMPTY: PlayerFlag = { level: 0 };

export class PlayerFlagsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Set or clear the My Guy level.
   *
   * A cleared flag is deleted rather than kept as a zero, so the table holds
   * only decisions the user actually made and "unflagged" has exactly one
   * representation.
   */
  async setLevel(playerId: string, level: MyGuyLevel): Promise<PlayerFlag> {
    return this.write(playerId, { level });
  }

  private async write(playerId: string, change: { level: MyGuyLevel }): Promise<PlayerFlag> {
    if (change.level <= 0) {
      await this.db.prepare('DELETE FROM player_flags WHERE player_id = ?').bind(playerId).run();
      return EMPTY;
    }

    /*
     * `queued` and `queue_order` are still columns on this table and are
     * deliberately never written. Migration 0028 emptied them and moved the
     * queue to `draft_queue`; the columns stay because dropping a column is the
     * one schema change D1 makes expensive, and a write that named them would
     * be the first step back towards a global queue.
     */
    await this.db
      .prepare(
        `INSERT INTO player_flags (player_id, level, updated_at) VALUES (?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET
           level = excluded.level,
           updated_at = excluded.updated_at`,
      )
      .bind(playerId, change.level, nowIso())
      .run();
    return { level: change.level };
  }

  async get(playerId: string): Promise<PlayerFlag> {
    const row = await this.db
      .prepare('SELECT level FROM player_flags WHERE player_id = ?')
      .bind(playerId)
      .first<{ level: number }>();
    return row ? toFlag(row) : EMPTY;
  }

  /** Every mark the user has set. Small by nature — this is a shortlist. */
  async all(): Promise<Map<string, PlayerFlag>> {
    const rows = await this.db
      .prepare('SELECT player_id, level FROM player_flags ORDER BY level DESC, player_id')
      .all<{ player_id: string; level: number }>();
    return new Map(rows.results.map((r) => [String(r.player_id), toFlag(r)]));
  }

  /** Marks for a known set of players, chunked to stay inside D1's bound-parameter cap. */
  async forPlayers(playerIds: string[]): Promise<Map<string, PlayerFlag>> {
    const unique = [...new Set(playerIds)].filter(Boolean);
    const out = new Map<string, PlayerFlag>();
    if (unique.length === 0) return out;
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT player_id, level FROM player_flags WHERE player_id IN (${placeholders})`)
        .bind(...batch)
        .all<{ player_id: string; level: number }>();
      for (const r of rows.results) out.set(String(r.player_id), toFlag(r));
    }
    return out;
  }
}

function toFlag(row: { level: number }): PlayerFlag {
  return { level: toMyGuyLevel(row.level) };
}
