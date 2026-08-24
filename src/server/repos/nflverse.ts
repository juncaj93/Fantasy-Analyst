/**
 * Storage for the three nflverse sources Projection v2 added: the identity
 * crosswalk, snap counts and depth charts.
 *
 * Nothing here interprets. Which rank means what, how a share is computed and
 * what counts as a role change all live in `core/nflverse/` and
 * `core/projection/`, so every reader arrives at the same answer rather than
 * building its own.
 *
 * The one policy decision that does live here is {@link DepthChartRepo.prune}:
 * the source publishes every daily capture of a whole season and this keeps two.
 * That is a storage decision rather than a modelling one — change detection
 * compares the current chart with the previous one, and a chart from October is
 * not evidence about this week — and it is what keeps the table at roughly two
 * thousand rows instead of half a million.
 */

import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import { SourceStateRepo } from './sourceState.ts';
import type { IdentityLink } from '../../core/nflverse/roster.ts';
import type { DepthRole, DepthSchema } from '../../core/nflverse/depthChart.ts';

/** One stored snap-count row, in the shape the read path holds it. */
export interface StoredSnapWeek {
  playerId: string;
  season: string;
  week: number;
  /** `REG`, or one of `WC` / `DIV` / `CON` / `SB`. Never `POST` — see 0030. */
  gameType: string;
  team: string | null;
  opponent: string | null;
  position: string | null;
  offenseSnaps: number | null;
  offenseShare: number | null;
  pfrId: string | null;
  gsisId: string | null;
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
}

/** One stored depth-chart entry. */
export interface StoredDepthEntry {
  season: string;
  capturedAt: string;
  gsisId: string;
  team: string;
  playerName: string | null;
  position: string;
  posGroup: string | null;
  posSlot: number | null;
  posRank: number;
  starterSlots: number | null;
  schemaVersion: DepthSchema;
  source: string;
  fetchedAt: string;
}

/** One ingest attempt, per feed. */
export interface NflverseSourceRun {
  source: string;
  season: string;
  week: number | null;
  fetchedAt: string;
  publishedAt: string | null;
  rowsReturned: number;
  matched: number;
  unmatched: number;
  rowsWritten: number;
  outcome: 'ok' | 'not_modified' | 'not_published' | 'failed';
  note: string | null;
}

const IDENTITY_COLUMNS = 13;
const SNAP_COLUMNS = 14;
const DEPTH_COLUMNS = 13;

/**
 * Statements sent to D1 in one round trip.
 *
 * The reason this exists rather than a loop of awaits: a roster ingest writes
 * 915 rows, and at 90 bound parameters per statement and 13 columns per row
 * that is six rows a statement and **153 statements**. Awaited one at a time
 * inside a cron, that is 153 round trips of network latency for a job that has
 * no reason to take more than a handful — and the failure mode is a timeout on
 * a slow morning rather than an error anybody can read.
 *
 * `batch` runs its statements in a transaction on D1 and `NodeSqliteDatabase`
 * mirrors that, so the failure semantics are the same either way: a half-written
 * crosswalk is not a state either can produce.
 */
const STATEMENTS_PER_BATCH = 40;

/**
 * Insert many rows as multi-row `VALUES` statements, batched.
 *
 * Shared by all three stores because they differ only in their column list and
 * their conflict clause, and three copies of this arithmetic is three places for
 * the parameter cap to be got wrong by one.
 */
async function insertRows<T>(
  db: Database,
  rows: T[],
  columns: number,
  sql: (values: string) => string,
  bind: (row: T) => (string | number | null)[],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns));
  const statements = chunk(rows, perStatement).map((batch) => {
    const values = batch.map(() => `(${new Array(columns).fill('?').join(', ')})`).join(', ');
    const binds: (string | number | null)[] = [];
    for (const row of batch) binds.push(...bind(row));
    return db.prepare(sql(values)).bind(...binds);
  });
  for (const group of chunk(statements, STATEMENTS_PER_BATCH)) {
    await db.batch(group);
  }
}

// ------------------------------------------------------------- identity ---

