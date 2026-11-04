/**
 * Trades, round 2 of the November 2026 review: trade value is the rest of the
 * season, not this week (register T1, T9; `docs/REVIEW_2026-11.md`). Each case
 * is from the round's brief and fails on the code before it:
 *
 *  - Love against Young: one week's number no longer decides nine.
 *  - A bye in week 11, and a bye this week.
 *  - A player out for several weeks, valued on his season.
 *  - A playoff week counts 1.5 times.
 *  - A 2-for-1 that helps both lineups, and a depth-for-starter deal, shown.
 *  - A lopsided deal, never shown.
 *  - Build a trade asked about every team checks as many packages a team as
 *    the phone's sweep does.
 */

import { describe, expect, it } from 'vitest';
import { pricedCandidate as candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { buildPlayerRate, type PlayerRate } from '../src/core/tradeValue/rate.ts';
import { blendRate, REST_OF_SEASON, seasonWeights, totalWeight, productionGames, playedWeeksOf } from '../src/core/tradeValue/restOfSeason.ts';
import { evaluateTrade, replacementLevels, seasonValueOver } from '../src/core/tradeValue/evaluate.ts';
import { weeklyAvailability } from '../src/core/tradeValue/availability.ts';
import { tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { buildRosterShape as shapeOf } from '../src/core/sleeper/rosterShape.ts';
import { buildRosterViews } from '../src/core/trades/rosterUtility.ts';
import { assembleSmartTrades, NO_TRADE_HISTORY } from '../src/core/trades/assemble.ts';
import { applySeasonChecks, ideasToCheck, seasonCheckOf, type SeasonCheck } from '../src/core/trades/seasonCheck.ts';
import { FAIR_TO_BOTH, gainBars } from '../src/core/trades/fairToBoth.ts';
import { fairnessOf } from '../src/core/trades/bilateral.ts';
import { BUILDER, buildTradePackages } from '../src/core/trades/builder.ts';

/* Tony's Pizza Fantasy, week 9: weeks 9 to 17, playoffs 15 to 17, deadline after 11. */
const SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
const HORIZON = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 9 });
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2 }, POSITIONS);
const SHAPE = buildRosterShape(POSITIONS);
const LINEUP_SHAPE = shapeOf(POSITIONS);

/** A player priced this week at `week` points, with the blend's other inputs. */
function rated(
  id: string,
  position: string,
  week: number | null,
  opts: { ahead?: [number, number][]; production?: number[]; bye?: number | null; status?: string } = {},
): PlayerRate {
  const input = week == null ? { ...candidate(id, id, position, 1), props: [] } : candidate(id, id, position, week);
  const evaluation = evaluatePlayer(
    { ...input, ...(opts.status ? { injuryStatus: opts.status } : {}) },
    PROFILE,
  );
  return buildPlayerRate({
    evaluation,
    seasonLine: null,
    weeks: HORIZON.weeks,
    byeWeek: opts.bye ?? null,
    byeKnown: true,
    ahead: new Map(opts.ahead ?? []),
    production: opts.production ?? [],
  });
}

/** A rate written directly, for the lineup and search cases. */
function rate(id: string, position: string, ppg: number, opts: { bye?: number | null; weekly?: number[] } = {}): PlayerRate {
  const weekly = opts.weekly ?? HORIZON.weeks.map((w) => (w === opts.bye ? 0 : 1));
  return {
    playerId: id, name: id, position, team: 'AAA', rate: ppg, basis: 'market', rateNote: null, designation: 'healthy',
    games: weekly.reduce((a, b) => a + b, 0), weekly, injuryNote: null, byeWeek: opts.bye ?? null, byeKnown: true,
    byeInside: opts.bye != null, onReserve: false,
  };
}

const REPLACEMENT = replacementLevels([
  ...[15, 15, 15].map((v, i) => rate(`fa-qb${i}`, 'QB', v)),
  ...[7.5, 7.5, 7.5].map((v, i) => rate(`fa-rb${i}`, 'RB', v)),
  ...[8, 8, 8].map((v, i) => rate(`fa-wr${i}`, 'WR', v)),
  ...[6, 6, 6].map((v, i) => rate(`fa-te${i}`, 'TE', v)),
]);

