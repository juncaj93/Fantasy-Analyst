/**
 * Vegas snapshot persistence + the SnapshotStore implementation for the cache.
 *
 * Weekly game lines only. Season-long markets live in the same two tables under
 * `scope = 'season'` (see SeasonMarketsRepo), so every query here is scoped
 * explicitly — a season total read as Sunday's line would be a silent, and very
 * confident, lie.
 */

import type { CachedSnapshot, SnapshotStore } from '../../core/vegas/cache.ts';
import type { PlayerProp, RawPropSet } from '../../core/vegas/types.ts';
import { MAX_BOUND_PARAMS, chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

export class PropsRepo implements SnapshotStore {
  constructor(private readonly db: Database) {}

  /** Latest snapshot for an event, regardless of provider. */
  async get(eventId: string): Promise<CachedSnapshot | null> {
    const row = await this.db
      .prepare("SELECT * FROM prop_snapshots WHERE event_id = ? AND scope = 'week' ORDER BY fetched_at DESC LIMIT 1")
      .bind(eventId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      provider: String(row['provider']),
      eventId: String(row['event_id']),
      gameStart: String(row['game_start']),
      fetchedAt: String(row['fetched_at']),
      raw: parseJson<RawPropSet>(row['raw_json'], {
        provider: String(row['provider']),
        eventId: String(row['event_id']),
        gameStart: String(row['game_start']),
        fetchedAt: String(row['fetched_at']),
        quotes: [],
        raw: null,
      }),
    };
  }

  async put(snapshot: CachedSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
         VALUES (?,?,?,?,?,'week')
         ON CONFLICT(provider, event_id, fetched_at) DO NOTHING`,
      )
      .bind(snapshot.provider, snapshot.eventId, snapshot.gameStart, snapshot.fetchedAt, toJson(snapshot.raw))
      .run();
  }

  async snapshotId(provider: string, eventId: string, fetchedAt: string): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT id FROM prop_snapshots WHERE provider = ? AND event_id = ? AND fetched_at = ? AND scope = 'week'")
      .bind(provider, eventId, fetchedAt)
      .first<{ id: number }>();
    return row ? Number(row.id) : null;
  }

  /** Persist the resolved consensus rows for a snapshot. */
  async saveConsensus(snapshotId: number, props: PlayerProp[]): Promise<void> {
    await this.db.prepare('DELETE FROM player_props WHERE snapshot_id = ?').bind(snapshotId).run();
    for (const batch of chunk(props, 100)) {
      await this.db.batch(
        batch.map((p) =>
          this.db
            .prepare(
              `INSERT INTO player_props (
                 snapshot_id, player_id, source_player_name, market, line, over_price, under_price,
                 book_count, books_json, consensus_method, implied_probability, raw_json, scope
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'week')`,
            )
            .bind(
              snapshotId,
              p.playerId,
              p.sourcePlayerName,
              p.market,
              p.line,
              p.overPrice,
              p.underPrice,
              p.bookCount,
              toJson(p.books),
              p.consensusMethod,
              p.impliedProbability,
              toJson({ savedAt: nowIso() }),
            ),
        ),
      );
    }
  }

  /** Most recent consensus props for a set of players. */
  async latestForPlayers(playerIds: string[]): Promise<Map<string, PlayerProp[]>> {
    const out = new Map<string, PlayerProp[]>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT pp.* FROM player_props pp
             JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.player_id IN (${placeholders})
              AND ps.scope = 'week'
              AND ps.id = (
                SELECT id FROM prop_snapshots s2
                 WHERE s2.event_id = ps.event_id AND s2.scope = 'week'
                 ORDER BY s2.fetched_at DESC LIMIT 1
              )`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        const pid = String(r['player_id']);
        const prop = toProp(pid, r);
        const list = out.get(pid);
        if (list) list.push(prop);
        else out.set(pid, [prop]);
      }
    }
    return out;
  }

  /**
   * Kickoff time per player, taken from the newest snapshot that quoted them.
   *
   * The schedule is not stored separately — a prop snapshot carries the game it
   * belongs to, so the event a player has lines for is the game they are
   * playing in. Players nobody quoted are simply absent, and the caller treats
   * an absent kickoff as "unknown" rather than as "not playing".
   */
  async kickoffsForPlayers(playerIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT pp.player_id AS player_id, ps.game_start AS game_start
             FROM player_props pp
             JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.player_id IN (${placeholders})
              AND ps.scope = 'week'
            ORDER BY ps.fetched_at ASC`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      // Ascending, so the last write per player is the newest snapshot's view.
      for (const r of rows.results) out.set(String(r['player_id']), String(r['game_start']));
    }
    return out;
  }

  /**
   * The lines each player carried at the previous snapshot of their game.
   *
   * "Previous" is the second-newest snapshot for that event, which is what
   * makes movement mean "since the last time the app looked" rather than
   * "since some arbitrary point". A player whose game has only been fetched
   * once has no previous lines, and no movement is claimed for them.
   */
  async previousForPlayers(playerIds: string[]): Promise<Map<string, PlayerProp[]>> {
    const out = new Map<string, PlayerProp[]>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT pp.* FROM player_props pp
             JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.player_id IN (${placeholders})
              AND ps.scope = 'week'
              AND ps.id = (
                SELECT id FROM prop_snapshots s2
                 WHERE s2.event_id = ps.event_id AND s2.scope = 'week'
                 ORDER BY s2.fetched_at DESC LIMIT 1 OFFSET 1
              )`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        const pid = String(r['player_id']);
        const list = out.get(pid) ?? [];
        list.push(toProp(pid, r));
        out.set(pid, list);
      }
    }
    return out;
  }

  /** Freshness of the newest snapshot overall, for the UI badge. */
  async freshness(): Promise<{ fetchedAt: string | null; provider: string | null; events: number }> {
    const row = await this.db
      .prepare(
        "SELECT provider, fetched_at, COUNT(DISTINCT event_id) AS events FROM prop_snapshots WHERE scope = 'week' GROUP BY provider ORDER BY fetched_at DESC LIMIT 1",
      )
      .first<Record<string, unknown>>();
    return {
      fetchedAt: row ? String(row['fetched_at']) : null,
      provider: row ? String(row['provider']) : null,
      events: row ? Number(row['events'] ?? 0) : 0,
    };
  }
}

/** One consensus row as stored, in the shape the engines read. */
function toProp(playerId: string, r: Record<string, unknown>): PlayerProp {
  return {
    playerId,
    sourcePlayerName: String(r['source_player_name'] ?? ''),
    market: String(r['market']) as PlayerProp['market'],
    line: r['line'] == null ? null : Number(r['line']),
    overPrice: r['over_price'] == null ? null : Number(r['over_price']),
    underPrice: r['under_price'] == null ? null : Number(r['under_price']),
    bookCount: Number(r['book_count'] ?? 0),
    consensusMethod: String(r['consensus_method'] ?? 'none') as PlayerProp['consensusMethod'],
    books: parseJson<string[]>(r['books_json'], []),
    impliedProbability: r['implied_probability'] == null ? null : Number(r['implied_probability']),
  };
}
