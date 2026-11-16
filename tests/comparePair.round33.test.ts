/**
 * Round 33 Part B: Compare opened from a free agent picks the roster player he
 * would most likely replace, and offers the rest of the position as swaps.
 */

import { describe, expect, it } from 'vitest';
import { PAIR_SWAPS, pairFor, swapOptions } from '../src/web/comparePair.ts';

const row = (id: string, points: number | null, starter: boolean | null, ruledOut = false) => ({
  id,
  name: `Player ${id}`,
  starter,
  ruledOut,
  week: { points },
});

describe('who a free agent is compared with', () => {
  it('the weakest starter at his position', () => {
    const { pick, swaps } = pairFor([row('a', 14.2, true), row('b', 9.1, true), row('c', 11.0, false), row('d', 6.0, false)]);
    expect(pick?.id).toBe('b');
    expect(swaps.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('no starter there: the best of the bench at it', () => {
    expect(pairFor([row('c', 7.5, false), row('d', 8.4, false)]).pick?.id).toBe('d');
  });

  it('never a player who cannot play, as the pick or a swap', () => {
    const { pick, swaps } = pairFor([row('out', 2, true, true), row('a', 12, true), row('b', 5, false)]);
    expect(pick?.id).toBe('a');
    expect(swaps.map((r) => r.id)).toEqual(['b']);
  });

  it('nobody at his position: no pick, so the list opens instead', () => {
    expect(pairFor([]).pick).toBeNull();
  });

  it('one tap swaps: the rest of the position, best first, never the ones already in', () => {
    const mine = [row('a', 14, true), row('b', 9, true), row('c', 11, false), row('d', 6, false), row('e', 4, false)];
    expect(swapOptions(mine, ['fa', 'b']).map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect(swapOptions(mine, ['fa', 'b'])).toHaveLength(PAIR_SWAPS);
    // After swapping to c, b is offered back.
    expect(swapOptions(mine, ['fa', 'c']).map((r) => r.id)).toEqual(['a', 'b', 'd']);
  });
});
