/**
 * One number per player per week (October 2026, hard rule).
 *
 * The projection in the Compare picker, the Compare score, the Team screen's
 * Best move card, its lineup rows ("Start X instead") and the waiver tiers
 * must come from the same function. This runs the real routes over the seeded
 * league and fails if any two of them show a different number for the same
 * player in the same week.
 *
 * 13 October 2026: the lineup rows printed `weeklyProjection` (bare market or
 * Rotowire) while everything else printed `decisionPoints` (the same base plus
 * the capped nudges), so Walker read 15.1 on his row and 15.3 on Best move.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { buildPlayerRate } from '../src/core/tradeValue/rate.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { weekPoints, weekPointsBeforeStatus, weekPointsFrom, weekPointsOf } from '../src/core/startsit/weekPoints.ts';
import { rowFigure } from '../src/web/rowFigure.ts';
import type { StartSitEvaluation } from '../src/core/startsit/engine.ts';
import { createTestDb } from './helpers/db.ts';

type Evaluation = StartSitEvaluation;

let env: AppEnv;
const app = createApp();

async function json<T>(request: Request): Promise<T> {
  const res = await app(request, env);
  if (res.status !== 200) throw new Error(`${request.url} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const get = (path: string) => new Request(`https://app.test${path}`);
const post = (path: string, body: unknown) =>
  new Request(`https://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  const db = await createTestDb();
  await seedDemoData(db);
  env = {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    disableAuth: true,
  };
});

describe('the same number on every surface', () => {
  it('matches the picker, the comparison, the Best move card and the tier rate', async () => {
    const lineup = await json<{
      mode: string;
      starters: Evaluation[];
      bench: Evaluation[];
      swaps: { inPlayerId: string; outPlayerId: string; gain: number }[];
    }>(get('/api/leagues/demo-league/lineup'));
    const everyone = [...lineup.starters, ...lineup.bench].filter((e) => e.decision != null && e.score != null);
    expect(everyone.length).toBeGreaterThanOrEqual(2);

    const pool = await json<{ rows: { id: string; week: { points: number | null } }[] }>(
      get(`/api/leagues/demo-league/compare-pool?tab=mine&mode=${lineup.mode}`),
    );
    const poolPoints = new Map(pool.rows.map((r) => [r.id, r.week.points]));

    const pair = everyone.slice(0, 2).map((e) => e.playerId);
    const comparison = await json<{ evaluations: Evaluation[] }>(
      post('/api/startsit/compare', { leagueId: 'demo-league', playerIds: pair, mode: lineup.mode }),
    );

    for (const id of pair) {
      const fromLineup = weekPointsFrom(everyone.find((e) => e.playerId === id)!.decision).points;
      const fromCompare = weekPointsFrom(comparison.evaluations.find((e) => e.playerId === id)!.decision).points;
      expect(fromCompare, `Compare vs Best move for ${id}`).toBe(fromLineup);
      expect(poolPoints.get(id), `picker vs Best move for ${id}`).toBe(fromLineup);
    }
    // And for everybody on the roster the picker lists, not just the pair.
    for (const e of everyone) {
      if (!poolPoints.has(e.playerId)) continue;
      expect(poolPoints.get(e.playerId), e.name).toBe(weekPointsFrom(e.decision).points);
    }
  });

  it('prints the Best move gain as the difference of those same numbers', async () => {
    const lineup = await json<{ starters: Evaluation[]; bench: Evaluation[]; swaps: { inPlayerId: string; outPlayerId: string; gain: number }[] }>(
      get('/api/leagues/demo-league/lineup'),
    );
    const byId = new Map([...lineup.starters, ...lineup.bench].map((e) => [e.playerId, e]));
    for (const swap of lineup.swaps) {
      const inPts = byId.get(swap.inPlayerId)?.decision?.points;
      const outPts = byId.get(swap.outPlayerId)?.decision?.points;
      if (inPts == null || outPts == null) continue;
      expect(swap.gain).toBeCloseTo(inPts - outPts, 2);
    }
  });

  it('gives the waiver tiers the same number for a healthy player this week', async () => {
    const lineup = await json<{ starters: Evaluation[]; bench: Evaluation[] }>(get('/api/leagues/demo-league/lineup'));
    const healthy = [...lineup.starters, ...lineup.bench].filter(
      (e) => e.decision != null && (e.decision as { basis?: string }).basis === 'market' && !e.statusFlag,
    );
    expect(healthy.length).toBeGreaterThan(0);
    for (const evaluation of healthy) {
      const rate = buildPlayerRate({ evaluation, seasonLine: null, weeks: [6, 7, 8], byeWeek: null, byeKnown: true });
      expect(rate.rate, evaluation.name).toBe(weekPoints(evaluation).points);
    }
  });

  /** What a Team lineup row prints for a player: `rowFigure` over `weekPointsBeforeStatus`, as `TeamScreen` does. */
  const rowPrints = (e: Evaluation): number | null => {
    const figure = rowFigure(weekPointsBeforeStatus(e), e);
    return figure.kind === 'plain' || figure.kind === 'risk' ? figure.points : null;
  };

  it('prints the same number on every Team lineup row, incumbent and "Start X instead"', async () => {
    const lineup = await json<{ starters: Evaluation[]; bench: Evaluation[]; mode: string }>(get('/api/leagues/demo-league/lineup'));
    const everyone = [...lineup.starters, ...lineup.bench];
    const pool = await json<{ rows: { id: string; week: { points: number | null; out: boolean } }[] }>(
      get(`/api/leagues/demo-league/compare-pool?tab=mine&mode=${lineup.mode}`),
    );
    const poolWeek = new Map(pool.rows.map((r) => [r.id, r.week]));
    let checked = 0;
    for (const e of everyone) {
      const week = weekPointsOf(e);
      const row = rowPrints(e);
      if (week.out) {
        expect(row, `${e.name} is out: his row prints no number`).toBeNull();
        continue;
      }
      expect(row, `Team row vs Best move for ${e.name}`).toBe(week.points);
      if (poolWeek.has(e.playerId)) expect(poolWeek.get(e.playerId)!.points, `picker vs Team row for ${e.name}`).toBe(row);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('never hands a screen the internal gate value for a player who is out', async () => {
    const lineup = await json<{ starters: Evaluation[]; bench: Evaluation[] }>(get('/api/leagues/demo-league/lineup'));
    for (const e of [...lineup.starters, ...lineup.bench]) {
      const week = weekPointsOf(e);
      if (week.points != null) expect(week.points, e.name).toBeGreaterThan(-50);
      if (e.ruledOut) expect(week).toMatchObject({ points: null, out: true });
    }
    const pool = await json<{ rows: { week: { points: number | null } }[] }>(get('/api/leagues/demo-league/compare-pool?tab=all'));
    for (const r of pool.rows) if (r.week.points != null) expect(r.week.points).toBeGreaterThan(-50);
  });

  it('shows a fragment of a market as no number, never as a week', () => {
    const decision = { points: 1.6, basis: 'partial' as const, base: 1.6, adjustments: 0 };
    expect(weekPointsFrom(decision).points).toBeNull();
    expect(weekPointsBeforeStatus({ decision })).toBeNull();
  });

  /*
   * Team's "Waiver moves" and the Waivers page draw the same rows: one
   * endpoint, one field, one component. Jordan Love's +20.8 against +25.9 on
   * 13 October was two different times (the waiver engine changed at 01:58 UTC
   * and the start/sit score twice that morning), not two code paths.
   */
  it('draws Team\'s waiver line and the Waivers page from one endpoint and one component', async () => {
    const read = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');
    for (const screen of ['src/web/screens/TeamScreen.tsx', 'src/web/screens/WaiversScreen.tsx']) {
      const source = read(screen);
      expect(source, screen).toMatch(/api\.get<WaiverAdvice>\(`\/api\/leagues\/\$\{selected\.id\}\/waivers`/);
      expect(source, screen).toContain('<TierRowButton');
    }
    const first = await json<{ tiers?: unknown }>(get('/api/leagues/demo-league/waivers'));
    const second = await json<{ tiers?: unknown }>(get('/api/leagues/demo-league/waivers'));
    expect(second.tiers).toEqual(first.tiers);
  });
});
