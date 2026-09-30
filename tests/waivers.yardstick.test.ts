/**
 * One yardstick per comparison, and one cut for the card and the plan.
 *
 * The rules from the 30 September 2026 research round, each pinned on its own,
 * and then the week-4 board of that day rebuilt from the report's own numbers:
 * every card read `Better than Jaylen Wright` while the plan cut Emmett
 * Johnson three times, Jaylen Wright's bar was one 2+ TD line read as an
 * any-TD line, and MarShawn Lloyd was Sleeper's #1 most-dropped player and
 * still rankable.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendWaiverUpgrades } from '../src/core/startsit/waivers.ts';
import { buildWaiverClaimPlan } from '../src/core/waivers/claimPlan.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import {
  buildCutPool,
  compareOnYardstick,
  findHandcuffs,
  fullyPriced,
  planMoves,
  readYardstick,
  type MoveCandidate,
  type YardstickReading,
} from '../src/core/waivers/yardstick.ts';
import { dropSignal, mostAddedLine, propsEdge, recentDropNote } from '../src/core/waivers/signals.ts';
import { NO_INJURY_INFORMATION, type InjuryState } from '../src/core/injury/model.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { MarketKey, PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';
import { signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

/** Tony's Pizza's shape: 1 QB, 2 RB, 3 WR, 2 FLEX, bench. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN']);

function prop(id: string, market: MarketKey, line: number | null, probability: number | null = null): PlayerProp {
  return {
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
  };
}

/**
 * A player with exactly the lines given. `td` is `[line, probability]`.
 * No lines at all is a player no book has priced.
 */
function input(
  id: string,
  name: string,
  position: string,
  team: string,
  lines: Partial<Record<Exclude<MarketKey, 'anytime_td'>, number>> & { td?: [number | null, number] } = {},
  extra: { status?: string; injury?: InjuryState } = {},
): StartSitInput {
  const props: PlayerProp[] = [];
  for (const [market, line] of Object.entries(lines)) {
    if (market === 'td') continue;
    props.push(prop(id, market as MarketKey, line as number));
  }
  if (lines.td) props.push(prop(id, 'anytime_td', lines.td[0], lines.td[1]));
  return {
    player: player({ id, fullName: name, position, team }),
    props,
    signal: signalWithNet(1),
    injuryStatus: extra.status ?? null,
    ...(extra.injury ? { injury: extra.injury } : {}),
    propsStale: false,
  };
}

/** A full receiver board: rec yds, receptions, any-TD. */
const wrBoard = (yards: number, receptions: number, td = 0.3) => ({
  receiving_yards: yards,
  receptions,
  td: [0.5, td] as [number, number],
});
const rbBoard = (rush: number, yards: number, receptions: number, td = 0.3) => ({
  rush_yards: rush,
  receiving_yards: yards,
  receptions,
  td: [0.5, td] as [number, number],
});

function questionableDnp(): InjuryState {
  return {
    ...NO_INJURY_INFORMATION,
    designation: 'questionable',
    bodyPart: 'neck',
    practice: { trend: 'unknown', days: ['dnp'], latest: 'dnp', label: null },
  };
}

const reading = (over: Partial<YardstickReading> & { playerId: string }): YardstickReading => ({
  name: over.playerId,
  position: 'WR',
  team: 'NE',
  market: null,
  sleeper: null,
  availability: 0,
  availabilityNote: null,
  practiceNote: null,
  ...over,
});

