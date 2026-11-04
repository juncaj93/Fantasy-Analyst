/**
 * Round 5, waiver bugs (review register `docs/REVIEW_2026-11.md`, 4 November
 * 2026). Each test fails on the code before this round:
 *
 *  - W2: the tiers rank on the minus-2 rule (`rankingNumber`).
 *  - W1: a bye week is 0 with the source `bye`, and an earlier week's number
 *    says which week it is from.
 *  - W8: the drop score's recent form and season average skip a bye.
 *  - W12 and W6: bye cover two weeks out waits on a deep wire, and a free
 *    agent leads a claim for the same need when he is about as good.
 *  - W7: an add that cuts a useful player has to clear the toss-up bar.
 *  - W11: a "Starts this week" chip is this week's gain.
 *  - The defence planner speaks on a DEF bye this week however far kickoff
 *    is, and prefers a streamer who can be added now.
 *  - Team's bench line says "Toss-up" when Best move does.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverTiers, TIER_RULES, type TierCandidate, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { weekNumbers, type AheadNumbers } from '../src/core/waivers/aheadWeeks.ts';
import { formWeeks, pastByeWeeks } from '../src/core/waivers/tierInputs.ts';
import { dropScore, type DropSignals } from '../src/core/waivers/dropScore.ts';
import { buildTiersView } from '../src/core/waivers/tierPlan.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { planDst, type DstOption, type DstPlanInput } from '../src/core/dst/planner.ts';
import type { DstOutlook } from '../src/core/dst/outlook.ts';
import { DST_ROSTER_POSITIONS } from '../src/core/demo/fixtures/dst.ts';
import { gainChip, tierCard } from '../src/web/waiverCard.ts';
import { benchSummary } from '../src/web/benchSummary.ts';
import { TOSSUP_POINTS } from '../src/core/startsit/tossup.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const WEEKS = [9, 10, 11];

function p(id: string, position: string, rate: number | null, over: Partial<TierPlayer> = {}): TierPlayer {
  return { playerId: id, name: id, position, team: 'XX', rate, weekly: [1, 1, 1], designation: 'healthy', byeWeek: null, ...over };
}
const fa = (id: string, position: string, rate: number | null, over: Partial<TierCandidate> = {}): TierCandidate => p(id, position, rate, over);

/* Ten starters and six bench. WR4 is the weakest starter, at FLEX. */
function roster(over: Record<string, Partial<TierPlayer>> = {}): TierPlayer[] {
  const base = [
    p('Love', 'QB', 20),
    p('RB1', 'RB', 16),
    p('RB2', 'RB', 13),
    p('WR1', 'WR', 15),
    p('WR2', 'WR', 13),
    p('WR3', 'WR', 11),
    p('TE1', 'TE', 9),
    p('RB3', 'RB', 10),
    p('WR4', 'WR', 9),
    p('DEF1', 'DEF', 7),
    p('TE2', 'TE', 7),
    p('RB4', 'RB', 8),
    p('WR5', 'WR', 8),
    p('RB5', 'RB', 6),
    p('WR6', 'WR', 6),
    p('Dead', 'RB', 3),
  ];
  return base.map((x) => ({ ...x, ...(over[x.playerId] ?? {}) }));
}

function request(over: Partial<TierRequest> = {}): TierRequest {
  return {
    shape: SHAPE,
    weeks: WEEKS,
    weights: TIER_RULES.openWeights,
    leadWeeks: 2,
    roster: roster(),
    candidates: [],
    openSpots: 0,
    openReserve: 0,
    protections: new Map(),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['QB', 15],
      ['RB', 7],
      ['WR', 7],
      ['TE', 6],
    ]),
    ...over,
  };
}

const loveBye11: Partial<TierPlayer> = { byeWeek: 11, weekly: [1, 1, 0] };