/* ---------------------------------------------------------- Love vs Young -- */

describe('Love against Young: one week no longer sets nine (review T9)', () => {
  /*
   * The November probe: this week's number had Young over Love, so the model
   * started Young "10 weeks of 10". This season Love scores 23.57 a game in
   * this league, Young 16.94.
   */
  const love = rated('love', 'QB', 17.5, { ahead: [[10, 21], [11, 22], [12, 20]], production: [24.1, 22.0, 26.3, 21.8, 23.9, 25.2, 22.1, 23.2] });
  const young = rated('young', 'QB', 19, { ahead: [[10, 16.5], [11, 17], [12, 16]], production: [15.8, 18.2, 16.1, 17.9, 16.6, 17.3, 16.4, 17.2] });

  it('values Love clearly ahead of Young over the rest of the season', () => {
    expect(love.rate!).toBeGreaterThan(young.rate! + 3);
    // Half his projections (this week and the next three), half his season average.
    expect(love.blend).toMatchObject({ projectionWeeks: 4, games: 8, productionShare: 0.5 });
    expect(love.rate).toBeCloseTo(0.5 * ((17.5 + 21 + 22 + 20) / 4) + 0.5 * 23.575, 1);
    // This week alone is still known, and still has Young ahead: it just no longer decides.
    expect(young.weekRate!).toBeGreaterThan(love.weekRate!);
  });

  it('starts Love every week, not Young', () => {
    const roster = [love, young, rate('rb1', 'RB', 15), rate('rb2', 'RB', 14), rate('wr1', 'WR', 15), rate('wr2', 'WR', 14), rate('wr3', 'WR', 13), rate('te', 'TE', 9)];
    const other = [rate('o-qb', 'QB', 18), rate('o-rb', 'RB', 12), rate('o-wr', 'WR', 12), rate('o-te', 'TE', 8)];
    const ev = evaluateTrade({
      horizon: HORIZON, shape: LINEUP_SHAPE, replacement: REPLACEMENT,
      a: { label: 'Alex', rosterId: 1, isMine: true, roster },
      b: { label: 'B', rosterId: 2, isMine: false, roster: other },
      aSends: ['young'], bSends: [],
      rosterLimit: 18,
    });
    expect(ev.status).toBe('ok');
    expect(ev.a!.outgoing[0]!.startsWeeks).toBe(0);
    expect(ev.a!.lineupChange).toBe(0);
  });

  it('leans on the projection when the season average is short', () => {
    const two = blendRate({ projections: [10], production: [20, 20] });
    // Two games: a quarter from the average, three quarters from the projection.
    expect(two.productionShare).toBe(0.25);
    expect(two.rate).toBe(12.5);
    expect(blendRate({ projections: [10], production: [] }).rate).toBe(10);
  });
});

/* -------------------------------------------------------------------- byes -- */

describe('a bye is a week he does not play, not a number (review T1)', () => {
  it('a bye in week 11: the projection skips it, and the season counts the other eight weeks', () => {
    // Sleeper publishes nothing worth a game on his bye: 0.2 for week 11.
    const p = rated('bye11', 'WR', 14, { bye: 11, ahead: [[10, 13], [11, 0.2], [12, 15]], production: [14, 14, 14, 14, 14, 14, 14] });
    expect(p.blend!.projectionWeeks).toBe(3);
    expect(p.blend!.projection).toBe(14);
    expect(p.weekly[HORIZON.weeks.indexOf(11)]).toBe(0);
    expect(p.games).toBe(8);
    // Value over a free agent counts the weeks he plays, a playoff week at 1.5.
    expect(seasonValueOver(p, REPLACEMENT, seasonWeights(HORIZON))).toBeCloseTo((14 - 8) * (totalWeight(HORIZON) - 1), 1);
  });

  it('a bye this week: valued on the weeks after, and the ideas can trade him', () => {
    const p = rated('byeNow', 'WR', null, { bye: 9, ahead: [[10, 15], [11, 16], [12, 14]], production: [15, 15, 15, 15, 15, 15] });
    expect(p.rate).toBe(15);
    expect(p.basis).toBe('published');
    expect(p.weekly[0]).toBe(0);

    const pool = new Map<string, StartSitInput>([
      ['byeNow', { ...candidate('byeNow', 'BYENOW', 'WR', 1), props: [] }],
      ['mine', candidate('mine', 'MINE', 'WR', 12)],
    ]);
    const views = buildRosterViews({
      rosters: [{ key: '1', playerIds: ['mine'] }, { key: '2', playerIds: ['byeNow'] }],
      pool,
      shape: SHAPE,
      profile: PROFILE,
      season: { rates: new Map([['byeNow', p], ['mine', rate('mine', 'WR', 12)]]), replacement: REPLACEMENT, weights: seasonWeights(HORIZON) },
    });
    // On this week alone he has no number and cannot be traded; on the season he can.
    expect(views.get('2')!.valueOf.has('byeNow')).toBe(true);
    expect(views.get('2')!.unpriced.has('byeNow')).toBe(false);
  });
});

