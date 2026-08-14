/**
 * The one line that replaced the explanation.
 *
 * Two ways it can fail. It can say nothing when it should — the tier is about
 * to run out and the card is silent — or it can say something on every card,
 * which is the wallpaper this project has removed twice now in other forms.
 */

import { describe, expect, it } from 'vitest';
import { tierContextLine } from '../src/core/draft/tierContext.ts';
import { NO_CLIFF, type TierCliff } from '../src/core/draft/tiers.ts';
import type { PositionDemand } from '../src/core/draft/demandAhead.ts';

function tier(over: Partial<TierCliff>): TierCliff {
  return { ...NO_CLIFF, tierIndex: 0, tierSize: 4, tierEndsAtCliff: true, ...over };
}
/** Eleven teams pick before your next turn, as in round one of a 12-team draft. */
const demand = (over: Partial<PositionDemand> = {}): PositionDemand => ({
  teamsAhead: 11,
  needing: 11,
  couldHaveCovered: 11,
  ...over,
});

describe('the tier-context line', () => {
  it('says how many are left in the group', () => {
    expect(tierContextLine('WR', tier({ tierSize: 4 }), null)).toBe('WR board thinning · 4 left in this tier');
  });

  it('calls it a cliff once the group is nearly gone', () => {
    expect(tierContextLine('TE', tier({ tierSize: 1 }), null)).toBe('TE tier cliff · 1 left');
    expect(tierContextLine('TE', tier({ tierSize: 2 }), null)).toBe('TE tier cliff · 2 left in this tier');
  });

  /**
   * Shown to everyone in the group, not only to whoever sits at its edge —
   * "five left" is the same useful fact to all five of them.
   */
  it('reads the same for every member of a group', () => {
    const mid = tierContextLine('WR', tier({ tierSize: 4, severity: 'none' }), null);
    const edge = tierContextLine('WR', tier({ tierSize: 4, severity: 'last_in_tier' }), null);
    expect(mid).toBe(edge);
  });

  /**
   * The last tier at a position has nothing after it, so there is no drop to be
   * ahead of and "twenty-two left" is context for nothing.
   */
  it('says nothing about a group the board simply ends after', () => {
    expect(tierContextLine('QB', tier({ tierEndsAtCliff: false, tierSize: 22 }), null)).toBeNull();
  });

  it('says nothing about a player with no draft order', () => {
    expect(tierContextLine('WR', NO_CLIFF, null)).toBeNull();
  });

  describe('the demand clause', () => {
    it('reports when every team ahead is already set', () => {
      expect(tierContextLine('TE', tier({ tierSize: 1 }), demand({ needing: 0 }))).toBe(
        'TE tier cliff · 1 left · teams ahead already have TE',
      );
    });

    it('reports when they all still need one', () => {
      expect(tierContextLine('WR', tier({ tierSize: 4 }), demand({ teamsAhead: 4, needing: 4, couldHaveCovered: 4 }))).toBe(
        'WR board thinning · 4 left in this tier · all 4 teams ahead need WR',
      );
    });

    it('reports a majority without claiming all of them', () => {
      expect(tierContextLine('RB', tier({ tierSize: 3 }), demand({ teamsAhead: 4, needing: 3 }))).toBe(
        'RB board thinning · 3 left in this tier · 3 teams ahead still need RB',
      );
    });

    it('reports the quiet end of the scale', () => {
      expect(tierContextLine('QB', tier({ tierSize: 4 }), demand({ teamsAhead: 4, needing: 1 }))).toContain(
        'few teams ahead need QB',
      );
    });

    /**
     * The ordinary middle says neither "a run is coming" nor "you have time",
     * so it is left off rather than padded onto the line.
     */
    it('stays quiet about a split field', () => {
      expect(tierContextLine('WR', tier({ tierSize: 4 }), demand({ teamsAhead: 4, needing: 2 }))).toBe(
        'WR board thinning · 4 left in this tier',
      );
    });

    /**
     * Early in a draft nobody has covered anything, so every position comes
     * back "they all need one" — true, and it distinguishes nothing.
     */
    it('stays quiet before the teams ahead have had a chance', () => {
      const roundOne = demand({ teamsAhead: 11, needing: 11, couldHaveCovered: 2 });
      expect(tierContextLine('QB', tier({ tierSize: 4 }), roundOne)).toBe('QB board thinning · 4 left in this tier');
    });

    it('speaks up once most of them have had one', () => {
      const later = demand({ teamsAhead: 4, needing: 4, couldHaveCovered: 3 });
      expect(tierContextLine('QB', tier({ tierSize: 4 }), later)).toContain('all 4 teams ahead need QB');
    });

    it('says nothing when nobody picks before you do again', () => {
      expect(tierContextLine('WR', tier({ tierSize: 4 }), demand({ teamsAhead: 0, needing: 0 }))).toBe(
        'WR board thinning · 4 left in this tier',
      );
    });
  });

  /**
   * The line describes the group a player is in, wherever that group sits.
   * A tier three rungs down the board is still a group with a size and a drop
   * after it, and the player looking at it needs the same fact.
   */
  it('describes any tier, not only the best one left', () => {
    const top = tierContextLine('WR', tier({ tierIndex: 0, tierSize: 4 }), null);
    const lower = tierContextLine('WR', tier({ tierIndex: 3, tierSize: 4 }), null);
    expect(lower).toBe(top);
  });

  /** It moves as the group is drafted, because the size it reads is live. */
  it('counts down as the group is taken', () => {
    expect(tierContextLine('WR', tier({ tierSize: 4 }), null)).toContain('4 left');
    expect(tierContextLine('WR', tier({ tierSize: 3 }), null)).toContain('3 left');
    expect(tierContextLine('WR', tier({ tierSize: 1 }), null)).toBe('WR tier cliff · 1 left');
  });

  /**
   * The check that keeps this from becoming the next thing to delete.
   *
   * Every tier but the last ends at a cliff, so "ends at a cliff" on its own
   * puts a line on four cards in five — production said 158 of 195 — and
   * "12 left in this tier" is a large comfortable group with an alarming word
   * in front of it. The measured test is whether the teams picking before your
   * next turn could plausibly take the whole group.
   */
  describe('only when running out is a real prospect', () => {
    it('stays quiet about a group bigger than the field ahead of you', () => {
      expect(tierContextLine('WR', tier({ tierSize: 12 }), demand({ teamsAhead: 11 }))).toBeNull();
    });

    it('speaks when the field ahead could take the whole group', () => {
      expect(tierContextLine('WR', tier({ tierSize: 11 }), demand({ teamsAhead: 11 }))).toContain('11 left');
      expect(tierContextLine('WR', tier({ tierSize: 5 }), demand({ teamsAhead: 11 }))).toContain('5 left');
    });

    it('always says it for a cliff, whatever the arithmetic', () => {
      expect(tierContextLine('TE', tier({ tierSize: 2 }), demand({ teamsAhead: 1 }))).toContain('tier cliff');
      expect(tierContextLine('TE', tier({ tierSize: 1 }), null)).toContain('tier cliff');
    });

    /** Your last pick of the draft, or a slot Sleeper never published. */
    it('falls back to a small fixed group when there is nothing to measure', () => {
      expect(tierContextLine('WR', tier({ tierSize: 4 }), null)).toContain('4 left');
      expect(tierContextLine('WR', tier({ tierSize: 5 }), null)).toBeNull();
    });
  });
});
