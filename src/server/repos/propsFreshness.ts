/**
 * The weekly odds freshness line, kept where a Worker can read it in two rows.
 *
 * ## Why this exists
 *
 * `PropsRepo.freshness` answers "when were the odds last bought, from whom,
 * for how many games" with `MAX(fetched_at)` and `COUNT(DISTINCT event_id)`
 * over every weekly snapshot. No index shortens a `COUNT(DISTINCT)`, so each
 * call walks the whole set: about 753 rows. A screen asks it about six times
 * (Team, Waivers, Trades, Compare and the health line all want it), and on
 * 5 November 2026 it ran 749 times for 563,892 rows, 13.4% of the day's
 * 5,000,000. The answer changes only when new odds are stored.
 *
 * ## How it stays exact
 *
 * The one writer of weekly snapshots (`PropsRepo.put`) writes a new stamp
 * ({@link PROPS_STAMP_KEY}) right after the snapshot row lands. Then:
 *
 *   - the five-minute tick ({@link refreshStoredPropsFreshness}) reads the
 *     stamp and the stored answer (two rows), and when they no longer match it
 *     counts once, exactly the old query, and stores the answer under the stamp
 *     it read before counting;
 *   - readers re-check the stamp at most every {@link STAMP_CHECK_MS} per
 *     Worker (the same two rows), use the stored answer only when it was
 *     counted under the current stamp, and otherwise count live as before,
 *     holding that count in memory for that stamp only. Readers never write,
 *     so a screen read still leaves the database exactly as it found it.
 *
 * Reading the stamp before counting is what keeps it from ever being older
 * than the last refresh: the writer stores the snapshot first and stamps
 * second, so a count taken after seeing the new stamp includes the new row. A
 * count that raced the writer is kept under the old stamp, and every reader
 * that has seen the new one ignores it.
 *
 * {@link STORED_MAX_AGE_MS} is a backstop for the one thing no stamp can see: a
 * row changed outside the app (a hand-run cleanup), or a snapshot written by
 * the previous release in the seconds a deploy overlaps. Nothing older than
 * that is ever served; the tick re-counts a little before it, about once an
 * hour (about 750 rows each time).
 *
 * No schema change: two keys in the `settings` table, like the stored player
 * list beside them.
 */

import { parseJson, toJson, type Database } from '../db.ts';
import { memoKeyOf } from './slowRead.ts';

export interface PropsFreshness {
  fetchedAt: string | null;
  provider: string | null;
  events: number;
}

/** Written by every weekly odds store, after the snapshot row. */
export const PROPS_STAMP_KEY = 'props.week.stamp';
/** The answer, with the stamp it was counted under. */
export const PROPS_FRESHNESS_KEY = 'props.week.freshness';
/** How long a Worker trusts the stamp it last read. */
export const STAMP_CHECK_MS = 5_000;
/** The backstop for changes made outside the app: nothing older is served. */
export const STORED_MAX_AGE_MS = 60 * 60 * 1_000;
/** The tick re-counts once the stored answer is this old, so readers rarely reach the backstop. */
export const STORED_RECOUNT_MS = 50 * 60 * 1_000;

interface Stored {
  stamp: string;
  at: number;
  value: PropsFreshness;
}

interface Memo extends Stored {
  checkedAt: number;
}

const memos = new WeakMap<Database, Memo>();
let stampCounter = 0;

/** Forget this Worker's answer. The writer calls it; tests use it to play a cold Worker. */
export function forgetPropsFreshness(db: Database): void {
  memos.delete(memoKeyOf(db));
}

/**
 * Mark the weekly odds as changed. Called right after a snapshot row is stored.
 *
 * The value only has to differ from the last one: the time plus a counter and
 * a random tail, so two Workers storing in the same millisecond still differ.
 */
export async function stampPropsChange(db: Database, now: number = Date.now()): Promise<void> {
  forgetPropsFreshness(db);
  stampCounter = (stampCounter + 1) % 1_000_000;
  const stamp = `${new Date(now).toISOString()}#${stampCounter}#${Math.random().toString(36).slice(2, 10)}`;
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(PROPS_STAMP_KEY, toJson(stamp), new Date(now).toISOString())
    .run();
}