/* --------------------------------------------------------- an injured player -- */

describe('a player out for several weeks is valued on his season (review T1)', () => {
  it('on IR with nothing published: his season average, and only the weeks he is back', () => {
    const p = rated('hurt', 'RB', null, { status: 'IR', production: [18, 17, 19, 18, 18, 18] });
    expect(p.rate).toBe(18);
    expect(p.basis).toBe('season_average');
    // Out four weeks (9 to 12), back at 85% after that.
    expect(p.weekly.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(p.weekly[4]).toBe(0.85);
    const weights = seasonWeights(HORIZON);
    const expected = p.weekly.reduce((s, share, i) => s + share * weights[i]!, 0) * (18 - 7.5);
    expect(seasonValueOver(p, REPLACEMENT, weights)).toBeCloseTo(expected, 0);
  });

  it('can be put in a trade and given a verdict', () => {
    const hurt = rated('hurt', 'RB', null, { status: 'IR', production: [18, 17, 19, 18, 18, 18] });
    const ev = evaluateTrade({
      horizon: HORIZON, shape: LINEUP_SHAPE, replacement: REPLACEMENT,
      a: { label: 'Alex', rosterId: 1, isMine: true, roster: [rate('wr', 'WR', 14), rate('rb', 'RB', 12)] },
      b: { label: 'B', rosterId: 2, isMine: false, roster: [hurt, rate('b-wr', 'WR', 9)] },
      aSends: ['wr'], bSends: ['hurt'], rosterLimit: 18,
    });
    expect(ev.status).toBe('ok');
    expect(ev.a!.incoming[0]!.startsWeeks).toBe(5);
  });
});

/* ------------------------------------------------------------ the playoffs -- */

describe('a playoff week counts 1.5 times (Alex, November 2026)', () => {
  it('weights the horizon: six regular weeks and three playoff weeks', () => {
    expect(seasonWeights(HORIZON)).toEqual([1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5]);
    expect(totalWeight(HORIZON)).toBe(10.5);
    expect(REST_OF_SEASON.weights.playoff).toBe(1.5);
  });

  it('a player who plays weeks 15 to 17 is worth more than one who plays four regular weeks', () => {
    const late = rate('late', 'WR', 14, { weekly: HORIZON.weeks.map((w) => (w >= 15 ? 1 : 0)) });
    const early = rate('early', 'WR', 14, { weekly: HORIZON.weeks.map((w) => (w <= 12 ? 1 : 0)) });
    const weights = seasonWeights(HORIZON);
    expect(late.games).toBeLessThan(early.games);
    expect(seasonValueOver(late, REPLACEMENT, weights)!).toBeGreaterThan(seasonValueOver(early, REPLACEMENT, weights)!);
  });

  it('re-expresses the 8 and 3 point bars on the new scale, and shrinks them with the weeks left', () => {
    expect(gainBars(totalWeight(HORIZON))).toEqual({ user: 9.5, partner: 3.5 });
    const week11 = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 11 });
    expect(gainBars(totalWeight(week11))).toEqual({ user: 7.5, partner: 3 });
    expect(FAIR_TO_BOTH.userPerWeek).toBe(0.9);
  });
});

