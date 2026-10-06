/**
 * A short memo for reads that are expensive in rows and slow to change.
 *
 * ## Why this exists
 *
 * D1's free plan allows 5,000,000 rows read a day and answers everything with
 * an error once that is gone. The allowance was exhausted three times in two
 * days, and `wrangler d1 insights` named the spenders rather than leaving them
 * to be reasoned about: four queries, 97.5% of a day's reads between them, and
 * every one of them a full pass over a table that changes once a day.
 *
 *     2,271,594 rows   687 calls   the whole player dictionary
 *     1,431,688 rows   433 calls   SELECT COUNT(*) FROM players
 *       674,220 rows   204 calls   COUNT(*) FROM player_season_stats
 *       496,050 rows   150 calls   COUNT(*) FROM players WHERE active = 1 ...
 *
 * The call counts are the finding, not the row counts. A three-thousand-row
 * table is not an expensive read; a three-thousand-row table read six hundred
 * times in a day is, and nothing in the app asked for it six hundred times on
 * purpose. The Draft screen polls its board every five seconds while it is
 * open — 2,500ms when you are on the clock — and the board is built from the
 * whole dictionary. An hour of drafting is 720 rebuilds and 2.4 million rows,
 * which is half the daily allowance to answer a question whose answer last
 * changed at 09:00.
 *
 * So the fix is not a cheaper query. It is not asking again.
 *
 * ## What it does, and does not, promise
 *
 * Module state keyed by the database object rather than a global, exactly like
 * `MatchupService`'s forecast cache and the refresh orchestrator's dedupe: two
 * deployments — or two tests — sharing a process must never be able to serve
 * each other's rows. A Worker isolate lives long enough to absorb a burst of
 * polling and short enough that this never becomes a store.
 *
 * It is a *memo*, not a cache with a coherence protocol. It will hand back an
 * answer up to {@link SlowRead} ttl old, and the callers here are chosen so
 * that this is true and harmless: a player dictionary refreshed by the 09:00
 * tick, and three counts displayed as diagnostics. Every write that could
 * falsify one calls `forget`, so a manual re-sync is visible on the next read
 * rather than at the end of the window — the staleness is bounded by the
 * clock only where nothing has happened.
 *
 * Two details that are load-bearing rather than incidental:
 *
 *   - **only a settled answer is shared, never a read in flight.** This used
 *     to store the promise, so concurrent callers collapsed onto one query.
 *     On Workers that is a hang waiting to happen: a promise belongs to the
 *     request whose I/O will settle it, and when that request ends first (a
 *     client that hung up, which production cancels outright) the runtime
 *     cancels every *other* request's wait on it. They never answer, and the
 *     memo went on handing the same dead promise to every reader for the rest
 *     of its window (an hour for the counts, six for the usage tendencies).
 *     That was the 30-45 second hang on `/api/overview` and the lineup read
 *     in September 2026: Cloudflare recorded dozens of requests ending
 *     `clientDisconnected` at 44.8s having spent ~60ms of CPU and no D1 time.
 *     Now a caller who finds nothing settled runs its own read, and the first
 *     to land fills the slot. The price is a duplicate query when two requests
 *     miss at the same instant, once per window.
 *   - **a rejection is never remembered.** Only a value is ever stored, so a
 *     D1 error during an incident is not pinned in front of every reader for
 *     the rest of the window. That is the exact failure this module was
 *     written during, and caching it would be a fine way to cause it again.
 */

import type { Database } from '../db.ts';

interface Entry<T> {
  at: number;
  value: T;
}

/**
 * How long an answer stands.
 *
 * Five minutes against a five-second poll is 720 reads an hour becoming 12,
 * and against a dictionary the 09:00 tick rewrites it is not a staleness
 * anybody can observe — the writes that matter call `forget` and skip the wait
 * entirely. Longer would save little more; the poll is already the only reader
 * frequent enough for the window to matter.
 */
export const SLOW_READ_TTL_MS = 5 * 60 * 1_000;

/**
 * A wrapper around a database names the database it wraps under this key, and
 * the memo is kept on that one.
 *
 * The memo is keyed on the database *object*, which is right for a Worker (one
 * binding, many requests) and wrong for anything that wraps it per request: a
 * wrapper is a new object every time, so a read behind one is always a miss.
 * The request-cost meter is such a wrapper, and before this it reported the
 * cost of a cold isolate on every request, which is not what a real request
 * pays and is the wrong number to hold the free plan against.
 */
export const MEMO_KEY: unique symbol = Symbol('memoKey');

function memoKeyOf(db: Database): Database {
  return (db as unknown as { [MEMO_KEY]?: Database })[MEMO_KEY] ?? db;
}

/**
 * One memoised read, per database, per key.
 *
 * `key` exists for the reads that take an argument — a season, in practice —
 * so that asking about 2025 does not hand back 2024's answer. Callers with no
 * argument pass a constant.
 */
export class SlowRead<T> {
  private readonly store = new WeakMap<Database, Map<string, Entry<T>>>();

  constructor(
    private readonly ttlMs: number = SLOW_READ_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(db: Database, key: string, load: () => Promise<T>): Promise<T> {
    let byKey = this.store.get(memoKeyOf(db));
    if (!byKey) {
      byKey = new Map();
      this.store.set(memoKeyOf(db), byKey);
    }

    const at = this.now();
    const hit = byKey.get(key);
    if (hit && at - hit.at < this.ttlMs) return Promise.resolve(hit.value);

    /*
     * The caller's own read, shared with nobody until it has settled. The
     * window runs from when the read started, as it always has. A `forget`
     * during the read orphans `byKey`, so a read that began before a write
     * cannot land after it.
     */
    const value = load();
    const slot = byKey;
    void value.then(
      (settled) => {
        slot.set(key, { at, value: settled });
      },
      () => {},
    );
    return value;
  }

  /** Forget everything known about this database. Called by writes. */
  forget(db: Database): void {
    this.store.delete(memoKeyOf(db));
  }
}
