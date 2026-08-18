/**
 * Captures of Sleeper's global trending list.
 *
 * Append-only and deliberately so. The velocity story — adds per hour, rank
 * movement, acceleration — is a difference between two moments, and Sleeper
 * keeps no history at all: the only way to know a player's add rate sextupled
 * is to have written down what it was before. An overwritten row is a
 * measurement destroyed.
 *
 * The pruning is the counterweight. Fifty rows a capture, a few captures a day,
 * kept for a bounded number of days, is a few thousand rows — small enough to
 * be free and long enough to see a week's movement.
 */

import { chunk, nowIso, type Database } from '../db.ts';
import type { TrendingSnapshot } from '../../core/market/trending.ts';

/**
 * How long a capture is worth keeping.
 *
 * Long enough to cover the waiver cycle a bid is actually made in, and no
 * longer: last month's add rate for a player who has since been dropped
 * everywhere answers no question anybody asks.
 */
export const TRENDING_RETENTION_DAYS = 14;

export class TrendingRepo {
  constructor(private readonly db: Database) {}

  async save(snapshot: TrendingSnapshot): Promise<number> {
    for (const batch of chunk(snapshot.rows, 25)) {
      const statements = batch.map((row) =>
        this.db
          .prepare(
            `INSERT INTO trending_snapshots (captured_at, trend_type, lookback_hours, player_id, rank, count)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(captured_at, trend_type, player_id) DO NOTHING`,
          )
          .bind(snapshot.capturedAt, snapshot.type, snapshot.lookbackHours, row.playerId, row.rank, row.count),
      );
      if (statements.length > 0) await this.db.batch(statements);
    }
    return snapshot.rows.length;
  }

  /**
   * The `n`th most recent capture, 0-based.
   *
   * `latest(0)` and `latest(1)` are the two the velocity comparison needs. They
   * are fetched separately rather than as one windowed query because D1's
   * planner handles two small indexed reads better than one window function,
   * and because the second may legitimately not exist.
   */
  async capture(type: 'add' | 'drop', offset = 0): Promise<TrendingSnapshot | null> {
    const stamp = await this.db
      .prepare(
        `SELECT captured_at, lookback_hours FROM trending_snapshots
         WHERE trend_type = ?
         GROUP BY captured_at
         ORDER BY captured_at DESC
         LIMIT 1 OFFSET ?`,
      )
      .bind(type, offset)
      .first<{ captured_at: string; lookback_hours: number }>();
    if (!stamp) return null;

    const rows = await this.db
      .prepare('SELECT player_id, rank, count FROM trending_snapshots WHERE trend_type = ? AND captured_at = ? ORDER BY rank ASC')
      .bind(type, stamp.captured_at)
      .all<{ player_id: string; rank: number; count: number }>();

    return {
      capturedAt: stamp.captured_at,
      type,
      lookbackHours: Number(stamp.lookback_hours),
      rows: rows.results.map((r) => ({ playerId: r.player_id, rank: Number(r.rank), count: Number(r.count) })),
    };
  }

  /**
   * The previous capture that is actually comparable with `current`.
   *
   * Not simply "the one before". Two captures taken twenty minutes apart share
   * most of their window, so the difference between them is mostly the same
   * adds counted twice; and a capture taken over a different lookback is not
   * comparable at all. This walks back until it finds one that is both far
   * enough away and measured the same way, and returns null rather than a
   * misleading comparison.
   */
  async comparablePrevious(
    current: TrendingSnapshot,
    opts: { minGapHours?: number; maxLookBack?: number } = {},
  ): Promise<TrendingSnapshot | null> {
    const minGapMs = (opts.minGapHours ?? current.lookbackHours) * 3_600_000;
    const maxLookBack = opts.maxLookBack ?? 8;
    const currentMs = Date.parse(current.capturedAt);

    for (let offset = 1; offset <= maxLookBack; offset++) {
      const candidate = await this.capture(current.type, offset);
      if (!candidate) return null;
      if (candidate.lookbackHours !== current.lookbackHours) continue;
      if (currentMs - Date.parse(candidate.capturedAt) >= minGapMs) return candidate;
    }
    return null;
  }

  /** Drop captures older than the retention window. Returns rows removed. */
  async prune(retentionDays = TRENDING_RETENTION_DAYS, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const result = await this.db.prepare('DELETE FROM trending_snapshots WHERE captured_at < ?').bind(cutoff).run();
    return result.meta.changes ?? 0;
  }

  /** How much history exists, for the Setup panel's own honesty. */
  async coverage(type: 'add' | 'drop'): Promise<{ captures: number; oldest: string | null; newest: string | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT captured_at) AS captures, MIN(captured_at) AS oldest, MAX(captured_at) AS newest
         FROM trending_snapshots WHERE trend_type = ?`,
      )
      .bind(type)
      .first<{ captures: number; oldest: string | null; newest: string | null }>();
    return {
      captures: Number(row?.captures ?? 0),
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
    };
  }

  /** The instant a capture should be stamped with. Here so tests can pin it. */
  static stamp(): string {
    return nowIso();
  }
}
