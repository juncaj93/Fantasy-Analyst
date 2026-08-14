/**
 * Two separate marks the user can put on a player.
 *
 * **Queued** is a bookmark. During a draft the ★ is how you find the man you
 * meant to take, and the ★ filter is that list. It changes nothing about the
 * ranking, because "remind me about him" is not "he is better than the board
 * thinks".
 *
 * **My Guy** is an opinion — ♥ / ♥♥ / ♥♥♥ on the players list — and it does
 * move the ranking, by a bounded amount.
 *
 * Neither is evidence. The ledger records what newsletters said; these record
 * what the user wants, and the three are shown separately because a player can
 * easily be +8 in the ledger, unqueued and unrated.
 */

import { MAX_BOUND_PARAMS, chunk, nowIso, type Database } from '../db.ts';
import { toMyGuyLevel, type MyGuyLevel } from '../../core/draft/decisions.ts';

export interface PlayerFlag {
  level: MyGuyLevel;
  queued: boolean;
}

const EMPTY: PlayerFlag = { level: 0, queued: false };

export class PlayerFlagsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Set or clear the My Guy level, leaving the queue alone.
   *
   * A row with nothing on it is deleted rather than kept as a pair of zeroes,
   * so the table holds only decisions the user actually made and "unflagged"
   * has exactly one representation.
   */
  async setLevel(playerId: string, level: MyGuyLevel): Promise<PlayerFlag> {
    return this.write(playerId, { level });
  }

  /** Add to or remove from the draft queue, leaving My Guy alone. */
  async setQueued(playerId: string, queued: boolean): Promise<PlayerFlag> {
    return this.write(playerId, { queued });
  }

  private async write(playerId: string, change: { level?: MyGuyLevel; queued?: boolean }): Promise<PlayerFlag> {
    const current = await this.get(playerId);
    const next: PlayerFlag = {
      level: change.level ?? current.level,
      queued: change.queued ?? current.queued,
    };

    if (next.level <= 0 && !next.queued) {
      await this.db.prepare('DELETE FROM player_flags WHERE player_id = ?').bind(playerId).run();
      return EMPTY;
    }

    await this.db
      .prepare(
        `INSERT INTO player_flags (player_id, level, queued, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET
           level = excluded.level,
           queued = excluded.queued,
           updated_at = excluded.updated_at`,
      )
      .bind(playerId, next.level, next.queued ? 1 : 0, nowIso())
      .run();
    return next;
  }

  async get(playerId: string): Promise<PlayerFlag> {
    const row = await this.db
      .prepare('SELECT level, queued FROM player_flags WHERE player_id = ?')
      .bind(playerId)
      .first<{ level: number; queued: number }>();
    return row ? toFlag(row) : EMPTY;
  }

  /** Every mark the user has set. Small by nature — this is a shortlist. */
  async all(): Promise<Map<string, PlayerFlag>> {
    const rows = await this.db
      .prepare('SELECT player_id, level, queued FROM player_flags ORDER BY level DESC, player_id')
      .all<{ player_id: string; level: number; queued: number }>();
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
        .prepare(`SELECT player_id, level, queued FROM player_flags WHERE player_id IN (${placeholders})`)
        .bind(...batch)
        .all<{ player_id: string; level: number; queued: number }>();
      for (const r of rows.results) out.set(String(r.player_id), toFlag(r));
    }
    return out;
  }
}

function toFlag(row: { level: number; queued: number }): PlayerFlag {
  return { level: toMyGuyLevel(row.level), queued: Number(row.queued) === 1 };
}