describe('the yardstick', () => {
  it('compares market against market only when both are fully priced', () => {
    const cmp = compareOnYardstick(
      reading({ playerId: 'a', market: 8, sleeper: 6 }),
      reading({ playerId: 'b', market: 5, sleeper: 7 }),
    );
    expect(cmp).toMatchObject({ basis: 'market', addPoints: 8, dropPoints: 5, projectionGap: 3, bar: 0.5 });
  });

  it('falls back to Sleeper for both when either side is not fully priced', () => {
    const cmp = compareOnYardstick(
      reading({ playerId: 'a', market: null, sleeper: 7 }),
      reading({ playerId: 'b', market: 5, sleeper: 3.5 }),
    );
    // Never 7 (Sleeper) against 5 (market).
    expect(cmp).toMatchObject({ basis: 'sleeper', addPoints: 7, dropPoints: 3.5, projectionGap: 3.5, bar: 1 });
  });

  it('refuses to compare when no pair exists, rather than inventing one', () => {
    expect(compareOnYardstick(reading({ playerId: 'a', sleeper: 7 }), reading({ playerId: 'b', market: 5 }))).toBeNull();
  });

  it('charges availability to the decision and not to the printed numbers', () => {
    const cmp = compareOnYardstick(
      reading({ playerId: 'a', sleeper: 7 }),
      reading({ playerId: 'b', sleeper: 3.5, availability: -1 }),
    )!;
    expect(cmp.projectionGap).toBe(3.5);
    expect(cmp.gap).toBe(4.5);
  });

  it('does not call a 2+ TD line fully priced, whatever else he has', () => {
    const anyTd = input('x', 'X', 'RB', 'MIA', rbBoard(40, 10, 2, 0.3));
    const twoPlus = input('y', 'Y', 'RB', 'MIA', { ...rbBoard(40, 10, 2), td: [1.5, 0.077] });
    const evaluation = (i: StartSitInput) => ({
      playerId: i.player.id,
      name: i.player.fullName,
      position: i.player.position,
      team: i.player.team,
      expectation: { points: 7, missingMarkets: [] },
    });
    expect(fullyPriced(evaluation(anyTd), anyTd.props)).toBe(true);
    expect(fullyPriced(evaluation(twoPlus), twoPlus.props)).toBe(false);
  });

  it('reads a Questionable player who did not practise as a full point down', () => {
    const r = readYardstick(
      { playerId: 'j', name: 'J', position: 'RB', team: 'MIA', expectation: null, injury: questionableDnp() },
      [],
      3.47,
    );
    expect(r).toMatchObject({ sleeper: 3.47, market: null, availability: -1, availabilityNote: 'Questionable, did not practise' });
  });

  it('ignores a healthy veteran\'s rest-day DNP', () => {
    const rested: InjuryState = {
      ...NO_INJURY_INFORMATION,
      designation: 'healthy',
      practice: { trend: 'unknown', days: ['dnp'], latest: 'dnp', label: null },
    };
    const r = readYardstick({ playerId: 'v', name: 'V', position: 'WR', team: 'NE', injury: rested }, [], 9);
    expect(r.availability).toBe(0);
  });
});

describe('handcuffs', () => {
  const roster = [
    { playerId: 'walker', name: 'Kenneth Walker', position: 'RB', team: 'KC' },
    { playerId: 'emmett', name: 'Emmett Johnson', position: 'RB', team: 'KC' },
    { playerId: 'jaylen', name: 'Jaylen Wright', position: 'RB', team: 'MIA' },
    { playerId: 'third', name: 'Third Back', position: 'RB', team: 'KC' },
  ];
  const starters = new Set(['walker']);

  it('finds the #2 behind your #1 on the depth chart', () => {
    const cuffs = findHandcuffs({
      roster: roster.filter((p) => p.playerId !== 'third'),
      starterIds: starters,
      depth: new Map([
        ['walker', { rank: 1 }],
        ['emmett', { rank: 2 }],
      ]),
    });
    expect(cuffs.get('emmett')?.name).toBe('Kenneth Walker');
    expect(cuffs.has('jaylen')).toBe(false);
  });

  it('falls back to club and position for backs the chart does not name', () => {
    const cuffs = findHandcuffs({ roster: roster.slice(0, 3), starterIds: starters, depth: new Map() });
    expect(cuffs.get('emmett')?.name).toBe('Kenneth Walker');
  });

  it('lets the chart overrule the fallback: a #3 is not the handcuff', () => {
    const cuffs = findHandcuffs({
      roster,
      starterIds: starters,
      depth: new Map([
        ['walker', { rank: 1 }],
        ['emmett', { rank: 2 }],
        ['third', { rank: 3 }],
      ]),
    });
    expect(cuffs.has('emmett')).toBe(true);
    expect(cuffs.has('third')).toBe(false);
  });
});

