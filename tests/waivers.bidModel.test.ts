/**
 * The behaviour-aware bid model and its seed profiles. See
 * `core/waivers/bidModel.ts` and `core/waivers/managerSeeds.ts`.
 */

import { describe, expect, it } from 'vitest';
import { adviseBid, BID_MODEL, buildRivalProfiles, pullFor, type ClaimRecord, type RivalSeat } from '../src/core/waivers/bidModel.ts';
import { seedFor, STYLE_PRIORS } from '../src/core/waivers/managerSeeds.ts';
import { lastCompletedWeek, scoreWeek, weekPointsKey } from '../src/core/sleeper/weekPoints.ts';

const SEATS: RivalSeat[] = [
  { rosterId: 1, name: 'BigJuncer', isMine: true },
  { rosterId: 6, name: 'RonJonathan', isMine: false },
  { rosterId: 10, name: 'MattyB2317', isMine: false },
  { rosterId: 8, name: 'cheeseking', isMine: false },
  { rosterId: 9, name: 'MattLee04', isMine: false },
  { rosterId: 3, name: 'jfletcher433', isMine: false },
];
const quiet = { lastWeekPoints: 2, trendHeat: null, trendRank: null, roleRising: false, freshDrop: false };
const claim = (rosterId: number, playerId: string, amount: number, run: string, over: Partial<ClaimRecord> = {}): ClaimRecord => ({
  rosterId,
  playerId,
  amount,
  won: true,
  run,
  ...over,
});

describe('the seed profiles', () => {
  it('map Alex’s names to the right Sleeper owners, ignoring case', () => {
    expect(seedFor('RonJonathan')?.style).toBe('savvy');
    expect(seedFor('mattyb2317')?.style).toBe('slightly_savvy');
    expect(seedFor('cheeseking')?.style).toBe('rare');
    /* A different Matt is not MattyB2317. */
    expect(seedFor('MattLee04')).toBeNull();
  });

  it('call everyone else a last-week chaser by default', () => {
    const { profiles } = buildRivalProfiles({ seats: SEATS, claims: [] });
    expect(profiles.find((p) => p.name === 'MattLee04')?.style).toBe('chaser');
    expect(profiles.find((p) => p.name === 'MattLee04')?.styleSource).toBe('default');
    expect(profiles.find((p) => p.name === 'RonJonathan')?.styleSource).toBe('seed');
    expect(profiles.map((p) => p.name)).not.toContain('BigJuncer');
  });

  it('blend the seed with this season’s claims, so a busy chaser counts for more', () => {
    const claims = ['w1', 'w2', 'w3'].flatMap((run, i) => [claim(3, `a${i}`, 6, run), claim(3, `b${i}`, 7, run)]);
    const { profiles } = buildRivalProfiles({ seats: SEATS, claims });
    const jf = profiles.find((p) => p.name === 'jfletcher433')!;
    expect(jf.claimsPerRun).toBeGreaterThan(STYLE_PRIORS.chaser.claimsPerRun);
    expect(jf.bids).toEqual([6, 6, 6, 7, 7, 7]);
  });

  it('ignore a claim Sleeper voided for a full roster: it never competed', () => {
    const claims = [claim(6, 'x', 20, 'w1', { won: false, voided: true }), claim(6, 'y', 2, 'w1')];
    const { profiles, validClaims } = buildRivalProfiles({ seats: SEATS, claims });
    expect(validClaims).toBe(1);
    expect(profiles.find((p) => p.name === 'RonJonathan')!.bids).toEqual([2]);
  });
});

