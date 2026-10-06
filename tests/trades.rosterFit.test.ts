/**
 * Roster fit on both sides of a trade, built from the two cards on the live
 * Trades tab of 29 September 2026.
 *
 *   - Give Sam LaPorta (TE), get Malik Nabers (WR), "buy low", to a manager who
 *     already had a tight end in a league whose only tight-end spots are FLEX.
 *   - Give Kenneth Walker (RB), get CeeDee Lamb (WR), "sell high", from a roster
 *     with two startable backs and deep receivers.
 *
 * Both priced each player on his own number and never asked about the rosters.
 * See `src/core/trades/rosterFit.ts`.
 */

import { describe, expect, it } from 'vitest';
import { candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, type RosterView } from '../src/core/trades/rosterUtility.ts';
import { findBilateralTrades, MIN_USER_GAIN } from '../src/core/trades/bilateral.ts';
import { SCARCITY, counterpartNeed, scarcityOf } from '../src/core/trades/rosterFit.ts';
import { MEANINGFUL_UPGRADE_GAIN } from '../src/core/startsit/waivers.ts';
import type { ArbitrageRead } from '../src/core/trades/arbitrage.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

/** Tony's Pizza Fantasy: 1 QB, 2 RB, 3 WR, 2 FLEX, no dedicated tight end. */
const PIZZA = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
/** The same league with a tight-end slot, for the cases that need one. */
const WITH_TE = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

type Spec = [id: string, position: string, points: number | null, status?: string];

function leagueOf(positions: string[], rosters: Record<string, Spec[]>): Map<string, RosterView> {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(rosters)) {
    for (const [id, position, points, status] of specs) {
      pool.set(id, candidate(id, id, position, points, status ? { status } : {}));
    }
  }
  return buildRosterViews({
    rosters: Object.entries(rosters).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape: buildRosterShape(positions),
    profile: buildScoringProfile({}, positions),
  });
}

function run(views: Map<string, RosterView>, arbitrage: Map<string, ArbitrageRead>) {
  return findBilateralTrades({
    me: views.get('1')!,
    partners: [
      {
        view: views.get('2')!,
        partner: { key: '2', rosterId: 2, displayName: 'Partner', userId: 'u2' },
        fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
      },
    ],
    arbitrage,
  });
}

function reading(playerId: string, kind: ArbitrageRead['kind']): ArbitrageRead {
  return {
    playerId,
    kind,
    strength: 0.9,
    residualPerGame: kind === 'buy_low' ? -4 : 4,
    expectedPerGame: 12,
    observedPerGame: kind === 'buy_low' ? 8 : 16,
    games: 4,
    tdDependency: { profile: 'balanced', share: 0.4, touchdowns: 3, scoringGames: 2, games: 4, points: 0, display: '', driver: null },
    tallyFactor: 1,
    headline: `${playerId} headline`,
    reasons: ['because'],
  };
}

const ids = (players: { playerId: string }[]) => players.map((p) => p.playerId);

// ---------------------------------------------------------------- LaPorta --

/**
 * Alex holds two tight ends; the partner holds one whose market has not
 * posted this week, and a buy-low receiver. The partner's flex takes LaPorta
 * in Nabers' place for a lineup change of zero, which is what the live card
 * showed.
 */
const LAPORTA: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 13],
    ['rb3', 'RB', 9],
    ['wr1', 'WR', 12],
    ['wr2', 'WR', 11],
    ['wr3', 'WR', 9],
    ['laporta', 'TE', 10],
    ['te2', 'TE', 8],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb4', 'RB', 14],
    ['rb5', 'RB', 13],
    ['rb6', 'RB', 12],
    ['nabers', 'WR', 10],
    ['wr4', 'WR', 13],
    ['wr5', 'WR', 12],
    ['wr6', 'WR', 11],
    ['their_te', 'TE', null],
  ],
};

