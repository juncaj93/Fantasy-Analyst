/**
 * Health, inside a support snapshot.
 *
 * Support Snapshot says exactly what Junculator knew. This section says whether
 * what it knew was any good, and §11 is precise about what that has to buy: an
 * agent holding one file must be able to tell four states apart without asking
 * anybody anything.
 *
 *   - an exact replay standing on **stale injury data**;
 *   - a legitimate **`not_published`**;
 *   - **missing or fallback** data;
 *   - **deferred** background work that has nothing to do with the complaint.
 *
 * And §11's other half, which is the reason this is a projection rather than
 * the whole view: it must not bloat the file. A snapshot is already a couple of
 * hundred kilobytes and the point of this section is that it is readable in ten
 * seconds before anything else.
 *
 * The determinism claim — that adding it changes no replay — is asserted at the
 * bottom, because it is the one that would be expensive to discover later.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import { toSnapshotHealth } from '../src/core/health/snapshot.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { CronRunRecorder } from '../src/server/repos/cronRuns.ts';
import { InjurySourceRepo } from '../src/server/repos/injury.ts';
import { INJURY_SOURCE, injurySeason } from '../src/server/services/injuryService.ts';
import { IN_SEASON_KINDS } from '../src/core/support/contexts.ts';
import type { SnapshotDataHealth, SupportSnapshot } from '../src/core/support/schema.ts';

const SHA = '4c1f9a0b2d3e4f5061728394a5b6c7d8e9f00112';
const DRAFT = 'demo-draft';
const NOW = new Date('2026-09-15T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/**
 * A Sleeper stand-in that answers the scoreboard and nothing else.
 *
 * The matchup capture makes the one external call the whole support lane makes
 * — the identical request the Matchup screen makes on every open — so a client
 * that answered `null` to everything would fail that context for a reason that
 * has nothing to do with health. The same two rows `support.isolation` uses.
 */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '1007', '1011', '1017', '1019', '1013'];

function scoreboardSleeper(): SleeperClient {
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 0, starters: MINE, players: [...MINE, '1009'], players_points: {} },
    { roster_id: 2, matchup_id: 1, points: 0, starters: THEIRS, players: [...THEIRS, '1018'], players_points: {} },
  ];
  return new SleeperClient({
    fetch: async (url) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname)
        ? new Response(JSON.stringify(rows), { status: 200 })
        : new Response('null', { status: 200 }),
  });
}

function env(db: NodeSqliteDatabase, over: Partial<AppEnv> = {}): AppEnv {
  return {
    db,
    sleeper: scoreboardSleeper(),
    vegas: new MockVegasProvider(MOCK_GAMES),
    releaseSha: SHA,
    ...over,
  };
}

