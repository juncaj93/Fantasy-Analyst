/**
 * Players-list ordering: Sleeper's draft rank nudged by the tally.
 */

import { describe, expect, it } from 'vitest';
import {
  RANK_FLOOR,
  TALLY_WEIGHT,
  adjustedRank,
  orderPlayers,
  rawAdjustedRank,
} from '../src/core/draft/playerOrder.ts';

function p(id: string, draftRank: number | null, net: number, name = id) {
  return { id, draftRank, net, name };
}

describe('adjustedRank', () => {
  it('moves a player up half a pick per point of good news', () => {
    expect(adjustedRank(20, 10)).toBe(20 - TALLY_WEIGHT * 10);
    expect(adjustedRank(20, 10)).toBe(15);
  });

  it('moves a player down for bad news', () => {
    expect(adjustedRank(20, -6)).toBe(23);
  });

  it('leaves a player with no tally exactly where Sleeper put them', () => {
    expect(adjustedRank(42, 0)).toBe(42);
  });

  it('never invents a rank for an unranked player', () => {
    expect(adjustedRank(null, 12)).toBeNull();
    expect(adjustedRank(undefined, 12)).toBeNull();
  });

  it('cannot be pushed above the first pick by a huge tally', () => {
    // Puka Nacua's backfilled tally is +13; nothing should print rank -3.
    expect(adjustedRank(1, 100)).toBe(RANK_FLOOR);
    expect(adjustedRank(1, 100)).toBeGreaterThan(0);
  });
});

/**
 * The floor is a label, not a verdict.
 *
 * `adjustedRank` saturates by design and `rawAdjustedRank` must not, because the
 * saturating one is what gets printed and the other is what decides who is
 * printed first. Collapsing the two is the defect this pair exists to prevent.
 */
describe('rawAdjustedRank', () => {
  it('keeps going below the display floor', () => {
    // Jahmyr Gibbs, live: ADP 1.8, tally +10.
    expect(rawAdjustedRank(1.8, 10)).toBeCloseTo(-3.2, 10);
    expect(adjustedRank(1.8, 10)).toBe(RANK_FLOOR);
  });

  it('separates two players the floor would flatten into one value', () => {
    // Gibbs is ahead of Bijan Robinson on both inputs; the raw value says so.
    expect(rawAdjustedRank(1.8, 10)!).toBeLessThan(rawAdjustedRank(2.1, 5)!);
    expect(adjustedRank(1.8, 10)).toBe(adjustedRank(2.1, 5));
  });

  it('agrees with the floored rank wherever the floor is not in play', () => {
    expect(rawAdjustedRank(60, 5)).toBe(adjustedRank(60, 5));
    expect(rawAdjustedRank(null, 12)).toBeNull();
  });
});

describe('orderPlayers', () => {
  it('orders by adjusted rank, not raw rank', () => {
    // 30 with a +20 tally lands at 20, ahead of a quiet 25.
    const order = orderPlayers([p('quiet', 25, 0), p('riser', 30, 20)]);
    expect(order.map((r) => r.player.id)).toEqual(['riser', 'quiet']);
  });

  it('does not let a good run leapfrog a much better player', () => {
    // Half a pick per point means +8 moves you 4 picks, not 40.
    const order = orderPlayers([p('elite', 3, 0), p('hyped', 40, 8)]);
    expect(order.map((r) => r.player.id)).toEqual(['elite', 'hyped']);
  });

  it('reports how far the tally moved each player', () => {
    const order = orderPlayers([p('riser', 30, 20), p('faller', 10, -4)]);
    const byId = new Map(order.map((r) => [r.player.id, r]));
    expect(byId.get('riser')!.movement).toBe(10);
    expect(byId.get('faller')!.movement).toBe(-2);
  });

  it('puts unranked players after everyone Sleeper ranks', () => {
    const order = orderPlayers([p('unranked', null, 30), p('last-ranked', 900, 0)]);
    expect(order.map((r) => r.player.id)).toEqual(['last-ranked', 'unranked']);
  });

  it('still orders unranked players usefully, by tally', () => {
    const order = orderPlayers([p('quiet', null, 0), p('buzzy', null, 5)]);
    expect(order.map((r) => r.player.id)).toEqual(['buzzy', 'quiet']);
  });

  it('breaks ties by name so the order never shuffles between requests', () => {
    const a = orderPlayers([p('x', 10, 0, 'Zeta'), p('y', 10, 0, 'Alpha')]);
    const b = orderPlayers([p('y', 10, 0, 'Alpha'), p('x', 10, 0, 'Zeta')]);
    expect(a.map((r) => r.player.name)).toEqual(['Alpha', 'Zeta']);
    expect(a.map((r) => r.player.id)).toEqual(b.map((r) => r.player.id));
  });

  it('reports zero movement for a player it cannot place', () => {
    const order = orderPlayers([p('unranked', null, 7)]);
    expect(order[0]!.movement).toBe(0);
    expect(order[0]!.adjustedRank).toBeNull();
  });

  /**
   * Movement is the rule, all the way up.
   *
   * It used to be measured off the floored rank, which made it shrink precisely
   * where the tally was loudest: Gibbs at +10 reported 1.3 picks of movement
   * while Bijan at +5 reported 1.6, so the row said the stronger evidence had
   * moved him less.
   */
  it('reports the full nudge even for a player who lands on the floor', () => {
    const order = orderPlayers([p('gibbs', 1.8, 10), p('bijan', 2.1, 5)]);
    const byId = new Map(order.map((r) => [r.player.id, r]));
    expect(byId.get('gibbs')!.movement).toBe(TALLY_WEIGHT * 10);
    expect(byId.get('bijan')!.movement).toBe(TALLY_WEIGHT * 5);
    // Both are printed at the floor; only the movement tells them apart.
    expect(byId.get('gibbs')!.adjustedRank).toBe(RANK_FLOOR);
    expect(byId.get('bijan')!.adjustedRank).toBe(RANK_FLOOR);
  });

  it('lets players who tie on paper actually tie, and breaks it by name', () => {
    // 7.6 - 0.5x11 is 2.0999999999999996 in floating point. It must not beat a
    // player genuinely priced at 2.1 by four parts in a quadrillion.
    const order = orderPlayers([p('fp', 7.6, 11, 'Zeta'), p('exact', 2.1, 0, 'Alpha')]);
    expect(order.map((r) => r.player.name)).toEqual(['Alpha', 'Zeta']);
  });
});

