/**
 * Trades, round 1 of the November 2026 review: the cases from the register's
 * test list (`docs/REVIEW_2026-11.md`), each written to fail on the code before
 * this round.
 *
 *  - T5: no idea after the trade deadline (week 12 in this league).
 *  - The blind window (part of T1): from the first Sunday kickoff to the week
 *    rolling over, every lineup was locked and every idea read "would gain 0.0".
 *  - T10 and T11: Build a trade's three November packages, which went to the
 *    three least active traders, one paying 43 for 3, one the partner gained
 *    0.2 from, and one counting a player the partner would cut.
 */

import { describe, expect, it } from 'vitest';
import { pricedCandidate as candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews } from '../src/core/trades/rosterUtility.ts';
import { findBilateralTrades } from '../src/core/trades/bilateral.ts';
import { assembleSmartTrades, NO_TRADE_HISTORY } from '../src/core/trades/assemble.ts';
import { buildTradePackages, type BuilderInput, type BuilderTeam } from '../src/core/trades/builder.ts';
import { partnerActivity, rankPackages, topAcrossTeams, type BuiltPackage, type TradeActivity } from '../src/core/trades/builderResponse.ts';
import { replacementLevels } from '../src/core/tradeValue/evaluate.ts';
import type { PlayerRate } from '../src/core/tradeValue/rate.ts';
import { tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { buildRosterShape as shapeOf } from '../src/core/sleeper/rosterShape.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];
const profile = buildScoringProfile({}, POSITIONS);
const shape = buildRosterShape(POSITIONS);

type Spec = [id: string, position: string, points: number];

/** I am short a second back and deep at receiver; the partner is the mirror image. */
const ROSTERS: Record<string, Spec[]> = {
  '1': [['qb1', 'QB', 20], ['rb1', 'RB', 15], ['rb2', 'RB', 4], ['wr1', 'WR', 15], ['wr2', 'WR', 14], ['wr3', 'WR', 13], ['wr4', 'WR', 12], ['te1', 'TE', 9]],
  '2': [['qb2', 'QB', 19], ['rb3', 'RB', 14], ['rb4', 'RB', 13], ['rb5', 'RB', 12], ['rb6', 'RB', 11], ['wr5', 'WR', 6], ['te2', 'TE', 9]],
};

function poolOf(kickoff: string | null): Map<string, StartSitInput> {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(ROSTERS)) {
    for (const [id, position, points] of specs) pool.set(id, { ...candidate(id, id.toUpperCase(), position, points), kickoff });
  }
  return pool;
}

