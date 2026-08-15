/**
 * The detector, finally with something to read.
 *
 * `assessRole` has been complete since the season brief and has answered
 * "insufficient data" to every question ever put to it, because nothing in this
 * app knew how many targets a player saw. These tests run the whole path —
 * stored weeks, through the read path, into the engine — and check the three
 * answers that matter:
 *
 *   - six weeks of rising targets is a rising role;
 *   - five weeks is still not enough, and says so;
 *   - one enormous game among five ordinary ones is a spike and explicitly not
 *     a trend.
 *
 * The third is the one worth the most. A fourteen-target game after averaging
 * five is the exact shape of a false positive, and a feature that called it a
 * role change would be worse than no feature.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { UsageRepo } from '../src/server/repos/usage.ts';
import { UsageService } from '../src/server/services/usageService.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { player } from './helpers/players.ts';
import { toRoleMetrics, ROLE_WINDOW_GAMES, type UsageWeek } from '../src/core/usage/role.ts';
import { assessRole, WEEKLY_THRESHOLDS } from '../src/core/startsit/decisions.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2026';
const PROFILE = buildScoringProfile({ rec: 1 }, ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN']);

function week(over: Partial<UsageWeek> & { week: number }): UsageWeek {
  return {
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...over,
  };
}

/** Store a player and a run of weeks, exactly as an ingest would have. */
async function store(
  db: Database,
  who: { id: string; name: string; position: string },
  weeks: { week: number; targets?: number; carries?: number; targetShare?: number; attempts?: number; seasonType?: string }[],
): Promise<void> {
  await new PlayerRepo(db).upsertMany([
    player({ id: who.id, fullName: who.name, position: who.position, team: 'KC' }),
  ]);
  await new UsageRepo(db).saveWeeks(
    weeks.map((w) => ({
      playerId: who.id,
      season: SEASON,
      week: w.week,
      seasonType: w.seasonType ?? 'REG',
      team: 'KC',
      position: who.position,
      passAttempts: w.attempts ?? null,
      carries: w.carries ?? null,
      targets: w.targets ?? null,
      receptions: null,
      targetShare: w.targetShare ?? null,
      wopr: null,
      gsisId: '00-0000001',
      source: 'nflverse',
      publishedAt: null,
      fetchedAt: '2026-11-03T09:00:00.000Z',
    })),
  );
}

// ------------------------------------------------------------ the series

