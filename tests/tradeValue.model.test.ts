/**
 * The trade value model: what a trade does to each team's lineup from now to
 * the end of the league's playoffs.
 *
 * The properties worth pinning are the ones a reader would catch by eye on a
 * real card: a player a team cannot use is worth nothing to it, an upgrade at a
 * weak slot is worth a lot, a bye is a count and not a discount, a gap inside
 * the noise is never presented as a winner, and a player nobody can price
 * never gets a verdict at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { weeklyAvailability, AVAILABILITY_POLICY } from '../src/core/tradeValue/availability.ts';
import { bestLineup, slotsOf } from '../src/core/tradeValue/lineup.ts';
import { resolveRate, type PlayerRate } from '../src/core/tradeValue/rate.ts';
import {
  TRADE_VALUE,
  evaluateTrade,
  replacementLevels,
  type TradeSide,
} from '../src/core/tradeValue/evaluate.ts';
import { playoffLength, tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import type { StartSitEvaluation } from '../src/core/startsit/engine.ts';

/** Tony's Pizza Fantasy, as Sleeper publishes it. */
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
const SHAPE = buildRosterShape(POSITIONS);
const HORIZON = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 5 });

function rate(id: string, position: string, ppg: number | null, extra: Partial<PlayerRate> = {}): PlayerRate {
  const weekly = HORIZON.weeks.map(() => 1);
  return {
    playerId: id,
    name: id,
    position,
    team: 'AAA',
    rate: ppg,
    basis: ppg == null ? 'none' : 'market',
    rateNote: ppg == null ? 'no market, no published projection and no season line' : null,
    designation: 'healthy',
    games: weekly.reduce((a, b) => a + b, 0),
    weekly,
    injuryNote: null,
    byeWeek: null,
    byeKnown: true,
    byeInside: false,
    onReserve: false,
    ...extra,
  };
}

/** A bye in `week`: that week's availability is zero and the games fall by one. */
function withBye(p: PlayerRate, week: number): PlayerRate {
  const weekly = p.weekly.map((v, i) => (HORIZON.weeks[i] === week ? 0 : v));
  return { ...p, weekly, games: weekly.reduce((a, b) => a + b, 0), byeWeek: week, byeInside: true };
}

/** Free agents that put replacement at 10 RB, 9 WR, 8 TE, 12 QB, 5 DEF. */
const FREE_AGENTS: PlayerRate[] = [
  ...[10, 10, 10].map((v, i) => rate(`fa-rb${i}`, 'RB', v)),
  ...[9, 9, 9].map((v, i) => rate(`fa-wr${i}`, 'WR', v)),
  ...[8, 8, 8].map((v, i) => rate(`fa-te${i}`, 'TE', v)),
  ...[12, 12, 12].map((v, i) => rate(`fa-qb${i}`, 'QB', v)),
  ...[5, 5, 5].map((v, i) => rate(`fa-def${i}`, 'DEF', v)),
];
const REPLACEMENT = replacementLevels(FREE_AGENTS);

/** A roster that starts every slot at a known rate. Names are `${tag}-${slot}`. */
function roster(tag: string, overrides: Record<string, number | null> = {}, extra: PlayerRate[] = []): PlayerRate[] {
  const base: [string, string, number][] = [
    ['qb', 'QB', 20],
    ['rb1', 'RB', 16],
    ['rb2', 'RB', 13],
    ['wr1', 'WR', 17],
    ['wr2', 'WR', 14],
    ['wr3', 'WR', 11],
    ['te', 'TE', 10],
    ['flex1', 'RB', 11.5],
    ['flex2', 'WR', 10.5],
    ['def', 'DEF', 8],
  ];
  const players = base.map(([slot, position, ppg]) => {
    const key = `${tag}-${slot}`;
    const v = key in overrides ? overrides[key]! : slot in overrides ? overrides[slot]! : ppg;
    return rate(key, position, v);
  });
  return [...players, ...extra];
}

function side(label: string, players: PlayerRate[], isMine = false): TradeSide {
  return { label, rosterId: null, isMine, roster: players, starterIds: players.slice(0, 10).map((p) => p.playerId) };
}

function run(a: TradeSide, b: TradeSide, aSends: string[], bSends: string[]) {
  return evaluateTrade({ horizon: HORIZON, shape: SHAPE, replacement: REPLACEMENT, a, b, aSends, bSends });
}

