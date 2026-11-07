/**
 * The player list, kept where a fresh Worker can read it in a few rows.
 *
 * ## Why this exists
 *
 * `PlayerRepo.listAll` already holds the list in memory for an hour, so a warm
 * Worker never re-reads it. A cold one does, and Workers go cold all the time:
 * on 5 November 2026 the full list was read 206 times, 3,310 rows each, for
 * 681,860 rows (16.3% of the day's 5,000,000). The memory memo cannot help with
 * that, because a new Worker starts with an empty memory.
 *
 * So the list is also stored, already read, in a handful of rows of the
 * `settings` key/value table (no schema change: new keys, like the stored
 * player counts beside it). A cold Worker reads those few rows instead of
 * walking all 3,310 players. D1 bills rows, not bytes, so a few large rows
 * cost a few rows.
 *
 * ## Never older than the last download
 *
 * Every stored copy carries the download stamp it was built for
 * (`sleeper.players.lastSuccessAt`, written when a download succeeds). It is
 * used only while that stamp is still the current one:
 *
 *   - the stamp is re-read at most every {@link VERSION_CHECK_MS} per Worker,
 *     one row, so a Worker that already holds the list in memory notices a
 *     new download within seconds, not at the end of its hour;
 *   - a stored copy whose stamp does not match is ignored, and the reader falls
 *     back to the full read, exactly as before this existed;
 *   - the copy is rebuilt by the five-minute tick once a new stamp appears
 *     ({@link refreshPlayerListSnapshot}), so the full read happens once per
 *     download instead of once per cold Worker.
 *
 * A download that fails leaves the stamp alone, so the copy built for the last
 * good download stays in use, even if the failure left the table half written.
 */

import { nowIso, parseJson, toJson, type Database } from '../db.ts';
import { memoKeyOf } from './slowRead.ts';

/** The stamp a successful download writes. Same key as `SETTING_KEYS.playersLastSuccess`. */
export const PLAYER_LIST_STAMP_KEY = 'sleeper.players.lastSuccessAt';

/** The header row: which stamp, how many parts, how many players, which columns. */
export const SNAPSHOT_KEY = 'players.snapshot';
/** Parts are `players.snapshot.000`, `.001`, ... so one key range reads them all. */
const PART_PREFIX = `${SNAPSHOT_KEY}.`;
/** Upper bound of that range: '/' sorts right after '.', so this is header + parts only. */
const RANGE_END = `${SNAPSHOT_KEY}/`;
/** When the tick last tried to build a copy, so a failing build is not retried every five minutes. */
export const SNAPSHOT_ATTEMPT_KEY = 'players.snapshotAttempt';

/** About 150 KB a part on the real list, far under D1's 2 MB value limit. */
export const PLAYERS_PER_PART = 400;
/** How long a Worker trusts the stamp it last read. One row per window. */
export const VERSION_CHECK_MS = 5_000;
/** A build that failed is tried again after this long, not on every tick. */
export const SNAPSHOT_RETRY_MS = 60 * 60 * 1_000;

interface Header {
  version: string;
  parts: number;
  rows: number;
  columns: string[];
}

interface Part {
  version: string;
  index: number;
  rows: unknown[][];
}

const partKey = (index: number): string => `${PART_PREFIX}${String(index).padStart(3, '0')}`;

/* ------------------------------------------------------------ the stamp */

const versions = new WeakMap<Database, { at: number; value: string | null }>();

async function readStamp(db: Database): Promise<string | null> {
  const row = await db
    // Its own text, so Cloudflare's per-query numbers name this check.
    .prepare('SELECT value_json AS player_list_stamp FROM settings WHERE key = ?')
    .bind(PLAYER_LIST_STAMP_KEY)
    .first<{ player_list_stamp: string }>();
  return row?.player_list_stamp ?? null;
}

/**
 * The download stamp the player list should match, as stored (raw JSON text).
 *
 * Null when no download has ever been recorded, which is every test and dev
 * database: then there is no stored copy and the full read runs, as it always did.
 */