export class IdentityCrosswalkRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert the crosswalk.
   *
   * Upsert rather than replace, for the same reason the usage ingest upserts: a
   * later roster file that no longer mentions a player must not delete the
   * mapping that lets his stored history be read. A retired player's identifier
   * tuple does not stop being true.
   */
  async save(links: (IdentityLink & { fullName?: string | null; status?: string | null })[], fetchedAt: string): Promise<void> {
    await insertRows(
      this.db,
      links,
      IDENTITY_COLUMNS,
      (values) =>
        `INSERT INTO nflverse_identity
           (gsis_id, season, sleeper_id, pfr_id, espn_id, yahoo_id, team, position,
            full_name, status, source, as_of, fetched_at)
         VALUES ${values}
         ON CONFLICT(gsis_id, season) DO UPDATE SET
           sleeper_id = excluded.sleeper_id,
           pfr_id = excluded.pfr_id,
           espn_id = excluded.espn_id,
           yahoo_id = excluded.yahoo_id,
           team = excluded.team,
           position = excluded.position,
           full_name = excluded.full_name,
           status = excluded.status,
           source = excluded.source,
           as_of = excluded.as_of,
           fetched_at = excluded.fetched_at`,
      (link) => [
        link.gsisId,
        link.season,
        link.sleeperId,
        link.pfrId,
        link.espnId,
        link.yahooId,
        link.team,
        link.position,
        link.fullName ?? null,
        link.status ?? null,
        link.source,
        link.asOf,
        fetchedAt,
      ],
    );
  }

  /** The whole crosswalk for a season. It is ~900 rows; the resolver wants all of it. */
  async forSeason(season: string): Promise<(IdentityLink & { fullName: string | null; status: string | null })[]> {
    const { results } = await this.db
      .prepare(
        `SELECT gsis_id, season, sleeper_id, pfr_id, espn_id, yahoo_id, team, position,
                full_name, status, source, as_of
           FROM nflverse_identity WHERE season = ?`,
      )
      .bind(season)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => ({
      gsisId: String(row['gsis_id']),
      season: String(row['season']),
      sleeperId: str(row['sleeper_id']),
      pfrId: str(row['pfr_id']),
      espnId: str(row['espn_id']),
      yahooId: str(row['yahoo_id']),
      team: str(row['team']),
      position: String(row['position'] ?? ''),
      fullName: str(row['full_name']),
      status: str(row['status']),
      source: String(row['source'] ?? ''),
      asOf: str(row['as_of']),
    }));
  }

  /** How much of the crosswalk is usable, for the health panel and the closeout. */
  async coverage(season: string): Promise<{ rows: number; withSleeper: number; withPfr: number; asOf: string | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS rows_stored,
                SUM(CASE WHEN sleeper_id IS NOT NULL THEN 1 ELSE 0 END) AS with_sleeper,
                SUM(CASE WHEN pfr_id IS NOT NULL THEN 1 ELSE 0 END) AS with_pfr,
                MAX(as_of) AS as_of
           FROM nflverse_identity WHERE season = ?`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      rows: Number(row?.['rows_stored'] ?? 0),
      withSleeper: Number(row?.['with_sleeper'] ?? 0),
      withPfr: Number(row?.['with_pfr'] ?? 0),
      asOf: str(row?.['as_of']),
    };
  }
}

// ---------------------------------------------------------------- snaps ---

export class SnapCountRepo {
  constructor(private readonly db: Database) {}

  async saveWeeks(rows: StoredSnapWeek[]): Promise<void> {
    await insertRows(
      this.db,
      rows,
      SNAP_COLUMNS,
      (values) =>
        `INSERT INTO player_snap_weeks
           (player_id, season, week, game_type, team, opponent, position,
            offense_snaps, offense_share, pfr_id, gsis_id, source, published_at, fetched_at)
         VALUES ${values}
         ON CONFLICT(player_id, season, week) DO UPDATE SET
           game_type = excluded.game_type,
           team = excluded.team,
           opponent = excluded.opponent,
           position = excluded.position,
           offense_snaps = excluded.offense_snaps,
           offense_share = excluded.offense_share,
           pfr_id = excluded.pfr_id,
           gsis_id = excluded.gsis_id,
           source = excluded.source,
           published_at = excluded.published_at,
           fetched_at = excluded.fetched_at`,
      (row) => [
        row.playerId,
        row.season,
        row.week,
        row.gameType,
        row.team,
        row.opponent,
        row.position,
        row.offenseSnaps,
        row.offenseShare,
        row.pfrId,
        row.gsisId,
        row.source,
        row.publishedAt,
        row.fetchedAt,
      ],
    );
  }

  /** Regular-season snap weeks for a set of players, oldest first. */
  async weeksFor(playerIds: string[], season: string): Promise<Map<string, StoredSnapWeek[]>> {
    const out = new Map<string, StoredSnapWeek[]>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT * FROM player_snap_weeks
            WHERE season = ? AND player_id IN (${holes})
         ORDER BY week`,
        )
        .bind(season, ...batch)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const week = toSnapWeek(row);
        const list = out.get(week.playerId);
        if (list) list.push(week);
        else out.set(week.playerId, [week]);
      }
    }
    return out;
  }

  async coverage(season: string): Promise<{ players: number; weeks: number; latestWeek: number | null; rows: number }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week) AS weeks,
                MAX(week) AS latest_week, COUNT(*) AS rows_stored
           FROM player_snap_weeks WHERE season = ? AND game_type = 'REG'`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      players: Number(row?.['players'] ?? 0),
      weeks: Number(row?.['weeks'] ?? 0),
      latestWeek: row?.['latest_week'] == null ? null : Number(row['latest_week']),
      rows: Number(row?.['rows_stored'] ?? 0),
    };
  }
}

// ---------------------------------------------------------- depth charts ---

export class DepthChartRepo {
  constructor(private readonly db: Database) {}

  async saveSnapshot(rows: StoredDepthEntry[]): Promise<void> {
    await insertRows(
      this.db,
      rows,
      DEPTH_COLUMNS,
      (values) =>
        `INSERT INTO depth_chart_entries
           (season, captured_at, gsis_id, team, player_name, position, pos_group,
            pos_slot, pos_rank, starter_slots, schema_version, source, fetched_at)
         VALUES ${values}
         ON CONFLICT(season, captured_at, gsis_id) DO UPDATE SET
           team = excluded.team,
           player_name = excluded.player_name,
           position = excluded.position,
           pos_group = excluded.pos_group,
           pos_slot = excluded.pos_slot,
           pos_rank = excluded.pos_rank,
           starter_slots = excluded.starter_slots,
           schema_version = excluded.schema_version`,
      (row) => [
        row.season,
        row.capturedAt,
        row.gsisId,
        row.team,
        row.playerName,
        row.position,
        row.posGroup,
        row.posSlot,
        row.posRank,
        row.starterSlots,
        row.schemaVersion,
        row.source,
        row.fetchedAt,
      ],
    );
  }

  /** The capture times held for a season, newest first. */
  async captures(season: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT captured_at FROM depth_chart_entries
          WHERE season = ? ORDER BY captured_at DESC`,
      )
      .bind(season)
      .all<{ captured_at: string }>();
    return (results ?? []).map((r) => String(r.captured_at));
  }

  /**
   * Keep the newest `keep` captures and delete the rest.
   *
   * Two is enough for every question this phase asks — what the chart says now,
   * and what it said before — and the alternative is half a million rows a
   * season for a signal that is explicitly bounded to a role *change*.
   */
  async prune(season: string, keep = 2): Promise<number> {
    const captures = await this.captures(season);
    if (captures.length <= keep) return 0;
    const doomed = captures.slice(keep);
    let removed = 0;
    for (const batch of chunk(doomed, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const result = await this.db
        .prepare(`DELETE FROM depth_chart_entries WHERE season = ? AND captured_at IN (${holes})`)
        .bind(season, ...batch)
        .run();
      removed += Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    }
    return removed;
  }

  /** One capture, as `DepthRole` per `gsis_id`, ready for the change detector. */
  async rolesAt(season: string, capturedAt: string): Promise<Map<string, DepthRole>> {
    const { results } = await this.db
      .prepare(
        `SELECT gsis_id, team, position, pos_group, pos_slot, pos_rank, starter_slots
           FROM depth_chart_entries WHERE season = ? AND captured_at = ?`,
      )
      .bind(season, capturedAt)
      .all<Record<string, unknown>>();
    const out = new Map<string, DepthRole>();
    for (const row of results ?? []) {
      const starterSlots = row['starter_slots'] == null ? 1 : Number(row['starter_slots']);
      const rank = Number(row['pos_rank']);
      out.set(String(row['gsis_id']), {
        team: String(row['team']),
        position: String(row['position']),
        group: str(row['pos_group']),
        rank,
        slot: row['pos_slot'] == null ? null : Number(row['pos_slot']),
        starterSlots,
        isStarter: rank <= starterSlots,
      });
    }
    return out;
  }

  /**
   * Everyone ranked above a given rank on one capture, for one club and position.
   *
   * The input to the `depth_plus_roster` corroboration test: a promotion is
   * worth more when the player who was ahead of him has left.
   */
  async aheadOf(
    season: string,
    capturedAt: string,
    team: string,
    position: string,
    rank: number,
  ): Promise<{ gsisId: string; rank: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT gsis_id, pos_rank FROM depth_chart_entries
          WHERE season = ? AND captured_at = ? AND team = ? AND position = ? AND pos_rank < ?
       ORDER BY pos_rank`,
      )
      .bind(season, capturedAt, team, position, rank)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => ({ gsisId: String(row['gsis_id']), rank: Number(row['pos_rank']) }));
  }
}

// --------------------------------------------------------- source health ---

/**
 * The fingerprint, the lease, the failure counter and the write ledger for all
 * three feeds.
 *
 * `nflverse_source_state` is column-for-column what `usage_source_state` and
 * `injury_source_state` are, so this inherits every mechanism rather than
 * reimplementing three of them. The `source` key separates the feeds inside it.
 */
export class NflverseSourceRepo extends SourceStateRepo {
  constructor(db: Database) {
    super(db, 'nflverse_source_state', 'nflverse_write_budget');
  }
}

export class NflverseRunRepo {
  constructor(private readonly db: Database) {}

  async record(run: NflverseSourceRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO nflverse_source_runs
           (source, season, week, fetched_at, published_at, rows_returned, matched, unmatched, rows_written, outcome, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        run.source,
        run.season,
        run.week,
        run.fetchedAt,
        run.publishedAt,
        run.rowsReturned,
        run.matched,
        run.unmatched,
        run.rowsWritten,
        run.outcome,
        run.note,
      )
      .run();
  }

  async latest(source: string): Promise<NflverseSourceRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM nflverse_source_runs WHERE source = ? ORDER BY fetched_at DESC LIMIT 1`)
      .bind(source)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      source: String(row['source']),
      season: String(row['season']),
      week: row['week'] == null ? null : Number(row['week']),
      fetchedAt: String(row['fetched_at']),
      publishedAt: str(row['published_at']),
      rowsReturned: Number(row['rows_returned'] ?? 0),
      matched: Number(row['matched'] ?? 0),
      unmatched: Number(row['unmatched'] ?? 0),
      rowsWritten: Number(row['rows_written'] ?? 0),
      outcome: String(row['outcome'] ?? 'failed') as NflverseSourceRun['outcome'],
      note: str(row['note']),
    };
  }
}

function toSnapWeek(row: Record<string, unknown>): StoredSnapWeek {
  return {
    playerId: String(row['player_id']),
    season: String(row['season']),
    week: Number(row['week']),
    gameType: String(row['game_type'] ?? 'REG'),
    team: str(row['team']),
    opponent: str(row['opponent']),
    position: str(row['position']),
    offenseSnaps: numberOrNull(row['offense_snaps']),
    offenseShare: numberOrNull(row['offense_share']),
    pfrId: str(row['pfr_id']),
    gsisId: str(row['gsis_id']),
    source: String(row['source'] ?? ''),
    publishedAt: str(row['published_at']),
    fetchedAt: String(row['fetched_at'] ?? ''),
  };
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