describe('the fantasy season, from the league’s own settings', () => {
  it('runs from this week through the last playoff week and names the deadline', () => {
    expect(HORIZON.weeks).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(HORIZON.playoffWeeks).toEqual([15, 16, 17]);
    expect(HORIZON.regularSeasonEnd).toBe(14);
    expect(HORIZON.deadlineWeek).toBe(11);
    expect(HORIZON.weeksToDeadline).toBe(7);
    expect(HORIZON.deadlinePassed).toBe(false);
  });

  it('reports a passed deadline and an over season', () => {
    expect(tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 12 }).deadlinePassed).toBe(true);
    expect(tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 19 }).weeks).toEqual([]);
  });

  it('reads bracket size and round length', () => {
    expect(playoffLength({ playoff_teams: 6 })).toBe(3);
    expect(playoffLength({ playoff_teams: 4 })).toBe(2);
    expect(playoffLength({ playoff_teams: 8 })).toBe(3);
    expect(playoffLength({ playoff_teams: 6, playoff_round_type: 1 })).toBe(4);
    expect(playoffLength({ playoff_teams: 6, playoff_round_type: 2 })).toBe(6);
    expect(tradeHorizon({ leagueSettings: { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 2 }, currentWeek: 5 }).lastWeek).toBe(18);
  });

  it('treats no deadline as no deadline', () => {
    const h = tradeHorizon({ leagueSettings: { ...SETTINGS, trade_deadline: 0 }, currentWeek: 5 });
    expect(h.deadlineWeek).toBeNull();
    expect(h.deadlinePassed).toBe(false);
  });
});

describe('availability: byes are a count, injuries are assumptions', () => {
  const weeks = HORIZON.weeks;
  it('a bye removes exactly one week and nothing else', () => {
    const a = weeklyAvailability({ designation: 'healthy', weeks, byeWeek: 9 });
    expect(a.games).toBe(12);
    expect(a.weekly[weeks.indexOf(9)]).toBe(0);
    expect(a.byeInside).toBe(true);
  });

  it('a bye outside the horizon changes nothing', () => {
    expect(weeklyAvailability({ designation: 'healthy', weeks, byeWeek: 3 }).games).toBe(13);
  });

  it('Out is about two weeks, IR is four, and neither makes him worse afterwards', () => {
    const out = weeklyAvailability({ designation: 'out', weeks, byeWeek: null });
    expect(out.weekly.slice(0, 3)).toEqual([0, 0.5, 1]);
    const ir = weeklyAvailability({ designation: 'ir', weeks, byeWeek: null });
    expect(ir.weekly.slice(0, 5)).toEqual([0, 0, 0, 0, AVAILABILITY_POLICY.ir.after]);
  });

  it('a player in an IR slot is not available this week whatever his designation says', () => {
    const a = weeklyAvailability({ designation: 'questionable', onReserve: true, weeks, byeWeek: null });
    expect(a.weekly[0]).toBe(0);
  });

  it('an unknown designation is healthy, and says nothing', () => {
    const a = weeklyAvailability({ designation: 'unknown', weeks, byeWeek: null });
    expect(a.games).toBe(13);
    expect(a.note).toBeNull();
  });
});

describe('replacement level comes from the free-agent pool', () => {
  it('is the mean of the best three priced free agents, not the single best', () => {
    const level = replacementLevels([
      rate('a', 'WR', 12),
      rate('b', 'WR', 9),
      rate('c', 'WR', 6),
      rate('d', 'WR', 2),
    ]);
    expect(level.get('WR')!.rate).toBe(9);
    expect(level.get('WR')!.sample).toBe(3);
  });

  it('ignores unpriced and ruled-out free agents', () => {
    const level = replacementLevels([rate('a', 'WR', 12, { designation: 'out' }), rate('b', 'WR', null), rate('c', 'WR', 7)]);
    expect(level.get('WR')).toMatchObject({ rate: 7, sample: 1, names: ['c'] });
  });

  it('has no entry for a position with nobody priced', () => {
    expect(replacementLevels([rate('a', 'TE', null)]).has('TE')).toBe(false);
  });
});

