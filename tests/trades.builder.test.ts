/**
 * The trade builder: packages from Alex's Sell and Want marks, scored on both
 * real rosters by Check a trade's own evaluation.
 *
 * The cases the round asked for, each on a roster small enough to check by
 * hand: a package that helps both sides is shown, one that helps only Alex is
 * hidden, a 1 for 2 pairs a drop the waiver planner would make, an elite back
 * is never offered unless marked, a team's bye hole and injured starter are
 * named in plain words, a passed deadline closes the builder, and thin data is
 * said rather than guessed past.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { replacementLevels } from '../src/core/tradeValue/evaluate.ts';
import { slotsOf } from '../src/core/tradeValue/lineup.ts';
import type { PlayerRate } from '../src/core/tradeValue/rate.ts';
import { tradeHorizon, type TradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { weeklyAvailability } from '../src/core/tradeValue/availability.ts';
import type { DropSignals } from '../src/core/waivers/dropScore.ts';
import {
  BUILDER,
  buildTradePackages,
  givePoolOf,
  needsOf,
  pitchFor,
  shapes,
  statusOf,
  type BuilderInput,
  type BuilderTeam,
} from '../src/core/trades/builder.ts';
import { BUILDER_ADVISORY, BUILDER_WILLINGNESS } from '../src/core/trades/builderResponse.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
const SHAPE = buildRosterShape(POSITIONS);
const HORIZON = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 7 });

function rate(id: string, position: string, ppg: number | null, extra: Partial<PlayerRate> = {}, horizon: TradeHorizon = HORIZON): PlayerRate {
  const weekly = horizon.weeks.map(() => 1);
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

function withBye(p: PlayerRate, week: number): PlayerRate {
  const weekly = p.weekly.map((v, i) => (HORIZON.weeks[i] === week ? 0 : v));
  return { ...p, weekly, games: weekly.reduce((a, b) => a + b, 0), byeWeek: week, byeInside: true };
}

function injured(p: PlayerRate, designation: 'out' | 'ir'): PlayerRate {
  const a = weeklyAvailability({ designation, weeks: HORIZON.weeks, byeWeek: null });
  return { ...p, designation, weekly: a.weekly, games: a.games, injuryNote: a.note };
}

/** Free agents: QB 12, RB 6, WR 10, TE 4, DEF 5. */
const REPLACEMENT = replacementLevels([
  ...[12, 12, 12].map((v, i) => rate(`fa-qb${i}`, 'QB', v)),
  ...[6, 6, 6].map((v, i) => rate(`fa-rb${i}`, 'RB', v)),
  ...[10, 10, 10].map((v, i) => rate(`fa-wr${i}`, 'WR', v)),
  ...[4, 4, 4].map((v, i) => rate(`fa-te${i}`, 'TE', v)),
  ...[5, 5, 5].map((v, i) => rate(`fa-def${i}`, 'DEF', v)),
]);

/** Alex: two elite backs, a spare back, receivers who leave a flex slot to a free agent. Sixteen players, bench full. */
const ALEX: PlayerRate[] = [
  rate('qb', 'QB', 20),
  rate('Bijan Robinson', 'RB', 20),
  rate('Kenneth Walker', 'RB', 15),
  rate('Tony Pollard', 'RB', 11),
  rate('rb4', 'RB', 9),
  rate('rb5', 'RB', 7),
  rate('wr1', 'WR', 17),
  rate('wr2', 'WR', 14),
  rate('wr4', 'WR', 13),
  rate('wr3', 'WR', 9),
  rate('wr5', 'WR', 8),
  rate('wr6', 'WR', 7.5),
  rate('wr7', 'WR', 6.5),
  rate('te1', 'TE', 12),
  rate('te2', 'TE', 9),
  rate('def', 'DEF', 7),
];

