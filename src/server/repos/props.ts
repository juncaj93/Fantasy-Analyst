/**
 * Vegas snapshot persistence + the SnapshotStore implementation for the cache.
 *
 * Weekly game lines only. Season-long markets live in the same two tables under
 * `scope = 'season'` (see SeasonMarketsRepo), so every query here is scoped
 * explicitly — a season total read as Sunday's line would be a silent, and very
 * confident, lie.
 */

import type { CachedSnapshot, SnapshotStore } from '../../core/vegas/cache.ts';
import type { BookQuote, PlayerProp, RawPropSet } from '../../core/vegas/types.ts';
import type { StoredLine } from '../../core/vegas/combineProps.ts';
import { MAX_BOUND_PARAMS, chunk, parseJson, toJson, type Database } from '../db.ts';
import { storedCount } from './storedCounts.ts';
import {
  PROPS_FRESHNESS_KEY,
  cachedPropsFreshness,
  forgetPropsFreshness,
  refreshStoredPropsFreshness,
  stampPropsChange,
  type PropsFreshness,
  type StoredFreshnessOutcome,
} from './propsFreshness.ts';
import type { SlateWindow } from '../../core/nfl/slateWindow.ts';

export class PropsRepo implements SnapshotStore {
  constructor(private readonly db: Database) {}