/* -------------------------------------------------------------- the ideas -- */

interface Spec {
  id: string;
  position: string;
  ppg: number;
}

/** A board searched on the season, with each idea held to Check a trade on the same rates. */
function seasonBoard(mine: Spec[], theirs: Spec[]) {
  const all = [...mine, ...theirs];
  const pool = new Map<string, StartSitInput>(all.map((s) => [s.id, candidate(s.id, s.id, s.position, s.ppg)]));
  const rates = new Map(all.map((s) => [s.id, rate(s.id, s.position, s.ppg)] as const));
  const weights = seasonWeights(HORIZON);
  const board = assembleSmartTrades({
    leagueSettings: SETTINGS,
    shape: SHAPE,
    profile: PROFILE,
    rosters: [
      { rosterId: 1, ownerId: 'u1', ownerName: 'Alex', playerIds: mine.map((s) => s.id), isMine: true },
      { rosterId: 2, ownerId: 'u2', ownerName: 'Partner', playerIds: theirs.map((s) => s.id), isMine: false },
    ],
    inputs: [...pool.values()],
    history: { ...NO_TRADE_HISTORY, measured: true },
    currentWeek: 9,
    withReserve: true,
    season: { rates, replacement: REPLACEMENT, weights },
  });
  const checks = new Map<string, SeasonCheck>();
  for (const idea of ideasToCheck(board)) {
    const side = (id: number, list: Spec[]) => ({
      label: id === 1 ? 'Alex' : 'Partner', rosterId: id, isMine: id === 1, roster: list.map((s) => rates.get(s.id)!),
    });
    checks.set(
      idea.id,
      seasonCheckOf(
        evaluateTrade({
          horizon: HORIZON, shape: LINEUP_SHAPE, replacement: REPLACEMENT, a: side(1, mine), b: side(2, theirs),
          aSends: idea.give.map((p) => p.playerId), bSends: idea.get.map((p) => p.playerId), rosterLimit: 18,
        }),
      ),
    );
  }
  return { board, shown: applySeasonChecks(board, checks).board, checks };
}

/** Alex: strong everywhere but tight end, with two real backs on the bench. */
const ALEX: Spec[] = [
  { id: 'a-qb', position: 'QB', ppg: 22 },
  { id: 'a-rb1', position: 'RB', ppg: 18 }, { id: 'a-rb2', position: 'RB', ppg: 16 },
  { id: 'a-rb3', position: 'RB', ppg: 10.5 }, { id: 'a-rb4', position: 'RB', ppg: 10.5 },
  { id: 'a-wr1', position: 'WR', ppg: 18 }, { id: 'a-wr2', position: 'WR', ppg: 16 }, { id: 'a-wr3', position: 'WR', ppg: 14 },
  { id: 'a-wr4', position: 'WR', ppg: 13 }, { id: 'a-wr5', position: 'WR', ppg: 12 },
  { id: 'a-te', position: 'TE', ppg: 8 },
];
/** The partner: two good tight ends, and thin at back. */
const PARTNER: Spec[] = [
  { id: 'p-qb', position: 'QB', ppg: 21 },
  { id: 'p-rb1', position: 'RB', ppg: 15 }, { id: 'p-rb2', position: 'RB', ppg: 7 },
  { id: 'p-wr1', position: 'WR', ppg: 16 }, { id: 'p-wr2', position: 'WR', ppg: 14 }, { id: 'p-wr3', position: 'WR', ppg: 12 },
  { id: 'p-wr4', position: 'WR', ppg: 9 },
  { id: 'p-te1', position: 'TE', ppg: 12 }, { id: 'p-te2', position: 'TE', ppg: 10 },
];