describe('the lineup solver', () => {
  const slots = slotsOf(SHAPE);
  const cand = (id: string, position: string, value: number) => ({ id, position, value });

  it('fills dedicated slots and then the flex slots from what is left', () => {
    const picks = bestLineup(slots, [
      cand('q', 'QB', 20),
      cand('r1', 'RB', 15),
      cand('r2', 'RB', 14),
      cand('r3', 'RB', 13),
      cand('r4', 'RB', 12),
      cand('w1', 'WR', 10),
      cand('w2', 'WR', 9),
      cand('w3', 'WR', 8),
      cand('t', 'TE', 7),
      cand('d', 'DEF', 6),
    ]);
    // Both flex slots go to the third and fourth back, ahead of nothing else.
    expect(picks.total).toBe(20 + 15 + 14 + 13 + 12 + 10 + 9 + 8 + 7 + 6);
  });

  it('never starts a quarterback in a flex slot of a one-quarterback league', () => {
    const lineup = bestLineup(slots, [cand('q1', 'QB', 20), cand('q2', 'QB', 19)]);
    expect(lineup.picks.filter((p) => p?.position === 'QB')).toHaveLength(1);
  });

  it('is exact when two flex slots cross', () => {
    const crossing = slotsOf(buildRosterShape(['WR', 'RB', 'REC_FLEX', 'WRRB_FLEX']));
    const lineup = bestLineup(crossing, [
      cand('w1', 'WR', 10),
      cand('w2', 'WR', 9),
      cand('t1', 'TE', 8),
      cand('r1', 'RB', 7),
      cand('r2', 'RB', 6),
    ]);
    // WR slot: w1 (10). RB slot: r1 (7). REC_FLEX takes the TE (8) and WRRB_FLEX
    // the other receiver (9). A greedy fill that gave the receiver to REC_FLEX
    // would leave the TE with nowhere to go and score 8 less.
    expect(lineup.total).toBe(34);
  });

  it('leaves a slot empty rather than inventing a player', () => {
    const lineup = bestLineup(slots, [cand('q', 'QB', 20)]);
    expect(lineup.total).toBe(20);
    expect(lineup.picks.filter((p) => p == null).length).toBe(slots.length - 1);
  });
});

describe('the rate ladder', () => {
  function evaluation(opts: {
    market?: number | null;
    missing?: string[];
    status?: number;
    designation?: string;
    ruledOut?: boolean;
    nudges?: Record<string, number>;
  }): StartSitEvaluation {
    const components = [
      { key: 'vegas', value: opts.market ?? 0, unknown: opts.market == null },
      { key: 'status', value: opts.status ?? 0, unknown: false },
      ...Object.entries(opts.nudges ?? {}).map(([key, value]) => ({ key, value, unknown: false })),
    ];
    const score = components.filter((c) => !c.unknown).reduce((a, c) => a + c.value, 0);
    return {
      playerId: 'p',
      name: 'P',
      position: 'WR',
      team: 'AAA',
      score,
      expectation: { points: opts.market ?? null, missingMarkets: opts.missing ?? [] },
      components,
      injury: { designation: opts.designation ?? 'healthy' },
      ruledOut: opts.ruledOut ?? false,
    } as unknown as StartSitEvaluation;
  }

  it('uses a complete Vegas week, with the availability charge taken back out', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: 12, status: -1.5, designation: 'questionable' }),
      seasonLine: 9,
      byeThisWeek: false,
    });
    expect(r).toMatchObject({ rate: 12, basis: 'market' });
  });

  it('keeps the soft nudges the engine already budgeted and adds none of its own', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: 10, nudges: { news_recent: 0.3 } }),
      seasonLine: null,
      byeThisWeek: false,
    });
    expect(r.rate).toBe(10.3);
  });

  it('falls to Sleeper’s published week when the market is partial, and says so', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: 3, missing: ['player_receptions'] }),
      published: new Map([['p', 11]]),
      seasonLine: null,
      byeThisWeek: false,
    });
    expect(r.basis).toBe('published');
    expect(r.rate).toBe(11);
    expect(r.note).toMatch(/Sleeper/);
  });

  it('never treats a partial market as a forecast', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: 3, missing: ['player_receptions'] }),
      seasonLine: null,
      byeThisWeek: false,
    });
    expect(r).toMatchObject({ rate: null, basis: 'none' });
  });

  it('values a player on a bye by the season line, not by a number for a game that is not played', () => {
    const r = resolveRate({ evaluation: evaluation({ market: null }), seasonLine: 8.4, byeThisWeek: true });
    expect(r).toMatchObject({ rate: 8.4, basis: 'season_line' });
    expect(r.note).toMatch(/bye/);
  });

  it('values an out player by the season line when this week’s figure is a published zero', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: null, designation: 'out', ruledOut: true, status: -99 }),
      published: new Map([['p', 0]]),
      seasonLine: 13,
      byeThisWeek: false,
    });
    expect(r).toMatchObject({ rate: 13, basis: 'season_line' });
  });

  it('refuses to value an out player with no season line at zero', () => {
    const r = resolveRate({
      evaluation: evaluation({ market: null, designation: 'out', ruledOut: true, status: -99 }),
      published: new Map([['p', 0]]),
      seasonLine: null,
      byeThisWeek: false,
    });
    expect(r).toMatchObject({ rate: null, basis: 'none' });
  });
});