describe('counterpart need: the Sam LaPorta / Malik Nabers card', () => {
  it('no longer offers a tight end to a manager who already has one', () => {
    const report = run(leagueOf(PIZZA, LAPORTA), new Map([['nabers', reading('nabers', 'buy_low')]]));

    expect(report.offers.some((o) => ids(o.give).includes('laporta'))).toBe(false);
    const refused = report.rejections.find((r) => r.reason === 'counterparty_has_position' && r.give.includes('laporta'));
    expect(refused, 'the refusal is recorded where the probe can read it').toBeDefined();
    expect(refused!.detail).toMatch(/already hold one TE/);
  });

  it('still offers him when their tight end is on injured reserve, which is a real gap', () => {
    const hurt = { ...LAPORTA, '2': LAPORTA['2']!.map((s): Spec => (s[0] === 'their_te' ? ['their_te', 'TE', 9, 'IR'] : s)) };
    const views = leagueOf(PIZZA, hurt);
    const need = counterpartNeed({ receiver: views.get('2')!, sender: views.get('1')!, incoming: ['laporta'], outgoing: [] });
    expect(need.wanted).toBe(true);
  });

  it('asks for a clear upgrade over the tight end they start, using the waivers bar', () => {
    const priced = (theirs: number) =>
      leagueOf(WITH_TE, { ...LAPORTA, '2': LAPORTA['2']!.map((s): Spec => (s[0] === 'their_te' ? ['their_te', 'TE', theirs] : s)) });

    // LaPorta is 10. Against a 9 he is no upgrade worth a second tight end...
    let views = priced(9);
    let need = counterpartNeed({ receiver: views.get('2')!, sender: views.get('1')!, incoming: ['laporta'], outgoing: [] });
    expect(need.wanted).toBe(false);
    expect(need.detail).toMatch(/not a clear enough upgrade/);

    // ...and against one the bar's width below him, he is.
    views = priced(10 - MEANINGFUL_UPGRADE_GAIN - 0.5);
    need = counterpartNeed({ receiver: views.get('2')!, sender: views.get('1')!, incoming: ['laporta'], outgoing: [] });
    expect(need.wanted).toBe(true);
  });

  it('lets a like-for-like swap through: sending back their tight end makes room', () => {
    const views = leagueOf(WITH_TE, { ...LAPORTA, '2': LAPORTA['2']!.map((s): Spec => (s[0] === 'their_te' ? ['their_te', 'TE', 9] : s)) });
    const need = counterpartNeed({
      receiver: views.get('2')!,
      sender: views.get('1')!,
      incoming: ['laporta'],
      outgoing: ['their_te'],
    });
    expect(need.wanted).toBe(true);
  });

  it('puts no cap on backs and receivers', () => {
    const views = leagueOf(PIZZA, LAPORTA);
    const need = counterpartNeed({ receiver: views.get('2')!, sender: views.get('1')!, incoming: ['wr3'], outgoing: [] });
    expect(need.wanted).toBe(true);
  });
});

// ----------------------------------------------------------------- Walker --

/**
 * Two good backs and a third worth what the weakest flex receiver is, which
 * is what the live -0.2 implies: Walker out, a receiver into the flex, and the
 * week nets out. The partner is thin at back and deep at receiver, so Walker helps them
 * a little, as the live card's +0.2 said.
 */
const WALKER: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['walker', 'RB', 16.3],
    ['rb2', 'RB', 12],
    ['rb3', 'RB', 12],
    ['wr1', 'WR', 15],
    ['wr2', 'WR', 14],
    ['wr3', 'WR', 13],
    ['wr4', 'WR', 12.5],
    ['wr5', 'WR', 12],
    ['te1', 'TE', 8],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb4', 'RB', 11],
    ['rb5', 'RB', 8],
    ['rb6', 'RB', 7],
    ['lamb', 'WR', 16.1],
    ['wr6', 'WR', 13],
    ['wr7', 'WR', 12.5],
    ['wr8', 'WR', 12],
    ['wr9', 'WR', 11.8],
    ['te2', 'TE', 8],
  ],
};