/** Ron: deep at receiver, his second back is Out. */
const RON: PlayerRate[] = [
  rate('ron-qb', 'QB', 19),
  rate('ron-rbA', 'RB', 16),
  injured(rate('ron-rbB', 'RB', 13), 'out'),
  rate('ron-rbC', 'RB', 5),
  rate('ron-wrA', 'WR', 18),
  rate('ron-wrB', 'WR', 17),
  rate('ron-wrC', 'WR', 16),
  rate('ron-wrD', 'WR', 15),
  rate('ron-wrE', 'WR', 14.5),
  rate('Jaylen Waddle', 'WR', 14),
  rate('ron-wrG', 'WR', 11),
  rate('ron-te', 'TE', 10),
  rate('ron-def', 'DEF', 6),
];

/** Kim: her tight end is on a bye in week 8 and she has nobody behind him. */
const KIM: PlayerRate[] = [
  rate('kim-qb', 'QB', 18),
  rate('kim-rbA', 'RB', 15),
  rate('kim-rbB', 'RB', 12),
  rate('kim-wrA', 'WR', 16),
  rate('kim-wrB', 'WR', 15),
  rate('kim-wrC', 'WR', 13),
  rate('kim-wrD', 'WR', 12.5),
  rate('kim-wrE', 'WR', 12),
  rate('kim-wrF', 'WR', 12),
  withBye(rate('kim-te', 'TE', 9), 8),
  rate('kim-def', 'DEF', 6),
];

const activity = { thisSeason: 0, earlier: null, line: 'No trades this season' };
const team = (rosterId: number, label: string, roster: PlayerRate[]): BuilderTeam => ({ rosterId, label, roster, starterIds: [], activity });

function input(overrides: Partial<BuilderInput> = {}): BuilderInput {
  return {
    horizon: HORIZON,
    shape: SHAPE,
    replacement: REPLACEMENT,
    rosterLimit: 18,
    reserveSlots: 2,
    reserveAllows: { out: true, doubtful: false, sus: false },
    me: { ...team(1, 'Alex', ALEX), reserveIds: [] },
    teams: [team(2, 'Ron', RON), team(3, 'Kim', KIM)],
    sell: ['Tony Pollard'],
    want: new Map(),
    team: 2,
    considerUnmarked: false,
    eliteRbs: new Set(['Bijan Robinson', 'Kenneth Walker']),
    protections: new Map(),
    dropSignals: null,
    ...overrides,
  };
}

describe('a package that helps both sides', () => {
  const result = buildTradePackages(input({ want: new Map([[2, ['Jaylen Waddle']]]) }));
  const pkg = result.packages.find((p) => p.give[0]?.playerId === 'Tony Pollard' && p.get.length === 1 && p.get[0]?.playerId === 'Jaylen Waddle');

  it('is shown, with both gains positive', () => {
    expect(result.status).toBe('ok');
    expect(pkg).toBeDefined();
    expect(pkg!.alex.weighted).toBeGreaterThan(BUILDER.minGain);
    expect(pkg!.them.weighted).toBeGreaterThan(BUILDER.minGain);
    expect(pkg!.alex.restOfSeason).toBeGreaterThan(0);
    expect(pkg!.them.restOfSeason).toBeGreaterThan(0);
  });

  it('carries the three numbers: this week, the next three weeks, the playoffs', () => {
    /* Waddle (14) takes a flex slot a free agent (10) held; Pollard (11) leaves the other for wr4. +3 a week. */
    expect(pkg!.alex.thisWeek).toBeCloseTo(3, 0);
    expect(pkg!.alex.next3).toBeCloseTo(9, 0);
    expect(pkg!.alex.playoffs).toBeCloseTo(9, 0);
  });

  it('names their need and reads Likely, without a percentage', () => {
    expect(pkg!.need).toBe('their RB2 is Out');
    expect(pkg!.why).toBe('Their RB2 is Out');
    expect(pkg!.status).toBe('likely');
    expect(JSON.stringify(pkg)).not.toMatch(/%/);
  });

  it('says willingness is unknown, and that nothing is sent', () => {
    expect(result.willingness).toBe(BUILDER_WILLINGNESS);
    expect(result.advisory).toBe(BUILDER_ADVISORY);
    expect(result.advisory).toMatch(/never sends/);
  });

  it('has a pitch in Alex’s voice that never mentions the app', () => {
    expect(pkg!.pitch).toBe('Hey Ron, saw your RB2 is Out. I could send Tony Pollard for Jaylen Waddle. Open to it?');
    expect(pkg!.pitch).not.toMatch(/app|analyst|propos/i);
  });
});