describe('what a trade does to a lineup', () => {
  it('a third quarterback is worth about nothing to a team that already starts one', () => {
    const buyer = side('Buyer', roster('b'));
    const seller = side('Seller', roster('s', {}, [rate('s-qb2', 'QB', 19.5)]));
    const r = run(buyer, seller, [], ['s-qb2']);
    expect(r.status).toBe('ok');
    expect(r.a!.lineupChange).toBe(0);
    // Depth credit for a spare quarterback is small: a tenth of his edge, on a good day.
    expect(r.a!.depthChange).toBeLessThan(10);
    expect(r.a!.incoming[0]!.startsWeeks).toBe(0);
  });

  it('a wide receiver is worth a lot to a team whose third receiver is weak', () => {
    const needy = side('Needy', roster('n', { wr3: 9.5, flex2: 9.5 }));
    const deep = side('Deep', roster('d', {}, [rate('d-wr4', 'WR', 15)]));
    const r = run(needy, deep, [], ['d-wr4']);
    expect(r.a!.lineupChange).toBeGreaterThan(30);
    expect(r.a!.incoming[0]!.startsWeeks).toBe(13);
    // The same player is worth much less to a team that has receivers.
    const stacked = side('Stacked', roster('s', { wr3: 16, flex2: 15.5 }));
    const r2 = run(stacked, deep, [], ['d-wr4']);
    expect(r2.a!.lineupChange).toBeLessThan(r.a!.lineupChange);
  });

  it('losing a starter is not an empty slot, it is the waiver wire’s best', () => {
    const a = side('A', roster('a'));
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr1'], []);
    // 17 ppg gone. The lineup cascades: the other receivers move up and the open
    // flex goes to the best free agent anywhere (the 10 ppg back), so the cost is
    // 17 - 10 = 7 ppg over 13 weeks, not 17 and not a hole.
    expect(r.a!.lineupChange).toBeCloseTo(-7 * 13, 0);
  });

  it('a bye costs the one week and only when nobody good is behind him', () => {
    const base = roster('a');
    const withWeek = base.map((p) => (p.playerId === 'a-wr1' ? withBye(p, 9) : p));
    const a = side('A', withWeek);
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr1'], []);
    // 12 games of 17 ppg, against 12 games of... the replacement fills the rest.
    const full = run(side('A', base), b, ['a-wr1'], []);
    expect(Math.abs(r.a!.lineupChange)).toBeLessThan(Math.abs(full.a!.lineupChange));
    expect(r.a!.outgoing[0]!.byeInside).toBe(true);
  });

  it('puts a spare back into a flex slot and credits the points', () => {
    const a = side('A', roster('a'));
    const b = side('B', roster('b', {}, [rate('b-rb3', 'RB', 15)]));
    const r = run(a, b, [], ['b-rb3']);
    // He takes the 10.5 ppg receiver's flex slot: +4.5 ppg over 13 weeks.
    expect(r.a!.incoming[0]!.startsWeeks).toBe(13);
    expect(r.a!.lineupChange).toBeCloseTo(4.5 * 13, 0);
  });

  it('is not roster-blind: the same player is worth different amounts to different teams', () => {
    const star = rate('star-wr', 'WR', 18);
    const weak = side('Weak', roster('w', { wr1: 11, wr2: 10, wr3: 9.5 }));
    const strong = side('Strong', roster('s', { wr1: 19, wr2: 18.5, wr3: 18, flex1: 17, flex2: 17 }));
    const seller = side('Seller', roster('x', {}, [star]));
    const toWeak = run(weak, seller, [], ['star-wr']);
    const toStrong = run(strong, seller, [], ['star-wr']);
    expect(toWeak.a!.lineupChange).toBeGreaterThan(toStrong.a!.lineupChange + 30);
  });
});