export async function playerListVersion(db: Database, now: number = Date.now()): Promise<string | null> {
  const key = memoKeyOf(db);
  const hit = versions.get(key);
  if (hit && now - hit.at < VERSION_CHECK_MS) return hit.value;
  const value = await readStamp(db);
  versions.set(key, { at: now, value });
  return value;
}

/** Forget the stamp this Worker last read. Called by every write that changes the list. */
export function forgetPlayerListVersion(db: Database): void {
  versions.delete(memoKeyOf(db));
}

/* ------------------------------------------------------- the stored copy */

/**
 * The stored list for this stamp, or null when there is none that matches.
 *
 * One statement, a key-range read on the primary key: the header plus each
 * part, a handful of rows. Anything short of a complete copy built for exactly
 * this stamp answers null, and the caller does the full read.
 */
export async function readPlayerListSnapshot<T extends object>(db: Database, version: string): Promise<T[] | null> {
  let results: { key: string; value_json: string }[];
  try {
    ({ results } = await db
      .prepare('SELECT key, value_json FROM settings WHERE key >= ? AND key < ?')
      .bind(SNAPSHOT_KEY, RANGE_END)
      .all<{ key: string; value_json: string }>());
  } catch {
    return null;
  }
  const byKey = new Map(results.map((r) => [r.key, r.value_json]));
  const header = parseJson<Header | null>(byKey.get(SNAPSHOT_KEY), null);
  if (!header || header.version !== version || !Array.isArray(header.columns)) return null;
  const out: T[] = [];
  for (let index = 0; index < header.parts; index++) {
    const part = parseJson<Part | null>(byKey.get(partKey(index)), null);
    if (!part || part.version !== version || part.index !== index || !Array.isArray(part.rows)) return null;
    for (const values of part.rows) {
      const row: Record<string, unknown> = {};
      header.columns.forEach((column, i) => {
        row[column] = values[i] ?? null;
      });
      out.push(row as T);
    }
  }
  return out.length === header.rows ? out : null;
}

/**
 * Store a copy of the list for this stamp, replacing any older copy.
 *
 * One batch, which D1 runs as a transaction: the old parts go and the new
 * header and parts arrive together, so a reader never sees half of each.
 */
export async function writePlayerListSnapshot(
  db: Database,
  version: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  at: string = nowIso(),
): Promise<void> {
  const parts: Part[] = [];
  const count = Math.max(1, Math.ceil(rows.length / PLAYERS_PER_PART));
  for (let index = 0; index < count; index++) {
    const slice = rows.slice(index * PLAYERS_PER_PART, (index + 1) * PLAYERS_PER_PART);
    parts.push({ version, index, rows: slice.map((row) => columns.map((c) => row[c] ?? null)) });
  }
  const header: Header = { version, parts: parts.length, rows: rows.length, columns: [...columns] };
  const insert = (key: string, value: unknown) =>
    db
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)')
      .bind(key, toJson(value), at);
  await db.batch([
    db.prepare('DELETE FROM settings WHERE key >= ? AND key < ?').bind(SNAPSHOT_KEY, RANGE_END),
    insert(SNAPSHOT_KEY, header),
    ...parts.map((part) => insert(partKey(part.index), part)),
  ]);
}

/* ----------------------------------------------- the five-minute rebuild */

export type SnapshotOutcome =
  | { outcome: 'fresh' }
  | { outcome: 'no-download' }
  | { outcome: 'skipped'; note: string }
  | { outcome: 'written'; rows: number };

/**
 * Make sure the stored copy matches the last successful download.
 *
 * Runs on the five-minute tick. On almost every tick it is one read of up to
 * three settings rows that finds the copy current and stops. After a download
 * it does the one full read the cold Workers would otherwise each have done,
 * and stores it.
 *
 * A build that fails (or a tick that ran out of time part way) is not retried
 * on every tick: the attempt is recorded first, and tried again after
 * {@link SNAPSHOT_RETRY_MS}. Until then readers do the full read, which is
 * exactly what they did before this existed.
 */
