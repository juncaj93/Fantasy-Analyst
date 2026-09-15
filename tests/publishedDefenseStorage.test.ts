/**
 * The published week in the database, and the two gates in front of it.
 *
 * Everything between Sleeper's answer and the number on the screen goes through
 * here, and until 10 September 2026 none of it was tested against a real
 * database — which is where the defect the owner reported actually lived. The
 * fallback for a defence was designed, scored, labelled and unit-tested, and it
 * had never once survived the round trip, because the feed was not asked for a
 * defensive row and nothing here would have noticed.
 *
 * So this exercises the path end to end over the production schema: parse what
 * Sleeper sends, write it, read it back, and score it under a league's own
 * rules. Plus the freshness gate, which is the reason a fix can ship and change
 * nothing for half a day.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';
import { SleeperProjectionService } from '../src/server/services/sleeperProjectionService.ts';
import { parseSleeperWeeklyProjections } from '../src/core/sleeper/weeklyProjections.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';

/** Sleeper's shape, with Jacksonville's real week-one row inside it. */
const FEED = [
  {
    player_id: 'JAX',
    company: 'rotowire',
    player: { position: 'DEF' },
    stats: {
      pts_std: 9.47,
      pts_half_ppr: 9.47,
      pts_ppr: 9.47,
      sack: 2.99,
      int: 0.9,
      fum_rec: 0.69,
      ff: 0.9,
      def_td: 0.21,
      blk_kick: 0.07,
      pts_allow: 15.75,
      yds_allow: 270.98,
    },
  },
  {
    player_id: '4034',
    company: 'rotowire',
    player: { position: 'WR' },
    stats: { pts_std: 10.4, pts_half_ppr: 13.33, pts_ppr: 16.2 },
  },
];

/** The owner's league: half PPR, six-point passing touchdowns, ff worth nothing. */
const TONYS_PIZZA = {
  rec: 0.5,
  pass_td: 6,
  sack: 1,
  int: 2,
  fum_rec: 2,
  ff: 0,
  def_td: 6,
  st_td: 6,
  safe: 2,
  blk_kick: 2,
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: 0,
  pts_allow_35p: 0,
};

async function stored() {
  const db = await createTestDb();
  const repo = new SleeperProjectionsRepo(db);
  await repo.save('2026', 1, parseSleeperWeeklyProjections(FEED), '2026-09-10T09:00:00Z');
  return { db, repo };
}

describe('a defence survives the round trip through the database', () => {
  it('keeps the projected counts, not just the totals', async () => {
    const { repo } = await stored();
    const week = await repo.forWeek('2026', 1);

    expect(week.get('JAX')?.defense).toEqual({
      sacks: 2.99,
      interceptions: 0.9,
      fumbleRecoveries: 0.69,
      forcedFumbles: 0.9,
      defensiveTds: 0.21,
      specialTeamsTds: 0,
      safeties: 0,
      blockedKicks: 0.07,
      pointsAllowed: 15.75,
      yardsAllowed: 270.98,
    });
    // And a receiver still carries nothing but his totals.
    expect(week.get('4034')?.defense).toBeNull();
    expect(week.get('4034')?.points.pts_half_ppr).toBe(13.33);
  });

  it('answers the owner’s own league, which the old rule refused', async () => {
    /*
     * The reported bug, end to end. Jacksonville is published at 9.47 under
     * Sleeper's defaults; this league pays nothing for a forced fumble, so it
     * is 8.57 here — and the quarterback rule that used to silence the whole
     * feed reaches nobody, because a defence is not scored on passing.
     */
    const { db } = await stored();
    const profile = buildScoringProfile(TONYS_PIZZA, []);
    const figures = await new SleeperProjectionService(db, {} as never).publishedFor({
      season: '2026',
      week: 1,
      playerIds: ['JAX', '4034'],
      profile,
      positionOf: (id) => (id === 'JAX' ? 'DEF' : 'WR'),
    });

    expect(figures.get('JAX')).toBeCloseTo(8.57, 2);
    expect(figures.get('4034')).toBe(13.33);
  });

  it('has no number for a defence when the caller cannot say it is one', async () => {
    // Not a regression to fix — the counts are scored under a *defensive*
    // table, so a caller who does not know the position is asking a question
    // with no answer. Every caller in the app supplies one.
    const { db } = await stored();
    const figures = await new SleeperProjectionService(db, {} as never).publishedFor({
      season: '2026',
      week: 1,
      playerIds: ['JAX'],
      profile: buildScoringProfile(TONYS_PIZZA, []),
      positionOf: () => null,
    });

    expect(figures.has('JAX')).toBe(false);
  });
});

describe('the freshness gate counts defences, not only rows', () => {
  it('reports them separately', async () => {
    const { repo } = await stored();
    const held = await repo.freshness('2026', 1);

    expect(held.players).toBe(2);
    expect(held.defenses).toBe(1);
  });

  it('refetches a week that is young but has no defence in it', async () => {
    /*
     * The half-day the fix would otherwise have been invisible for. The week
     * already in production when this shipped was four hundred players, no
     * defences, and eight hours old — current by every measure the gate had.
     */
    const db = await createTestDb();
    const offenceOnly = parseSleeperWeeklyProjections([FEED[1]]);
    await new SleeperProjectionsRepo(db).save('2026', 1, offenceOnly, '2026-09-10T09:00:00Z');

    let asked = 0;
    const sleeper = {
      getWeeklyProjections: async () => {
        asked += 1;
        return FEED;
      },
    };
    const service = new SleeperProjectionService(db, sleeper as never, () => new Date('2026-09-10T17:00:00Z'));

    const report = await service.refresh('2026', 1);
    expect(asked, 'eight hours old, and refetched anyway').toBe(1);
    expect(report.outcome).toBe('fetched');

    // And once the defences are in, the gate goes back to declining cheaply.
    const again = await service.refresh('2026', 1);
    expect(again.outcome).toBe('current');
    expect(asked, 'no second request').toBe(1);
  });
});