describe('the verdict', () => {
  it('calls a near-tie a close call, never a winner', () => {
    // Swap two nearly identical receivers.
    const a = side('A', roster('a', { wr2: 14 }));
    const b = side('B', roster('b', { wr2: 14.1 }));
    const r = run(a, b, ['a-wr2'], ['b-wr2']);
    expect(r.verdict!.kind).toBe('close');
    expect(r.verdict!.headline).toMatch(/Close call/);
  });

  it('calls a clear gap a favour, and names the winner', () => {
    const a = side('A', roster('a', { wr3: 9, flex2: 9 }));
    const b = side('B', roster('b', {}, [rate('b-wr9', 'WR', 22)]));
    // A gives a bench scrub for a star.
    const scrub = rate('a-bench', 'WR', 9.5);
    const r = run({ ...a, roster: [...a.roster, scrub] }, b, ['a-bench'], ['b-wr9']);
    expect(['favors_a', 'leans_a']).toContain(r.verdict!.kind);
    expect(r.verdict!.gap).toBeGreaterThan(r.verdict!.band);
    expect(r.verdict!.headline).toMatch(/^(Favors|Leans toward) A /);
  });

  it('says "you" when the winner is Alex', () => {
    const a = side('Alex', roster('a', { wr3: 9, flex2: 9 }, [rate('a-bench', 'WR', 9.5)]), true);
    const b = side('Ron', roster('b', {}, [rate('b-wr9', 'WR', 22)]));
    const r = run(a, b, ['a-bench'], ['b-wr9']);
    expect(r.verdict!.headline).toMatch(/for you|toward you| you /);
  });

  it('the band is at least the floor and grows with what moves', () => {
    const small = run(side('A', roster('a')), side('B', roster('b')), ['a-def'], ['b-def']);
    expect(small.verdict!.band).toBeGreaterThanOrEqual(TRADE_VALUE.closeCall.floor);
    const big = run(
      side('A', roster('a', { wr1: 24 })),
      side('B', roster('b', { wr1: 9 })),
      ['a-wr1'],
      ['b-wr1'],
    );
    expect(big.verdict!.band).toBeGreaterThan(small.verdict!.band);
  });

  it('notes when neither side improves', () => {
    const r = run(side('A', roster('a')), side('B', roster('b')), ['a-rb1'], ['b-wr1']);
    // Two starters swapped for different positions: nobody should call it a gift.
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe('thin data', () => {
  it('refuses a verdict when a moved player has no projection', () => {
    const a = side('A', roster('a', { wr1: null }));
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr1'], ['b-wr1']);
    expect(r.status).toBe('insufficient');
    expect(r.verdict).toBeNull();
    expect(r.insufficientReason).toMatch(/a-wr1/);
  });

  it('refuses when there is nothing to measure a position against', () => {
    const noDef = replacementLevels(FREE_AGENTS.filter((p) => p.position !== 'DEF'));
    const r = evaluateTrade({
      horizon: HORIZON,
      shape: SHAPE,
      replacement: noDef,
      a: side('A', roster('a')),
      b: side('B', roster('b')),
      aSends: ['a-def'],
      bSends: ['b-def'],
    });
    expect(r.status).toBe('insufficient');
    expect(r.insufficientReason).toMatch(/DEF/);
  });

  it('lowers confidence for a player valued on the season line', () => {
    const a = side('A', roster('a'));
    const b = side('B', roster('b').map((p) => (p.playerId === 'b-wr1' ? { ...p, basis: 'season_line' as const } : p)));
    const r = run(a, b, ['a-wr1'], ['b-wr1']);
    expect(r.confidence).toBe('low');
    expect(r.confidenceReasons.join(' ')).toMatch(/season line/);
  });

  it('flags a Sleeper starter with no projection as a reason the gain may be overstated', () => {
    const a = side('A', roster('a', { te: null }));
    const b = side('B', roster('b'));
    // A receiver swap reaches the tight end through the flex slots.
    const r = run(a, b, ['a-wr3'], ['b-wr3']);
    expect(r.a!.unvaluedStarters).toEqual(['a-te']);
    expect(r.confidence).not.toBe('high');
  });

  it('rejects a player who is not on the roster sending him', () => {
    const r = run(side('A', roster('a')), side('B', roster('b')), ['b-wr1'], []);
    expect(r.status).toBe('insufficient');
  });

  it('has nothing to say once the season is over', () => {
    const over = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 19 });
    const r = evaluateTrade({
      horizon: over,
      shape: SHAPE,
      replacement: REPLACEMENT,
      a: side('A', roster('a')),
      b: side('B', roster('b')),
      aSends: ['a-def'],
      bSends: ['b-def'],
    });
    expect(r.status).toBe('insufficient');
  });
});

describe('Alex’s preferences', () => {
  const spareQb = rate('b-qb2', 'QB', 19.5);
  const sellerWithQb = side('Seller', roster('b', {}, [spareQb]));

  it('are applied to his side only, and labeled', () => {
    const alex = side('Alex', roster('a'), true);
    const mine = run(alex, sellerWithQb, [], ['b-qb2']);
    const theirs = run({ ...alex, isMine: false }, sellerWithQb, [], ['b-qb2']);
    expect(mine.a!.adjustments.some((x) => x.key === 'spare_qb_te' || x.key === 'second_qb_te')).toBe(true);
    expect(mine.a!.adjustments.every((x) => x.label.length > 10)).toBe(true);
    expect(theirs.a!.adjustments).toEqual([]);
    expect(mine.b!.adjustments).toEqual([]);
  });

  it('give no credit for a spare QB, and take exactly that credit away', () => {
    const alex = side('Alex', roster('a'), true);
    const rival = { ...alex, isMine: false };
    const mine = run(alex, sellerWithQb, [], ['b-qb2']);
    const neutral = run(rival, sellerWithQb, [], ['b-qb2']);
    expect(neutral.a!.depthChange).toBeGreaterThan(0);
    expect(mine.a!.net).toBeLessThan(neutral.a!.net);
  });

  it('do not penalise a quarterback who is clearly better than what he has', () => {
    const alex = side('Alex', roster('a', { qb: 15 }), true);
    const star = side('Seller', roster('b', {}, [rate('b-qb-star', 'QB', 27)]));
    const r = run(alex, star, [], ['b-qb-star']);
    expect(r.a!.adjustments.some((x) => x.key === 'second_qb_te')).toBe(false);
    expect(r.a!.lineupChange).toBeGreaterThan(100);
  });

  it('leans toward running backs when value is close, by a small labeled amount', () => {
    const alex = side('Alex', roster('a', { flex2: 10 }, [rate('a-wr4', 'WR', 14)]), true);
    const other = side('Ron', roster('b', {}, [rate('b-rb4', 'RB', 14)]));
    const r = run(alex, other, ['a-wr4'], ['b-rb4']);
    const lean = r.a!.adjustments.find((x) => x.key === 'rb_lean');
    expect(lean).toBeDefined();
    expect(lean!.points).toBeGreaterThan(0);
    expect(lean!.points).toBeLessThan(3);
  });

  it('are capped at a small share of what moved', () => {
    const alex = side('Alex', roster('a'), true);
    const r = run(alex, sellerWithQb, [], ['b-qb2']);
    const gross = r.a!.incoming.reduce((s, p) => s + (p.rosValue ?? 0), 0);
    const cap = Math.max(TRADE_VALUE.prefs.capFloor, TRADE_VALUE.prefs.capShare * gross);
    expect(Math.abs(r.a!.adjustmentTotal)).toBeLessThanOrEqual(cap + 0.15);
  });

  it('give a rival the same lineup math with none of them', () => {
    const ron = side('Ron', roster('r'));
    const r = run(ron, sellerWithQb, [], ['b-qb2']);
    expect(r.a!.adjustments).toEqual([]);
    expect(r.a!.adjustmentTotal).toBe(0);
  });
});

describe('roster limits', () => {
  it('cuts the least valuable player when a trade leaves a roster over its limit', () => {
    const fullBench = Array.from({ length: 6 }, (_, i) => rate(`a-bn${i}`, 'WR', 4 + i * 0.1));
    const reserve = [rate('a-ir1', 'RB', 5), rate('a-ir2', 'WR', 5)];
    const a = side('A', roster('a', {}, [...fullBench, ...reserve]));
    const b = side('B', roster('b', {}, [rate('b-wr9', 'WR', 15), rate('b-rb9', 'RB', 15)]));
    const r = run(a, b, [], ['b-wr9', 'b-rb9']);
    expect(r.a!.mustDrop).not.toBeNull();
    expect(r.a!.mustDrop!.playerId).toBe('a-bn0');
  });
});

describe('where the numbers may come from', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'src', 'core', 'tradeValue');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('the model modules receive Sleeper\u2019s figure as a value and never import the feed', () => {
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      expect(/from '[^']*(weeklyProjections|sleeperProjection|repos\/)[^']*'/.test(text), `${file} imports the feed or a repo`).toBe(false);
    }
  });

  it('adds no news or research weighting of its own on top of Start/Sit', () => {
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      expect(/recentForm|last7|last30|signal\./.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${file} reads the tally`).toBe(false);
    }
  });

  it('never uses the words that would imply the app acts on a trade', () => {
    const banned = /\b(propos(e|es|ed|al)|offer(s|ed)?|accept(s|ed)?|decline(s|d)?|submit(s|ted)?|send(s|ing)?|sent|add(s|ed|ing)|drop(s|ped|ping)?|claim(s|ed|ing)?|bid(s|ding)?)\b/i;
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const strings = [...text.matchAll(/(['`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]!);
      for (const value of strings) expect(banned.test(value), `${file}: "${value}"`).toBe(false);
    }
  });
});