describe('Vegas props, market by market', () => {
  const kalif = { playerId: 'kalif', name: 'Kalif Raymond', position: 'WR', props: [prop('kalif', 'receiving_yards', 36.5), prop('kalif', 'receptions', 3.5)] };

  it('fires on a notably higher shared line with nothing pointing the other way', () => {
    const edge = propsEdge(
      { playerId: 'fa', name: 'FA', position: 'WR', props: [prop('fa', 'receiving_yards', 52.5), prop('fa', 'receptions', 4.5)] },
      [kalif],
    );
    expect(edge).toMatchObject({ verdict: 'ahead', nudge: 0.5, line: 'Vegas has him ahead of Kalif Raymond: 52.5 vs 36.5 rec yds' });
  });

  it('does not fire when any shared market points the other way', () => {
    const edge = propsEdge(
      { playerId: 'fa', name: 'FA', position: 'WR', props: [prop('fa', 'receiving_yards', 52.5), prop('fa', 'receptions', 3)] },
      [kalif],
    );
    expect(edge?.verdict ?? null).not.toBe('ahead');
  });

  it('says so when he trails on every shared line, and charges nothing for it', () => {
    const edge = propsEdge(
      { playerId: 'kupp', name: 'Cooper Kupp', position: 'WR', props: [prop('kupp', 'receiving_yards', 25.5), prop('kupp', 'receptions', 2.5)] },
      [kalif],
    );
    expect(edge).toMatchObject({ verdict: 'behind', nudge: 0, line: 'Vegas has him behind Kalif Raymond on every shared line' });
  });

  it('needs +15 yards and +25%: +8 rushing yards is under the bar', () => {
    const edge = propsEdge(
      { playerId: 'lloyd', name: 'MarShawn Lloyd', position: 'RB', props: [prop('lloyd', 'rush_yards', 24.5)] },
      [{ playerId: 'rj', name: 'RJ Harvey', position: 'RB', props: [prop('rj', 'rush_yards', 16.5)] }],
    );
    expect(edge).toBeNull();
  });

  it('never compares across positions, or a market only one side has', () => {
    expect(
      propsEdge({ playerId: 'fa', name: 'FA', position: 'RB', props: [prop('fa', 'receiving_yards', 80)] }, [kalif]),
    ).toBeNull();
    expect(
      propsEdge({ playerId: 'fa', name: 'FA', position: 'WR', props: [prop('fa', 'rush_yards', 80)] }, [kalif]),
    ).toBeNull();
  });

  it('compares touchdowns only at the same line', () => {
    const bench = [{ playerId: 'b', name: 'Bench', position: 'WR', props: [prop('b', 'anytime_td', 1.5, 0.9), prop('b', 'receptions', 3)] }];
    // His any-TD 0.5 against a 2+ TD 1.5 makes no claim, so the receptions edge stands alone.
    const edge = propsEdge(
      { playerId: 'fa', name: 'FA', position: 'WR', props: [prop('fa', 'anytime_td', 0.5, 0.2), prop('fa', 'receptions', 4.5)] },
      bench,
    );
    expect(edge?.verdict).toBe('ahead');
  });
});

describe('Sleeper trending and your own cuts', () => {
  it('says a rank, never a count', () => {
    expect(mostAddedLine(11)).toBe('#11 most-added on Sleeper today');
  });

  it('keeps a top-ten drop out of the plan and warns about him', () => {
    const top = dropSignal({ rank: 1, heat: 1 });
    expect(top.planExcluded).toBe('#1 most-dropped on Sleeper today. Check the news before claiming.');
    const lower = dropSignal({ rank: 22, heat: 0.58 });
    expect(lower).toMatchObject({ planExcluded: null, note: '#22 most-dropped on Sleeper today' });
    expect(lower.nudge).toBeLessThan(0);
    expect(lower.nudge).toBeGreaterThanOrEqual(-0.5);
  });

  it('notes your own cut inside two weeks, and not after', () => {
    const now = new Date('2026-09-30T19:00:00Z');
    expect(recentDropNote('2026-09-27T12:00:00Z', now)).toBe('Dropped by you 3 days ago');
    expect(recentDropNote('2026-09-10T12:00:00Z', now)).toBeNull();
  });
});

