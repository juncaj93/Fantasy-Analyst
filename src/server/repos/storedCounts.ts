/**
 * A count that is worked out once and kept in the settings table.
 *
 * ## Why this exists
 *
 * `COUNT(*)` and `COUNT(DISTINCT ...)` read every row they count, and D1 bills
 * every row read. The Data health and Setup screens show a handful of such
 * counts, and an in-memory memo (`SlowRead`) only helps for as long as one
 * Worker isolate stays warm. A cold isolate pays the full pass again, so a
 * count that changes once a day was still being walked 80 to 140 times a day.
 *
 * The settings table is a key/value store, so a count kept there is a new key,
 * not a schema change. A reader costs one row. The count is recomputed only
 * when the thing it counts has changed.
 *
 * ## How a stored count stays honest
 *
 * Each value carries an `anchor`: a short string that changes whenever the
 * counted data changes. Two kinds of anchor are used:
 *
 *   - **a fact the caller already has**, such as the newest snapshot time and
 *     game count that the same screen reads anyway. The stored value is used
 *     only while the anchor still matches, so a new snapshot refreshes it on
 *     the next read. Nothing has to remember to invalidate.
 *   - **a fixed marker**, for data with a single writer. The writer calls
 *     {@link forgetStoredCount} after it writes, and the next read counts once.
 *
 * A missing, unreadable or mismatched value falls back to the live count, so a
 * database that has never stored one behaves exactly as it did before. Storing
 * is best effort: a failed write never fails the read that asked for it.
 */

import { nowIso, parseJson, toJson, type Database } from '../db.ts';

const PREFIX = 'counts.';

interface Stored {
  value: number;
  anchor: string;
  at: string;
}

export interface CountedValue {
  value: number;
  /** ISO time the count was taken, for "as of" labels. */
  asOf: string;
}

/**
 * The count for `name`, from the settings row while `anchor` still matches,
 * otherwise from `compute` (which is then stored).
 */
export async function storedCount(
  db: Database,
  name: string,
  anchor: string,
  compute: () => Promise<number>,
): Promise<CountedValue> {
  const key = PREFIX + name;
  try {
    const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?').bind(key).first<{ value_json: string }>();
    if (row) {
      const stored = parseJson<Partial<Stored> | null>(row.value_json, null);
      if (stored && stored.anchor === anchor && Number.isFinite(stored.value)) {
        return { value: Number(stored.value), asOf: String(stored.at ?? '') };
      }
    }
  } catch {
    // Fall through to the live count.
  }

  const value = await compute();
  const at = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(key, toJson({ value, anchor, at } satisfies Stored), at)
      .run();
  } catch {
    // Best effort. The caller has its answer.
  }
  return { value, asOf: at };
}

/** Drop a stored count so the next read counts once. Called by the data's writer. */
export async function forgetStoredCount(db: Database, name: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM settings WHERE key = ?').bind(PREFIX + name).run();
  } catch {
    // The anchor is the backstop: a stale value is only ever served for a fixed marker.
  }
}