describe('the ideas are not blind from Sunday kickoff to the week rolling over (review T1)', () => {
  const ideas = (kickoff: string | null) => {
    const views = buildRosterViews({
      rosters: Object.entries(ROSTERS).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
      pool: poolOf(kickoff),
      shape,
      profile,
    });
    return findBilateralTrades({
      me: views.get('1')!,
      partners: [{ view: views.get('2')!, partner: { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' }, fit: { tendencies: null, seasonsObserved: 0, historyComplete: false } }],
    });
  };

  it('finds the same ideas, at the same gains, when every game has kicked off', () => {
    const before = ideas(new Date(Date.now() + 86_400_000).toISOString());
    const locked = ideas(new Date(Date.now() - 3_600_000).toISOString());
    expect(before.offers.length).toBeGreaterThan(0);
    expect(locked.offers.map((o) => [o.id, o.user.starterGain])).toEqual(before.offers.map((o) => [o.id, o.user.starterGain]));
    expect(locked.rejections.some((r) => /would gain 0\.0 pts/.test(r.detail))).toBe(false);
  });
});

describe('no idea after the trade deadline (review T5)', () => {
  const request = (currentWeek: number) => ({
    leagueSettings: { trade_deadline: 11, playoff_week_start: 15 },
    shape,
    profile,
    rosters: Object.entries(ROSTERS).map(([key, specs]) => ({
      rosterId: Number(key),
      ownerId: `u${key}`,
      ownerName: `Team ${key}`,
      playerIds: specs.map((s) => s[0]),
      isMine: key === '1',
    })),
    inputs: [...poolOf(null).values()],
    history: { ...NO_TRADE_HISTORY, measured: true },
    currentWeek,
  });

  it('week 11, the last week to trade: ideas as usual', () => {
    expect(assembleSmartTrades(request(11)).offers.length).toBeGreaterThan(0);
  });

  it('week 12: trades are closed, and nothing is suggested', () => {
    const board = assembleSmartTrades(request(12));
    expect(board.offers).toEqual([]);
    expect(board.found).toBe(false);
    expect(board.notes).toEqual(['Trades are closed for the season.']);
  });
});

/* ------------------------------------------------- Build a trade, T10/T11 -- */

const SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
const HORIZON = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 9 });
const BUILDER_SHAPE = shapeOf(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);

function rate(id: string, position: string, ppg: number): PlayerRate {
  const weekly = HORIZON.weeks.map(() => 1);
  return {
    playerId: id, name: id, position, team: 'AAA', rate: ppg, basis: 'market', rateNote: null, designation: 'healthy',
    games: weekly.length, weekly, injuryNote: null, byeWeek: null, byeKnown: true, byeInside: false, onReserve: false,
  };
}

const REPLACEMENT = replacementLevels([
  ...[12, 12, 12].map((v, i) => rate(`fa-qb${i}`, 'QB', v)),
  ...[6, 6, 6].map((v, i) => rate(`fa-rb${i}`, 'RB', v)),
  ...[9, 9, 9].map((v, i) => rate(`fa-wr${i}`, 'WR', v)),
  ...[4, 4, 4].map((v, i) => rate(`fa-te${i}`, 'TE', v)),
]);

/** Alex: deep at receiver, short a second back. */
const ALEX: PlayerRate[] = [
  rate('qb', 'QB', 22), rate('rb1', 'RB', 18), rate('rb2', 'RB', 8), rate('rb3', 'RB', 7),
  rate('wr1', 'WR', 17), rate('wr2', 'WR', 15), rate('wr3', 'WR', 14), rate('wr4', 'WR', 13), rate('wr5', 'WR', 12.5), rate('wr6', 'WR', 12),
  rate('te', 'TE', 10),
];
/** A partner deep at back and short at receiver: the same roster for each manager below. */
const PARTNER = (prefix: string): PlayerRate[] => [
  rate(`${prefix}-qb`, 'QB', 19), rate(`${prefix}-rbA`, 'RB', 16), rate(`${prefix}-rbB`, 'RB', 13), rate(`${prefix}-rbC`, 'RB', 12.5), rate(`${prefix}-rbD`, 'RB', 12),
  rate(`${prefix}-wrA`, 'WR', 11), rate(`${prefix}-wrB`, 'WR', 9.5), rate(`${prefix}-wrC`, 'WR', 9), rate(`${prefix}-te`, 'TE', 9),
];

const traded = (thisSeason: number, earlier: number): TradeActivity => ({ thisSeason, earlier, seasons: 3, line: '' });
const team = (rosterId: number, label: string, activity: TradeActivity): BuilderTeam => ({
  rosterId, label, roster: PARTNER(label), starterIds: [], activity,
});

function builder(over: Partial<BuilderInput> = {}): BuilderInput {
  return {
    horizon: HORIZON,
    shape: BUILDER_SHAPE,
    replacement: REPLACEMENT,
    rosterLimit: 18,
    reserveSlots: 2,
    me: { rosterId: 1, label: 'Alex', roster: ALEX, starterIds: [], activity: traded(7, 30), reserveIds: [] },
    teams: [
      team(2, 'jfletcher433', traded(4, 18)),
      team(3, 'NateyDee', traded(3, 12)),
      team(4, 'zackstephens54', traded(0, 1)),
      team(5, 'RonJonathan', traded(1, 1)),
      team(6, 'cheeseking', traded(0, 0)),
    ],
    sell: ['wr4', 'wr5', 'wr6'],
    want: new Map(),
    team: 'all',
    considerUnmarked: false,
    eliteRbs: new Set(['rb1']),
    protections: new Map(),
    dropSignals: null,
    ...over,
  };
}

describe('Build a trade asks frequent traders, and never the rare ones (review T11)', () => {
  it('reads the stored counts in the same classes the trade ideas use', () => {
    expect(partnerActivity(traded(4, 18))).toBe('active');
    expect(partnerActivity(traded(3, 12))).toBe('active');
    expect(partnerActivity(traded(1, 1))).toBe('low_activity');
    expect(partnerActivity(traded(0, 0))).toBe('effectively_inactive');
    expect(partnerActivity({ thisSeason: 0, earlier: null, line: '' })).toBe('unknown');
  });

  it('all teams: packages go to jfletcher433 and NateyDee, none to the 0-to-2-trade managers', () => {
    const result = buildTradePackages(builder());
    const partners = new Set(result.packages.map((p) => p.partner.label));
    expect(result.packages.length).toBeGreaterThan(0);
    expect([...partners].every((l) => ['jfletcher433', 'NateyDee'].includes(l))).toBe(true);
    expect(result.audit.hidden['rare_trader']).toBe(3);
  });

  it('a team Alex names himself is still asked', () => {
    const result = buildTradePackages(builder({ team: 4 }));
    expect(result.audit.hidden['rare_trader']).toBeUndefined();
  });

  it('ranks a frequent trader’s package above a bigger gain from a rare one, on the screen’s merge too', () => {
    const pkg = (id: string, weighted: number, activity: TradeActivity) =>
      ({ id, costsNow: false, status: 'maybe', alex: { weighted }, partner: { rosterId: Number(id), label: id, activity } }) as unknown as BuiltPackage;
    const rare = pkg('9', 40, traded(0, 1));
    const frequent = pkg('2', 12, traded(4, 18));
    expect(rankPackages([rare, frequent]).map((p) => p.id)).toEqual(['2', '9']);
    expect(topAcrossTeams([rare, frequent])[0]!.id).toBe('2');
  });
});

describe('Build a trade shows only deals fair to both sides (review T10)', () => {
  it('does not show Alex paying far more value than he gets back (43 for 3)', () => {
    // Two good receivers for a back worth little over a free agent.
    const result = buildTradePackages(builder({ team: 2, sell: ['wr2', 'wr3'], want: new Map([[2, ['jfletcher433-rbD']]]) }));
    expect(result.packages.find((p) => p.give.length === 2)).toBeUndefined();
    expect(result.audit.hidden['you_overpay'] ?? result.audit.hidden['no_gain_for_you']).toBeGreaterThan(0);
  });

  it('every package shown is within 10% Alex’s way, and both sides gain over the season', () => {
    const result = buildTradePackages(builder({ sell: ['wr3', 'wr4', 'wr5', 'wr6', 'rb3'] }));
    for (const p of result.packages) {
      const larger = Math.max(p.balance.give, p.balance.get);
      expect(Math.round(((p.balance.get - p.balance.give) / larger) * 100)).toBeLessThanOrEqual(10);
      expect(p.alex.restOfSeason).toBeGreaterThanOrEqual(8);
      expect(p.them.restOfSeason).toBeGreaterThanOrEqual(3);
    }
  });
});