describe('the plan can spend two drops, each on its own merits', () => {
  const pool = buildCutPool({
    roster: [
      reading({ playerId: 'd1', name: 'Weakest', sleeper: 2 }),
      reading({ playerId: 'd2', name: 'Next', sleeper: 3 }),
      reading({ playerId: 'cuff', name: 'Handcuff', position: 'RB', sleeper: 1 }),
    ],
    starterIds: new Set(),
    reserveIds: new Set(),
    ruledOutIds: new Set(),
    held: new Map(),
    handcuffs: new Map([['cuff', { playerId: 's', name: 'Starter' }]]),
    excludedPositions: new Set(['DEF']),
  });
  const fa = (id: string, sleeper: number): MoveCandidate => ({
    reading: reading({ playerId: id, name: id, sleeper }),
    tier: 'value',
    competes: () => true,
    overCap: false,
    nudges: { lift: 0, order: 0 },
    planExcluded: null,
  });

  it('hangs three fallbacks off the first drop, and a fourth claim off a second drop that it clears alone', () => {
    const plan = planMoves({ candidates: [fa('a', 9), fa('b', 8), fa('c', 7), fa('d', 6), fa('e', 3.5)], pool });
    expect(plan.groups.map((g) => [g.drop?.name, g.addIds])).toEqual([
      ['Weakest', ['a', 'b', 'c']],
      ['Next', ['d']],
    ]);
    // Card and plan agree: d's own cut is the second drop now.
    expect(plan.moves.get('d')!.cut!.reading.name).toBe('Next');
    // e clears Weakest (1.5) but not Next (0.5 < 1.0), so he stays an option under Weakest.
    expect(plan.moves.get('e')!.cut!.reading.name).toBe('Weakest');
    expect(plan.groups.flatMap((g) => g.addIds)).not.toContain('e');
  });

  it('never spends a handcuff as a second drop', () => {
    expect(pool.candidates[0]!.reading.name).toBe('Handcuff');
    const plan = planMoves({ candidates: [fa('a', 9)], pool });
    expect(plan.groups[0]!.drop!.name).toBe('Weakest');
    expect(plan.groups[0]!.kept.map((k) => k.name)).toEqual(['Handcuff']);
  });
});

/*
 * Week 4, 30 September 2026, rebuilt from the research report's own numbers.
 * The snapshot itself is league data and stays out of the repository.
 */
