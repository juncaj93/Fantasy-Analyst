/**
 * A projection fetch that caught Sleeper's feed mid-update.
 *
 * On Wednesday 7 October 2026 the 09:00 fetch wrote 30 rows. The table is
 * upserted, so the other 376 stayed from Tuesday, the stored week read as
 * minutes old, and the twelve-hour gate declined every refresh until the next
 * morning. The gate now reads how much the newest fetch wrote, and the Waivers
 * pull-to-refresh offers the same gated refresh the Team refresh already did.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';
import { SleeperProjectionService, isSliver, qbLinesKey } from '../src/server/services/sleeperProjectionService.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import type { SleeperWeeklyProjection } from '../src/core/sleeper/weeklyProjections.ts';
import { createApp } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { LEAGUE, envFor, seed } from './helpers/tradeLeague.ts';

const row = (i: number, defense = false): SleeperWeeklyProjection => ({
  playerId: defense ? `D${i}` : String(1000 + i),
  publisher: 'rotowire',
  points: { pts_std: 5, pts_half_ppr: 6, pts_ppr: 7 },
  defense: defense
    ? {
        sacks: 2,
        interceptions: 1,
        fumbleRecoveries: 0.5,
        forcedFumbles: 0.5,
        defensiveTds: 0.1,
        specialTeamsTds: 0.05,
        safeties: 0.02,
        blockedKicks: 0.05,
        pointsAllowed: 21,
        yardsAllowed: 330,
      }
    : null,
});
const week = (n: number) => [...Array.from({ length: n - 2 }, (_, i) => row(i)), row(1, true), row(2, true)];

/** A feed of `n` rows, the way Sleeper sends it. */
const feed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    player_id: String(1000 + i),
    company: 'rotowire',
    player: { position: 'WR' },
    stats: { pts_std: 5, pts_half_ppr: 6, pts_ppr: 7 },
  }));

describe('how much the newest fetch wrote', () => {
  it('is reported beside the stored total', async () => {
    const db = await createTestDb();
    const repo = new SleeperProjectionsRepo(db);
    await repo.save('2026', 5, week(400), '2026-10-06T09:00:00Z');
    await repo.save('2026', 5, week(30), '2026-10-07T09:00:00Z');
    const held = await repo.freshness('2026', 5);
    expect(held.players).toBe(400);
    expect(held.latestRows).toBe(30);
    expect(held.fetchedAt).toBe('2026-10-07T09:00:00Z');
    expect(held.defenses).toBe(2);
    expect(held.publisher).toBe('rotowire');
  });

  it('calls a sliver a sliver, and a whole refetch whole', () => {
    expect(isSliver({ players: 406, latestRows: 30 })).toBe(true);
    expect(isSliver({ players: 450, latestRows: 400 })).toBe(false);
    // Too small to judge: an early-week feed can be genuinely small.
    expect(isSliver({ players: 30, latestRows: 5 })).toBe(false);
  });
});

describe('the refresh gate', () => {
  async function service(stored: { n: number; at: string }[]) {
    const db = await createTestDb();
    const repo = new SleeperProjectionsRepo(db);
    for (const s of stored) await repo.save('2026', 5, week(s.n), s.at);
    // A week fetched since quarterback lines are kept (8 October 2026).
    await new SettingsRepo(db).set(qbLinesKey('2026', 5), { fetchedAt: stored.at(-1)!.at, lines: {} });
    let asked = 0;
    const sleeper = {
      getWeeklyProjections: async () => {
        asked += 1;
        return feed(406);
      },
    };
    const svc = new SleeperProjectionService(db, sleeper as never, () => new Date('2026-10-07T15:00:00Z'));
    return { svc, asked: () => asked };
  }

  it('refetches a young week whose newest fetch was a sliver', async () => {
    const { svc, asked } = await service([
      { n: 400, at: '2026-10-06T09:00:00Z' },
      { n: 30, at: '2026-10-07T09:00:00Z' },
    ]);
    const report = await svc.refresh('2026', 5);
    expect(report.outcome).toBe('fetched');
    expect(asked()).toBe(1);
  });

  it('still declines a young, whole week for one read', async () => {
    const { svc, asked } = await service([{ n: 400, at: '2026-10-07T09:00:00Z' }]);
    const report = await svc.refresh('2026', 5);
    expect(report.outcome).toBe('current');
    expect(asked()).toBe(0);
  });
});

describe('the Waivers pull-to-refresh', () => {
  async function refresh(seedProjections: boolean) {
    const db = await createTestDb();
    await seed(db);
    if (seedProjections) {
      // Young and whole: the gate should decline without asking Sleeper.
      const at = new Date(Date.now() - 60 * 60_000).toISOString();
      await new SleeperProjectionsRepo(db).save('2026', 5, week(400), at);
      await new SettingsRepo(db).set(qbLinesKey('2026', 5), { fetchedAt: at, lines: {} });
    }
    const asked: string[] = [];
    const sleeper = new SleeperClient({
      fetch: async (url: string) => {
        asked.push(String(url));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const res = await createApp()(
      new Request(`http://x/api/leagues/${LEAGUE}/waivers/refresh`, { method: 'POST' }),
      envFor(db, sleeper),
    );
    return { status: res.status, asked };
  }

  it('offers this week’s published projections a refresh', async () => {
    const { status, asked } = await refresh(false);
    expect(status).toBe(200);
    expect(asked.some((u) => u.includes('/projections/nfl/2026/5'))).toBe(true);
  });

  it('does not ask for them when the stored week is young and whole', async () => {
    const { status, asked } = await refresh(true);
    expect(status).toBe(200);
    expect(asked.some((u) => u.includes('/projections/'))).toBe(false);
  });
});

describe('Data health on a sliver', () => {
  it('reads degraded and says what to do', async () => {
    const { DataHealthService } = await import('../src/server/services/dataHealthService.ts');
    const db = await createTestDb();
    await seed(db);
    const repo = new SleeperProjectionsRepo(db);
    const now = Date.now();
    await repo.save('2026', 5, week(400), new Date(now - 30 * 3_600_000).toISOString());
    await repo.save('2026', 5, week(30), new Date(now - 3_600_000).toISOString());
    const view = await new DataHealthService(db, { now: () => new Date(now), releaseSha: 'test' }).view();
    const row = view.sources.find((s) => s.id === 'published-projections')!;
    expect(row.state).toBe('degraded');
    expect(row.note).toMatch(/30 of 400/);
  });
});
