/**
 * The last seven days of news as a secondary nudge on waiver drops and pickups.
 *
 * The rules, each pinned on its own: a thin week says nothing, a small sample is
 * shrunk toward zero, a settled month outranks the week, and nothing the week
 * says can cross the ceiling that keeps it a tie-breaker. Then the engine: the
 * order changes only where two players are close, the phrase appears only when
 * the order changed, the printed projections never move, and a handcuff stays
 * protected whatever his week says.
 */

import { describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import { recommendWaiverUpgrades } from '../src/core/startsit/waivers.ts';
import { buildWaiverClaimPlan } from '../src/core/waivers/claimPlan.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import { RECENT_FORM, recentFormOf, recentFormPhrase } from '../src/core/waivers/recentForm.ts';
import { buildCutPool, cutFor, type YardstickReading } from '../src/core/waivers/yardstick.ts';
import type { MarketKey, PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN']);

/** A tally with chosen 7-day and 30-day windows. */
function tally(net7: number, items7: number, net30 = net7, items30 = items7): PlayerSignal {
  const s = emptySignal('x');
  s.last7 = { positive: Math.max(0, net7), negative: Math.max(0, -net7), net: net7, items: items7 };
  s.last30 = { positive: Math.max(0, net30), negative: Math.max(0, -net30), net: net30, items: items30 };
  return s;
}

describe('what a week of news is allowed to say', () => {
  it('says nothing for a player with no tally at all', () => {
    expect(recentFormOf(null)).toMatchObject({ points: 0, direction: null });
    expect(recentFormOf(emptySignal('x'))).toMatchObject({ points: 0, direction: null });
  });

  it('says nothing from a single item, however loud', () => {
    expect(recentFormOf(tally(-3, 1))).toMatchObject({ points: 0, direction: null, items7: 1 });
    expect(recentFormOf(tally(3, 1))).toMatchObject({ points: 0, direction: null });
  });

  it('shrinks a small sample toward zero: the same net counts for less on fewer items', () => {
    const two = recentFormOf(tally(-3, 2)).points;
    const six = recentFormOf(tally(-3, 6)).points;
    expect(two).toBeLessThan(0);
    expect(six).toBeLessThan(two); // more items behind the same net, more weight
    expect(Math.abs(two)).toBeLessThanOrEqual(RECENT_FORM.maxPoints / 2);
    expect(recentFormOf(tally(-3, 2)).weight).toBe(0.5);
  });

  it('is a tie-breaker by construction: it can never exceed the ceiling', () => {
    expect(recentFormOf(tally(-40, 30)).points).toBe(-RECENT_FORM.maxPoints);
    expect(recentFormOf(tally(40, 30)).points).toBe(RECENT_FORM.maxPoints);
    // The widest swing between two players stays under the Sleeper bar of 1.0.
    expect(RECENT_FORM.maxPoints * 2).toBeLessThan(1);
  });

  it('reads the real item count when the stored-summary read reports last7.items as zero', () => {
    // The cache-fed signal has always said items: 0 for the draft board's sake; last7Count is the truth.
    const cached = { ...tally(-4, 0), last7Count: 4 };
    expect(recentFormOf(cached)).toMatchObject({ direction: 'down', items7: 4 });
    // And without it, a zero count is a silent week, as before.
    expect(recentFormOf(tally(-4, 0))).toMatchObject({ direction: null });
  });

  it('is signed so a good week is positive and a bad one negative', () => {
    expect(recentFormOf(tally(4, 4))).toMatchObject({ direction: 'up' });
    expect(recentFormOf(tally(-4, 4))).toMatchObject({ direction: 'down' });
    expect(recentFormOf(tally(4, 4)).points).toBeGreaterThan(0);
    expect(recentFormOf(tally(-4, 4)).points).toBeLessThan(0);
  });

  it('halves the week when a settled month points the other way, and not when the month agrees or is thin', () => {
    const alone = recentFormOf(tally(-4, 4, -4, 4));
    const against = recentFormOf(tally(-4, 4, 6, 6));
    const thinMonth = recentFormOf(tally(-4, 4, 1, 1));
    expect(against.againstMonth).toBe(true);
    expect(Math.abs(against.points)).toBeCloseTo(Math.abs(alone.points) * RECENT_FORM.againstMonth, 1);
    expect(thinMonth.againstMonth).toBe(false);
    expect(thinMonth.points).toBe(alone.points);
  });

  it('drops anything too small to name', () => {
    expect(recentFormOf(tally(0.2, 2)).direction).toBeNull();
    expect(recentFormPhrase('down')).toBe('trending down this week');
    expect(recentFormPhrase('up')).toBe('trending up this week');
  });
});

describe('the cut order', () => {
  const reading = (playerId: string, sleeper: number): YardstickReading => ({
    playerId,
    name: playerId,
    position: 'WR',
    team: 'NE',
    market: null,
    sleeper,
    availability: 0,
    availabilityNote: null,
    practiceNote: null,
  });
  const base = {
    starterIds: new Set<string>(),
    reserveIds: new Set<string>(),
    ruledOutIds: new Set<string>(),
    held: new Map<string, string>(),
    handcuffs: new Map<string, { playerId: string; name: string }>(),
    excludedPositions: new Set<string>(),
  };
  const roster = [reading('a', 5.0), reading('b', 5.3)];

  it('is the projection alone when nobody has a week worth reading', () => {
    const pool = buildCutPool({ ...base, roster });
    expect(pool.candidates.map((c) => c.reading.playerId)).toEqual(['a', 'b']);
    expect(pool.candidates.every((c) => c.form === 0)).toBe(true);
  });

  it('puts the worse week first when two players are close', () => {
    const pool = buildCutPool({ ...base, roster, form: new Map([['a', 0.4], ['b', -0.4]]) });
    expect(pool.candidates.map((c) => c.reading.playerId)).toEqual(['b', 'a']);
    expect(pool.candidates[0]!.standing).toBe(4.9);
  });

  it('cannot turn a clear gap over: a starter-in-waiting keeps his place through a quiet week', () => {
    const pool = buildCutPool({
      ...base,
      roster: [reading('benchwarmer', 3.5), reading('stash', 6.5)],
      form: new Map([['benchwarmer', 0.4], ['stash', -0.4]]),
    });
    expect(pool.candidates.map((c) => c.reading.playerId)).toEqual(['benchwarmer', 'stash']);
  });

  it('never reads the week into the numbers a card prints', () => {
    const pool = buildCutPool({ ...base, roster, form: new Map([['a', 0.4], ['b', -0.4]]) });
    expect(pool.candidates.find((c) => c.reading.playerId === 'b')!.reading.sleeper).toBe(5.3);
  });

  it('leaves a handcuff protected whatever his week says', () => {
    const pool = buildCutPool({
      ...base,
      roster,
      handcuffs: new Map([['b', { playerId: 'starter', name: 'Starter' }]]),
      form: new Map([['a', 0.4], ['b', -0.4]]),
    });
    const cut = cutFor('WR', pool, { competes: () => true, overCap: false });
    expect(cut!.reading.playerId).toBe('a');
  });
});

describe('a waiver board where two bench players and two adds are close', () => {
  const prop = (id: string, market: MarketKey, line: number | null, probability: number | null = null): PlayerProp => ({
    playerId: id,
    sourcePlayerName: id,
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: probability,
  });
  /** A starter with a full Vegas board, so he scores; a bench player or free agent has none and reads on Sleeper's number. */
  const board = (id: string, lines: Partial<Record<Exclude<MarketKey, 'anytime_td'>, number>>, td = 0.35): PlayerProp[] => [
    ...Object.entries(lines).map(([market, line]) => prop(id, market as MarketKey, line as number)),
    prop(id, 'anytime_td', 0.5, td),
  ];
  const mk = (
    id: string,
    name: string,
    position: string,
    team: string,
    props: PlayerProp[] = [],
    signal: PlayerSignal | null = null,
  ): StartSitInput => ({
    player: player({ id, fullName: name, position, team }),
    props,
    signal: signal ?? emptySignal(id),
    propsStale: false,
  });
  const wr = (id: string, name: string, signal: PlayerSignal | null = null) => mk(id, name, 'WR', 'NE', [], signal);
  const starterWr = (id: string, name: string, team: string, yards: number) =>
    mk(id, name, 'WR', team, board(id, { receiving_yards: yards, receptions: 5 }));
  const starterRb = (id: string, name: string, team: string, rush: number) =>
    mk(id, name, 'RB', team, board(id, { rush_yards: rush, receiving_yards: 20, receptions: 3 }, 0.45));

  interface Case {
    benchA: [number, PlayerSignal | null];
    benchB: [number, PlayerSignal | null];
    addX: [number, PlayerSignal | null];
    addY: [number, PlayerSignal | null];
  }

  function run(c: Case) {
    const roster: StartSitInput[] = [
      mk('burrow', 'Joe Burrow', 'QB', 'CIN', board('burrow', { pass_yards: 260, pass_tds: 1.5, rush_yards: 8 })),
      starterRb('bijan', 'Bijan Robinson', 'ATL', 85),
      starterRb('braelon', 'Braelon Allen', 'NYJ', 60),
      starterRb('walker', 'Kenneth Walker', 'KC', 55),
      starterWr('egbuka', 'Emeka Egbuka', 'TB', 65),
      starterWr('gwilson', 'Garrett Wilson', 'NYJ', 62),
      starterWr('mcconkey', 'Ladd McConkey', 'LAC', 55),
      starterWr('flexguy', 'Flex Guy', 'DAL', 50),
      wr('benchA', 'Bench Alpha', c.benchA[1]),
      wr('benchB', 'Bench Bravo', c.benchB[1]),
    ];
    const wire: StartSitInput[] = [wr('addX', 'Add Xavier', c.addX[1]), wr('addY', 'Add Yusuf', c.addY[1])];
    const published = new Map<string, number>([
      ['burrow', 19],
      ['bijan', 17],
      ['braelon', 12],
      ['walker', 11],
      ['egbuka', 11],
      ['gwilson', 11],
      ['mcconkey', 10],
      ['flexguy', 9],
      ['benchA', c.benchA[0]],
      ['benchB', c.benchB[0]],
      ['addX', c.addX[0]],
      ['addY', c.addY[0]],
    ]);
    const advice = recommendWaiverUpgrades({
      roster,
      candidates: wire,
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: roster.map((i) => i.player.id),
      currentStarterIds: ['burrow', 'bijan', 'braelon', 'egbuka', 'gwilson', 'mcconkey', 'walker', 'flexguy'],
      calendar: { week: 5, playoffWeeks: [15, 16, 17] },
      published,
      now: new Date('2026-10-01T19:00:00Z'),
    });
    const full = { ...advice, faab: { bids: [] } };
    return { advice, plan: buildWaiverClaimPlan({ advice: full }), board: buildWaiverBoard(full) };
  }

  const up = tally(5, 5);
  const down = tally(-5, 5);

  it('baseline: with no week worth reading, the weaker projection is cut and the better add leads', () => {
    const { plan, advice } = run({ benchA: [5.0, null], benchB: [5.3, null], addX: [8.0, null], addY: [7.8, null] });
    expect(plan.groups[0]!.drop!.name).toBe('Bench Alpha');
    expect(plan.groups[0]!.formNote).toBeNull();
    expect(advice.valueAdds.map((a) => a.playerId)).toEqual(['addX', 'addY']);
    for (const a of advice.valueAdds) expect(a.notes).toEqual([]);
  });

  it('drops the player with the worse week of two similar bench players, and says so', () => {
    const { plan } = run({ benchA: [5.0, up], benchB: [5.3, down], addX: [8.0, null], addY: [7.8, null] });
    expect(plan.groups[0]!.drop!.name).toBe('Bench Bravo');
    expect(plan.groups[0]!.formNote).toBe('trending down this week');
    const why = plan.claims[0]!.why.join(' ');
    expect(why).toContain('Bench Bravo is trending down this week');
  });

  it('says it from the other side when a good week is what kept the lower projection', () => {
    const { plan } = run({ benchA: [5.0, up], benchB: [5.3, null], addX: [8.0, null], addY: [7.8, null] });
    expect(plan.groups[0]!.drop!.name).toBe('Bench Bravo');
    expect(plan.groups[0]!.formNote).toBe('Bench Alpha trending up this week');
  });

  it('does not let one quiet week turn over a clear gap: the bench-warmer is still cut, with no phrase', () => {
    const { plan } = run({ benchA: [3.5, up], benchB: [6.5, down], addX: [8.0, null], addY: [7.8, null] });
    expect(plan.groups[0]!.drop!.name).toBe('Bench Alpha');
    expect(plan.groups[0]!.formNote).toBeNull();
  });

  it('does not act on a thin week: one item each changes nothing', () => {
    const { plan } = run({ benchA: [5.0, tally(3, 1)], benchB: [5.3, tally(-3, 1)], addX: [8.0, null], addY: [7.8, null] });
    expect(plan.groups[0]!.drop!.name).toBe('Bench Alpha');
    expect(plan.groups[0]!.formNote).toBeNull();
  });

  it('puts the hotter of two close adds first, says why, and leaves the printed numbers alone', () => {
    const { advice, board } = run({ benchA: [5.0, null], benchB: [5.3, null], addX: [8.0, down], addY: [7.8, up] });
    expect(advice.valueAdds.map((a) => a.playerId)).toEqual(['addY', 'addX']);
    const y = advice.valueAdds[0]!;
    const x = advice.valueAdds[1]!;
    expect(y.notes?.[0]).toBe('Trending up this week');
    expect(x.notes?.[0]).toBe('Trending down this week');
    // The comparison a card prints is the projection, untouched.
    expect(y.basis.projection).toBe(7.8);
    expect(x.basis.projection).toBe(8.0);
    expect(y.gain).toBeCloseTo(2.8, 5);
    expect(board.rows.filter((r) => r.strength.level === 'value').map((r) => r.playerId)).toEqual(['addY', 'addX']);
    expect(y.basis.recentForm).toMatchObject({ changed: true });
  });

  it('cannot let one hot week override a much stronger case for a different add', () => {
    const { advice } = run({ benchA: [5.0, null], benchB: [5.3, null], addX: [9.0, null], addY: [6.9, up] });
    expect(advice.valueAdds.map((a) => a.playerId)).toEqual(['addX', 'addY']);
    // His week is on his sheet, honestly marked as not having moved him.
    const y = advice.valueAdds[1]!;
    expect(y.basis.recentForm).toMatchObject({ changed: false });
    expect(y.notes).toEqual([]);
  });

  it('never admits a player the projection does not: a hot week cannot create a claim', () => {
    const { advice } = run({ benchA: [5.0, null], benchB: [5.3, null], addX: [8.0, null], addY: [5.4, tally(9, 9)] });
    expect(advice.valueAdds.map((a) => a.playerId)).toEqual(['addX']);
  });

  it('is the same board as before when the week is silent: no notes, no form on any basis', () => {
    const { advice } = run({ benchA: [5.0, null], benchB: [5.3, null], addX: [8.0, tally(0, 4)], addY: [7.8, tally(0, 4)] });
    for (const a of advice.valueAdds) {
      expect(a.basis.recentForm).toBeNull();
      expect(a.notes).toEqual([]);
    }
  });
});