describe('the 30 September board, rebuilt', () => {
  const roster: StartSitInput[] = [
    input('burrow', 'Joe Burrow', 'QB', 'CIN', { pass_yards: 260, pass_tds: 1.5, rush_yards: 8 }),
    input('bijan', 'Bijan Robinson', 'RB', 'ATL', rbBoard(85, 25, 3, 0.55)),
    input('braelon', 'Braelon Allen', 'RB', 'NYJ', rbBoard(60, 12, 2, 0.4)),
    input('walker', 'Kenneth Walker', 'RB', 'KC', rbBoard(55, 10, 2, 0.4)),
    input('egbuka', 'Emeka Egbuka', 'WR', 'TB', wrBoard(65, 5, 0.4)),
    input('gwilson', 'Garrett Wilson', 'WR', 'NYJ', wrBoard(62, 5, 0.35)),
    input('mcconkey', 'Ladd McConkey', 'WR', 'LAC', wrBoard(55, 4.5, 0.35)),
    input('laporta', 'Sam LaPorta', 'TE', 'DET', wrBoard(45, 4, 0.3)),
    // One 2+ TD line and nothing else: 3.47 published, Questionable, no practice.
    input('jaylen', 'Jaylen Wright', 'RB', 'MIA', { td: [1.5, 0.077] }, { status: 'Questionable', injury: questionableDnp() }),
    // No props at all: 3.92 published, the direct backup to Walker.
    input('emmett', 'Emmett Johnson', 'RB', 'KC'),
    input('kalif', 'Kalif Raymond', 'WR', 'CHI', wrBoard(36.5, 3.5, 0.2)),
    input('harvey', 'RJ Harvey', 'RB', 'DEN', { rush_yards: 16.5, receiving_yards: 21.5, receptions: 2.5, td: [1.5, 0.1] }),
  ];
  const wire: StartSitInput[] = [
    input('keenan', 'Keenan Allen', 'WR', 'IND'),
    input('kc', 'KC Concepcion', 'WR', 'CLE'),
    input('kupp', 'Cooper Kupp', 'WR', 'SEA', wrBoard(25.5, 2.5, 0.15)),
    input('bryant', 'Pat Bryant', 'WR', 'DEN', wrBoard(22.5, 2.5, 0.2)),
    input('lloyd', 'MarShawn Lloyd', 'RB', 'GB', { rush_yards: 24.5 }),
  ];
  const published = new Map([
    ['burrow', 19],
    ['bijan', 17],
    ['braelon', 12.37],
    ['walker', 10.5],
    ['egbuka', 11],
    ['gwilson', 11],
    ['mcconkey', 10],
    ['laporta', 8.5],
    ['jaylen', 3.47],
    ['emmett', 3.92],
    ['kalif', 5.2],
    ['harvey', 9.69],
    ['keenan', 6.98],
    ['kc', 7.57],
    ['kupp', 5.16],
    ['bryant', 6.14],
    ['lloyd', 7.2],
  ]);

  const advice = recommendWaiverUpgrades({
    roster,
    candidates: wire,
    shape: SHAPE,
    profile: HALF_PPR,
    rosteredPlayerIds: roster.map((i) => i.player.id),
    currentStarterIds: ['burrow', 'bijan', 'braelon', 'egbuka', 'gwilson', 'mcconkey', 'walker', 'laporta'],
    calendar: { week: 4, playoffWeeks: [15, 16, 17] },
    attention: new Map([['keenan', { heat: 0.8, rank: 11 }]]),
    heldIds: new Map([
      ['kalif', '#7 add in Sleeper this week'],
      ['harvey', 'drafted around pick 82'],
    ]),
    published,
    handcuffs: new Map([['emmett', { playerId: 'walker', name: 'Kenneth Walker' }]]),
    trendingDrops: new Map([
      ['lloyd', { heat: 1, rank: 1 }],
      ['kc', { heat: 0.58, rank: 22 }],
    ]),
    recentlyDropped: new Map([['kc', '2026-09-23T07:10:00Z']]),
    now: new Date('2026-09-30T19:00:00Z'),
  });
  const plan = buildWaiverClaimPlan({ advice: { ...advice, faab: { bids: [] } } });
  const board = buildWaiverBoard({ ...advice, faab: { bids: [] } });

  it('cuts Jaylen Wright, the one the cards name, and keeps Emmett Johnson for a stated reason', () => {
    expect(plan.state).toBe('plan');
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.drop!.name).toBe('Jaylen Wright');
    expect(plan.groups[0]!.keep).toContain('Keeping Emmett Johnson: he backs up Kenneth Walker, your starting RB.');
    for (const claim of plan.claims) expect(claim.dropName).toBe('Jaylen Wright');
  });

  it('names the same cut on every card as the plan does', () => {
    const planned = new Map(plan.claims.map((c) => [c.addPlayerId, c.dropName]));
    for (const row of board.rows) {
      if (row.cut == null) continue;
      if (planned.has(row.playerId)) expect(row.cut.name).toBe(planned.get(row.playerId));
      expect(row.cut.name).not.toBe('Emmett Johnson');
    }
  });

  it('puts the best projection first, on one yardstick', () => {
    expect(plan.claims.map((c) => c.addName).slice(0, 2)).toEqual(['Keenan Allen', 'KC Concepcion']);
    const keenan = board.rows.find((r) => r.playerId === 'keenan')!;
    expect(keenan.shortTerm.label).toBe('7.0 vs 3.5');
    expect(keenan.yardstick?.label).toBe('Sleeper projection for both');
    expect(plan.claims[0]!.detail).toContain('Proj. 7.0 vs 3.5 (Sleeper projection for both)');
    expect(plan.claims[0]!.detail).toContain('#11 most-added on Sleeper today');
    expect(plan.claims[1]!.qualifier).toBe('Only if 1 loses');
  });

  it('says you cut KC Concepcion recently, and still ranks him', () => {
    const kc = board.rows.find((r) => r.playerId === 'kc')!;
    expect(kc.notes).toContain('Dropped by you 7 days ago');
    expect(kc.notes).toContain('#22 most-dropped on Sleeper today');
  });

  it('keeps the #1 most-dropped player out of the plan, with the warning on his card', () => {
    expect(plan.claims.map((c) => c.addPlayerId)).not.toContain('lloyd');
    const lloyd = board.rows.find((r) => r.playerId === 'lloyd');
    expect(lloyd?.planExcluded).toBe('#1 most-dropped on Sleeper today. Check the news before claiming.');
    expect(lloyd?.notes).toContain('#1 most-dropped on Sleeper today. Check the news before claiming.');
  });

  it('prices nothing it cannot, and never compares Jaylen Wright on his 2+ TD line', () => {
    const kupp = board.rows.find((r) => r.playerId === 'kupp')!;
    // Kupp is fully priced; Jaylen is not, so both are read on Sleeper's number.
    expect(kupp.yardstick?.basis).toBe('sleeper');
    expect(kupp.shortTerm.label).toBe('5.2 vs 3.5');
    expect(kupp.notes).toContain('Vegas has him behind Kalif Raymond on every shared line');
  });
});