describe('the recommended bid', () => {
  it('is $1 when nobody is likely chasing him, and says so', () => {
    const seats = SEATS.filter((s) => s.isMine || s.name === 'cheeseking');
    const { profiles, targetsPerRun } = buildRivalProfiles({ seats, claims: [] });
    const advice = adviseBid({ signals: quiet, profiles, targetsPerRun, validClaims: 40, remaining: 80 });
    expect(advice.recommended).toBe(1);
    expect(advice.reason).toBe('Nobody is likely chasing him, so $1 should win.');
  });

  it('goes higher for last week’s big scorer who is also a top Sleeper add, and names the savvy manager', () => {
    const { profiles, targetsPerRun } = buildRivalProfiles({ seats: SEATS, claims: [] });
    const hot = adviseBid({
      signals: { lastWeekPoints: 24, trendHeat: 0.9, trendRank: 2, roleRising: true, freshDrop: false },
      profiles,
      targetsPerRun,
      validClaims: 40,
      remaining: 80,
    });
    const cold = adviseBid({ signals: quiet, profiles, targetsPerRun, validClaims: 40, remaining: 80 });
    expect(hot.recommended).toBeGreaterThan(cold.recommended);
    expect(hot.expectedRivals).toBeGreaterThan(cold.expectedRivals);
    expect(hot.reason).toContain('Scored 24.0 last week');
    expect(hot.reason).toContain('a likely RonJonathan target (#2 on Sleeper');
    expect(hot.rivals[0]!.name).toBe('RonJonathan');
  });

  it('reads Sleeper’s adds as a minor pull for a chaser and a major one for the savvy manager', () => {
    const trend = { ...quiet, lastWeekPoints: null, trendHeat: 1 };
    expect(pullFor('savvy', trend) - pullFor('savvy', quiet)).toBeGreaterThan(pullFor('chaser', trend) - pullFor('chaser', quiet));
  });

  it('widens the range on a thin record rather than raising the bid', () => {
    const { profiles, targetsPerRun } = buildRivalProfiles({ seats: SEATS, claims: [] });
    const signals = { ...quiet, lastWeekPoints: 15 };
    const thin = adviseBid({ signals, profiles, targetsPerRun, validClaims: 5, remaining: 80 });
    const full = adviseBid({ signals, profiles, targetsPerRun, validClaims: 60, remaining: 80 });
    expect(thin.recommended).toBe(full.recommended);
    expect(thin.high).toBeGreaterThanOrEqual(full.high);
    expect(thin.thin).toBe('Only 5 claims on record this season, so the range is wide.');
    expect(full.thin).toBeNull();
  });

  it('never recommends more than the wallet holds, and keeps low ≤ bid ≤ high', () => {
    const { profiles, targetsPerRun } = buildRivalProfiles({ seats: SEATS, claims: [] });
    const advice = adviseBid({
      signals: { lastWeekPoints: 30, trendHeat: 1, trendRank: 1, roleRising: true, freshDrop: true },
      profiles,
      targetsPerRun,
      validClaims: 40,
      remaining: 3,
    });
    expect(advice.recommended).toBeLessThanOrEqual(3);
    expect(advice.low).toBeLessThanOrEqual(advice.recommended);
    expect(advice.high).toBeGreaterThanOrEqual(advice.recommended);
    expect(BID_MODEL.minBid).toBe(1);
  });
});

describe('last week’s points', () => {
  it('score a stat line with the league’s own settings, defence and QB included', () => {
    const scoring = { pass_td: 6, pass_int: -2, pass_yd: 0.04, rec: 0.5, rec_yd: 0.1, def_int: 2, pts_allow_7_13: 4 };
    const points = scoreWeek(
      {
        qb: { pass_td: 2, pass_int: 1, pass_yd: 250, gms_active: 1 },
        wr: { rec: 6, rec_yd: 80, pos_rank_ppr: 12 },
        def: { def_int: 1, pts_allow_7_13: 1 },
        bench: { gms_active: 1 },
      },
      scoring,
    );
    expect(points).toEqual({ qb: 20, wr: 11, def: 6 });
  });

  it('count this week once its last kickoff is five hours gone', () => {
    const kickoffs = ['2026-10-08T00:15:00Z', '2026-10-11T17:00:00Z', '2026-10-13T00:15:00Z'];
    expect(lastCompletedWeek(5, kickoffs, new Date('2026-10-12T20:00:00Z'))).toBe(4);
    expect(lastCompletedWeek(5, kickoffs, new Date('2026-10-13T06:00:00Z'))).toBe(5);
    expect(lastCompletedWeek(5, [], new Date())).toBe(4);
  });

  it('are kept one settings row per week', () => {
    expect(weekPointsKey('2026', 4)).toBe('sleeper.weekPoints.2026.4');
  });
});