describe('a package that helps only Alex', () => {
  it('is hidden, and the audit says why', () => {
    const result = buildTradePackages(input({ sell: ['wr5'], want: new Map([[2, ['ron-wrA']]]) }));
    expect(result.packages).toHaveLength(0);
    expect(result.audit.hidden['no_gain_for_them']).toBeGreaterThan(0);
    expect(result.message).toMatch(/helps both you and Ron/);
  });
});

describe('roster limit: more players in than out', () => {
  const want = new Map([[2, ['Jaylen Waddle', 'ron-wrG']]]);
  const twoForOne = (r: ReturnType<typeof buildTradePackages>) => r.packages.find((p) => p.get.length === 2 && p.give.length === 1);

  it('pairs a drop, never a protected player or a lineup starter', () => {
    const result = buildTradePackages(
      input({ want, protections: new Map([['te2', 'round 5 pick'], ['rb5', 'backs up Bijan Robinson']]) }),
    );
    const pkg = twoForOne(result);
    expect(pkg).toBeDefined();
    expect(pkg!.drops).toHaveLength(1);
    const drop = pkg!.drops[0]!.playerId;
    expect(['te2', 'rb5', 'rb4', 'wr3']).not.toContain(drop);
    expect(['wr5', 'wr6', 'wr7']).toContain(drop);
  });

  it('takes the waiver planner’s drop score when this season’s points are on record', () => {
    const signal = (id: string, position: string, season: number): DropSignals => ({
      playerId: id,
      name: id,
      position,
      seasonPoints: season,
      weeksPlayed: 6,
      recent: [season / 6, season / 6, season / 6],
      projection: 7,
      role: null,
      heldWeeks: 4,
      drafted: false,
      handcuffOf: null,
      inLineup: false,
      unavailable: false,
    });
    const dropSignals = new Map([
      ['wr5', signal('wr5', 'WR', 48)],
      ['wr6', signal('wr6', 'WR', 40)],
      ['wr7', signal('wr7', 'WR', 12)],
      ['rb5', signal('rb5', 'RB', 30)],
      ['te2', signal('te2', 'TE', 20)],
    ]);
    const pkg = twoForOne(buildTradePackages(input({ want, dropSignals })));
    expect(pkg!.drops[0]!.playerId).toBe('wr7');
    expect(pkg!.drops[0]!.reason).toMatch(/lowest season points on your bench/);
    /* The cut is in Alex's numbers: the rest-of-season figure is net of losing him. */
    expect(pkg!.alex.restOfSeason).toBeLessThanOrEqual(twoForOne(buildTradePackages(input({ want })))!.alex.restOfSeason + 1);
  });

  it('moves an IR-eligible player to an open IR slot before cutting anybody', () => {
    const me = ALEX.map((p) => (p.playerId === 'wr6' ? injured(p, 'out') : p));
    const pkg = twoForOne(buildTradePackages(input({ want, me: { ...team(1, 'Alex', me), reserveIds: [] } })));
    expect(pkg!.irMoves.map((p) => p.playerId)).toEqual(['wr6']);
    expect(pkg!.drops).toHaveLength(0);
  });

  it('shows no package when nobody can safely go', () => {
    const everyone = new Map(ALEX.map((p) => [p.playerId, 'protected'] as const));
    const result = buildTradePackages(input({ want, protections: everyone }));
    expect(twoForOne(result)).toBeUndefined();
    expect(result.audit.hidden['no_safe_drop']).toBeGreaterThan(0);
  });
});

