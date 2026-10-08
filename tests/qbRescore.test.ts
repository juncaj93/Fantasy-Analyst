/**
 * Quarterbacks rescored for this league's scoring (finding F5, October 2026).
 *
 * Sleeper's published QB total assumes 4 points a passing touchdown and -1 an
 * interception; Tony's Pizza Fantasy pays 6 and charges -2. Until now every
 * quarterback without a full betting market had no number at all. Alex
 * approved rebuilding the total from the stat line beside it, stored without a
 * migration: one settings row per week holds each quarterback's counts.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import {
  parseSleeperWeeklyProjections,
  publishedRefusal,
  qbRescore,
  rescoreQbTotal,
  sleeperScoringKey,
} from '../src/core/sleeper/weeklyProjections.ts';
import { SleeperProjectionService, qbLinesKey } from '../src/server/services/sleeperProjectionService.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';

const TONYS_PIZZA = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2 }, []);
const STANDARD_QB = buildScoringProfile({ rec: 0.5 }, []);

/** Joe Burrow's week-5 row, as Sleeper sends it (published 19.27; this league 22.20). */
const BURROW = {
  player_id: '6770',
  company: 'rotowire',
  player: { position: 'QB' },
  stats: { pts_std: 19.27, pts_half_ppr: 19.27, pts_ppr: 19.27, pass_yd: 262, pass_td: 1.77, pass_int: 0.61, rush_yd: 9, rush_td: 0.1, fum_lost: 0.1 },
};
const RECEIVER = {
  player_id: '4034',
  company: 'rotowire',
  player: { position: 'WR' },
  stats: { pts_std: 10.4, pts_half_ppr: 13.33, pts_ppr: 16.2 },
};
// Sleeper also wants defences in the feed, or the gate refetches.
const DEFENCE = { player_id: 'JAX', company: 'rotowire', player: { position: 'DEF' }, stats: { pts_std: 9, pts_half_ppr: 9, pts_ppr: 9, sack: 3 } };
const FEED = [BURROW, RECEIVER, DEFENCE];
const position = (id: string) => (id === '6770' ? 'QB' : id === 'JAX' ? 'DEF' : 'WR');

describe('the rescoring rule', () => {
  it('adjusts for exactly the settings this league changed', () => {
    const r = qbRescore(TONYS_PIZZA)!;
    expect(r.key).toBe('pts_half_ppr');
    expect(r.per).toEqual({ passTds: 2, interceptions: -1 });
  });

  it('rebuilds Burrow’s total: 19.27 + 2 x 1.77 - 1 x 0.61', () => {
    const [row] = parseSleeperWeeklyProjections([BURROW]);
    expect(row!.qb).toMatchObject({ passTds: 1.77, interceptions: 0.61, passYards: 262 });
    expect(rescoreQbTotal(row!.points, row!.qb, qbRescore(TONYS_PIZZA)!)).toBe(22.2);
  });

  it('keeps no stat line for anybody but a quarterback', () => {
    const [row] = parseSleeperWeeklyProjections([RECEIVER]);
    expect(row!.qb).toBeUndefined();
  });

  it('has nothing to do in a league that already scores quarterbacks the feed’s way', () => {
    expect(qbRescore(STANDARD_QB)).toBeNull();
    expect(sleeperScoringKey(STANDARD_QB, 'QB')).toBe('pts_half_ppr');
  });

  it('still refuses a quarterback when the reception value picks no published total', () => {
    const oddPpr = buildScoringProfile({ rec: 0.75, pass_td: 6 }, []);
    expect(qbRescore(oddPpr)).toBeNull();
    expect(publishedRefusal(oddPpr, 'QB')).not.toBeNull();
  });

  it('stops calling this league’s quarterback refused', () => {
    expect(publishedRefusal(TONYS_PIZZA, 'QB')).toBeNull();
    // The published total itself is still never quoted as-is.
    expect(sleeperScoringKey(TONYS_PIZZA, 'QB')).toBeNull();
  });
});

describe('stored without a migration', () => {
  async function fetched() {
    const db = await createTestDb();
    let asked = 0;
    const sleeper = {
      getWeeklyProjections: async () => {
        asked += 1;
        return FEED;
      },
    };
    const service = new SleeperProjectionService(db, sleeper as never, () => new Date('2026-10-08T09:00:00Z'));
    return { db, service, asked: () => asked };
  }

  it('keeps the week’s quarterback lines in one settings row', async () => {
    const { db, service } = await fetched();
    expect((await service.refresh('2026', 5)).outcome).toBe('fetched');
    const row = await new SettingsRepo(db).get<{ lines: Record<string, unknown> } | null>(qbLinesKey('2026', 5), null);
    expect(Object.keys(row!.lines)).toEqual(['6770']);
  });

  it('leaves the projections table exactly as it was', async () => {
    const db = await createTestDb();
    const { results } = await db.prepare("SELECT name FROM pragma_table_info('sleeper_weekly_projections')").all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(
      ['defense_json', 'fetched_at', 'player_id', 'pts_half_ppr', 'pts_ppr', 'pts_std', 'publisher', 'season', 'week'].sort(),
    );
  });

  it('reads Burrow at 22.2 in this league, and the receiver as before', async () => {
    const { service } = await fetched();
    await service.refresh('2026', 5);
    const figures = await service.publishedFor({
      season: '2026',
      week: 5,
      playerIds: ['6770', '4034'],
      profile: TONYS_PIZZA,
      positionOf: position,
      narrow: true,
    });
    expect(figures.get('6770')).toBe(22.2);
    expect(figures.get('4034')).toBe(13.33);
  });

  it('gives a quarterback no number when no lines row is stored, exactly as before', async () => {
    const db = await createTestDb();
    await new SleeperProjectionsRepo(db).save('2026', 5, parseSleeperWeeklyProjections(FEED), '2026-10-08T08:00:00Z');
    const service = new SleeperProjectionService(db, {} as never);
    const figures = await service.publishedFor({
      season: '2026',
      week: 5,
      playerIds: ['6770', '4034'],
      profile: TONYS_PIZZA,
      positionOf: position,
      narrow: true,
    });
    expect(figures.has('6770')).toBe(false);
    expect(figures.get('4034')).toBe(13.33);
  });

  it('refetches a young week once when it was stored before lines were kept, then declines', async () => {
    const { db, service, asked } = await fetched();
    await new SleeperProjectionsRepo(db).save('2026', 5, parseSleeperWeeklyProjections(FEED), '2026-10-08T08:00:00Z');
    expect((await service.refresh('2026', 5)).outcome).toBe('fetched');
    expect((await service.refresh('2026', 5)).outcome).toBe('current');
    expect(asked()).toBe(1);
  });

  it('rescores an earlier week for the trade check when that week’s lines are stored', async () => {
    const { service } = await fetched();
    await service.refresh('2026', 4);
    const recent = await service.publishedRecent({
      season: '2026',
      weeks: [4],
      playerIds: ['6770'],
      profile: TONYS_PIZZA,
      positionOf: position,
      floor: 1,
    });
    expect(recent.get('6770')).toEqual({ week: 4, points: 22.2 });
  });
});