describe('roster limits, from the league\u2019s own settings', () => {
  /** Seventeen players: ten starters, six bench and one in an IR slot. */
  const seventeen = () =>
    roster('a', {}, [...Array.from({ length: 6 }, (_, i) => rate(`a-bn${i}`, 'WR', 4 + i * 0.1)), rate('a-ir1', 'RB', 5)]);

  it('never cuts anybody on a one-for-one swap, even when the slot list undercounts the limit', () => {
    // The slot list says 10 + 6 = 16, and this roster holds 17 already.
    const a = side('A', seventeen());
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr3'], ['b-wr3']);
    expect(r.a!.mustDrop).toBeNull();
    expect(r.a!.cutCount).toBe(0);
  });

  it('cuts only what the trade itself forces, as many as it takes, least valuable first', () => {
    const a = side('A', seventeen());
    const b = side('B', roster('b', {}, [rate('b-x1', 'WR', 15), rate('b-x2', 'RB', 15), rate('b-x3', 'WR', 14)]));
    const r = evaluateTrade({
      horizon: HORIZON,
      shape: SHAPE,
      replacement: REPLACEMENT,
      a,
      b,
      rosterLimit: 18,
      aSends: [],
      bSends: ['b-x1', 'b-x2', 'b-x3'],
    });
    // 17 + 3 = 20 against a limit of 18: two go.
    expect(r.a!.cutCount).toBe(2);
    expect(r.a!.mustDrop!.playerId).toBe('a-bn0');
    expect(r.caveats.join(' ')).toMatch(/cut a-bn0 and 1 more/);
  });

  it('does not blame a trade for a roster that was already over the limit', () => {
    const a = side('A', seventeen());
    const b = side('B', roster('b', {}, [rate('b-x1', 'WR', 15)]));
    const r = evaluateTrade({
      horizon: HORIZON, shape: SHAPE, replacement: REPLACEMENT, a, b,
      rosterLimit: 16, aSends: [], bSends: ['b-x1'],
    });
    // 18 after against a limit of 16, but it was 17 before: only one over what it was.
    expect(r.a!.cutCount).toBe(1);
  });
});