describe('elite backs', () => {
  it('are never offered unless Alex marks them', () => {
    const pool = givePoolOf(input({ sell: [], considerUnmarked: true }), slotsOf(SHAPE));
    expect(pool).not.toContain('Bijan Robinson');
    expect(pool).not.toContain('Kenneth Walker');
    expect(pool.length).toBeGreaterThan(0);
    const result = buildTradePackages(input({ sell: [], considerUnmarked: true, team: 'all' }));
    for (const p of result.packages) for (const g of p.give) expect(['Bijan Robinson', 'Kenneth Walker']).not.toContain(g.playerId);
  });

  it('are offered once marked', () => {
    expect(givePoolOf(input({ sell: ['Kenneth Walker'] }), slotsOf(SHAPE))).toEqual(['Kenneth Walker']);
  });

  it('with nothing marked and the toggle off, asks for a mark', () => {
    const result = buildTradePackages(input({ sell: [] }));
    expect(result.status).toBe('no_sells');
    expect(result.message).toMatch(/Mark at least one/);
  });
});

describe('their needs, in plain words', () => {
  const slots = slotsOf(SHAPE);

  it('a team with a bye hole', () => {
    expect(needsOf(team(3, 'Kim', KIM), slots, REPLACEMENT, HORIZON).map((n) => n.label)).toContain('their TE is on bye in week 8');
  });

  it('a team with an injured starter', () => {
    expect(needsOf(team(2, 'Ron', RON), slots, REPLACEMENT, HORIZON)[0]!.label).toBe('their RB2 is Out');
  });

  it('a package that fills the bye hole says so', () => {
    const result = buildTradePackages(input({ team: 3, sell: ['te2'], want: new Map([[3, ['kim-wrF']]]) }));
    const pkg = result.teams[0]!.packages.find((p) => p.give.some((g) => g.playerId === 'te2'));
    expect(pkg).toBeDefined();
    expect(pkg!.need).toBe('their TE is on bye in week 8');
    expect(pkg!.why).toBe('Their TE is on bye in week 8');
    expect(pkg!.pitch).toMatch(/saw your TE is on bye in week 8/);
  });
});

describe('suggestions when Alex marks nobody on their side', () => {
  it('suggests their players who would most improve his lineup', () => {
    const result = buildTradePackages(input());
    expect(result.teams[0]!.suggested.length).toBeGreaterThan(0);
    expect(result.teams[0]!.suggested.length).toBeLessThanOrEqual(BUILDER.suggestionsPerTeam);
    expect(result.teams[0]!.suggested).not.toContain('ron-rbC');
  });

  it('All teams suggests only players some 1 for 1 could bring back, never a star nobody would trade', () => {
    const result = buildTradePackages(input({ team: 'all', sell: ['Tony Pollard'] }));
    for (const t of result.teams) expect(t.suggested).not.toContain('ron-wrA');
  });

  it('All teams shows at most five, at most two per team, ranked by Alex’s gain', () => {
    const result = buildTradePackages(input({ team: 'all', sell: ['Tony Pollard', 'rb4', 'te2'] }));
    expect(result.packages.length).toBeLessThanOrEqual(BUILDER.shownAll);
    const counts = new Map<number, number>();
    for (const p of result.packages) counts.set(p.partner.rosterId, (counts.get(p.partner.rosterId) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(BUILDER.perTeamInAll);
    const gains = result.packages.map((p) => p.alex.weighted);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    for (const p of result.packages) expect(p.status).not.toBe('long_shot');
  });
});

describe('the trade deadline', () => {
  it('passed: the builder says trades are closed and builds nothing', () => {
    const late = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 12 });
    const result = buildTradePackages(input({ horizon: late }));
    expect(result.status).toBe('closed');
    expect(result.packages).toHaveLength(0);
    expect(result.message).toMatch(/deadline was after week 11/);
  });

  it('near: the deadline line says so', () => {
    const near = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 11 });
    const result = buildTradePackages(input({ horizon: near, me: { ...team(1, 'Alex', ALEX.map((p) => rate(p.playerId, p.position, p.rate, {}, near))), reserveIds: [] }, teams: [] }));
    expect(result.deadline?.line).toBe('Last week to trade: the deadline is after week 11.');
  });
});