/**
 * The regression matrix the ordering brief asks for.
 *
 * Every case is stated as a property of the formula rather than as a fixed list
 * of names, so it keeps meaning something when the market moves. There is no
 * injury or availability term in this ordering at all — the row shows a status
 * tag, and the tag does not move anybody — which is itself worth pinning down.
 */
describe('players ordering: regression matrix', () => {
  const ids = (rows: ReturnType<typeof orderPlayers>) => rows.map((r) => r.player.id);

  it('ranks a player who is better on both market and evidence above one who is not', () => {
    expect(ids(orderPlayers([p('worse', 2.5, 5, 'Alpha'), p('better', 2.0, 10, 'Zeta')]))).toEqual([
      'better',
      'worse',
    ]);
  });

  it('resolves better-market-worse-evidence by the stated arithmetic', () => {
    // 2.0 - 1.0 = 1.0 against 3.5 - 4.0 = -0.5. The evidence wins, and by how
    // much is visible rather than a matter of taste.
    expect(ids(orderPlayers([p('market', 2.0, 2), p('evidence', 3.5, 8)]))).toEqual([
      'evidence',
      'market',
    ]);
  });

  it('moves the stronger tally up when the market prices two players alike', () => {
    expect(ids(orderPlayers([p('quiet', 12, 1, 'Alpha'), p('loud', 12, 9, 'Zeta')]))).toEqual([
      'loud',
      'quiet',
    ]);
  });

  it('moves the better market rank up when the evidence is identical', () => {
    expect(ids(orderPlayers([p('later', 30, 6, 'Alpha'), p('earlier', 8, 6, 'Zeta')]))).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('never lets an unpriced player outrank a priced one, however loud', () => {
    // Null is not zero and not pick one. The deepest ranked player still leads.
    const order = orderPlayers([p('unpriced', null, 40), p('deep', 999, -20)]);
    expect(ids(order)).toEqual(['deep', 'unpriced']);
    expect(order[1]!.adjustedRank).toBeNull();
  });

  it('does not read availability at all, so a status tag moves nobody', () => {
    // Two identical inputs stay in name order whatever else is true of them:
    // the formula has no injury term, and the row's tag is a label only.
    expect(ids(orderPlayers([p('b', 10, 3, 'Bravo'), p('a', 10, 3, 'Alpha')]))).toEqual(['a', 'b']);
  });

  it('produces the same order whichever way round the input arrives', () => {
    const roster = [
      p('gibbs', 1.8, 10, 'Jahmyr Gibbs'),
      p('bijan', 2.1, 5, 'Bijan Robinson'),
      p('puka', 4.1, 13, 'Puka Nacua'),
      p('cmc', 5.5, 7, 'Christian McCaffrey'),
      p('jsn', 7.6, 11, 'Jaxon Smith-Njigba'),
      p('jt', 6.4, 8, 'Jonathan Taylor'),
      p('unranked', null, 4, 'Nobody Priced'),
    ];
    expect(ids(orderPlayers([...roster].reverse()))).toEqual(ids(orderPlayers(roster)));
  });
});

/**
 * The live cluster that prompted the investigation.
 *
 * Production showed Bijan Robinson (ADP 2.1, +5) above Jahmyr Gibbs (ADP 1.8,
 * +10) — worse on both inputs, higher on the page — because both were floored to
 * 0.5 and `Bijan` sorts before `Jahmyr`. Pinned with the real figures so the
 * regression has a name.
 */
describe('players ordering: the Bijan/Gibbs cluster', () => {
  const cluster = [
    p('bijan', 2.1, 5, 'Bijan Robinson'),
    p('gibbs', 1.8, 10, 'Jahmyr Gibbs'),
    p('puka', 4.1, 13, 'Puka Nacua'),
    p('cmc', 5.5, 7, 'Christian McCaffrey'),
    p('jsn', 7.6, 11, 'Jaxon Smith-Njigba'),
    p('jt', 6.4, 8, 'Jonathan Taylor'),
  ];

  it('orders the whole cluster by the formula', () => {
    expect(orderPlayers(cluster).map((r) => r.player.id)).toEqual([
      'gibbs', // -3.2
      'puka', // -2.4
      'bijan', // -0.4
      'cmc', //  2.0
      'jsn', //  2.1
      'jt', //  2.4
    ]);
  });

  it('puts Gibbs above Bijan, who is worse on both inputs', () => {
    const order = orderPlayers(cluster).map((r) => r.player.id);
    expect(order.indexOf('gibbs')).toBeLessThan(order.indexOf('bijan'));
  });

  it('leaves the players the floor never touched exactly where they were', () => {
    // CMC, JSN and Taylor all land above the floor and were never mis-ordered.
    // The correction must not have moved them relative to one another.
    const order = orderPlayers(cluster).filter((r) => r.adjustedRank! > RANK_FLOOR);
    expect(order.map((r) => r.player.id)).toEqual(['cmc', 'jsn', 'jt']);
    expect(order.map((r) => r.adjustedRank)).toEqual([2, 2.0999999999999996, 2.4000000000000004]);
  });
});
