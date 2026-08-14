/**
 * Storage for the published injury report, and for every attempt to fetch it.
 *
 * Two reads, and they are different questions. `latestFor` answers "what is the
 * most recent report about these players", which is what a card and a Start/Sit
 * comparison want. `weeksFor` answers "what has the last few weeks looked like",
 * which is the only way this source can say anything about a direction.
 *
 * Nothing here interprets. Normalization and conflict resolution live in
 * `core/injury/model.ts`, so every screen reads one interpretation rather than
 * arriving at its own.
 */

import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import { normalizePractice, type PracticeStatus } from '../../core/injury/model.ts';
import type { ComparableInjury, InjuryEvent } from '../../core/injury/diff.ts';

export interface StoredInjuryReport {
  playerId: string;
  season: string;
  week: number;
  team: string | null;
  reportStatus: string | null;
  primaryInjury: string | null;
  secondaryInjury: string | null;
  practiceStatus: PracticeStatus;
  practiceRaw: string | null;
  gsisId: string | null;
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
}

export interface InjurySourceRun {
  source: string;
  season: string;
  latestWeek: number | null;
  fetchedAt: string;
  publishedAt: string | null;
  rowsReturned: number;
  matchedById: number;
  matchedByName: number;
  unmatched: number;
  /** `ok` | `not_published` | `failed` — a preseason 404 is not a failure. */
  outcome: 'ok' | 'not_published' | 'failed';
  note: string | null;
  /**
   * Players whose normalized state moved in this ingest.
   *
   * Present only on a run that actually wrote something, and not persisted —
   * it is the hand-off to targeted Start/Sit and Trade recomputation, which is
   * a fact about this invocation rather than about the run's history.
   */
  changedPlayerIds?: string[];
}

/** Bound parameters per row, for D1's cap. */
const REPORT_COLUMNS = 13;

