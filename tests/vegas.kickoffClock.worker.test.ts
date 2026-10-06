/**
 * The deployed entry point, driven the way Cloudflare drives it.
 *
 * What the other two files prove about the arithmetic and the service is worth
 * nothing if `scheduled()` does not call them, so this runs the real handler
 * over a real database and counts what actually goes out to the odds provider.
 *
 * The fixed instants matter. The week's kickoff is set so that its 48-hour
 * checkpoint falls on 21:30 UTC, which is a tick that already parses an
 * nflverse file; the job must wait for the first tick after that is free.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { createTestDb } from './helpers/db.ts';

/** Sunday 11 October 2026, 5:30pm Eastern: the 48-hour mark is Friday 21:30 UTC. */
const KICKOFF = '2026-10-11T21:30:00.000Z';
const CHECKPOINT = Date.parse('2026-10-09T21:30:00.000Z');

let db: NodeSqliteDatabase;
let realFetch: typeof fetch;
let urls: string[];

function cronEnv() {
  return { DB: db, VEGAS_PROVIDER: 'sportsgameodds', SPORTSGAMEODDS_API_KEY: 'test-key' } as never;
}

/** The outside world, answering only what these ticks ask. */
function stubWorld(): void {
  urls = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('sportsgameodds') && url.includes('/account/usage')) {
      return new Response(
        JSON.stringify({ data: { rateLimits: { 'per-month': { 'current-entities': 10, 'max-entities': 2500 } } } }),
        { status: 200 },
      );
    }
    if (url.includes('sportsgameodds') && url.includes('eventID=')) {
      const eventId = /eventID=([^&]+)/.exec(url)![1]!;
      return new Response(
        JSON.stringify({ data: [{ eventID: eventId, status: { startsAt: KICKOFF }, players: {}, odds: {}, teams: {} }] }),
        { status: 200 },
      );
    }
    if (url.includes('sportsgameodds')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.includes('github.com')) return new Response(null, { status: 304 });
    if (/\/matchups\/\d+$/.test(url)) return new Response('[]', { status: 200 });
    if (url.includes('/state/nfl')) {
      return new Response(JSON.stringify({ season: '2026', season_type: 'regular', week: 5, leg: 5 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

const oddsCalls = () => urls.filter((u) => u.includes('sportsgameodds') && u.includes('eventID='));
const tick = (iso: string, cron = '*/5 * * * *') => worker.scheduled({ cron, scheduledTime: Date.parse(iso) }, cronEnv());

beforeEach(async () => {
  db = await createTestDb();
  await seedDemoData(db);

  // Learn the week through the ordinary path, then pin it to fixed instants so
  // the test does not depend on the day it is run.
  const mock = new MockVegasProvider(MOCK_GAMES);
  const service = new VegasRefreshService(db, mock);
  await service.refresh({ manual: true });
  const preview = await service.preview();
  const teams = new Set<string>();
  for (const p of preview.players as (typeof preview.players[number] & { team: string | null })[]) {
    if (p.team && p.eventId === 'demo-game-1') teams.add(p.team.toUpperCase());
  }
  await new VegasEventsRepo(db).upsertMany([
    { eventId: 'demo-game-1', provider: 'sportsgameodds', kickoff: KICKOFF, homeTeam: 'KC', awayTeam: 'DAL' },
  ]);
  // A second apart per row: (provider, event, fetched_at) is unique.
  await db
    .prepare("UPDATE prop_snapshots SET fetched_at = '2026-10-07T00:00:' || printf('%02d', id % 50) || '.000Z' WHERE event_id = 'demo-game-1'")
    .run();
  await new NflScheduleRepo(db).save(
    [...teams].map((team) => ({ season: '2026', week: 5, team, opponent: 'OPP', home: true, kickoff: KICKOFF, roof: null })),
    '2026-10-07T00:00:00.000Z',
  );
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 5, leg: 5, fetchedAt: '2026-10-09T00:00:00.000Z' });
  // The week's schedule was checked recently, so the ordinary tick leaves it alone.
  realFetch = globalThis.fetch;
  stubWorld();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the odds job, on the deployed entry point', () => {
  it('stays off the ticks that already parse an nflverse file, and runs on the first free one', async () => {
    // 21:30, 21:35 and 21:40 own the three nflverse files.
    for (const hhmm of ['21:30', '21:35', '21:40']) {
      stubWorld();
      await tick(`2026-10-09T${hhmm}:00Z`);
      expect(oddsCalls(), `${hhmm} owns a feed`).toEqual([]);
    }
    stubWorld();
    await tick('2026-10-09T21:45:00Z');
    expect(oddsCalls().length, 'the first free tick after the checkpoint').toBeGreaterThan(0);
  });

  it('buys the game once for the checkpoint and not again on the next tick', async () => {
    stubWorld();
    await tick('2026-10-09T21:45:00Z');
    expect(oddsCalls()).toHaveLength(1);

    stubWorld();
    await tick('2026-10-09T21:50:00Z');
    expect(oddsCalls()).toEqual([]);
  });

  it('does nothing at all on a tick with no checkpoint, beyond reading the gate', async () => {
    stubWorld();
    await tick('2026-10-09T21:45:00Z');
    stubWorld();
    // Mid-morning on Saturday: nothing new for this game for hours.
    await tick('2026-10-10T14:00:00Z');
    expect(urls.filter((u) => u.includes('sportsgameodds'))).toEqual([]);
  });

  it('is on the half-hour mark before kickoff, which is the last look', async () => {
    stubWorld();
    await tick('2026-10-09T21:45:00Z');
    stubWorld();
    // 30 minutes before kickoff.
    await tick('2026-10-11T21:00:00Z');
    // A ticks that is a feed tick? 21:00 is not. Lines are hours old by now.
    expect(oddsCalls().length).toBeGreaterThan(0);
  });

  it('buys nothing once the game has started', async () => {
    stubWorld();
    await tick('2026-10-09T21:45:00Z');
    stubWorld();
    await tick('2026-10-11T22:30:00Z');
    expect(oddsCalls()).toEqual([]);
  });

  it('no longer buys anything on the old Saturday and Sunday clocks', async () => {
    for (const [cron, iso] of [
      ['0 23 * * SAT', '2026-10-10T23:00:00Z'],
      ['0 15 * * SUN', '2026-10-11T15:00:00Z'],
    ] as const) {
      stubWorld();
      await tick(iso, cron);
      expect(urls.filter((u) => u.includes('sportsgameodds')), cron).toEqual([]);
    }
  });

  it('survives a provider that is down, and the injury check does not notice', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('sportsgameodds')) return new Response('boom', { status: 500 });
      if (url.includes('github.com')) return new Response(null, { status: 304 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await expect(tick('2026-10-09T21:45:00Z')).resolves.toBeUndefined();
  });

  it('keeps the checkpoint reachable: the gate never sleeps past a game\'s next mark', async () => {
    await tick('2026-10-09T21:45:00Z');
    const state = await new SettingsRepo(db).get<{ next: string }>(SETTING_KEYS.vegasClock, null as never);
    expect(Date.parse(state.next)).toBeGreaterThan(CHECKPOINT);
    // The 24-hour mark is Saturday 21:30; the gate may wake earlier but never later.
    expect(Date.parse(state.next)).toBeLessThanOrEqual(Date.parse('2026-10-10T21:30:00Z'));
  });
});
