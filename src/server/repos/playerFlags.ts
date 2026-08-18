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
import { appendRank, queueSequence, type QueueEntry } from '../../core/draft/queueOrder.ts';

export interface PlayerFlag {
  level: MyGuyLevel;
  queued: boolean;
  /**
   * Where he sits in the user's own order. Null for a player queued before the
   * order existed, or from a path that does not assign one.
   *
   * Sparse rather than dense — see `core/draft/queueOrder.ts` — so a drag costs
   * one write rather than a renumber of the whole list.
   */
  queueOrder: number | null;
}

const EMPTY: PlayerFlag = { level: 0, queued: false, queueOrder: null };

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

  /**
   * Add to or remove from the draft queue, leaving My Guy alone.
   *
   * A player joining the queue is appended after everybody already in it,
   * every time. That predictability is the requirement: a player starred in the
   * eleventh round goes at the end of the ten already starred, whatever the
   * board thinks of him — a queue that re-sorted itself on insert would be the
   * model overruling the reader in the one list that is theirs.
   *
   * **Leaving the queue discards the rank**, because leaving the queue discards
   * the row: a player with no ★ and no ♥ is deleted, so that "unflagged" has
   * exactly one representation in this table. That invariant predates the
   * order and is worth more than the convenience of remembering where an
   * un-starred player used to sit — a rank stored against a row nobody has
   * flagged is state with no owner. Re-starring him therefore appends him, the
   * same as starring him the first time did.
   *
   * A player who is *already* queued and already ranked keeps his place: this
   * is idempotent, so a repeated star from a stale client cannot walk him to
   * the bottom of his own queue.
   */
  async setQueued(playerId: string, queued: boolean): Promise<PlayerFlag> {
    if (!queued) return this.write(playerId, { queued });
    const current = await this.get(playerId);
    if (current.queued && current.queueOrder != null) return current;
    const order = current.queueOrder ?? appendRank(await this.queueEntries());
    return this.write(playerId, { queued, queueOrder: order });
  }

  /** Every queued player with a rank, best-first. Small by nature. */
  async queueEntries(): Promise<QueueEntry[]> {
    const rows = await this.db
      .prepare(
        'SELECT player_id, queue_order FROM player_flags WHERE queued = 1 AND queue_order IS NOT NULL ORDER BY queue_order',
      )
      .all<{ player_id: string; queue_order: number }>();
    return rows.results.map((r) => ({ playerId: String(r.player_id), order: Number(r.queue_order) }));
  }

  /** The queue as an ordered list of ids. */
  async queueOrder(): Promise<string[]> {
    return queueSequence(await this.queueEntries());
  }

  /**
   * Persist a reorder: the rows the drag actually moved, and no others.
   *
   * Usually one row. A compaction — which happens once in thousands of drags,
   * when the sparse ladder finally runs out of room between two neighbours —
   * sends the whole list, and is the only case that does.
   *
   * Writes are applied only to players who are actually queued, so a stale
   * client cannot use this endpoint to give a rank to somebody who has since
   * been drafted or unstarred.
   */
  async setQueueOrder(entries: readonly QueueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = nowIso();
    for (const batch of chunk([...entries], 100)) {
      await this.db.batch(
        batch.map((entry) =>
          this.db
            .prepare('UPDATE player_flags SET queue_order = ?, updated_at = ? WHERE player_id = ? AND queued = 1')
            .bind(entry.order, now, entry.playerId),
        ),
      );
    }
  }

  private async write(
    playerId: string,
    change: { level?: MyGuyLevel; queued?: boolean; queueOrder?: number | null },
  ): Promise<PlayerFlag> {
    const current = await this.get(playerId);
    const next: PlayerFlag = {
      level: change.level ?? current.level,
      queued: change.queued ?? current.queued,
      queueOrder: change.queueOrder === undefined ? current.queueOrder : change.queueOrder,
    };

    if (next.level <= 0 && !next.queued) {
      await this.db.prepare('DELETE FROM player_flags WHERE player_id = ?').bind(playerId).run();
      return EMPTY;
    }

    await this.db
      .prepare(
        `INSERT INTO player_flags (player_id, level, queued, queue_order, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET
           level = excluded.level,
           queued = excluded.queued,
           queue_order = excluded.queue_order,
           updated_at = excluded.updated_at`,
      )
      .bind(playerId, next.level, next.queued ? 1 : 0, next.queueOrder, nowIso())
      .run();
    return next;
  }

  async get(playerId: string): Promise<PlayerFlag> {
    const row = await this.db
      .prepare('SELECT level, queued, queue_order FROM player_flags WHERE player_id = ?')
      .bind(playerId)
      .first<{ level: number; queued: number; queue_order: number | null }>();
    return row ? toFlag(row) : EMPTY;
  }

  /** Every mark the user has set. Small by nature — this is a shortlist. */
  async all(): Promise<Map<string, PlayerFlag>> {
    const rows = await this.db
      .prepare('SELECT player_id, level, queued, queue_order FROM player_flags ORDER BY level DESC, player_id')
      .all<{ player_id: string; level: number; queued: number; queue_order: number | null }>();
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
        .prepare(
          `SELECT player_id, level, queued, queue_order FROM player_flags WHERE player_id IN (${placeholders})`,
        )
        .bind(...batch)
        .all<{ player_id: string; level: number; queued: number; queue_order: number | null }>();
      for (const r of rows.results) out.set(String(r.player_id), toFlag(r));
    }
    return out;
  }
}

function toFlag(row: { level: number; queued: number; queue_order?: number | null }): PlayerFlag {
  return {
    level: toMyGuyLevel(row.level),
    queued: Number(row.queued) === 1,
    queueOrder: row.queue_order == null ? null : Number(row.queue_order),
  };
}