describe('building a per-game series', () => {
  it('gives a receiver targets and target share, and nothing that merely echoes them', () => {
    const weeks = [1, 2, 3, 4, 5, 6].map((w) =>
      week({ week: w, targets: 5, receptions: 4, targetShare: 0.2, wopr: 0.4 }),
    );
    const metrics = toRoleMetrics('WR', weeks);
    expect(metrics.map((m) => m.key)).toEqual(['targets', 'target_share']);
    /*
     * Receptions and WOPR are stored and deliberately absent here. Both are
     * built out of the two above them, so a detector that counted them as
     * agreeing metrics would manufacture high confidence out of one signal.
     */
    expect(metrics.some((m) => m.key === 'receptions' || m.key === 'wopr')).toBe(false);
  });

  it('gives a back his two jobs, and a quarterback his', () => {
    const weeks = [1, 2, 3].map((w) => week({ week: w, carries: 12, targets: 3, passAttempts: 30 }));
    expect(toRoleMetrics('RB', weeks).map((m) => m.key)).toEqual(['carries', 'targets']);
    expect(toRoleMetrics('QB', weeks).map((m) => m.key)).toEqual(['pass_attempts', 'carries']);
  });

  it('says nothing at all about a position this app does not carry', () => {
    expect(toRoleMetrics('K', [week({ week: 1, targets: 0 })])).toEqual([]);
    expect(toRoleMetrics('DEF', [week({ week: 1, targets: 0 })])).toEqual([]);
  });

  it('keeps the games in order, oldest first', () => {
    const weeks = [3, 1, 2].map((w) => week({ week: w, targets: w }));
    expect(toRoleMetrics('WR', weeks)[0]!.perGame).toEqual([1, 2, 3]);
  });

  it('leaves the playoffs out — they are not the season anyone is asked about', () => {
    const weeks = [
      ...[1, 2, 3].map((w) => week({ week: w, targets: 4 })),
      week({ week: 19, seasonType: 'POST', targets: 12 }),
    ];
    expect(toRoleMetrics('WR', weeks)[0]!.perGame).toEqual([4, 4, 4]);
  });

  /**
   * The rule that matters most, because breaking it fabricates the strongest
   * possible evidence. A player who was inactive has no row in the source; a
   * zero written for that week would read as a role that collapsed.
   */
  it('never turns a game that was not played into a zero', () => {
    const weeks = [week({ week: 1, targets: 8 }), week({ week: 3, targets: 9 })];
    expect(toRoleMetrics('WR', weeks)[0]!.perGame).toEqual([8, 9]);
  });

  it('drops a game from a metric the source left blank, rather than counting it as none', () => {
    const weeks = [
      week({ week: 1, targets: 6, targetShare: 0.2 }),
      week({ week: 2, targets: 7, targetShare: null }),
    ];
    const metrics = toRoleMetrics('WR', weeks);
    expect(metrics.find((m) => m.key === 'targets')!.perGame).toEqual([6, 7]);
    expect(metrics.find((m) => m.key === 'target_share')!.perGame).toEqual([0.2]);
  });

  it('reaches back eight games and no further', () => {
    const weeks = Array.from({ length: 14 }, (_, i) => week({ week: i + 1, targets: i + 1 }));
    const perGame = toRoleMetrics('WR', weeks)[0]!.perGame;
    expect(perGame).toHaveLength(ROLE_WINDOW_GAMES);
    // The most recent eight, so the baseline is about this month rather than
    // about September.
    expect(perGame).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

// --------------------------------------------------------- the whole path

describe('from stored weeks to an answer on the card', () => {
  const evaluate = (position: string, usage: ReturnType<typeof toRoleMetrics>) =>
    evaluatePlayer(
      {
        player: player({ id: 'p1', fullName: 'Puka Nacua', position, team: 'KC' }),
        props: [],
        signal: null,
        usage,
        now: '2026-11-03T12:00:00.000Z',
      },
      PROFILE,
    );

  it('calls six weeks of rising targets a rising role', async () => {
    const db = await createTestDb();
    await store(db, { id: 'p1', name: 'Puka Nacua', position: 'WR' }, [
      { week: 1, targets: 4, targetShare: 0.12 },
      { week: 2, targets: 4, targetShare: 0.13 },
      { week: 3, targets: 5, targetShare: 0.14 },
      { week: 4, targets: 9, targetShare: 0.25 },
      { week: 5, targets: 10, targetShare: 0.27 },
      { week: 6, targets: 11, targetShare: 0.28 },
    ]);

    const metrics = await new UsageService(db).roleMetricsFor([{ playerId: 'p1', position: 'WR' }], SEASON);
    const usage = metrics.get('p1')!;
    expect(usage.find((m) => m.key === 'targets')!.perGame).toEqual([4, 4, 5, 9, 10, 11]);

    const evaluation = evaluate('WR', usage);
    expect(evaluation.role.trend).toMatch(/^rising_/);
    expect(evaluation.role.games).toBe(6);
    // Both metrics agree, which is what earns the stronger claim.
    expect(evaluation.role.trend).toBe('rising_high');
    const component = evaluation.components.find((c) => c.key === 'role_trend')!;
    expect(component.unknown).toBe(false);
    expect(component.value).toBeGreaterThan(0);
  });

  it('still says "not enough" at five weeks', async () => {
    const db = await createTestDb();
    await store(db, { id: 'p1', name: 'Puka Nacua', position: 'WR' }, [
      { week: 1, targets: 4, targetShare: 0.12 },
      { week: 2, targets: 5, targetShare: 0.14 },
      { week: 3, targets: 8, targetShare: 0.22 },
      { week: 4, targets: 10, targetShare: 0.27 },
      { week: 5, targets: 11, targetShare: 0.28 },
    ]);

    const metrics = await new UsageService(db).roleMetricsFor([{ playerId: 'p1', position: 'WR' }], SEASON);
    const evaluation = evaluate('WR', metrics.get('p1')!);

    expect(evaluation.role.trend).toBe('insufficient_data');
    expect(evaluation.role.detail).toContain('not enough');
    // …and it contributes nothing to the score rather than a zero dressed up as
    // a signal.
    const component = evaluation.components.find((c) => c.key === 'role_trend')!;
    expect(component.unknown).toBe(true);
    expect(component.value).toBe(0);
  });

  it('calls one enormous game a spike, not a trend', async () => {
    const db = await createTestDb();
    await store(db, { id: 'p1', name: 'Puka Nacua', position: 'WR' }, [
      { week: 1, targets: 5, targetShare: 0.16 },
      { week: 2, targets: 5, targetShare: 0.16 },
      { week: 3, targets: 5, targetShare: 0.16 },
      { week: 4, targets: 5, targetShare: 0.16 },
      { week: 5, targets: 5, targetShare: 0.16 },
      { week: 6, targets: 14, targetShare: 0.44 },
    ]);

    const metrics = await new UsageService(db).roleMetricsFor([{ playerId: 'p1', position: 'WR' }], SEASON);
    const evaluation = evaluate('WR', metrics.get('p1')!);

    expect(evaluation.role.trend).toBe('spike');
    expect(evaluation.role.detail).toContain('one game carries most of it');
    // A spike is worth nothing on the score. It is worth saying out loud.
    expect(evaluation.components.find((c) => c.key === 'role_trend')!.value).toBe(0);
  });

  it('says nothing about a player with no usage stored at all', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([player({ id: 'p9', fullName: 'Nobody Yet', position: 'WR', team: 'KC' })]);
    const metrics = await new UsageService(db).roleMetricsFor([{ playerId: 'p9', position: 'WR' }], SEASON);
    expect(metrics.has('p9')).toBe(false);

    const evaluation = evaluate('WR', []);
    expect(evaluation.role.trend).toBe('insufficient_data');
    expect(evaluation.role.detail).toContain('No per-game usage is connected');
  });

  /**
   * The window is eight *regular-season* games, and in January that is not the
   * same as the last eight rows. A player with a full season and a playoff run
   * has four of each in his last eight; trimming before the season type was
   * read would leave the detector with four games and refuse to say anything
   * about a player it knows everything about.
   */
  it('reads eight regular-season games even when the playoffs are stored on top', async () => {
    const db = await createTestDb();
    await store(db, { id: 'p1', name: 'Puka Nacua', position: 'WR' }, [
      ...Array.from({ length: 18 }, (_, i) => ({ week: i + 1, targets: 4 + (i % 3), targetShare: 0.2 })),
      ...[19, 20, 21, 22].map((w) => ({ week: w, seasonType: 'POST', targets: 12, targetShare: 0.4 })),
    ]);

    const metrics = await new UsageService(db).roleMetricsFor([{ playerId: 'p1', position: 'WR' }], SEASON);
    const targets = metrics.get('p1')!.find((m) => m.key === 'targets')!;
    expect(targets.perGame).toHaveLength(ROLE_WINDOW_GAMES);
    // Weeks 11–18, and not one of the four playoff games above them.
    expect(targets.perGame.every((v) => v < 12)).toBe(true);
  });

  it('cannot see one season in another', async () => {
    const db = await createTestDb();
    await store(db, { id: 'p1', name: 'Puka Nacua', position: 'WR' }, [
      { week: 1, targets: 4 },
      { week: 2, targets: 5 },
      { week: 3, targets: 6 },
      { week: 4, targets: 9 },
      { week: 5, targets: 10 },
      { week: 6, targets: 11 },
    ]);
    // The same weeks, asked for under a different season, are not this season's.
    const other = await new UsageService(db).roleMetricsFor([{ playerId: 'p1', position: 'WR' }], '2025');
    expect(other.has('p1')).toBe(false);
  });
});

// ------------------------------------------------------------ the threshold

describe('the six-game minimum', () => {
  it('is three recent against three of baseline, and both halves are required', () => {
    expect(WEEKLY_THRESHOLDS.role.recentGames).toBe(3);
    expect(WEEKLY_THRESHOLDS.role.minBaselineGames).toBe(3);

    const rising = (games: number) => ({
      key: 'targets',
      label: 'Targets',
      perGame: Array.from({ length: games }, (_, i) => 3 + i * 2),
    });
    expect(assessRole([rising(5)]).trend).toBe('insufficient_data');
    expect(assessRole([rising(6)]).trend).not.toBe('insufficient_data');
  });
});