export class InjuryRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert a week's reports.
   *
   * Upsert rather than replace: re-ingesting the same week must be idempotent,
   * and a later file that drops a player must not delete the last thing anyone
   * knew about him. History accumulates by (player, season, week).
   */
  async saveReports(rows: StoredInjuryReport[]): Promise<void> {
    const perStatement = Math.floor(MAX_BOUND_PARAMS / REPORT_COLUMNS);
    for (const batch of chunk(rows, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const row of batch) {
        binds.push(
          row.playerId,
          row.season,
          row.week,
          row.team,
          row.reportStatus,
          row.primaryInjury,
          row.secondaryInjury,
          row.practiceStatus,
          row.practiceRaw,
          row.gsisId,
          row.source,
          row.publishedAt,
          row.fetchedAt,
        );
      }
      await this.db
        .prepare(
          `INSERT INTO player_injury_reports
             (player_id, season, week, team, report_status, primary_injury, secondary_injury,
              practice_status, practice_raw, gsis_id, source, published_at, fetched_at)
           VALUES ${values}
           ON CONFLICT(player_id, season, week) DO UPDATE SET
             team = excluded.team,
             report_status = excluded.report_status,
             primary_injury = excluded.primary_injury,
             secondary_injury = excluded.secondary_injury,
             practice_status = excluded.practice_status,
             practice_raw = excluded.practice_raw,
             gsis_id = excluded.gsis_id,
             source = excluded.source,
             published_at = excluded.published_at,
             fetched_at = excluded.fetched_at`,
        )
        .bind(...binds)
        .run();
    }
  }

  /** The most recent report for each of these players, in one round trip. */
  async latestFor(playerIds: string[], season: string): Promise<Map<string, StoredInjuryReport>> {
    const out = new Map<string, StoredInjuryReport>();
    if (playerIds.length === 0) return out;

    // One bound parameter per id plus the season, chunked against D1's cap.
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT r.* FROM player_injury_reports r
             JOIN (SELECT player_id, MAX(week) AS week
                     FROM player_injury_reports
                    WHERE season = ? AND player_id IN (${holes})
                 GROUP BY player_id) latest
               ON latest.player_id = r.player_id AND latest.week = r.week
            WHERE r.season = ?`,
        )
        .bind(season, ...batch, season)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const report = toReport(row);
        out.set(report.playerId, report);
      }
    }
    return out;
  }

  /**
   * The last few weeks for one player, oldest first.
   *
   * Used to say which way a practice status is heading — and only ever for one
   * player at a time, because it is read on an opened card rather than for
   * forty rows of a board.
   */
  async weeksFor(playerId: string, season: string, weeks = 3): Promise<StoredInjuryReport[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM player_injury_reports
          WHERE player_id = ? AND season = ?
       ORDER BY week DESC LIMIT ?`,
      )
      .bind(playerId, season, Math.max(1, weeks))
      .all<Record<string, unknown>>();
    return (results ?? []).map(toReport).reverse();
  }

  /**
   * The oldest week below `through` that has no stored rows at all.
   *
   * Used by catch-up to find the hole an outage left. Deliberately asks for the
   * *oldest* gap rather than the newest: filling forward keeps the stored weeks
   * contiguous as they arrive, so a practice trend read part-way through a
   * catch-up is computed over a run of real weeks rather than over a gap.
   *
   * Returns null when there is no gap, which is the ordinary case and the one
   * this must answer cheaply -- it is asked on every tick.
   */
  async missingWeekBefore(season: string, through: number): Promise<number | null> {
    if (!Number.isFinite(through) || through <= 1) return null;
    const { results } = await this.db
      .prepare(`SELECT DISTINCT week FROM player_injury_reports WHERE season = ? AND week <= ? ORDER BY week`)
      .bind(season, through)
      .all<{ week: number }>();
    const present = new Set((results ?? []).map((r) => Number(r.week)));
    if (present.size === 0) return null;
    const earliest = Math.min(...present);
    for (let week = earliest; week < through; week++) {
      if (!present.has(week)) return week;
    }
    return null;
  }

  async recordRun(run: InjurySourceRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO injury_source_runs
           (source, season, latest_week, fetched_at, published_at, rows_returned,
            matched_by_id, matched_by_name, unmatched, outcome, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.source,
        run.season,
        run.latestWeek,
        run.fetchedAt,
        run.publishedAt,
        run.rowsReturned,
        run.matchedById,
        run.matchedByName,
        run.unmatched,
        run.outcome,
        run.note,
      )
      .run();
  }

  async latestRun(): Promise<InjurySourceRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1`)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      source: String(row['source']),
      season: String(row['season']),
      latestWeek: row['latest_week'] == null ? null : Number(row['latest_week']),
      fetchedAt: String(row['fetched_at']),
      publishedAt: row['published_at'] == null ? null : String(row['published_at']),
      rowsReturned: Number(row['rows_returned'] ?? 0),
      matchedById: Number(row['matched_by_id'] ?? 0),
      matchedByName: Number(row['matched_by_name'] ?? 0),
      unmatched: Number(row['unmatched'] ?? 0),
      outcome: String(row['outcome']) as InjurySourceRun['outcome'],
      note: row['note'] == null ? null : String(row['note']),
    };
  }

  /** How many players the store currently holds a report for, this season. */
  async coverage(season: string): Promise<{ players: number; latestWeek: number | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT player_id) AS players, MAX(week) AS latest_week
           FROM player_injury_reports WHERE season = ?`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      players: Number(row?.['players'] ?? 0),
      latestWeek: row?.['latest_week'] == null ? null : Number(row['latest_week']),
    };
  }
}

function toReport(row: Record<string, unknown>): StoredInjuryReport {
  return {
    playerId: String(row['player_id']),
    season: String(row['season']),
    week: Number(row['week']),
    team: row['team'] == null ? null : String(row['team']),
    reportStatus: row['report_status'] == null ? null : String(row['report_status']),
    primaryInjury: row['primary_injury'] == null ? null : String(row['primary_injury']),
    secondaryInjury: row['secondary_injury'] == null ? null : String(row['secondary_injury']),
    practiceStatus: normalizePractice(row['practice_status'] == null ? null : String(row['practice_status'])),
    practiceRaw: row['practice_raw'] == null ? null : String(row['practice_raw']),
    gsisId: row['gsis_id'] == null ? null : String(row['gsis_id']),
    source: String(row['source']),
    publishedAt: row['published_at'] == null ? null : String(row['published_at']),
    fetchedAt: String(row['fetched_at']),
  };
}