describe('every capture carries the health of what it read', () => {
  let db: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('the draft capture does', async () => {
    const res = await app(new Request(`https://app.test/api/drafts/${DRAFT}/support-snapshot`), env(db));
    const snapshot = (await res.json()) as SupportSnapshot;
    expect(snapshot.dataHealth).toBeTruthy();
    expect(snapshot.dataHealth!.sources.length).toBeGreaterThan(0);
  });

  it.each(IN_SEASON_KINDS)('the %s capture does', async (context) => {
    const res = await app(
      new Request(`https://app.test/api/leagues/demo-league/support-snapshot?context=${context}`),
      env(db),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const snapshot = (await res.json()) as SupportSnapshot;
    expect(snapshot.dataHealth, context).toBeTruthy();
  });

  /**
   * Outside `decision`, on purpose.
   *
   * Replay compares the decision term by term with no tolerance. Health is a
   * fact about the deployment measured by a different subsystem, and a snapshot
   * captured on a Tuesday and replayed in March would fail every freshness term
   * in it for no reason anybody cares about.
   */
  it('sits on the envelope rather than inside the decision', async () => {
    const res = await app(new Request(`https://app.test/api/drafts/${DRAFT}/support-snapshot`), env(db));
    const snapshot = (await res.json()) as SupportSnapshot & { decision: Record<string, unknown> };
    expect(snapshot.decision).not.toHaveProperty('dataHealth');
  });
});

describe('the four states an agent has to be able to tell apart', () => {
  const health = async (db: NodeSqliteDatabase): Promise<SnapshotDataHealth> =>
    toSnapshotHealth(await new DataHealthService(db, { now: () => NOW, releaseSha: SHA }).view());

  const find = (h: SnapshotDataHealth, id: string) => h.sources.find((s) => s.id === id)!;

  it('stale injury data is stale, with its age, beside an otherwise exact replay', async () => {
    const db = await createTestDb();
    await new InjurySourceRepo(db).recordCheck(INJURY_SOURCE, injurySeason(NOW), {
      checkedAt: ago(3),
      ingestedAt: ago(4 * 24 * 60),
      outcome: 'not_modified',
      note: null,
    });
    const injuries = find(await health(db), 'injuries');
    expect(injuries.state).toBe('stale');
    expect(injuries.ageMinutes).toBe(4 * 24 * 60);
    expect(injuries.severity).toBe('critical');
  });

  it('a legitimate not-published reads as waiting, which is not a fault', async () => {
    const db = await createTestDb();
    await new InjurySourceRepo(db).recordCheck(INJURY_SOURCE, injurySeason(NOW), {
      checkedAt: ago(3),
      ingestedAt: null,
      outcome: 'not_published',
      note: null,
    });
    expect(find(await health(db), 'injuries').state).toBe('waiting');
  });

  it('a provider with no key reads as missing rather than as stale', async () => {
    const db = await createTestDb();
    const view = await new DataHealthService(db, {
      now: () => NOW,
      vegas: { name: 'sportsgameodds', isConfigured: () => false } as never,
    }).view();
    expect(toSnapshotHealth(view).sources.find((s) => s.id === 'vegas')!.state).toBe('missing');
  });

  /**
   * The one that is most misdiagnosable, and the reason `deferred` is named on
   * the run as well as on the row: everything looks fine, one number is thin,
   * and without this nothing anywhere says why.
   */
  it('deferred background work is deferred, named on the run, and marked background', async () => {
    const db = await createTestDb();
    await db
      .prepare(
        `INSERT INTO leagues (id, sleeper_league_id, name, season, total_rosters, scoring_settings_json,
                              roster_positions_json, league_settings_json, is_selected, last_synced_at)
         VALUES ('L','S','L','2026',12,'{}','[]','{}',1,'2026-09-15T00:00:00.000Z')`,
      )
      .run();
    const run = new CronRunRecorder(db, {
      cron: '0 9 * * *',
      label: 'Daily refresh',
      releaseSha: SHA,
      now: () => NOW,
    });
    await run.step('injuries', 'Injuries', async () => ({ outcome: 'succeeded' as const }));
    await run.step('manager-intel', 'Manager tendencies', async () => ({ outcome: 'deferred' as const }));
    await run.finish({ limit: 48, used: 48, remaining: 0 });

    const h = await health(db);
    expect(find(h, 'manager-intel').state).toBe('deferred');
    expect(find(h, 'manager-intel').severity).toBe('background');
    expect(h.lastRun?.deferred).toEqual(['Manager tendencies']);
    expect(h.lastRun?.failed).toEqual([]);
  });
});

describe('and it does not bloat the file', () => {
  let db: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  /**
   * A hard ceiling, because "keep it small" is a convention that decays.
   *
   * Twelve rows of five short fields plus one run line is about a kilobyte. Two
   * is a generous ceiling that a per-source cadence sentence or a technical
   * block would immediately fail — which is the point: those belong on the
   * screen, not in the file.
   */
  it('is under two kilobytes', async () => {
    const view = await new DataHealthService(db, { releaseSha: SHA }).view();
    const bytes = JSON.stringify(toSnapshotHealth(view)).length;
    expect(bytes).toBeLessThan(2_048);
  });

  it('is a small fraction of the snapshot it travels in', async () => {
    const res = await app(new Request(`https://app.test/api/drafts/${DRAFT}/support-snapshot`), env(db));
    const snapshot = (await res.json()) as SupportSnapshot;
    const whole = JSON.stringify(snapshot).length;
    const section = JSON.stringify(snapshot.dataHealth).length;
    expect(section / whole).toBeLessThan(0.05);
  });

  /**
   * Deliberately absent: the prose a person standing at the screen needs and an
   * agent reading a file does not.
   */
  it('carries no cadence sentence, no impact sentence and no technical block', async () => {
    const view = await new DataHealthService(db, { releaseSha: SHA }).view();
    const section = toSnapshotHealth(view);
    for (const source of section.sources) {
      expect(Object.keys(source).sort()).toEqual(['ageMinutes', 'id', 'label', 'severity', 'state']);
    }
    expect(JSON.stringify(section)).not.toContain('Checked every');
  });
});

describe('adding it changed no replay', () => {
  /**
   * The claim §11 ends on: Draft and every in-season deterministic replay stay
   * green. Asserted here rather than trusted, because a health block that
   * accidentally landed inside `decision` would be compared term by term and
   * would start failing a week after capture.
   */
  it('a draft snapshot carrying health still reproduces exactly', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const app = createApp();
    const res = await app(new Request(`https://app.test/api/drafts/${DRAFT}/support-snapshot`), env(db));
    const raw = (await res.json()) as unknown;

    const snapshot = readSnapshot(raw);
    expect(snapshot.dataHealth).toBeTruthy();
    const report = await replayDraftSnapshot(snapshot as never);
    expect(report.outcome, report.summary).toBe('reproduced');
  });

  /** The reader accepts a file with the section, and a file without it. */
  it('a snapshot written before this existed is still readable', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const app = createApp();
    const res = await app(new Request(`https://app.test/api/drafts/${DRAFT}/support-snapshot`), env(db));
    const raw = (await res.json()) as Record<string, unknown>;
    delete raw['dataHealth'];
    expect(() => readSnapshot(raw)).not.toThrow();
  });
});
