/**
 * Season-long market persistence.
 *
 * Same two tables as the weekly props, under `scope = 'season'`: one pipeline,
 * two horizons. Snapshots are append-only and keyed by fetch time, so the
 * history a season line moved through is kept rather than overwritten — which
 * is what a future "the market has been climbing since July" would be built on.
 */

import { resolveSeasonLines, type SnapshotLine } from '../../core/seasonImport/gapFill.ts';
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

  /**
   * The season market lines for a set of players, across every snapshot held.
   *
   * Deliberately not "the latest snapshot's rows". Once season lines can arrive
   * by hand as well as by fetch, a season holds several captures, and picking
   * one of them wholesale silently deletes coverage: a small Thursday capture
   * of forty players would replace a Monday capture of two hundred, and the
   * other hundred and sixty would lose their line to a snapshot that never
   * mentioned them. The choice is made per player and per market instead, by
   * `resolveSeasonLines` — which prefers a named primary source, fills only
   * genuine gaps from anything else, and never averages two books into a number
   * neither of them published.
   *
   * `bookCount` rides along because the card shows quantities summed from more
   * than one market, and "how many books stand behind this line" is the first
   * question a reader asks once a number stops being a single quote.
   */
  async latestForPlayers(
    season: string,
    playerIds: string[],
    opts: { primarySource?: string | null } = {},
  ): Promise<Map<string, { market: SeasonMarketKey; line: number | null; bookCount?: number }[]>> {
    const out = new Map<string, { market: SeasonMarketKey; line: number | null; bookCount?: number }[]>();
    if (playerIds.length === 0) return out;

    const books = new Map<string, number>();
    const lines: SnapshotLine[] = [];

    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 2)) {
      const placeholders = batch.map(() => '?').join(',');
      /*
       * A fetched snapshot has no capture columns — they belong to the hand
       * import — so its own provider and fetch time stand in. That keeps one
       * ordering rule over both kinds rather than two rules that could disagree
       * about which line is newer.
       */
      const rows = await this.db
        .prepare(
          `SELECT p.id AS row_id, p.player_id, p.market, p.line, p.book_count,
                  COALESCE(s.capture_source, s.provider) AS source,
                  COALESCE(s.captured_at, s.fetched_at) AS captured_at,
                  s.id AS snapshot_id
             FROM player_props p
             JOIN prop_snapshots s ON s.id = p.snapshot_id
            WHERE s.scope = 'season' AND s.season = ?
              AND p.scope = 'season' AND p.player_id IN (${placeholders})`,
        )
        .bind(season, ...batch)
        .all<Record<string, unknown>>();

      for (const r of rows.results) {
        const line = r['line'] == null ? null : Number(r['line']);
        // A row with no line carries no opinion to choose between, and letting
        // it into the resolution could see it beat a real line on recency.
        if (line == null) continue;
        const key = `${String(r['player_id'])}|${String(r['market'])}|${String(r['snapshot_id'])}`;
        const count = r['book_count'] == null ? 0 : Number(r['book_count']);
        books.set(key, Number.isFinite(count) && count > 0 ? count : 0);
        lines.push({
          playerId: String(r['player_id']),
          market: String(r['market']) as SeasonMarketKey,
          line,
          overPrice: null,
          underPrice: null,
          source: String(r['source'] ?? ''),
          capturedAt: String(r['captured_at'] ?? ''),
          snapshotId: Number(r['snapshot_id']),
        });
      }
    }

    for (const chosen of resolveSeasonLines(lines, { primarySource: opts.primarySource ?? null })) {
      const count = books.get(`${chosen.playerId}|${chosen.market}|${chosen.snapshotId}`) ?? 0;
      const entry = {
        market: chosen.market,
        line: chosen.line,
        bookCount: count > 0 ? count : undefined,
      };
      const list = out.get(chosen.playerId);
      if (list) list.push(entry);
      else out.set(chosen.playerId, [entry]);
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