/** What we last saw upstream, and who currently holds the ingest lease. */
export interface InjurySourceState {
  source: string;
  season: string;
  etag: string | null;
  lastModified: string | null;
  /** When we last asked. Moves every tick, change or no change. */
  checkedAt: string | null;
  /** When the FILE last changed. The one that belongs next to a designation. */
  sourceModifiedAt: string | null;
  /** When we last actually stored something. */
  ingestedAt: string | null;
  lastOutcome: string | null;
  lastNote: string | null;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  /**
   * Ingests that started and did not finish, in a row.
   *
   * The number that stops a fresh `checkedAt` from vouching for stale data: a
   * pipeline checking happily every five minutes while four consecutive ingests
   * died is not healthy, and only this can say so.
   */
  consecutiveFailures: number;
  /** When the current run of failures began. Null while the count is zero. */
  failingSince: string | null;
  /** The highest week actually stored, so a gap against the source is visible. */
  caughtUpThrough: number | null;
}

/**
 * Storage for the five-minute check: the fingerprint, the lease, the events and
 * the write budget.
 *
 * Split from {@link InjuryRepo} only by concern, not by table ownership — it is
 * the same database and the same migration. Kept in one class so the ingest
 * reads and writes its own bookkeeping without threading two repositories
 * through every call.
 */
export class InjurySourceRepo {
  constructor(private readonly db: Database) {}

  async get(source: string, season: string): Promise<InjurySourceState | null> {
    const row = await this.db
      .prepare(`SELECT * FROM injury_source_state WHERE source = ? AND season = ?`)
      .bind(source, season)
      .first<Record<string, unknown>>();
    return row ? toSourceState(row) : null;
  }

  /**
   * Record that we looked.
   *
   * Deliberately separate from recording that we *stored* something: the common
   * tick updates only `checked_at`, which is one write against a one-row table
   * and is what keeps "is the pipeline alive" answerable without pretending the
   * data is newer than it is.
   */
  async recordCheck(
    source: string,
    season: string,
    patch: {
      checkedAt: string;
      etag?: string | null;
      lastModified?: string | null;
      sourceModifiedAt?: string | null;
      ingestedAt?: string | null;
      outcome: string;
      note: string | null;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO injury_source_state
           (source, season, etag, last_modified, checked_at, source_modified_at, ingested_at,
            last_outcome, last_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, season) DO UPDATE SET
           -- COALESCE so a check that learned nothing new does not erase what
           -- an earlier successful ingest already established.
           etag = COALESCE(excluded.etag, etag),
           last_modified = COALESCE(excluded.last_modified, last_modified),
           checked_at = excluded.checked_at,
           source_modified_at = COALESCE(excluded.source_modified_at, source_modified_at),
           ingested_at = COALESCE(excluded.ingested_at, ingested_at),
           last_outcome = excluded.last_outcome,
           last_note = excluded.last_note`,
      )
      .bind(
        source,
        season,
        patch.etag ?? null,
        patch.lastModified ?? null,
        patch.checkedAt,
        patch.sourceModifiedAt ?? null,
        patch.ingestedAt ?? null,
        patch.outcome,
        patch.note,
      )
      .run();
  }

  /**
   * Claim the right to ingest, or find out somebody else has it.
   *
   * A compare-and-swap, because D1 has no advisory locks: the UPDATE only
   * matches a row whose lease is absent or expired, and SQLite reports how many
   * rows it changed. One means it is ours. Zero means another invocation is
   * mid-ingest and this one should stop — downloading and parsing the same file
   * twice concurrently is exactly the waste the five-minute cadence could
   * otherwise cause.
   *
   * The lease expires rather than being released, so a Worker killed mid-parse
   * cannot wedge the pipeline: the first tick after expiry takes over.
   */
  /**
   * Record that an ingest did not finish.
   *
   * Separate from `recordCheck` because the two answer different questions and
   * a failed ingest must not be allowed to look like a check that found nothing.
   * `failing_since` is set only on the transition into failure, so it keeps
   * saying when the trouble started rather than when it was last observed.
   */
  async recordIngestFailure(source: string, season: string, at: string, note: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE injury_source_state
            SET consecutive_failures = consecutive_failures + 1,
                failing_since = COALESCE(failing_since, ?),
                last_outcome = 'ingest_failed',
                last_note = ?
          WHERE source = ? AND season = ?`,
      )
      .bind(at, note, source, season)
      .run();
  }