describe('W2: the tiers rank a Sleeper-only number two points lower', () => {
  it('a Sleeper-only 12.0 over a priced 9.0 is +1.0 a week, not +3.0 and "Do this"', () => {
    const plan = planWaiverTiers(
      request({ openSpots: 1, candidates: [fa('Borrowed', 'WR', 12, { weekBorrowed: [true, true, true], rateBorrowed: true })] }),
    );
    const move = plan.all.find((m) => m.playerId === 'Borrowed')!;
    expect(move.byWeek.map((w) => w.change)).toEqual([1, 1, 1]);
    /* 1.0 × (1 + 1 + 0.5). Before: 3.0 × 2.5 = 7.5, a big upgrade. */
    expect(move.lineupGain).toBeCloseTo(2.5, 2);
    expect(move.reason).toBe('Starts over WR4, +1.0 pts in week 9');
    expect(plan.doThese.map((m) => m.playerId)).not.toContain('Borrowed');
    expect(plan.consider.map((m) => m.playerId)).toContain('Borrowed');
    /* The sheet still shows his own number. */
    expect(move.weekNumbers[0]?.points).toBe(12);
  });

  it('the same player on a full Vegas week keeps the whole gain', () => {
    const plan = planWaiverTiers(request({ openSpots: 1, candidates: [fa('Priced', 'WR', 12.5)] }));
    expect(plan.all.find((m) => m.playerId === 'Priced')?.byWeek[0]?.change).toBe(3.5);
  });
});

describe('W1: a bye week has no number', () => {
  const ahead: AheadNumbers = { sleeper: new Map([[10, new Map([['AW', 6.2]])], [11, new Map([['AW', 5.8], ['Love', 0]])]]) };

  it('the bye week is 0 from a bye, never an earlier week copied in', () => {
    const n = weekNumbers({ playerId: 'AW', rate: 4.89, weeks: WEEKS, currentWeek: 9, ahead, byeWeek: 9, rateWeek: 8 });
    expect(n[0]).toEqual({ week: 9, points: 0, source: 'bye' });
    expect(n[1]).toEqual({ week: 10, points: 6.2, source: 'sleeper' });
    expect(n[2]).toEqual({ week: 11, points: 5.8, source: 'sleeper' });
  });

  it("Jordan Love's week 11 bye is 0, not this week's 18.00", () => {
    const n = weekNumbers({ playerId: 'Love', rate: 18, weeks: WEEKS, currentWeek: 9, ahead, byeWeek: 11 });
    expect(n[2]).toEqual({ week: 11, points: 0, source: 'bye' });
  });

  it('an earlier week standing in says which week it is from', () => {
    const n = weekNumbers({ playerId: 'X', rate: 4.89, weeks: WEEKS, currentWeek: 9, ahead: null, rateWeek: 8 });
    expect(n.map((x) => x.fromWeek)).toEqual([8, 8, 8]);
    expect(n[0]?.source).toBe('this_week');
  });

  it("a free agent's own week list shows the bye as 0", () => {
    const numbers = weekNumbers({ playerId: 'FA', rate: 14, weeks: WEEKS, currentWeek: 9, ahead: null, byeWeek: 10 });
    const plan = planWaiverTiers(
      request({
        openSpots: 1,
        candidates: [fa('FA', 'WR', 14, { byeWeek: 10, weekly: [1, 0, 1], weekValues: numbers.map((x) => x.points), weekSources: numbers.map((x) => x.source) })],
      }),
    );
    const move = plan.all.find((m) => m.playerId === 'FA')!;
    expect(move.weekNumbers[1]).toEqual({ week: 10, points: 0, source: 'bye' });
  });
});

describe('W8: a bye is a week off, not a zero in his form', () => {
  it('10, bye, 10 reads as recent form 10, not 6.7', () => {
    const points = [10, 10, 10, 10, 10, 10, 0, 10];
    const form = formWeeks(points, 8, 7);
    expect(form.recent).toEqual([10, 10, 10]);
    expect(form.weeks).toBe(7);
    const s: DropSignals = {
      playerId: 'WR',
      name: 'WR',
      position: 'WR',
      seasonPoints: 70,
      weeksPlayed: form.weeks,
      recent: form.recent,
      projection: 10,
      role: null,
      heldWeeks: null,
      drafted: false,
      handcuffOf: null,
      inLineup: false,
      unavailable: false,
    };
    const reading = dropScore(s);
    expect(reading.parts.recent).toBeCloseTo(0.35 * 10, 2);
    expect(reading.parts.season).toBeCloseTo(0.25 * 10, 2);
  });

  it("finds each club's past bye from the season's points alone", () => {
    const season = new Map<string, number[]>();
    for (let i = 0; i < 8; i++) season.set(`pit${i}`, [5 + i, 6, 7, 0, 8, 9]);
    season.set('traded', [3, 3, 3, 3, 3, 3]);
    for (let i = 0; i < 8; i++) season.set(`gb${i}`, [5, 6, 7, 8, 9, 10]);
    const teamOf = (id: string) => (id.startsWith('pit') || id === 'traded' ? 'PIT' : 'GB');
    const byes = pastByeWeeks(season, 6, teamOf);
    expect(byes.get('PIT')).toBe(4);
    expect(byes.has('GB')).toBe(false);
  });
});