/** The stamp and the stored answer, in one statement. */
async function readStampAndStored(db: Database): Promise<{ stamp: string; stored: Stored | null }> {
  const { results } = await db
    // Its own column name, so Cloudflare's per-query numbers name this check.
    .prepare('SELECT key, value_json AS props_freshness FROM settings WHERE key IN (?, ?)')
    .bind(PROPS_STAMP_KEY, PROPS_FRESHNESS_KEY)
    .all<{ key: string; props_freshness: string }>();
  const byKey = new Map(results.map((r) => [r.key, r.props_freshness]));
  // No stamp yet (before the first store on this release): '' is a version like any other.
  const stamp = parseJson<string>(byKey.get(PROPS_STAMP_KEY), '') || '';
  return { stamp, stored: parseStored(byKey.get(PROPS_FRESHNESS_KEY)) };
}

const usable = (s: Stored | null, stamp: string, now: number): s is Stored =>
  !!s && s.stamp === stamp && now >= s.at && now - s.at < STORED_MAX_AGE_MS;

/**
 * The freshness line: from memory, the stored answer, or the live count.
 *
 * `live` is the old query, unchanged. Reads only: any failure reading the
 * stamp falls back to it, so this can only ever be cheaper, never wrong.
 */
export async function cachedPropsFreshness(
  db: Database,
  live: () => Promise<PropsFreshness>,
  now: number = Date.now(),
): Promise<PropsFreshness> {
  const key = memoKeyOf(db);
  const memo = memos.get(key);
  if (memo && now - memo.checkedAt < STAMP_CHECK_MS && now - memo.at < STORED_MAX_AGE_MS) return copy(memo.value);

  let read: { stamp: string; stored: Stored | null };
  try {
    read = await readStampAndStored(db);
  } catch {
    return live();
  }
  const { stamp, stored } = read;

  if (usable(stored, stamp, now)) {
    // Prefer the stored answer (counted by the tick) over this Worker's own.
    memos.set(key, { ...stored, checkedAt: now });
    return copy(stored.value);
  }
  if (memo && usable(memo, stamp, now)) {
    memos.set(key, { ...memo, checkedAt: now });
    return copy(memo.value);
  }

  // Counted after reading the stamp, so it is at least as new as that stamp.
  const value = await live();
  memos.set(key, { stamp, at: now, value, checkedAt: now });
  return copy(value);
}

export type StoredFreshnessOutcome = { outcome: 'fresh' } | { outcome: 'written'; events: number };

/**
 * Keep the stored answer in step with the stamp. The five-minute tick calls it.
 *
 * Nearly every tick: one statement, two rows, finds it current. After an odds
 * refresh (or once the answer is {@link STORED_RECOUNT_MS} old) it counts once
 * and stores the count under the stamp read before counting.
 */
export async function refreshStoredPropsFreshness(
  db: Database,
  live: () => Promise<PropsFreshness>,
  now: number = Date.now(),
): Promise<StoredFreshnessOutcome> {
  const { stamp, stored } = await readStampAndStored(db);
  if (stored && stored.stamp === stamp && now >= stored.at && now - stored.at < STORED_RECOUNT_MS) {
    return { outcome: 'fresh' };
  }
  const value = await live();
  const fresh: Stored = { stamp, at: now, value };
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(PROPS_FRESHNESS_KEY, toJson(fresh), new Date(now).toISOString())
    .run();
  return { outcome: 'written', events: value.events };
}

function parseStored(text: string | undefined): Stored | null {
  const s = parseJson<Partial<Stored> | null>(text, null);
  if (!s || typeof s.stamp !== 'string' || !Number.isFinite(s.at) || !s.value) return null;
  const v = s.value as Partial<PropsFreshness>;
  if (!Number.isFinite(v.events)) return null;
  return {
    stamp: s.stamp,
    at: Number(s.at),
    value: {
      fetchedAt: v.fetchedAt == null ? null : String(v.fetchedAt),
      provider: v.provider == null ? null : String(v.provider),
      events: Number(v.events),
    },
  };
}

/** A fresh object each time, so no caller can edit another's answer. */
function copy(v: PropsFreshness): PropsFreshness {
  return { fetchedAt: v.fetchedAt, provider: v.provider, events: v.events };
}