describe('own scarcity: the Kenneth Walker / CeeDee Lamb card', () => {
  it('charges losing one of two startable backs, and nothing for a deep receiver', () => {
    const me = leagueOf(PIZZA, WALKER).get('1')!;

    const back = scarcityOf({ view: me, give: ['walker'], incoming: [{ position: 'WR', value: 16.1 }] });
    // RB starters go from walker + rb2 to rb2 + rb3: 16.3 → 12, a loss of about
    // 4.2 now that the engine's nudges are held to a tenth of the market number.
    expect(back.costs[0]!.loss).toBeCloseTo(4.18, 1);
    expect(back.charge).toBeCloseTo(SCARCITY.weight * (4.18 - SCARCITY.freeLoss), 1);
    expect(back.costs[0]!.replacement?.name).toBe('rb3');

    const receiver = scarcityOf({ view: me, give: ['wr3'], incoming: [{ position: 'RB', value: 13 }] });
    expect(receiver.charge).toBe(0);
  });

  it('costs nothing when a back comes back in the same deal', () => {
    const me = leagueOf(PIZZA, WALKER).get('1')!;
    const swap = scarcityOf({ view: me, give: ['walker'], incoming: [{ position: 'RB', value: 15 }] });
    expect(swap.charge).toBe(0);
  });

  it('no longer sells Walker for Lamb at a lineup wash', () => {
    const report = run(leagueOf(PIZZA, WALKER), new Map([['walker', reading('walker', 'sell_high')]]));

    expect(report.offers.some((o) => ids(o.give).includes('walker') && ids(o.get).includes('lamb'))).toBe(false);
    const refused = report.rejections.find((r) => r.reason === 'costs_scarce_player' && r.give.includes('walker'));
    expect(refused).toBeDefined();
    expect(refused!.detail).toMatch(/walker is hard to replace: rb3/);
  });

  /**
   * A sell-high from depth, at a small lineup loss: the arbitrage suite's
   * `SELLABLE` pair. The receiver sent has two more behind him, so the charge
   * is zero and the offer surfaces exactly as it did before this round.
   */
  const SELLABLE: Record<string, Spec[]> = {
    '1': [
      ['qb1', 'QB', 20],
      ['rb1', 'RB', 15],
      ['rb2', 'RB', 9],
      ['wr1', 'WR', 14],
      ['wr2', 'WR', 12],
      ['te1', 'TE', 9],
      ['wr3', 'WR', 11],
    ],
    '2': [
      ['qb2', 'QB', 20],
      ['rb3', 'RB', 16],
      ['rb5', 'RB', 12],
      ['rb6', 'RB', 11],
      ['wr4', 'WR', 13],
      ['te2', 'TE', 9],
    ],
  };
  const SELL_SHAPE = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];

  it('still sells from depth, with nothing charged', () => {
    const report = run(leagueOf(SELL_SHAPE, SELLABLE), new Map([['wr3', reading('wr3', 'sell_high')]]));
    const sell = report.offers.find((o) => ids(o.give).includes('wr3'));
    expect(sell, 'depth is exactly what a sell-high should move').toBeDefined();
    expect(sell!.scarcity).toEqual([]);
    expect(sell!.user.starterGain).toBeLessThan(MIN_USER_GAIN);
  });

  it('prints a lineup loss with one sign, not "+-0.2"', () => {
    const report = run(leagueOf(SELL_SHAPE, SELLABLE), new Map([['wr3', reading('wr3', 'sell_high')]]));
    expect(report.offers.length).toBeGreaterThan(0);
    for (const offer of report.offers) {
      expect(offer.headline).not.toMatch(/\+-/);
      if (Math.round(offer.user.starterGain * 10) < 0) expect(offer.headline).toMatch(/^−\d/);
    }
  });
});
