/**
 * The need-aware rival model: each rival's roster need, his FAAB, and his
 * bidding history across seasons, blended with Alex's seeds. See
 * `core/waivers/rivalNeed.ts`, `core/waivers/rivalHistory.ts` and the
 * need-aware path in `core/waivers/bidModel.ts`.
 */

import { describe, expect, it } from 'vitest';
import { adviseBid, BID_POSTURE, buildRivalProfiles, type RivalContext, type RivalSeat } from '../src/core/waivers/bidModel.ts';
import { positionNeed, type NeedRosterPlayer } from '../src/core/waivers/rivalNeed.ts';
import {
  blendRivalTendency,
  buildRivalSeasonAggregates,
  rivalHistoryKey,
  seedTendency,
  STYLE_RATE,
  type HistoryClaim,
} from '../src/core/waivers/rivalHistory.ts';

const STARTERS = { QB: 1, RB: 2, WR: 3, TE: 1, DEF: 1 };
const qb = (id: string, team: string, status: string | null = null): NeedRosterPlayer => ({ playerId: id, name: id, position: 'QB', team, status });
const noByes = () => false;
const byeIn = (team: string, week: number) => (t: string, w: number) => t === team && w === week;

describe('positional need from a rival’s real roster', () => {
  it('reads three quarterbacks in a one-QB league as a surplus: an unlikely bidder', () => {
    const need = positionNeed({ starters: STARTERS, weeks: [6, 7], roster: [qb('Maye', 'NE'), qb('Mahomes', 'KC'), qb('Young', 'CAR')], onBye: noByes }, 'QB');
    expect(need.state).toBe('surplus');
    expect(need.factor).toBeLessThan(0.5);
    expect(need.reason).toBe('has 3 QBs, unlikely');
  });

  it('reads a lone quarterback on bye next week as a hole: a likely bidder', () => {
    const need = positionNeed({ starters: STARTERS, weeks: [6, 7], roster: [qb('Burrow', 'CIN')], onBye: byeIn('CIN', 6) }, 'QB');
    expect(need.state).toBe('hole');
    expect(need.factor).toBeGreaterThanOrEqual(2.5);
    expect(need.reason).toBe('QB on bye in week 6, no backup');
  });

  it('counts an Out or IR quarterback as unable to start', () => {
    const need = positionNeed({ starters: STARTERS, weeks: [6, 7], roster: [qb('A', 'BUF', 'Out')], onBye: noByes }, 'QB');
    expect(need.state).toBe('hole');
    expect(need.reason).toBe('QB hurt, no healthy backup');
  });

  it('counts a weak backup as half a starter when his projection is known', () => {
    const roster = [{ ...qb('Shough', 'NO'), projection: 10 }, { ...qb('Brissett', 'ARI'), projection: 9 }];
    const need = positionNeed({ starters: STARTERS, weeks: [6, 7], roster, onBye: noByes }, 'QB');
    expect(need.startable).toEqual([1, 1]);
    expect(need.state).toBe('thin');
  });

  it('treats depth at receiver as normal, not a reason to stop bidding', () => {
    const wr = (id: string): NeedRosterPlayer => ({ playerId: id, name: id, position: 'WR', team: 'X', status: null });
    const need = positionNeed({ starters: STARTERS, weeks: [6, 7], roster: ['a', 'b', 'c', 'd', 'e'].map(wr), onBye: noByes }, 'WR');
    expect(need.state).toBe('backup');
    expect(need.factor).toBeGreaterThanOrEqual(1);
  });
});

/* Ten managers' worth of claims over two seasons, one contested player per run. */
function claims(): HistoryClaim[] {
  const out: HistoryClaim[] = [];
  let at = 1_000_000;
  for (const season of ['2025', '2026']) {
    for (let run = 1; run <= 10; run++) {
      at += 7 * 86_400_000;
      /* u-ron bids on every RB and never on a QB; u-quiet never bids. */
      const position = run % 2 === 0 ? 'QB' : 'RB';
      out.push({ season, week: run, userId: 'u-chaser', playerId: `${season}-${run}`, position, amount: 4, won: true, at });
      if (position === 'RB') out.push({ season, week: run, userId: 'u-ron', playerId: `${season}-${run}`, position, amount: 10, won: false, at });
    }
  }
  return out;
}
const SEASONS = new Map([
  ['u-chaser', ['2025', '2026']],
  ['u-ron', ['2025', '2026']],
  ['u-quiet', ['2025', '2026']],
  ['u-new', ['2026']],
]);