describe('cautions about missing projections', () => {
  it('say nothing about a position the trade cannot touch', () => {
    const a = side('A', roster('a', { qb: null }));
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr3'], ['b-wr3']);
    expect(r.a!.unvaluedStarters).toEqual([]);
    expect(r.confidence).toBe('high');
  });

  it('name a starter at a position the trade does reach, including through a flex slot', () => {
    const a = side('A', roster('a', { te: null }));
    const b = side('B', roster('b'));
    const r = run(a, b, ['a-wr3'], ['b-wr3']);
    // WR can fill FLEX and so can TE, so a missing tight end can change who a receiver displaces.
    expect(r.a!.unvaluedStarters).toEqual(['a-te']);
  });
});

describe('the refusal sentence', () => {
  it('reads cleanly, with no doubled pronoun', () => {
    const a = side('A', roster('a', { wr1: null }).map((p) => (p.playerId === 'a-wr1' ? { ...p, rateNote: 'ruled out and no season line is stored for him' } : p)));
    const r = run(a, side('B', roster('b')), ['a-wr1'], ['b-wr1']);
    expect(r.insufficientReason).not.toMatch(/\b(him|them) (him|them)\b/);
    expect(r.insufficientReason).toMatch(/for him\. A verdict needs/);
  });
});

describe('what the card says, and what it shows its working with', () => {
  it('puts both sides\u2019 changes beside the gap, so a swap never reads as double', () => {
    // Alex gives a 17 ppg receiver for a 9 ppg one: he loses what Dermot gains.
    const r = run(side('Alex', roster('a'), true), side('Dermot', roster('b', { wr1: 9 })), ['a-wr1'], ['b-wr1']);
    const net = Math.round(Math.abs(r.a!.net));
    expect(r.verdict!.headline).toMatch(/^Favors Dermot by about \d+ pts over the rest of the season \(you \u2212\d+, Dermot \+\d+\)\.$/);
    expect(r.verdict!.headline).toContain(`you \u2212${net}`);
    // The gap counts both sides, which is why the two changes sit next to it.
    expect(Math.abs(r.verdict!.gap)).toBeCloseTo(Math.abs(r.a!.net) + Math.abs(r.b!.net), 0);
  });

  it('adds nothing to a close call', () => {
    const r = run(side('A', roster('a', { wr2: 14 })), side('B', roster('b', { wr2: 14.1 })), ['a-wr2'], ['b-wr2']);
    expect(r.verdict!.headline).not.toMatch(/\(/);
  });

  it('tells a reader to check again later when the gap is about the market, and not when it is about an injury', () => {
    const market = run(side('A', roster('a', { wr1: null })), side('B', roster('b')), ['a-wr1'], ['b-wr1']);
    expect(market.insufficientReason).toMatch(/check again Thursday or later/);
    const hurt = roster('a', { wr1: null }).map((p) => (p.playerId === 'a-wr1' ? { ...p, rateNote: 'ruled out and no season line is stored for him' } : p));
    const out = run(side('A', hurt), side('B', roster('b')), ['a-wr1'], ['b-wr1']);
    expect(out.insufficientReason).not.toMatch(/Thursday/);
  });

  it('reports each side\u2019s lineup week by week, and the weeks add to the total', () => {
    const r = run(side('Alex', roster('a'), true), side('Dermot', roster('b', { wr1: 9 })), ['a-wr1'], ['b-wr1']);
    for (const s of [r.a!, r.b!]) {
      expect(s.weekly).toHaveLength(13);
      const summed = s.weekly!.reduce((acc, w) => acc + (w.lineupAfter - w.lineupBefore), 0);
      expect(Math.abs(summed - s.lineupChange)).toBeLessThan(0.1 * 13 + 0.2);
    }
  });

  it('says which weeks a player starts, when he plays, and what his rate is made of', () => {
    const star = { ...rate('b-wr9', 'WR', 17), rateParts: { base: 16.2, nudges: 0.8 } };
    const withBye = withBye_(star, 9);
    const r = run(side('Alex', roster('a', { wr1: 9 }), true), side('Dermot', roster('b', {}, [withBye])), [], ['b-wr9']);
    const line = r.a!.incoming[0]!;
    expect(line.rateParts).toEqual({ base: 16.2, nudges: 0.8 });
    expect(line.weekly).toHaveLength(13);
    expect(line.weekly![HORIZON.weeks.indexOf(9)]).toBe(0);
    expect(line.startsOn).not.toContain(9);
    expect(line.startsOn!.length).toBe(line.startsWeeks);
  });
});

function withBye_(p: PlayerRate, week: number): PlayerRate {
  const weekly = p.weekly.map((v, i) => (HORIZON.weeks[i] === week ? 0 : v));
  return { ...p, weekly, games: weekly.reduce((a, b) => a + b, 0), byeWeek: week, byeInside: true };
}