describe("W12: a bye two weeks out waits for its week when the wire is deep", () => {
  const qbs = [fa('Stroud', 'QB', 18.4), fa('Darnold', 'QB', 19.9, { instant: true }), fa('Rodgers', 'QB', 19.6, { instant: true }), fa('Murray', 'QB', 19.1, { instant: true })];

  it('Love on bye in week 11, in week 9, with four free QBs: no claim now', () => {
    const plan = planWaiverTiers(request({ roster: roster({ Love: loveBye11 }), candidates: qbs }));
    expect([...plan.doThese, ...plan.consider].filter((m) => m.position === 'QB')).toEqual([]);
    const later = plan.watch.find((m) => m.reasonCode === 'bye_later');
    expect(later).toBeDefined();
    expect(later!.reason).toBe('Cover Love’s week 11 bye that week; free QBs will be there');
  });

  it('a thin wire still says add him now', () => {
    const plan = planWaiverTiers(request({ roster: roster({ Love: loveBye11 }), candidates: [fa('Stroud', 'QB', 18.4)] }));
    expect(plan.consider.find((m) => m.playerId === 'Stroud')?.reasonCode).toBe('bye_depth');
  });

  it('in the bye week, a free QB as good as a claim is the "Do this"', () => {
    const plan = planWaiverTiers(
      request({
        roster: roster({ Love: { byeWeek: 10, weekly: [1, 0, 1] } }),
        candidates: [fa('Stroud', 'QB', 18.4), fa('Darnold', 'QB', 17.5, { instant: true })],
      }),
    );
    expect(plan.doThis?.playerId).toBe('Darnold');
    expect(plan.doThis?.reasonCode).toBe('hole_bye');
    expect(plan.doThis?.alternatives).toContain('Stroud');
  });

  it('a claim far better than the free one still leads', () => {
    const plan = planWaiverTiers(
      request({
        roster: roster({ Love: { byeWeek: 10, weekly: [1, 0, 1] } }),
        candidates: [fa('Stroud', 'QB', 22), fa('Darnold', 'QB', 16, { instant: true })],
      }),
    );
    expect(plan.doThis?.playerId).toBe('Stroud');
  });

  it('the waiting row carries no bid', () => {
    const plan = planWaiverTiers(request({ roster: roster({ Love: loveBye11 }), candidates: qbs }));
    const view = buildTiersView({
      plan,
      pickup: { Stroud: { state: 'waivers', reason: 'dropped', until: '2026-11-05T08:00:00.000Z' } },
      rules: null,
      budgets: null,
      prices: null,
      claims: [],
      seats: [],
      lastWeek: { week: 8, points: null },
      trending: new Map(),
      held: new Map(),
      paidFor: new Set(),
      evaluations: new Map(),
      week: 9,
      finalWeek: 14,
    });
    const row = view.watch.find((r) => r.reasonCode === 'bye_later')!;
    expect(row.bid.recommended).toBeNull();
    expect(tierCard(row).reason).toBe('Love bye wk 11: add then');
  });
});

describe('W7: an add that cuts a useful player clears the toss-up bar', () => {
  /* A full bench of useful players: nobody is drop-ready. */
  const full = () => roster({ Dead: { rate: 7.6 } });

  it('a 1.8 gain that costs a player who plays is not Worth considering', () => {
    const plan = planWaiverTiers(request({ weights: [1], weeks: [9], roster: full(), candidates: [fa('Small', 'WR', 10.8)] }));
    const move = plan.all.find((m) => m.playerId === 'Small')!;
    expect(move.gain).toBeGreaterThanOrEqual(TIER_RULES.consider);
    expect(move.gain).toBeLessThan(TOSSUP_POINTS);
    expect(plan.consider.map((m) => m.playerId)).not.toContain('Small');
    expect(plan.watch.map((m) => m.playerId)).toContain('Small');
  });

  it('the same gain into an open spot is still Worth considering', () => {
    const plan = planWaiverTiers(request({ weights: [1], weeks: [9], openSpots: 1, roster: full(), candidates: [fa('Small', 'WR', 10.8)] }));
    expect(plan.consider.map((m) => m.playerId)).toContain('Small');
  });

  it('the same gain that cuts a drop-ready player is still Worth considering', () => {
    const plan = planWaiverTiers(request({ weights: [1], weeks: [9], candidates: [fa('Small', 'WR', 10.8)] }));
    const move = plan.consider.find((m) => m.playerId === 'Small');
    expect(move?.drop?.name).toBe('Dead');
  });
});

