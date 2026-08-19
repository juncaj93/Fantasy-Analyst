/**
 * Season-long market persistence.
 *
 * Same two tables as the weekly props, under `scope = 'season'`: one pipeline,
 * two horizons. Snapshots are append-only and keyed by fetch time, so the
 * history a season line moved through is kept rather than overwritten — which
 * is what a future "the market has been climbing since July" would be built on.
 */

import type { PlayerSeasonMarket } from '../../core/vegas/season.ts';
import type { SeasonMarketKey, SeasonMarketSet } from '../../core/vegas/types.ts';
import { chunk, MAX_BOUND_PARAMS, parseJson, toJson, type Database } from '../db.ts';

export interface SeasonSnapshotMeta {
  id: number;
  provider: string;
  season: string;
  fetchedAt: string;
  /** Whatever the provider said about an empty answer, when it said anything. */
  note: string | null;
}

/** The season identity doubles as the event id, so one row is one season. */
const eventIdFor = (season: string) => `season:${season}`;

export class SeasonMarketsRepo {
  constructor(private readonly db: Database) {}

  /** The newest snapshot for a season, whoever provided it. */
  async latestSnapshot(season: string): Promise<SeasonSnapshotMeta | null> {
    const row = await this.db
      .prepare(
        `SELECT id, provider, season, fetched_at, raw_json FROM prop_snapshots
          WHERE scope = 'season' AND event_id = ?
          ORDER BY fetched_at DESC LIMIT 1`,
      )
      .bind(eventIdFor(season))
      .first<Record<string, unknown>>();
    if (!row) return null;
    const raw = parseJson<{ note?: string | null }>(row['raw_json'], {});
    return {
      id: Number(row['id']),
      provider: String(row['provider']),
      season: String(row['season'] ?? season),
      fetchedAt: String(row['fetched_at']),
      note: raw?.note ?? null,
    };
  }

  /**
   * Store one fetch, with the resolved rows it produced.
   *
   * Idempotent on (provider, event, fetched_at): re-running the same fetch does
   * not create a second snapshot, and re-resolving one replaces its rows rather
   * than doubling them.
   */
  async saveSnapshot(set: SeasonMarketSet, markets: PlayerSeasonMarket[]): Promise<number> {
    const eventId = eventIdFor(set.season);
    await this.db
      .prepare(
        `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope, season)
         VALUES (?,?,?,?,?,'season',?)
         ON CONFLICT(provider, event_id, fetched_at) DO NOTHING`,
      )
      .bind(set.provider, eventId, '', set.fetchedAt, toJson({ note: set.note, raw: set.raw }), set.season)
      .run();

    const row = await this.db
      .prepare(
        `SELECT id FROM prop_snapshots
          WHERE provider = ? AND event_id = ? AND fetched_at = ? AND scope = 'season'`,
      )
      .bind(set.provider, eventId, set.fetchedAt)
      .first<{ id: number }>();
    if (!row) throw new Error('season snapshot could not be stored');
    const snapshotId = Number(row.id);

    await this.db.prepare('DELETE FROM player_props WHERE snapshot_id = ?').bind(snapshotId).run();
    for (const batch of chunk(markets, 100)) {
      await this.db.batch(
        batch.map((m) =>
          this.db
            .prepare(
              `INSERT INTO player_props (
                 snapshot_id, player_id, source_player_name, market, line, over_price, under_price,
                 book_count, books_json, consensus_method, implied_probability, raw_json, scope
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'season')`,
            )
            .bind(
              snapshotId,
              m.playerId,
              m.sourcePlayerName,
              m.market,
              m.line,
              null,
              null,
              m.bookCount,
              toJson([m.book]),
              m.bookCount > 1 ? 'median' : 'single',
              null,
              toJson({}),
            ),
        ),
      );
    }
    return snapshotId;
  }

  /** The newest season market lines for a set of players. */
  async latestForPlayers(
    season: string,
    playerIds: string[],
  ): Promise<Map<string, { market: SeasonMarketKey; line: number | null; bookCount?: number }[]>> {
    const out = new Map<string, { market: SeasonMarketKey; line: number | null; bookCount?: number }[]>();
    const snapshot = await this.latestSnapshot(season);
    if (!snapshot || playerIds.length === 0) return out;

    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const placeholders = batch.map(() => '?').join(',');
      /*
       * `book_count` rides along because the card now shows quantities this app
       * summed from more than one market, and "how many books stand behind each
       * line" is the question a reader asks the moment a number stops being a
       * single quote. It is one more column on a query that was already running.
       */
      const rows = await this.db
        .prepare(
          `SELECT player_id, market, line, book_count FROM player_props
            WHERE snapshot_id = ? AND scope = 'season' AND player_id IN (${placeholders})`,
        )
        .bind(snapshot.id, ...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        const playerId = String(r['player_id']);
        const books = r['book_count'] == null ? 0 : Number(r['book_count']);
        const entry = {
          market: String(r['market']) as SeasonMarketKey,
          line: r['line'] == null ? null : Number(r['line']),
          bookCount: Number.isFinite(books) && books > 0 ? books : undefined,
        };
        const list = out.get(playerId);
        if (list) list.push(entry);
        else out.set(playerId, [entry]);
      }
    }
    return out;
  }

  /** How much of the board the newest snapshot covers, for source health. */
  async coverage(season: string): Promise<{ players: number; quotes: number; unresolved: number }> {
    const snapshot = await this.latestSnapshot(season);
    if (!snapshot) return { players: 0, quotes: 0, unresolved: 0 };
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT player_id) AS players,
                COUNT(*) AS quotes,
                SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) AS unresolved
           FROM player_props WHERE snapshot_id = ? AND scope = 'season'`,
      )
      .bind(snapshot.id)
      .first<Record<string, unknown>>();
    return {
      players: Number(row?.['players'] ?? 0),
      quotes: Number(row?.['quotes'] ?? 0),
      unresolved: Number(row?.['unresolved'] ?? 0),
    };
  }
}