describe('the ideas are found and ranked on the season (review T1)', () => {
  it('shows a 2-for-1 that helps both lineups: two spare backs for a tight end', () => {
    const { shown, checks } = seasonBoard(ALEX, PARTNER);
    const idea = shown.offers.find((o) => o.give.length === 2 && o.get.map((p) => p.playerId).join() === 'p-te1');
    expect(idea).toBeDefined();
    const check = checks.get(idea!.id)!;
    expect(check.unfair).toBeNull();
    expect(check.you!).toBeGreaterThanOrEqual(9.5);
    expect(check.them!).toBeGreaterThanOrEqual(3.5);
    expect(Math.abs(check.edge!)).toBeLessThanOrEqual(0.1);
    // The row reads the season, not one week.
    expect(idea!.headline).toMatch(/^You \+\d+, them \+\d+ over the season$/);
  });

  it('shows a depth-for-starter deal: a bench back for a receiver who starts', () => {
    // Alex is weak at his third receiver and has a back to spare; the partner is the other way round.
    const mine: Spec[] = [
      { id: 'a-qb', position: 'QB', ppg: 22 },
      { id: 'a-rb1', position: 'RB', ppg: 18 }, { id: 'a-rb2', position: 'RB', ppg: 16 }, { id: 'a-rb3', position: 'RB', ppg: 12 },
      { id: 'a-rb4', position: 'RB', ppg: 10.5 }, { id: 'a-rb5', position: 'RB', ppg: 10 },
      { id: 'a-wr1', position: 'WR', ppg: 18 }, { id: 'a-wr2', position: 'WR', ppg: 16 }, { id: 'a-wr3', position: 'WR', ppg: 9 },
      { id: 'a-te', position: 'TE', ppg: 12 },
    ];
    const theirs: Spec[] = [
      { id: 'p-qb', position: 'QB', ppg: 21 },
      { id: 'p-rb1', position: 'RB', ppg: 15 }, { id: 'p-rb2', position: 'RB', ppg: 7 },
      { id: 'p-wr1', position: 'WR', ppg: 16 }, { id: 'p-wr2', position: 'WR', ppg: 14 }, { id: 'p-wr3', position: 'WR', ppg: 13 },
      { id: 'p-wr4', position: 'WR', ppg: 11.2 }, { id: 'p-wr5', position: 'WR', ppg: 10 }, { id: 'p-wr6', position: 'WR', ppg: 9.5 },
      { id: 'p-te1', position: 'TE', ppg: 9 },
    ];
    const { shown, checks } = seasonBoard(mine, theirs);
    const idea = shown.offers.find(
      (o) => o.give.length === 1 && o.give[0]!.position === 'RB' && o.get.length === 1 && o.get[0]!.position === 'WR',
    );
    expect(idea).toBeDefined();
    // A back from his depth (beyond his two backs), never one of the two.
    expect(['a-rb3', 'a-rb4', 'a-rb5']).toContain(idea!.give[0]!.playerId);
    const check = checks.get(idea!.id)!;
    expect(check.unfair).toBeNull();
    expect(check.you!).toBeGreaterThanOrEqual(9.5);
    expect(check.them!).toBeGreaterThanOrEqual(3.5);
  });

  it('never shows a lopsided deal: a spare receiver for their best back', () => {
    const { board, shown } = seasonBoard(ALEX, [
      ...PARTNER.filter((s) => s.id !== 'p-rb1'),
      { id: 'p-rb1', position: 'RB', ppg: 21 },
      { id: 'p-rb3', position: 'RB', ppg: 16 },
    ]);
    const lopsided = (o: { give: { playerId: string }[]; get: { playerId: string }[] }) =>
      o.get.some((p) => p.playerId === 'p-rb1') && o.give.every((p) => ['a-wr4', 'a-wr5', 'a-rb3', 'a-rb4'].includes(p.playerId));
    expect(shown.offers.some(lopsided)).toBe(false);
    expect(ideasToCheck(board).some(lopsided)).toBe(false);
  });

  it('weighs the value balance on each side’s value over a free agent, not on raw points', () => {
    // Two backs at 10.5 (3 over a free agent each) against a tight end at 12 (6 over).
    const seasonal = (id: string, position: string, ppg: number, over: number) => ({ playerId: id, name: id, position, value: ppg, seasonValue: over });
    const fair = fairnessOf(
      [seasonal('x', 'RB', 10.5, 31.5), seasonal('y', 'RB', 10.5, 31.5)],
      [seasonal('t', 'TE', 12, 63)],
    );
    expect(fair.band).toBe('even');
    // On raw points the same deal read 21 against 12: Alex overpaying by 43%.
    const raw = fairnessOf(
      [{ playerId: 'x', name: 'x', position: 'RB', value: 10.5 }, { playerId: 'y', name: 'y', position: 'RB', value: 10.5 }],
      [{ playerId: 't', name: 't', position: 'TE', value: 12 }],
    );
    expect(raw.band).toBe('outside_range');
  });
});

