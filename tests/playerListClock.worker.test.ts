/**
 * The Sunday game-time download through the real `scheduled()` (24 October 2026).
 *
 * The pure clock is in `playerListClock.test.ts`. This drives the worker's own
 * ticks against a stubbed network and counts the requests for `/players/nfl`,
 * which Sleeper asks apps to make at most once a day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const TICK = '*/5 * * * *';
const PLAYERS = /\/players\/nfl$/;

let db: NodeSqliteDatabase;
let realFetch: typeof fetch;
let downloads: number;
/** Sleeper's client retries a failed read itself, so a failing attempt fails every try. */
let failing: boolean;

beforeEach(async () => {
  // Only the clock is fake, so a success is stamped at the tick's own time.
  vi.useFakeTimers({ toFake: ['Date'] });
  db = await createTestDb();
  realFetch = globalThis.fetch;
  downloads = 0;
  failing = false;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (PLAYERS.test(new URL(url).pathname)) {
      downloads += 1;
      if (failing) return new Response('upstream down', { status: 500 });
      return new Response(JSON.stringify({ '1000': { player_id: '1000', full_name: 'A Back', position: 'RB', team: 'NE', injury_status: 'Out' } }));
    }
    return new Response('null', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

function tick(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso));
  return worker.scheduled({ cron: TICK, scheduledTime: Date.parse(iso) }, { DB: db } as never);
}

describe('Sunday, on the five-minute tick', () => {
  it('downloads at 11:45 AM EDT and not on the retry slots after a success', async () => {
    await tick('2026-10-25T15:40:00Z'); // 11:40 AM
    expect(downloads).toBe(0);
    await tick('2026-10-25T15:45:00Z'); // 11:45 AM
    expect(downloads).toBe(1);
    expect(await new SettingsRepo(db).playersLastSuccessAt()).not.toBeNull();
    await tick('2026-10-25T16:15:00Z'); // 12:15 PM
    await tick('2026-10-25T16:30:00Z'); // 12:30 PM
    expect(downloads).toBe(1);
  });

  it('retries at 12:15 PM after a failed 11:45 AM, and stops once it succeeds', async () => {
    failing = true;
    await tick('2026-10-25T15:45:00Z');
    expect(downloads).toBeGreaterThanOrEqual(1);
    expect(await new SettingsRepo(db).playersLastSuccessAt()).toBeNull();
    failing = false;
    const afterFailure = downloads;
    await tick('2026-10-25T16:15:00Z');
    expect(downloads).toBe(afterFailure + 1);
    await tick('2026-10-25T16:30:00Z');
    expect(downloads).toBe(afterFailure + 1);
  });

  it('11:45 AM EST after 1 November is the 16:45 UTC tick', async () => {
    await tick('2026-11-01T15:45:00Z');
    expect(downloads).toBe(0);
    await tick('2026-11-01T16:45:00Z');
    expect(downloads).toBe(1);
  });
});