describe('thin data', () => {
  it('a Sell mark with no number is left out and said', () => {
    const me = ALEX.map((p) => (p.playerId === 'Tony Pollard' ? { ...p, rate: null, basis: 'none' as const } : p));
    const result = buildTradePackages(input({ me: { ...team(1, 'Alex', me), reserveIds: [] } }));
    expect(result.status).toBe('no_sells');
    expect(result.notes.join(' ')).toMatch(/Tony Pollard has no number this week/);
  });

  it('a Want mark with no number builds nothing and is counted', () => {
    const ron = RON.map((p) => (p.playerId === 'Jaylen Waddle' ? { ...p, rate: null, basis: 'none' as const } : p));
    const result = buildTradePackages(input({ teams: [team(2, 'Ron', ron)], want: new Map([[2, ['Jaylen Waddle']]]) }));
    expect(result.packages).toHaveLength(0);
    expect(result.audit.hidden['nothing_to_get']).toBe(1);
  });
});

describe('shapes and status', () => {
  it('1 for 1, 2 for 1, 1 for 2, and 2 for 2 only for short lists', () => {
    const small = shapes(['a', 'b'], ['x', 'y']);
    expect(small.map((s) => `${s.give.length}-${s.get.length}`).sort()).toEqual(['1-1', '1-1', '1-1', '1-1', '1-2', '1-2', '2-1', '2-1', '2-2']);
    const long = shapes(['a', 'b', 'c', 'd', 'e'], ['x', 'y']);
    expect(long.some((s) => s.give.length === 2 && s.get.length === 2)).toBe(false);
  });

  it('Likely needs a named need; tilt toward Alex lowers it; a lopsided one is a Long shot', () => {
    expect(statusOf({ edge: 0, need: true, alex: 10, them: 8 }).status).toBe('likely');
    expect(statusOf({ edge: 0, need: false, alex: 10, them: 8 }).status).toBe('maybe');
    expect(statusOf({ edge: 0.2, need: true, alex: 10, them: 8 }).status).toBe('maybe');
    expect(statusOf({ edge: 0.4, need: true, alex: 10, them: 8 }).status).toBe('long_shot');
    expect(statusOf({ edge: 0, need: true, alex: 40, them: 2 }).status).toBe('maybe');
  });

  it('the status sentence agrees with which way the value leans', () => {
    /* Found by the production replay: "About even on value" beside "they get more value". */
    expect(statusOf({ edge: -0.49, need: true, alex: 12, them: 10 }).reason).toBe('You give more value, and it fills a need they have.');
    expect(statusOf({ edge: 0, need: true, alex: 12, them: 10 }).reason).toBe('About even on value, and it fills a need they have.');
    expect(statusOf({ edge: -0.3, need: false, alex: 12, them: 10 }).reason).toBe('You give more value, though it fills no clear need of theirs.');
  });

  it('a pitch for a thin team, and one with no named need', () => {
    expect(pitchFor({ partner: 'Kim', need: 'thin at WR', give: ['A'], get: ['B'] })).toBe("Hey Kim, looks like you're thin at WR. I could send A for B. Open to it?");
    expect(pitchFor({ partner: 'Kim', need: null, give: ['A', 'C'], get: ['B'] })).toBe(
      'Hey Kim, had an idea that could help your lineup. I could send A and C for B. Open to it?',
    );
  });
});