  /**
   * Record that an ingest finished.
   *
   * Including one that finished with nothing to write: an unchanged source is a
   * healthy answer, and a run of them should not look like a run of failures.
   */
  async recordIngestSuccess(source: string, season: string, caughtUpThrough: number | null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE injury_source_state
            SET consecutive_failures = 0,
                failing_since = NULL,
                caught_up_through = COALESCE(?, caught_up_through)
          WHERE source = ? AND season = ?`,
      )
      .bind(caughtUpThrough, source, season)
      .run();
  }

  async acquireLock(
    source: string,
    season: string,
    owner: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const nowIso = now.toISOString();

    // The row may not exist on a first ever run; insert it unlocked, ignoring a
    // race where somebody else inserted it first.
    await this.db
      .prepare(
        `INSERT INTO injury_source_state (source, season, checked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source, season) DO NOTHING`,
      )
      .bind(source, season, nowIso)
      .run();

    const result = await this.db
      .prepare(
        `UPDATE injury_source_state
            SET lock_owner = ?, lock_expires_at = ?
          WHERE source = ? AND season = ?
            AND (lock_expires_at IS NULL OR lock_expires_at < ?)`,
      )
      .bind(owner, expiresAt, source, season, nowIso)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  /** Give it back early. Only the owner may, so a late finisher cannot free a lease it lost. */
  async releaseLock(source: string, season: string, owner: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE injury_source_state SET lock_owner = NULL, lock_expires_at = NULL
          WHERE source = ? AND season = ? AND lock_owner = ?`,
      )
      .bind(source, season, owner)
      .run();
  }

  // ------------------------------------------------------------------ events

  /**
   * Append transitions, ignoring ones already recorded.
   *
   * `event_key` is the primary key and is derived from the transition itself,
   * so `DO NOTHING` is what makes re-ingesting an unchanged file free rather
   * than duplicative.
   */
  async recordEvents(events: InjuryEvent[], meta: { source: string; sourceModifiedAt: string | null; detectedAt: string }): Promise<number> {
    if (events.length === 0) return 0;
    let written = 0;
    const perStatement = Math.floor(MAX_BOUND_PARAMS / 10);
    for (const batch of chunk(events, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const e of batch) {
        binds.push(
          e.eventKey,
          e.playerId,
          e.season,
          e.week,
          e.kind,
          e.from,
          e.to,
          meta.source,
          meta.sourceModifiedAt,
          meta.detectedAt,
        );
      }
      const result = await this.db
        .prepare(
          `INSERT INTO injury_events
             (event_key, player_id, season, week, kind, from_value, to_value, source,
              source_modified_at, detected_at)
           VALUES ${values}
           ON CONFLICT(event_key) DO NOTHING`,
        )
        .bind(...binds)
        .run();
      written += result.meta.changes ?? 0;
    }
    return written;
  }

  /** The most recent transitions, for diagnostics and for "what changed since". */
  async recentEvents(limit = 20): Promise<
    { playerId: string; season: string; week: number; kind: string; from: string | null; to: string | null; detectedAt: string }[]
  > {
    const { results } = await this.db
      .prepare(
        `SELECT player_id, season, week, kind, from_value, to_value, detected_at
           FROM injury_events ORDER BY detected_at DESC, rowid DESC LIMIT ?`,
      )
      .bind(Math.max(1, limit))
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => ({
      playerId: String(row['player_id']),
      season: String(row['season']),
      week: Number(row['week']),
      kind: String(row['kind']),
      from: row['from_value'] == null ? null : String(row['from_value']),
      to: row['to_value'] == null ? null : String(row['to_value']),
      detectedAt: String(row['detected_at']),
    }));
  }

  // ------------------------------------------------------------ write budget

  /** How many rows this pipeline has written today (UTC, matching D1's reset). */
  async writesToday(day: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT rows_written FROM injury_write_budget WHERE day = ?`)
      .bind(day)
      .first<Record<string, unknown>>();
    return Number(row?.['rows_written'] ?? 0);
  }

  async addWrites(day: string, rows: number, now: string): Promise<void> {
    if (rows <= 0) return;
    await this.db
      .prepare(
        `INSERT INTO injury_write_budget (day, rows_written, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           rows_written = rows_written + excluded.rows_written,
           updated_at = excluded.updated_at`,
      )
      .bind(day, rows, now)
      .run();
  }

  /**
   * The stored rows the incoming ingest would overwrite, keyed for the diff.
   *
   * Reads only the (player, week) pairs the file actually contains, so the
   * comparison costs one read of roughly the same size as the ingest rather
   * than a scan of the season.
   */
  async comparableFor(keys: { playerId: string; week: number }[], season: string): Promise<Map<string, ComparableInjury>> {
    const out = new Map<string, ComparableInjury>();
    if (keys.length === 0) return out;

    const ids = [...new Set(keys.map((k) => k.playerId))];
    const weeks = [...new Set(keys.map((k) => k.week))];
    // Bounded by the parameter cap: chunk the players, and pass the weeks whole
    // since a season has at most a couple of dozen.
    for (const batch of chunk(ids, Math.max(1, MAX_BOUND_PARAMS - weeks.length - 1))) {
      const idHoles = batch.map(() => '?').join(', ');
      const weekHoles = weeks.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT player_id, season, week, report_status, primary_injury, practice_status
             FROM player_injury_reports
            WHERE season = ? AND player_id IN (${idHoles}) AND week IN (${weekHoles})`,
        )
        .bind(season, ...batch, ...weeks)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const item: ComparableInjury = {
          playerId: String(row['player_id']),
          season: String(row['season']),
          week: Number(row['week']),
          reportStatus: row['report_status'] == null ? null : String(row['report_status']),
          primaryInjury: row['primary_injury'] == null ? null : String(row['primary_injury']),
          practiceStatus: normalizePractice(row['practice_status'] == null ? null : String(row['practice_status'])),
        };
        out.set(`${item.playerId}:${item.season}:${item.week}`, item);
      }
    }
    return out;
  }

  /** How many rows the store holds for a season, for the anomaly guard. */
  async storedCount(season: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM player_injury_reports WHERE season = ?`)
      .bind(season)
      .first<Record<string, unknown>>();
    return Number(row?.['n'] ?? 0);
  }
}

function toSourceState(row: Record<string, unknown>): InjurySourceState {
  const text = (key: string) => (row[key] == null ? null : String(row[key]));
  return {
    source: String(row['source']),
    season: String(row['season']),
    etag: text('etag'),
    lastModified: text('last_modified'),
    checkedAt: text('checked_at'),
    sourceModifiedAt: text('source_modified_at'),
    ingestedAt: text('ingested_at'),
    lastOutcome: text('last_outcome'),
    lastNote: text('last_note'),
    lockOwner: text('lock_owner'),
    lockExpiresAt: text('lock_expires_at'),
    consecutiveFailures: Number(row['consecutive_failures'] ?? 0),
    failingSince: text('failing_since'),
    caughtUpThrough: row['caught_up_through'] == null ? null : Number(row['caught_up_through']),
  };
}