export async function refreshPlayerListSnapshot(
  db: Database,
  readLive: () => Promise<{ columns: readonly string[]; rows: Record<string, unknown>[] }>,
  now: number = Date.now(),
): Promise<SnapshotOutcome> {
  const { results } = await db
    .prepare('SELECT key, value_json FROM settings WHERE key IN (?,?,?)')
    .bind(PLAYER_LIST_STAMP_KEY, SNAPSHOT_KEY, SNAPSHOT_ATTEMPT_KEY)
    .all<{ key: string; value_json: string }>();
  const byKey = new Map(results.map((r) => [r.key, r.value_json]));
  const version = byKey.get(PLAYER_LIST_STAMP_KEY) ?? null;
  if (version == null) return { outcome: 'no-download' };

  const header = parseJson<Header | null>(byKey.get(SNAPSHOT_KEY), null);
  if (header?.version === version) return { outcome: 'fresh' };

  const attempt = parseJson<{ version?: string; at?: string } | null>(byKey.get(SNAPSHOT_ATTEMPT_KEY), null);
  const attemptedAt = attempt?.at ? Date.parse(attempt.at) : NaN;
  if (attempt?.version === version && Number.isFinite(attemptedAt) && now - attemptedAt < SNAPSHOT_RETRY_MS) {
    return { outcome: 'skipped', note: 'a build for this download was tried less than an hour ago' };
  }

  const at = new Date(now).toISOString();
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(SNAPSHOT_ATTEMPT_KEY, toJson({ version, at }), at)
    .run();

  const live = await readLive();
  await writePlayerListSnapshot(db, version, live.columns, live.rows, at);
  return { outcome: 'written', rows: live.rows.length };
}

/* ------------------------------------------- every player's position */

/**
 * Every player's position (active or not), stored for one download stamp.
 *
 * Last season's statistics are matched against `SELECT id, position FROM
 * players`, the whole table including retired players, which the stored list
 * above leaves out on purpose. That read was 3,310 rows a call and the biggest
 * single reader on 5 November 2026 (774,540 rows in 234 calls). Positions only
 * change with a download, so the pairs are kept in one settings row under the
 * same stamp as the list, and used only while that stamp is current.
 */
export const POSITIONS_KEY = 'players.positions';

interface PositionsCopy {
  version: string;
  rows: [string, string][];
}

/** The stored pairs for this stamp, in table order, or null when there is none that matches. */
export async function readPositionsSnapshot(db: Database, version: string): Promise<Map<string, string> | null> {
  let row: { players_positions: string } | null;
  try {
    row = await db
      // Its own column name, so Cloudflare's per-query numbers name this read.
      .prepare('SELECT value_json AS players_positions FROM settings WHERE key = ?')
      .bind(POSITIONS_KEY)
      .first<{ players_positions: string }>();
  } catch {
    return null;
  }
  const copy = parseJson<PositionsCopy | null>(row?.players_positions, null);
  if (!copy || copy.version !== version || !Array.isArray(copy.rows) || copy.rows.length === 0) return null;
  const out = new Map<string, string>();
  for (const pair of copy.rows) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return null;
    out.set(pair[0], pair[1]);
  }
  return out;
}

/**
 * Store the pairs a full read just returned, under the stamp read before it.
 *
 * The stamp is read first, so pairs stored under it are never older than the
 * download it names: a download writes its rows before its stamp.
 */
export async function writePositionsSnapshot(
  db: Database,
  version: string,
  rows: readonly { id: string; position: string }[],
  at: string = nowIso(),
): Promise<void> {
  if (rows.length === 0) return;
  const copy: PositionsCopy = { version, rows: rows.map((r) => [r.id, r.position]) };
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(POSITIONS_KEY, toJson(copy), at)
    .run();
}
