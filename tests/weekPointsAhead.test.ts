/**
 * Sleeper's projection for the weeks after this one, kept for the waiver
 * planner: scored in this league's rules, one settings row a week, behind a
 * twelve-hour gate, and never in the shared projection table.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { WeekPointsService } from '../src/server/services/weekPointsService.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';

const SCORING = { pass_yd: 0.04, pass_td: 6, pass_int: -2, rush_yd: 0.1, rec: 0.5, rec_yd: 0.1 };
const FEED = [
  { player_id: '6804', player: { position: 'QB' }, stats: { pass_yd: 250, pass_td: 2, pass_int: 1 } },
  { player_id: '9000', player: { position: 'WR' }, stats: { rec: 5, rec_yd: 60 } },
  { player_id: 'GB', player: { position: 'DEF' }, stats: { pass_int: 1 } },
];

async function service() {
  const db = await createTestDb();
  const asked: string[] = [];
  const sleeper = new SleeperClient({
    fetch: async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify(FEED), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { db, asked, svc: new WeekPointsService(db, sleeper) };
}

describe('the weeks ahead', () => {
  it('stores the next three weeks in this league’s scoring, quarterbacks and skill players only', async () => {
    const { svc, asked } = await service();
    const now = new Date('2026-10-09T03:00:00Z');
    const report = await svc.refreshAheadWeeks({ season: '2026', week: 5, scoring: SCORING, now });
    expect(report.map((r) => [r.week, r.stored, r.skipped])).toEqual([
      [6, 2, null],
      [7, 2, null],
      [8, 2, null],
    ]);
    expect(asked.filter((u) => u.includes('/projections/nfl/2026/')).length).toBe(3);
    const ahead = await svc.readAhead('2026', [6, 7, 8]);
    /* 250 × 0.04 + 2 × 6 − 1 × 2 */
    expect(ahead.get(6)?.get('6804')).toBe(20);
    expect(ahead.get(6)?.get('9000')).toBe(8.5);
    expect(ahead.get(6)?.has('GB')).toBe(false);
  });

  it('asks Sleeper nothing within twelve hours of the last copy', async () => {
    const { svc, asked } = await service();
    await svc.refreshAheadWeeks({ season: '2026', week: 5, scoring: SCORING, now: new Date('2026-10-09T03:00:00Z') });
    const before = asked.length;
    const again = await svc.refreshAheadWeeks({ season: '2026', week: 5, scoring: SCORING, now: new Date('2026-10-09T12:00:00Z') });
    expect(asked.length).toBe(before);
    expect(again.every((r) => r.skipped === 'stored copy is recent')).toBe(true);
  });

  it('never writes into the shared projection table the Start/Sit number reads', async () => {
    const { db, svc } = await service();
    await svc.refreshAheadWeeks({ season: '2026', week: 5, scoring: SCORING, now: new Date('2026-10-09T03:00:00Z') });
    for (const week of [6, 7, 8]) expect((await new SleeperProjectionsRepo(db).forWeek('2026', week)).size).toBe(0);
  });
});