  /**
   * Latest snapshot for an event, regardless of provider.
   *
   * The provider payload is left in the database. Rows written before `put`
   * stopped storing it carry about 1.3 MB of it beside some 9 KB of quotes, and
   * this runs once per planned game on every refresh purely to learn how old
   * the game's lines are; parsing that payload in the Worker is CPU the weekend
   * cron could not afford. SQLite drops it instead, which costs the Worker
   * nothing.
   */
  async get(eventId: string): Promise<CachedSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, event_id, game_start, fetched_at, json_remove(raw_json, '$.raw') AS raw_json
         FROM prop_snapshots WHERE event_id = ? AND scope = 'week'
          AND json_extract(raw_json, '$.topUp') IS NULL
         ORDER BY fetched_at DESC LIMIT 1`,
      )
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

  /**
   * Store a fetched set: its quotes and game lines, not the provider's payload.
   *
   * Measured on production on 29 September 2026: a stored game was 1.24-1.37 MB,
   * of which 99% was the provider's own answer (1,500-1,650 odds with a
   * per-book breakdown each) and about 9 KB the ~70 quotes anything here reads.
   * Writing that out cost a full serialisation per game, and was a large part
   * of why the Saturday and Sunday Vegas crons were killed for CPU on every
   * weekend from 19 September. Nothing reads the payload back: the quotes and
   * the game lines are taken out of it at fetch time, and the consensus rows
   * are what every screen reads.
   */
  async put(snapshot: CachedSnapshot): Promise<void> {
    const { raw: _payload, ...kept } = snapshot.raw;
    await this.db
      .prepare(
        `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
         VALUES (?,?,?,?,?,'week')
         ON CONFLICT(provider, event_id, fetched_at) DO NOTHING`,
      )
      .bind(snapshot.provider, snapshot.eventId, snapshot.gameStart, snapshot.fetchedAt, toJson({ ...kept, raw: null }))
      .run();
    // After the row, never before: a reader that sees the new stamp must count the new row.
    await markPropsChanged(this.db);
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
    await this.saveRows(snapshotId, props);
  }

  /**
   * Write only the lines a look changed (Round 23).
   *
   * Unlike {@link saveConsensus} nothing is deleted first: the snapshot is a new
   * look, and the lines it does not carry are still the ones on file from an
   * earlier look of the same game. See {@link latestForPlayers} for how they are
   * read back.
   */
  async saveChanges(snapshotId: number, props: PlayerProp[]): Promise<void> {
    if (props.length === 0) return;
    await this.saveRows(snapshotId, props);
  }

  private async saveRows(snapshotId: number, props: PlayerProp[]): Promise<void> {
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
              toJson(p.bookDetail && p.bookDetail.length > 0 ? p.bookDetail : p.books),
              p.consensusMethod,
              p.impliedProbability,
              '{}',
            ),
        ),
      );
    }
  }

  /**
   * The lines on file for one game, newest per player and market, "gone"
   * markers included, with each book's last quote. What a new look is compared
   * against before anything is written.
   *
   * Reads the game's looks by its event index and their lines by the snapshot
   * index: about 65 to 150 rows a game.
   */
  async currentForEvent(eventId: string): Promise<StoredLine[]> {
    const snaps = await this.snapshotsForEvents([eventId]);
    const list = snaps.get(eventId) ?? [];
    const eligible = eligibleSnapshots(list, false);
    if (eligible.length === 0) return [];
    const ids = eligible.map((s) => s.id);
    const rows: Record<string, unknown>[] = [];
    for (const batch of chunk(ids, MAX_BOUND_PARAMS)) {
      const { results } = await this.db
        .prepare(`SELECT * FROM player_props WHERE snapshot_id IN (${batch.map(() => '?').join(',')}) AND scope = 'week'`)
        .bind(...batch)
        .all<Record<string, unknown>>();
      rows.push(...results);
    }
    const order = new Map(eligible.map((s, i) => [s.id, i]));
    const newest = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const k = `${String(r['source_player_name'] ?? '').toLowerCase()}|${String(r['market'])}`;
      const held = newest.get(k);
      if (!held || isNewer(r, held, order)) newest.set(k, r);
    }
    return [...newest.values()].map((r) => {
      const prop = toProp(r['player_id'] == null ? (null as unknown as string) : String(r['player_id']), r);
      return { ...prop, playerId: r['player_id'] == null ? null : String(r['player_id']), gone: prop.consensusMethod === 'none' };
    });
  }

  /** Every weekly look of these games, newest first, with the game line each carried. */
  private async snapshotsForEvents(eventIds: string[]): Promise<Map<string, SnapshotRef[]>> {
    const out = new Map<string, SnapshotRef[]>();
    const unique = [...new Set(eventIds)].filter(Boolean);
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const { results } = await this.db
        .prepare(`${SNAPSHOT_REF_SELECT} WHERE event_id IN (${batch.map(() => '?').join(',')}) AND +scope = 'week'`)
        .bind(...batch)
        .all<Record<string, unknown>>();
      addSnapshotRefs(out, results);
    }
    return sortSnapshotRefs(out);
  }

  /**
   * Every weekly look of the games in a slate, by the window index. Asked at the
   * same time as the lines (it needs nothing from them), so a screen's read is
   * one round trip, not two.
   */
  private async snapshotsInWindow(window: SlateWindow): Promise<Map<string, SnapshotRef[]>> {
    const { results } = await this.db
      .prepare(`${SNAPSHOT_REF_SELECT} WHERE scope = 'week' AND game_start >= ? AND game_start <= ?`)
      .bind(window.from, window.to)
      .all<Record<string, unknown>>();
    return sortSnapshotRefs(addSnapshotRefs(new Map(), results));
  }

  /**
   * The newest line per player, game and market, as of the newest look
   * (`previous` false) or the look before it (`previous` true).
   *
   * Since Round 23 a look writes only the lines that changed, so a game's lines
   * are spread over its looks: the newest row for each player and market is the
   * current one. Looks written before that are full copies, and the newest full
   * copy is where a game's history starts, so a line an old full copy dropped
   * is not brought back. "Gone" markers are read and then left out.
   *
   * Each line carries the look it is current as of (time and game line), which
   * is what the stale-prop check compares with the latest game line.
   */
  private async linesAsOf(
    playerIds: string[],
    window: SlateWindow | undefined,
    previous: boolean,
  ): Promise<Map<string, PlayerProp[]>> {
    const out = new Map<string, PlayerProp[]>();
    if (playerIds.length === 0) return out;
    // The slate's looks need nothing from the lines, so they are asked for at the same time.
    const inWindow = window ? this.snapshotsInWindow(window) : null;
    inWindow?.catch(() => undefined);
    const rows: Record<string, unknown>[] = [];
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 2)) {
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `SELECT pp.*, ps.event_id AS snapshot_event_id
             FROM player_props pp
             JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.player_id IN (${placeholders})
              AND ps.scope = 'week'
              ${window ? 'AND ps.game_start >= ? AND ps.game_start <= ?' : ''}`,
        )
        .bind(...batch, ...(window ? [window.from, window.to] : []))
        .all<Record<string, unknown>>();
      rows.push(...results);
    }
    if (rows.length === 0) return out;
    const snaps = window ? await inWindow! : new Map<string, SnapshotRef[]>();
    // A game whose looks are not all in the window (a flexed kickoff), or no window at all.
    const missing = [...new Set(rows.map((r) => String(r['snapshot_event_id'])))].filter((id) => !snaps.has(id));
    if (missing.length > 0) for (const [id, list] of await this.snapshotsForEvents(missing)) snaps.set(id, list);

    const newest = new Map<string, { row: Record<string, unknown>; asOf: SnapshotRef }>();
    const plan = new Map<string, { asOf: SnapshotRef; order: Map<number, number> } | null>();
    for (const r of rows) {
      const eventId = String(r['snapshot_event_id']);
      if (!plan.has(eventId)) {
        const eligible = eligibleSnapshots(snaps.get(eventId) ?? [], previous);
        plan.set(eventId, eligible.length === 0 ? null : { asOf: eligible[0]!, order: new Map(eligible.map((s, i) => [s.id, i])) });
      }
      const p = plan.get(eventId);
      if (!p || !p.order.has(Number(r['snapshot_id']))) continue;
      const k = `${String(r['player_id'])}|${eventId}|${String(r['market'])}`;
      const held = newest.get(k);
      if (!held || isNewer(r, held.row, p.order)) newest.set(k, { row: r, asOf: p.asOf });
    }
    for (const { row, asOf } of newest.values()) {
      if (String(row['consensus_method'] ?? '') === 'none') continue;
      const pid = String(row['player_id']);
      const prop = toProp(pid, {
        ...row,
        snapshot_fetched_at: asOf.fetchedAt,
        snapshot_total: asOf.total,
        snapshot_spread: asOf.spread,
        snapshot_spread_team: asOf.spreadTeam,
      });
      const list = out.get(pid);
      if (list) list.push(prop);
      else out.set(pid, [prop]);
    }
    return out;
  }

  /**
   * Most recent consensus props for a set of players, for the games in a window.
   *
   * ## The window is not optional in spirit
   *
   * This table has no season column and no week column. A snapshot's only
   * temporal anchor is the `game_start` of the fixture it belongs to, and the
   * `ps.id = (newest per event)` clause below means a week 1 event's snapshot
   * stays the newest snapshot of *that event* for ever. Without a bound on
   * `game_start`, this method answers a question nobody asked — "what is the
   * last thing a book ever said about this player" — and the caller reads the
   * answer as "what does the market expect of him this week".
   *
   * On 15 September 2026, the Tuesday of week 2, that is exactly what happened
   * in production: nine of ten starters priced from the previous Sunday's
   * lines, every one of them locked against a kickoff that had already passed.
   * The companion read on the same request, `VegasEventsRepo.between`, had been
   * windowed since it was written, so the game lines for those fixtures were
   * correctly absent while their player props were not.
   *
   * The parameter is optional only because {@link VegasRefreshService} has a
   * legitimate use for the unbounded question — it is deciding which players
   * still need buying, across a fetch horizon that can span two NFL weeks, and
   * "what do we already hold" is genuinely not week-scoped. Every caller
   * serving a screen passes {@link slateWindow}.
   *
   * ## `+s2.scope`, and why the plus is load-bearing
   *
   * The newest-snapshot subquery has two indexes it could use: one on
   * `(event_id, fetched_at)` and one on `(scope, fetched_at)`. D1 keeps no
   * table statistics, so SQLite cannot tell that nearly every snapshot is
   * `scope = 'week'` and picked the scope index — walking every game's
   * snapshots, newest first, until it reached one for this game, once per
   * snapshot in the outer scan. The unary plus changes no value; it only rules
   * that term out as an index key, which leaves the event index.
   *
   * Measured on production on 1 October 2026 with D1's own `rows_read`, same
   * rows returned before and after: this read 1,498 → 1,156 a call, the
   * previous-lines read 2,311 → 1,061. `d1 insights` had these reads, with the
   * unwindowed form below, at about 60% of the two days that set off the 81%
   * allowance alert. See `scripts/probe-props-reads.mjs`.
   */
  async latestForPlayers(playerIds: string[], window?: SlateWindow): Promise<Map<string, PlayerProp[]>> {
    return this.linesAsOf(playerIds, window, false);
  }

  /**
   * Which of these players carry at least one stored line, anywhere.
   *
   * The odds job's staleness check only needs a yes or no per player, and it
   * used to get it by reading every line every one of them had ever carried
   * ({@link latestForPlayers} with no window: 4,172 rows a call, 275,352 rows
   * over 66 calls on 12 October 2026). The answer is the same here: the
   * slate's lines are read first with the window every screen read uses, so the
   * index from migration 0044 applies, and only a player with nothing in the
   * slate is asked again without one. A player seen in the window is a player
   * with a line, and a player not seen there gets the original question, so no
   * player's answer can differ from the unwindowed read.
   */
  async playersWithAnyLine(playerIds: string[], window: SlateWindow): Promise<Set<string>> {
    const out = new Set<string>();
    if (playerIds.length === 0) return out;
    const inSlate = await this.latestForPlayers(playerIds, window);
    for (const [id, props] of inSlate) if (props.length > 0) out.add(id);
    const rest = playerIds.filter((id) => !out.has(id));
    if (rest.length === 0) return out;
    /*
     * A player with no stored quote at all (a defence, a kicker) cannot have a
     * line in any snapshot, so asking the unwindowed question about him would
     * only make the database walk every weekly snapshot to find nothing. One
     * seek per player on `idx_player_props_player` settles that, whatever scope
     * or week a quote belongs to, and only players with some quote on file are
     * asked the full question.
     */
    const quoted: string[] = [];
    for (const batch of chunk(rest, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `SELECT p.id AS id FROM players p
            WHERE p.id IN (${placeholders})
              AND EXISTS (SELECT 1 FROM player_props pp WHERE pp.player_id = p.id)`,
        )
        .bind(...batch)
        .all<{ id: string }>();
      for (const r of results) quoted.push(String(r.id));
    }
    if (quoted.length === 0) return out;
    const anywhere = await this.latestForPlayers(quoted);
    for (const [id, props] of anywhere) if (props.length > 0) out.add(id);
    return out;
  }

  /**
   * Kickoff per player, from the games in a window.
   *
   * The secondary source, behind the fixture list. `nfl_schedule` is
   * authoritative — it has all thirty-two teams and a kickoff for games nobody
   * has priced — but it is an ingested table that can be empty, and a
   * deployment whose schedule has not been read yet must not lose every
   * kickoff it has. Where a book has quoted a game in the current window, the
   * `game_start` on that snapshot is the same fact from a second source.
   *
   * The window is **required**, unlike on the reads above, and that is the
   * whole difference between this method and the one it replaces. The previous
   * version took the newest snapshot that had ever mentioned the player,
   * whatever week it belonged to, which on the Tuesday of week 2 handed back
   * the previous Sunday's kickoff for nine of ten starters and locked every
   * one of them. A kickoff that may be any week's is worse than no kickoff at
   * all: unknown is never treated as a lock, and a wrong one silently is.
   *
   * ## `+ps.fetched_at`, and why the plus is load-bearing
   *
   * The same trick as `+s2.scope` below, for the sort this time. The rows are
   * few, so sorting them costs nothing; but an `ORDER BY` an index can answer
   * is one SQLite will walk that index to avoid, and `(scope, fetched_at)`
   * answers this one by walking every weekly snapshot of the season. The plus
   * changes no value and no order; it only leaves the planner the window
   * index from migration 0044, which reads this slate's snapshots and no
   * others. Production, 8 October 2026: 2,623 rows a call before.
   */
  async kickoffsForPlayers(playerIds: string[], window: SlateWindow): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 2)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT pp.player_id AS player_id, ps.game_start AS game_start
             FROM player_props pp
             JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.player_id IN (${placeholders})
              AND ps.scope = 'week'
              AND ps.game_start >= ? AND ps.game_start <= ?
            ORDER BY +ps.fetched_at ASC`,
        )
        .bind(...batch, window.from, window.to)
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
  async previousForPlayers(playerIds: string[], window?: SlateWindow): Promise<Map<string, PlayerProp[]>> {
    return this.linesAsOf(playerIds, window, true);
  }

  /**
   * When the weekly market was last *fetched*, and how many games it covers.
   *
   * A reading about the pipeline, not about the data. A row in `prop_snapshots`
   * exists as soon as the provider answered about a game, whether that answer
   * carried a hundred player quotes or none at all — so `events` counts stored
   * envelopes and says nothing whatever about whether a lineup can be ranked.
   * That is a fine thing to report and a disastrous thing to report *as* the
   * market: see {@link pricedPlayerCount}, and `DataHealthService.vegas()`,
   * which needs both and must not confuse them.
   *
   * Deliberately still one query. Eleven callers read this, several of them on
   * paths that run on every recommendation, and D1 bills every row walked —
   * so the expensive question lives in its own method that only the health
   * screen asks.
   *
   * `MAX(fetched_at)` rather than a bare column under `GROUP BY provider`:
   * SQLite fills bare columns from an arbitrary row of the group unless exactly
   * one `min()` or `max()` aggregate is present, in which case it takes them
   * from that row. So `provider` is the newest snapshot's provider by
   * construction, where before it was only accidentally so.
   */
  /**
   * When each of these games was last bought, keyed by event.
   *
   * The per-game question {@link freshness} cannot answer: that is one number
   * for the whole table, and the refresh planner was reading it as the age of
   * every player's lines. See `VegasRefreshService.snapshotAges`.
   */
  async newestFetchByEvent(eventIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(eventIds)].filter(Boolean);
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT event_id, MAX(fetched_at) AS fetched_at FROM prop_snapshots
            WHERE scope = 'week' AND event_id IN (${placeholders})
              AND json_extract(raw_json, '$.topUp') IS NULL
            GROUP BY event_id`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        if (r['fetched_at'] != null) out.set(String(r['event_id']), String(r['fetched_at']));
      }
    }
    return out;
  }

  /**
   * The weekly odds freshness line, counted at most once per odds refresh.
   *
   * The count below walks every weekly snapshot (about 750 rows) and screens ask
   * it about six times a load. It is now kept with the stamp `put` writes, and
   * re-counted only when that stamp moves. Same answer; see `propsFreshness.ts`.
   */
  async freshness(): Promise<PropsFreshness> {
    return cachedPropsFreshness(this.db, () => this.freshnessLive());
  }

  /** Store the freshness answer for the current odds stamp. The five-minute tick calls this. */
  async refreshStoredFreshness(now: number = Date.now()): Promise<StoredFreshnessOutcome> {
    return refreshStoredPropsFreshness(this.db, () => this.freshnessLive(), now);
  }

  /** The live count {@link freshness} stands in for, unchanged. */
  async freshnessLive(): Promise<PropsFreshness> {
    const row = await this.db
      .prepare(
        "SELECT provider, MAX(fetched_at) AS fetched_at, COUNT(DISTINCT event_id) AS events " +
          "FROM prop_snapshots WHERE scope = 'week'",
      )
      .first<Record<string, unknown>>();
    const fetchedAt = row?.['fetched_at'] == null ? null : String(row['fetched_at']);
    if (fetchedAt == null) return { fetchedAt: null, provider: null, events: 0 };
    return {
      fetchedAt,
      provider: row?.['provider'] == null ? null : String(row['provider']),
      events: Number(row?.['events'] ?? 0),
    };
  }

  /**
   * How many players the stored weekly market can actually price.
   *
   * The question {@link freshness} cannot answer and was being asked to.
   * A consensus row, resolved to a player in this app's dictionary, on the
   * newest snapshot of its event — which is exactly the set
   * {@link latestForPlayers} reads, counted rather than returned, because a
   * health screen that asked a different question of a different set of rows
   * would end up describing a market no recommendation is using.
   *
   * On 8 September 2026 the two numbers came apart: Setup reported
   * `Vegas lines: Current · 8h ago` off the envelope count while every player
   * card in the app said no betting market had priced him. Two fixtures had
   * been stored, with zero usable quotes between them.
   *
   * Its own method, and read on the health screen alone. This walks
   * `player_props`, which the recommendation paths have no reason to pay for.
   */
  async pricedPlayerCount(anchor?: string): Promise<number> {
    if (anchor == null) return this.pricedPlayerCountLive();
    return (await this.pricedPlayerCountAsOf(anchor)).value;
  }

  /**
   * The same count, kept in the settings table and re-counted only when the
   * stored weekly market has changed.
   *
   * The live count walks about 5,500 rows (the newest snapshot of every game,
   * joined to its quotes) and was the largest reader on the account: 665,520
   * rows over 120 calls on 12 October 2026, 13% of the daily allowance, to
   * produce one integer that moves only when a snapshot is written. The
   * `anchor` is the newest fetch time and game count, which the health screen
   * has already read from {@link freshness}; a new snapshot changes it, so the
   * count is exact for the data on file, never a day-old guess.
   */
  async pricedPlayerCountAsOf(anchor: string): Promise<{ value: number; asOf: string }> {
    return storedCount(this.db, 'props.priced', anchor, () => this.pricedPlayerCountLive());
  }

  /**
   * Players with a line on the newest look of their game, counting the lines
   * earlier looks wrote and the newest did not repeat (Round 23).
   *
   * The snapshot side is filtered first (a weekly look at or after its game's
   * newest full copy), and only those looks' lines are read through the
   * snapshot index, which is the same set the old "newest copy only" count
   * read for a full copy. A player whose only line has since been withdrawn
   * ("gone" marker newer than it) is not counted.
   */
  private async pricedPlayerCountLive(): Promise<number> {
    const row = await this.db
      .prepare(
        `WITH base AS (
           SELECT event_id, MAX(fetched_at) AS since
             FROM prop_snapshots
            WHERE scope = 'week' AND json_extract(raw_json, '$.delta') IS NULL
            GROUP BY event_id
         ),
         looks AS (
           SELECT ps.id, ps.event_id, ps.fetched_at
             FROM prop_snapshots ps
             LEFT JOIN base ON base.event_id = ps.event_id
            WHERE ps.scope = 'week' AND ps.fetched_at >= COALESCE(base.since, '')
         ),
         lines AS (
           SELECT pp.player_id, pp.market, ps.event_id, pp.consensus_method,
                  ROW_NUMBER() OVER (PARTITION BY pp.player_id, pp.market, ps.event_id
                                     ORDER BY ps.fetched_at DESC, pp.id DESC) AS rn
             FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
            WHERE pp.snapshot_id IN (SELECT id FROM looks) AND pp.player_id IS NOT NULL
         )
         SELECT COUNT(DISTINCT l.player_id) AS priced FROM lines l WHERE l.rn = 1 AND l.consensus_method <> 'none'`,
      )
      .first<{ priced: number }>();
    return Number(row?.priced ?? 0);
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
    ...booksFrom(r['books_json']),
    impliedProbability: r['implied_probability'] == null ? null : Number(r['implied_probability']),
    ...(r['snapshot_fetched_at'] == null
      ? {}
      : {
          snapshot: {
            fetchedAt: String(r['snapshot_fetched_at']),
            total: r['snapshot_total'] == null ? null : Number(r['snapshot_total']),
            spread: r['snapshot_spread'] == null ? null : Number(r['snapshot_spread']),
            spreadTeam: r['snapshot_spread_team'] == null ? null : String(r['snapshot_spread_team']),
          },
        }),
  };
}

/**
 * Stamp the weekly odds as changed, and never let a failed stamp leave a stale count.
 *
 * If the stamp cannot be written, the stored count is deleted instead, so the
 * next reader counts live. Both failing at once (the database refusing writes
 * just after accepting one) is covered by the one-hour backstop in
 * `propsFreshness.ts`. Never throws: the odds are already stored, and the
 * refresh that stored them must carry on exactly as before.
 */
async function markPropsChanged(db: Database): Promise<void> {
  try {
    await stampPropsChange(db);
  } catch {
    forgetPropsFreshness(db);
    await db
      .prepare('DELETE FROM settings WHERE key = ?')
      .bind(PROPS_FRESHNESS_KEY)
      .run()
      .catch(() => undefined);
  }
}

/** One weekly look at a game, as the delta reads need it. */
interface SnapshotRef {
  id: number;
  eventId: string;
  fetchedAt: string;
  /** Written by Round 23's write-on-change path: carries only the lines that changed. */
  delta: boolean;
  total: number | null;
  spread: number | null;
  spreadTeam: string | null;
}

/**
 * The looks whose lines count, newest first.
 *
 * From the newest look (or the one before it, for "previous") back to and
 * including the newest full copy, since a full copy holds every line the game
 * had and anything older is superseded by it. With no full copy at all (a game
 * first bought after Round 23) every look counts.
 */
export function eligibleSnapshots<T extends { delta: boolean }>(newestFirst: readonly T[], previous: boolean): T[] {
  const list = previous ? newestFirst.slice(1) : newestFirst.slice();
  const out: T[] = [];
  for (const s of list) {
    out.push(s);
    if (!s.delta) break;
  }
  return out;
}

/** Is row `a` newer than row `b`, by its look's place in the newest-first order, then by id? */
function isNewer(a: Record<string, unknown>, b: Record<string, unknown>, order: Map<number, number>): boolean {
  const ra = order.get(Number(a['snapshot_id'])) ?? Infinity;
  const rb = order.get(Number(b['snapshot_id'])) ?? Infinity;
  if (ra !== rb) return ra < rb;
  return Number(a['id']) > Number(b['id']);
}

/** `books_json` is a list of names (before Round 23) or of per-book quotes (since). */
function booksFrom(raw: unknown): { books: string[]; bookDetail?: BookQuote[] } {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return { books: [] };
  if (parsed.every((b) => typeof b === 'string')) return { books: parsed as string[] };
  const detail = parsed.filter((b): b is BookQuote => b != null && typeof b === 'object' && typeof (b as BookQuote).book === 'string');
  return { books: [...new Set(detail.filter((b) => !b.out).map((b) => b.book))].sort(), bookDetail: detail };
}

const SNAPSHOT_REF_SELECT = `SELECT id, event_id, fetched_at,
        json_extract(raw_json, '$.delta') AS delta,
        json_extract(raw_json, '$.gameLines.total') AS total,
        json_extract(raw_json, '$.gameLines.spread') AS spread,
        json_extract(raw_json, '$.gameLines.spreadTeam') AS spread_team
   FROM prop_snapshots`;

function addSnapshotRefs(out: Map<string, SnapshotRef[]>, results: Record<string, unknown>[]): Map<string, SnapshotRef[]> {
  for (const r of results) {
    const ref: SnapshotRef = {
      id: Number(r['id']),
      eventId: String(r['event_id']),
      fetchedAt: String(r['fetched_at']),
      delta: r['delta'] === 1 || r['delta'] === true || r['delta'] === 'true',
      total: r['total'] == null ? null : Number(r['total']),
      spread: r['spread'] == null ? null : Number(r['spread']),
      spreadTeam: r['spread_team'] == null ? null : String(r['spread_team']),
    };
    const list = out.get(ref.eventId) ?? [];
    list.push(ref);
    out.set(ref.eventId, list);
  }
  return out;
}

function sortSnapshotRefs(out: Map<string, SnapshotRef[]>): Map<string, SnapshotRef[]> {
  for (const list of out.values()) list.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id);
  return out;
}