/* -------------------------------------------------- season average inputs -- */

describe('the season average counts games he played', () => {
  it('a bye or a week out is not a zero in his average; a played zero is', () => {
    const played = playedWeeksOf([
      { week: 1, seasonType: 'REG', targets: 6, receptions: 4, passAttempts: null, carries: null },
      { week: 3, seasonType: 'REG', targets: 0, receptions: 0, passAttempts: null, carries: null },
    ]);
    expect(productionGames({ leaguePoints: [12, 0, 0, 0, 9], through: 5, playedWeeks: played })).toEqual([12, 0, 9]);
  });
});

/* ------------------------------------------------- Build a trade, all teams -- */

describe('Build a trade, every team at once, checks what the phone checks', () => {
  it('evaluates up to ten packages a team, as the team-by-team sweep does', () => {
    const roster = (p: string) => [
      rate(`${p}-qb`, 'QB', 19), rate(`${p}-rbA`, 'RB', 16), rate(`${p}-rbB`, 'RB', 13), rate(`${p}-rbC`, 'RB', 12.5),
      rate(`${p}-wrA`, 'WR', 11), rate(`${p}-wrB`, 'WR', 9.5), rate(`${p}-wrC`, 'WR', 9), rate(`${p}-te`, 'TE', 9),
    ];
    const me = [
      rate('qb', 'QB', 22), rate('rb1', 'RB', 18), rate('rb2', 'RB', 8),
      rate('wr1', 'WR', 17), rate('wr2', 'WR', 15), rate('wr3', 'WR', 14), rate('wr4', 'WR', 13), rate('wr5', 'WR', 12.5), rate('wr6', 'WR', 12),
      rate('te', 'TE', 10),
    ];
    const activity = { thisSeason: 4, earlier: 18, seasons: 3, line: '' };
    const result = buildTradePackages({
      horizon: HORIZON, shape: LINEUP_SHAPE, replacement: REPLACEMENT, rosterLimit: 18, reserveSlots: 2,
      me: { rosterId: 1, label: 'Alex', roster: me, starterIds: [], activity, reserveIds: [] },
      teams: [{ rosterId: 2, label: 'Two', roster: roster('two'), starterIds: [], activity }],
      sell: ['wr4', 'wr5', 'wr6'], want: new Map(), team: 'all', considerUnmarked: false,
      eliteRbs: new Set(), protections: new Map(), dropSignals: null,
    });
    expect(BUILDER.evaluatedPerTeam).toBe(10);
    expect(result.audit.generated).toBeGreaterThan(4);
    expect(result.audit.evaluated).toBe(Math.min(10, result.audit.generated));
  });
});

/* A sanity line on availability, so the injury case above reads off one rule. */
describe('availability is unchanged by the round', () => {
  it('IR is four weeks out, then 85%', () => {
    const av = weeklyAvailability({ designation: 'ir', weeks: HORIZON.weeks, byeWeek: null });
    expect(av.weekly).toEqual([0, 0, 0, 0, 0.85, 0.85, 0.85, 0.85, 0.85]);
  });
});

/* --------------------------------------------------- T8, the market labels -- */

describe('the market list says what the news says, not what to trade (review T8)', () => {
  it('names every group as a news trend, never as a trade call', async () => {
    const { VERDICT_LABELS } = await import('../src/core/trades/engine.ts');
    expect(VERDICT_LABELS).toEqual({
      trade_target: 'News rising',
      emerging_target: 'News rising this week',
      add_waiver: 'News rising, free agent',
      sell_high: 'News cooling',
      trade_away: 'News falling',
      hold_mixed: 'News mixed',
    });
    for (const label of Object.values(VERDICT_LABELS)) {
      expect(label).not.toMatch(/trade|sell|target|reduce risk/i);
      expect(label).not.toContain('—');
    }
  });
});
