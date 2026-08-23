/**
 * The ★ queue, which belongs to one draft.
 *
 * Every method here takes a `draftId` and none of them has a default. That is
 * the whole design: the bug this table exists to fix was a queue with no draft
 * attached to it, so there is deliberately no way to read or write one without
 * naming the draft it is for. A caller that does not know which draft it is in
 * cannot compile, rather than quietly getting somebody else's shortlist.
 *
 * **It is not an opinion about a player.** A queue position says where to look,
 * not how good he is — the ranking is identical whether or not the star is lit.
 * My Guy, which *is* an opinion and *does* move the ranking by a bounded amount,
 * is a different mark in a different table and stays global, because "he is my
 * guy" survives the draft it was said in and a shortlist does not. See
 * `playerFlags.ts` for that half.
 *
 * Ranks are sparse — 1000, 2000, 3000 — so a drag persists one row rather than
 * renumbering the list. The arithmetic lives in `core/draft/queueOrder.ts` and
 * is shared with the screen; this file only stores what that module decides.
 */

import { chunk, nowIso, type Database } from '../db.ts';
import { appendRank, queueSequence, type QueueEntry } from '../../core/draft/queueOrder.ts';

export class DraftQueueRepo {
  constructor(private readonly db: Database) {}

  /** Every queued player in this draft, with his rank, best-first. Small by nature. */
  async entries(draftId: string): Promise<QueueEntry[]> {
    const rows = await this.db
      .prepare('SELECT player_id, queue_order FROM draft_queue WHERE draft_id = ? ORDER BY queue_order')
      .bind(draftId)
      .all<{ player_id: string; queue_order: number }>();
    return rows.results.map((r) => ({ playerId: String(r.player_id), order: Number(r.queue_order) }));
  }

  /** This draft's queue as an ordered list of ids. */
  async order(draftId: string): Promise<string[]> {
    return queueSequence(await this.entries(draftId));
  }

  /** The ids queued in this draft, for a caller that only needs membership. */
  async queuedIds(draftId: string): Promise<Set<string>> {
    return new Set((await this.entries(draftId)).map((e) => e.playerId));
  }

  /**
   * Add a player to this draft's queue, or take him out.
   *
   * A player joining is appended after everybody already in it, every time.
   * That predictability is the requirement: a player starred in the eleventh
   * round goes at the end of the ten already starred, whatever the board thinks
   * of him — a queue that re-sorted itself on insert would be the model
   * overruling the reader in the one list that is theirs.
   *
   * **Leaving the queue discards the rank**, because leaving discards the row.
   * A rank stored against a player nobody has starred is state with no owner,
   * and "not queued" then has exactly one representation. Re-starring appends
   * him, the same as starring him the first time did.
   *
   * Idempotent: a repeated star from a stale client cannot walk a player to the
   * bottom of his own queue.
   */
  async setQueued(draftId: string, playerId: string, queued: boolean): Promise<boolean> {
    if (!queued) {
      await this.db
        .prepare('DELETE FROM draft_queue WHERE draft_id = ? AND player_id = ?')
        .bind(draftId, playerId)
        .run();
      return false;
    }

    const entries = await this.entries(draftId);
    if (entries.some((e) => e.playerId === playerId)) return true;
    await this.db
      .prepare('INSERT INTO draft_queue (draft_id, player_id, queue_order, updated_at) VALUES (?,?,?,?)')
      .bind(draftId, playerId, appendRank(entries), nowIso())
      .run();
    return true;
  }

  /**
   * Persist a reorder: the rows the drag actually moved, and no others.
   *
   * Usually one row. A compaction — once in thousands of drags, when the sparse
   * ladder finally runs out of room between two neighbours — sends the whole
   * list, and is the only case that does.
   *
   * Scoped to the draft in the `WHERE`, so a stale client holding another
   * draft's ids cannot write ranks into this one, and applied only to players
   * who are actually in this queue, so it cannot enrol somebody who has since
   * been drafted or unstarred.
   */
  async setOrder(draftId: string, entries: readonly QueueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = nowIso();
    for (const batch of chunk([...entries], 100)) {
      await this.db.batch(
        batch.map((entry) =>
          this.db
            .prepare('UPDATE draft_queue SET queue_order = ?, updated_at = ? WHERE draft_id = ? AND player_id = ?')
            .bind(entry.order, now, draftId, entry.playerId),
        ),
      );
    }
  }
}
