/**
 * Players-list ordering: Sleeper's draft rank nudged by the tally.
 */

import { describe, expect, it } from 'vitest';
import { TALLY_WEIGHT, adjustedRank, orderPlayers } from '../src/core/draft/playerOrder.ts';

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
    // Puka Nacua's backfilled tally is +13; nothing should produce rank -3.
    expect(adjustedRank(1, 100)).toBeGreaterThan(0);
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
});