describe('W11: the gain chip beside "Starts this week" is this week', () => {
  it('reads the week from the reason, and three weeks anywhere else', () => {
    expect(gainChip({ gain: 7.82, reasonCode: 'start_now', reason: 'Starts this week: +2.4 pts on your best lineup' })).toBe('+2.4');
    expect(gainChip({ gain: 3.1, reasonCode: 'start_tie', reason: 'Ties McConkey this week' })).toBe('+0.0');
    expect(gainChip({ gain: 7.82, reasonCode: 'upgrade', reason: 'Starts over WR4, +3.5 pts in week 9' })).toBe('+7.8');
  });
});

describe("the defence planner on a DEF bye", () => {
  const SHAPE_DEF = buildRosterShape(DST_ROSTER_POSITIONS);
  const outlook = (weeks: DstOutlook['weeks'], byes: number[] = []): DstOutlook => ({
    team: 'XX',
    weeks,
    perWeek: 7,
    total: 21,
    ratedFromLine: 0,
    ratedFromForm: 3,
    playable: 3,
    byes,
    confidence: 'low',
    display: '',
    notes: [],
  });
  const option = (team: string, thisWeek: number | null, extra: Partial<DstOption> = {}): DstOption => ({
    playerId: team.toLowerCase(),
    name: `${team} Defense`,
    team,
    thisWeek,
    confidence: 'high',
    unavailable: false,
    unavailableReason: null,
    locked: false,
    opponent: 'OPP',
    opponentImpliedTotal: 20,
    forward: null,
    playoff: null,
    ...extra,
  });
  const input = (over: Partial<DstPlanInput>): DstPlanInput => ({
    /* Monday 9 PM ET of week 9: Thursday's game is about 71 hours off, Sunday's far more. */
    now: '2026-11-03T02:00:00.000Z',
    currentWeek: 9,
    shape: SHAPE_DEF,
    bestBall: false,
    draftComplete: true,
    nextKickoff: '2026-11-07T01:15:00.000Z',
    rostered: [],
    available: [],
    streaming: null,
    roster: { openSpots: 0, dropCandidate: null },
    playoff: { weeks: [15, 16, 17], emphasis: 0 },
    ...over,
  });
  const pit = option('PIT', null, { unavailable: true, unavailableReason: 'is on bye' });

  it('speaks on the bye week however far the first kickoff is', () => {
    const plan = planDst(input({ nextKickoff: '2026-11-07T01:15:00.000Z', now: '2026-11-03T00:00:00.000Z', rostered: [pit], available: [option('NYJ', 8, { addableNow: true })] }));
    expect(plan.surface).toBe(true);
    expect(plan.decision).toBe('stream');
    expect(plan.headline).toBe('Stream NYJ · PIT is on bye');
  });

  it('names a free agent over a claim when he is about as good', () => {
    const plan = planDst(input({ rostered: [pit], available: [option('DEN', 9, { addableNow: false }), option('NYJ', 8, { addableNow: true })] }));
    expect(plan.target?.team).toBe('NYJ');
  });

  it('a claim far better still leads', () => {
    const plan = planDst(input({ rostered: [pit], available: [option('DEN', 12, { addableNow: false }), option('NYJ', 8, { addableNow: true })] }));
    expect(plan.target?.team).toBe('DEN');
  });

  it('the week before, names the best fill for the bye week', () => {
    const held = option('PIT', 7, { forward: outlook([], [10]) });
    const nyj = option('NYJ', 6, { addableNow: true, forward: outlook([{ week: 10, opponent: 'MIA', bye: false, home: true, opponentImpliedTotal: 17, basis: 'form', points: 8.4 }]) });
    const plan = planDst(input({ rostered: [held], available: [nyj] }));
    expect(plan.headline).toMatch(/bye week 10/);
    expect(plan.why.join(' ')).toContain('Best fill for week 10: NYJ Defense (8.4 pts, free agent)');
  });
});

describe("Team's bench line agrees with a toss-up", () => {
  it('says Toss-up, not No better option', () => {
    expect(benchSummary({ found: true, swaps: [], fills: [], tossUps: [{}] })).toBe('Toss-up');
    expect(benchSummary({ found: true, swaps: [], fills: [], tossUps: [] })).toBe('No better option');
    expect(benchSummary({ found: true, swaps: [{}], fills: [], tossUps: [{}] })).toBe('1 strong alternative');
  });
});