describe('bid history across seasons', () => {
  const aggregates = buildRivalSeasonAggregates({ claims: claims(), seasonsByUser: SEASONS, budgetTotal: 100 });

  it('keeps one compact row per manager per season', () => {
    const ron = aggregates.filter((a) => a.userId === 'u-ron');
    expect(ron.map((a) => a.season)).toEqual(['2025', '2026']);
    expect(ron[0]).toMatchObject({ targets: 10, bids: 5, byPosition: { RB: 5 } });
    expect(ron[0]!.shares.every((s) => s > 0 && s <= 1)).toBe(true);
    expect(rivalHistoryKey('L1', '2026', 'u-ron')).toBe('waivers.rivalHistory.L1.2026.u-ron');
  });

  it('lets history override the seed: a "savvy" seed who never bids on QBs is unlikely to bid on one', () => {
    const ron = blendRivalTendency({ userId: 'u-ron', style: 'savvy', aggregates, currentSeason: '2026' });
    expect(ron.source).toBe('history');
    expect(ron.interest['QB']).toBeLessThan(0.5);
    expect(ron.interest['RB']).toBeGreaterThan(1.3);
  });

  it('weights the newest season more than the one before', () => {
    /* Same manager: busy in 2025, silent in 2026. His rate sits nearer 2026. */
    const busyThenQuiet: HistoryClaim[] = claims()
      .filter((c) => c.userId === 'u-chaser' && c.season === '2025')
      .concat(claims().filter((c) => c.userId === 'u-ron' && c.season === '2026').map((c) => ({ ...c, userId: 'u-other' })));
    const agg = buildRivalSeasonAggregates({
      claims: busyThenQuiet,
      seasonsByUser: new Map([['u-chaser', ['2025', '2026']], ['u-other', ['2025', '2026']]]),
      budgetTotal: 100,
    });
    const t = blendRivalTendency({ userId: 'u-chaser', style: 'chaser', aggregates: agg, currentSeason: '2026' });
    const unweighted = 10 / 15; /* 10 bids of 15 contested players over both seasons */
    expect(t.rate).toBeLessThan(unweighted);
  });

  it('falls back to the seed when the record is thin', () => {
    const fresh = blendRivalTendency({ userId: 'u-new', style: 'slightly_savvy', aggregates, currentSeason: '2026' });
    expect(fresh.source).toBe('seed');
    const seed = seedTendency('u-x', 'rare');
    expect(seed.rate).toBeCloseTo(STYLE_RATE.rare, 3);
    expect(seed.shares.length).toBeGreaterThan(0);
  });

  it('never counts a manager as passing on players from before he joined', () => {
    const newcomer = aggregates.filter((a) => a.userId === 'u-new');
    expect(newcomer.map((a) => a.season)).toEqual(['2026']);
  });
});

describe('the need-aware bid', () => {
  const SEATS: RivalSeat[] = [
    { rosterId: 1, name: 'BigJuncer', isMine: true },
    { rosterId: 6, name: 'RonJonathan', isMine: false },
    { rosterId: 3, name: 'jfletcher433', isMine: false },
    { rosterId: 9, name: 'MattLee04', isMine: false },
  ];
  const { profiles, targetsPerRun, validClaims } = buildRivalProfiles({ seats: SEATS, claims: [] });
  const signals = { lastWeekPoints: 17, trendHeat: 0.2, trendRank: 40, roleRising: false, freshDrop: false };
  const tendency = (id: string, rate: number) => ({ ...seedTendency(id, 'chaser'), rate, interest: { QB: 1, RB: 1, WR: 1, TE: 1, DEF: 1 } });
  const need = (roster: NeedRosterPlayer[], bye?: [string, number]) =>
    positionNeed({ starters: STARTERS, weeks: [6, 7], roster, onBye: bye ? byeIn(bye[0], bye[1]) : noByes }, 'QB');
  const contexts = (ronRemaining: number | null): Map<number, RivalContext> =>
    new Map([
      [6, { tendency: tendency('ron', 0.3), need: need([qb('Maye', 'NE'), qb('Mahomes', 'KC'), qb('Young', 'CAR')]), remaining: ronRemaining }],
      [3, { tendency: tendency('jf', 0.2), need: need([qb('Allen', 'BUF')], ['BUF', 6]), remaining: 61 }],
      [9, { tendency: tendency('ml', 0.04), need: need([qb('Cousins', 'ATL')]), remaining: 96 }],
    ]);

  it('ranks the rival with a QB hole above the savvy rival with three QBs, and says why', () => {
    const advice = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 80, rivals: contexts(50), position: 'QB', posture: 'do_this' });
    expect(advice.rivals[0]!.name).toBe('jfletcher433');
    expect(advice.rivals[0]!.why).toBe('QB on bye in week 6, no backup');
    const ron = advice.rivals.find((r) => r.name === 'RonJonathan')!;
    expect(ron.why).toBe('has 3 QBs, unlikely');
    expect(ron.chance).toBeLessThan(advice.rivals[0]!.chance / 3);
    expect(advice.reason).not.toMatch(/likely .* target/);
  });

  it('never expects a rival to bid more than the FAAB he has left', () => {
    const advice = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 80, rivals: contexts(0), position: 'QB', posture: 'do_this' });
    const ron = advice.rivals.find((r) => r.name === 'RonJonathan')!;
    expect(ron.likelyBid).toBe(0);
    expect(ron.why).toBe('has 3 QBs, unlikely');
    const capped = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 80, rivals: contexts(3), position: 'QB', posture: 'do_this' });
    expect(capped.rivals.find((r) => r.name === 'RonJonathan')!.likelyBid).toBeLessThanOrEqual(3);
  });

  it('bids harder for a hole than for an upgrade, and $0 to $1 for a stash', () => {
    const base = { signals, profiles, targetsPerRun, validClaims, remaining: 80, rivals: contexts(50), position: 'QB' };
    const hole = adviseBid({ ...base, posture: 'do_this' });
    const upgrade = adviseBid({ ...base, posture: 'consider' });
    const stash = adviseBid({ ...base, posture: 'stash' });
    expect(hole.recommended).toBeGreaterThanOrEqual(upgrade.recommended);
    expect(stash.recommended).toBeLessThanOrEqual(1);
    expect(stash.high).toBeLessThanOrEqual(BID_POSTURE.stash.cap!);
    expect(stash.low).toBe(0);
  });

  it('reads a rival with no stored history from his seed alone', () => {
    const thin = new Map<number, RivalContext>([[6, { tendency: seedTendency('ron', 'savvy'), need: null, remaining: null }]]);
    const advice = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 80, rivals: thin, position: 'QB', posture: 'do_this' });
    const ron = advice.rivals.find((r) => r.name === 'RonJonathan')!;
    expect(ron.parts?.rate).toBeCloseTo(STYLE_RATE.savvy, 2);
    /* The other two have no context and are read by the old model. */
    expect(advice.rivals.find((r) => r.name === 'MattLee04')!.why).toBeUndefined();
  });
});
