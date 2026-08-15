/**
 * What we last saw upstream, for any published file this app reads.
 *
 * Two feeds now depend on the same four mechanisms — a stored validator so a
 * check costs no bytes, a lease so two invocations cannot ingest the same file
 * at once, a count of consecutive failures so a fresh `checked_at` cannot vouch
 * for stale data, and a daily write ledger so a bug cannot spend the free-tier
 * D1 budget in an afternoon. The injury report proved all four in production;
 * usage needs the same four.
 *
 * So they live here once, parameterized by table name, rather than being copied
 * with the words changed. `injury_source_state` and `usage_source_state` are
 * column-for-column identical by design, and the migration that adds the second
 * says so.
 *
 * The table names are compile-time constants supplied by the two subclasses and
 * never anything a request can influence; every value is bound.
 */

import type { Database } from '../db.ts';

export interface SourceState {
  source: string;
  season: string;
  etag: string | null;
  lastModified: string | null;
  /** When we last asked. Moves every tick, change or no change. */
  checkedAt: string | null;
  /** When the FILE last changed. The one that belongs next to a number on a card. */
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
   * pipeline checking happily on schedule while four consecutive ingests died
   * is not healthy, and only this can say so.
   */
  consecutiveFailures: number;
  /** When the current run of failures began. Null while the count is zero. */
  failingSince: string | null;
  /** The highest week actually stored, so a gap against the source is visible. */
  caughtUpThrough: number | null;
}

export class SourceStateRepo {
  constructor(
    protected readonly db: Database,
    /** The state table for this feed. A constant, never request-derived. */
    private readonly stateTable: string,
    /** The daily write ledger for this feed. Separate per pipeline on purpose. */
    private readonly budgetTable: string,
  ) {}

  async get(source: string, season: string): Promise<SourceState | null> {
    const row = await this.db
      .prepare(`SELECT * FROM ${this.stateTable} WHERE source = ? AND season = ?`)
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
        `INSERT INTO ${this.stateTable}
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
        `UPDATE ${this.stateTable}
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
        `UPDATE ${this.stateTable}
            SET consecutive_failures = 0,
                failing_since = NULL,
                caught_up_through = COALESCE(?, caught_up_through)
          WHERE source = ? AND season = ?`,
      )
      .bind(caughtUpThrough, source, season)
      .run();
  }

  /**
   * Claim the right to ingest, or find out somebody else has it.
   *
   * A compare-and-swap, because D1 has no advisory locks: the UPDATE only
   * matches a row whose lease is absent or expired, and SQLite reports how many
   * rows it changed. One means it is ours. Zero means another invocation is
   * mid-ingest and this one should stop — downloading and parsing the same file
   * twice concurrently is exactly the waste a frequent cadence could cause.
   *
   * The lease expires rather than being released, so a Worker killed mid-parse
   * cannot wedge the pipeline: the first tick after expiry takes over.
   */
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
        `INSERT INTO ${this.stateTable} (source, season, checked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source, season) DO NOTHING`,
      )
      .bind(source, season, nowIso)
      .run();

    const result = await this.db
      .prepare(
        `UPDATE ${this.stateTable}
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
        `UPDATE ${this.stateTable} SET lock_owner = NULL, lock_expires_at = NULL
          WHERE source = ? AND season = ? AND lock_owner = ?`,
      )
      .bind(source, season, owner)
      .run();
  }

  // ------------------------------------------------------------ write budget

  /** How many rows this pipeline has written today (UTC, matching D1's reset). */
  async writesToday(day: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT rows_written FROM ${this.budgetTable} WHERE day = ?`)
      .bind(day)
      .first<Record<string, unknown>>();
    return Number(row?.['rows_written'] ?? 0);
  }

  async addWrites(day: string, rows: number, now: string): Promise<void> {
    if (rows <= 0) return;
    await this.db
      .prepare(
        `INSERT INTO ${this.budgetTable} (day, rows_written, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           rows_written = rows_written + excluded.rows_written,
           updated_at = excluded.updated_at`,
      )
      .bind(day, rows, now)
      .run();
  }
}

export function toSourceState(row: Record<string, unknown>): SourceState {
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
