/**
 * The decision feed's storage.
 *
 * Rows are never deleted. A situation that develops supersedes its own earlier
 * row rather than overwriting it, so "what did the app tell me on Friday" stays
 * answerable — which matters more here than in most tables, because this is the
 * surface that claims a recommendation changed.
 */

import type { FeedEvent } from '../../core/league/feed.ts';
import { nowIso, type Database } from '../db.ts';

export interface StoredFeedEvent extends FeedEvent {
  id: number;
  supersededAt: string | null;
  seenAt: string | null;
}

export class DecisionFeedRepo {
  constructor(private readonly db: Database) {}

  async listOpen(sleeperLeagueId: string | null, limit = 40): Promise<StoredFeedEvent[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM decision_feed_events
          WHERE (sleeper_league_id IS ? OR ? IS NULL)
            AND superseded_at IS NULL
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(sleeperLeagueId, sleeperLeagueId, limit)
      .all<Record<string, unknown>>();
    return rows.results.map(rowToEvent);
  }

  async insert(sleeperLeagueId: string | null, event: FeedEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO decision_feed_events
           (sleeper_league_id, dedupe_key, kind, subject_player_id, headline, detail, magnitude, occurred_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        sleeperLeagueId,
        event.dedupeKey,
        event.kind,
        event.playerId ?? null,
        event.headline,
        detailWithCorroboration(event),
        event.magnitude,
        event.occurredAt,
      )
      .run();
  }

  async supersede(id: number): Promise<void> {
    await this.db
      .prepare('UPDATE decision_feed_events SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL')
      .bind(nowIso(), id)
      .run();
  }

  /** Mark everything currently open as read. The feed is a delta, not an inbox. */
  async markSeen(sleeperLeagueId: string | null): Promise<{ marked: number }> {
    const result = await this.db
      .prepare(
        `UPDATE decision_feed_events SET seen_at = ?
          WHERE seen_at IS NULL AND superseded_at IS NULL AND (sleeper_league_id IS ? OR ? IS NULL)`,
      )
      .bind(nowIso(), sleeperLeagueId, sleeperLeagueId)
      .run();
    return { marked: Number(result.meta?.changes ?? 0) };
  }
}

/**
 * Corroboration lives in the detail line rather than in its own column.
 *
 * It is display text — "also reported by two other sources" — and giving it a
 * column would invite querying on it, which would make a presentational
 * decision into a schema commitment.
 */
function detailWithCorroboration(event: FeedEvent): string | null {
  if (event.corroboration.length === 0) return event.detail ?? null;
  const line = `also reported by ${event.corroboration.join(', ')}`;
  return event.detail ? `${event.detail} · ${line}` : line;
}

function rowToEvent(r: Record<string, unknown>): StoredFeedEvent {
  return {
    id: Number(r['id']),
    kind: String(r['kind']) as FeedEvent['kind'],
    dedupeKey: String(r['dedupe_key']),
    playerId: (r['subject_player_id'] as string | null) ?? null,
    headline: String(r['headline']),
    detail: (r['detail'] as string | null) ?? null,
    magnitude: Number(r['magnitude'] ?? 0),
    occurredAt: String(r['occurred_at'] ?? ''),
    changesDecision: true,
    corroboration: [],
    supersededAt: (r['superseded_at'] as string | null) ?? null,
    seenAt: (r['seen_at'] as string | null) ?? null,
  };
}
