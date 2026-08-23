/**
 * FLX: the ordinary W/R/T view, and the two ways it goes wrong.
 *
 * The first is letting a quarterback in, which is what happens the moment
 * anybody confuses this with superflex. The second is quietly relabelling a
 * running back as "FLX", which would leak a view into the data.
 */

import { describe, expect, it } from 'vitest';
import {
  FLEX_POSITIONS,
  FLX_FILTER,
  POSITION_ORDER,
  isFlexEligible,
  TRAILING_FILTER_POSITIONS,
  offersFlexFilter,
  orderFilterChips,
  orderPositions,
  positionMatchesFilter,
  resolveComparisonSlot,
  slotAccepts,
  slotAcceptsPosition,
  slotsOf,
} from '../src/core/sleeper/eligibility.ts';
import { buildRosterShape, startablePositions } from '../src/core/sleeper/scoring.ts';

const ONE_FLEX = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);
const NO_FLEX = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'BN', 'BN']);
const SUPERFLEX = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN']);

/**
 * A normal redraft league that starts a defence, and a Best Ball one that does
 * not. The two shapes the filter row has to get right, side by side.
 *
 * Best Ball is the case a defence chip must not appear in at all, and it is by
 * far the more common of the two in this app's fixtures — which is exactly how
 * a defence sitting in the middle of the row survived unnoticed.
 */
const WITH_DEF = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN']);
const BEST_BALL = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);
const WITH_K_AND_DEF = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN']);

describe('normal flex eligibility', () => {
  it('is exactly RB, WR and TE', () => {
    expect([...FLEX_POSITIONS]).toEqual(['RB', 'WR', 'TE']);
  });

  it('includes the three that play in it', () => {
    expect(isFlexEligible('RB')).toBe(true);
    expect(isFlexEligible('WR')).toBe(true);
    expect(isFlexEligible('TE')).toBe(true);
    // Case and whitespace are presentation, not meaning.
    expect(isFlexEligible(' rb ')).toBe(true);
  });

  it('excludes the three that do not', () => {
    expect(isFlexEligible('QB')).toBe(false);
    expect(isFlexEligible('K')).toBe(false);
    expect(isFlexEligible('DEF')).toBe(false);
  });

  it('excludes nothing-at-all rather than guessing', () => {
    expect(isFlexEligible(null)).toBe(false);
    expect(isFlexEligible(undefined)).toBe(false);
    expect(isFlexEligible('')).toBe(false);
  });
});

describe('the FLX filter', () => {
  it('is a view: ALL and an empty filter still match everybody', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
      expect(positionMatchesFilter(position, 'ALL')).toBe(true);
      expect(positionMatchesFilter(position, null)).toBe(true);
    }
  });

  it('narrows to W/R/T and nothing else', () => {
    expect(positionMatchesFilter('RB', FLX_FILTER)).toBe(true);
    expect(positionMatchesFilter('WR', FLX_FILTER)).toBe(true);
    expect(positionMatchesFilter('TE', FLX_FILTER)).toBe(true);
    expect(positionMatchesFilter('QB', FLX_FILTER)).toBe(false);
    expect(positionMatchesFilter('K', FLX_FILTER)).toBe(false);
    expect(positionMatchesFilter('DEF', FLX_FILTER)).toBe(false);
  });

  it('leaves the single-position chips exactly as they were', () => {
    expect(positionMatchesFilter('RB', 'RB')).toBe(true);
    expect(positionMatchesFilter('WR', 'RB')).toBe(false);
    expect(positionMatchesFilter('DEF', 'DEF')).toBe(true);
  });

  /**
   * The whole reason this is a separate concept from `SUPER_FLEX`.
   *
   * Sleeper's superflex slot takes a quarterback and the app must keep reading
   * it that way; the FLX *view* never does, in a superflex league or any other.
   */
  it('is not superflex', () => {
    expect(slotAccepts('SUPER_FLEX')).toEqual(['QB', 'RB', 'WR', 'TE']);
    expect(slotAcceptsPosition('SUPER_FLEX', 'QB')).toBe(true);

    expect(slotAccepts(FLX_FILTER)).toEqual(['RB', 'WR', 'TE']);
    expect(slotAcceptsPosition(FLX_FILTER, 'QB')).toBe(false);

    // ...including in a league that actually has a superflex slot.
    expect(positionMatchesFilter('QB', FLX_FILTER)).toBe(false);
    expect(SUPERFLEX.superflex).toBe(true);
    expect(slotsOf(SUPERFLEX).find((s) => s.slot === 'SUPER_FLEX')?.accepts).toContain('QB');
  });

  it('is offered to a league that starts any of them, and not to one that does not', () => {
    expect(offersFlexFilter(startablePositions(ONE_FLEX))).toBe(true);
    expect(offersFlexFilter(startablePositions(NO_FLEX))).toBe(true);
    expect(offersFlexFilter(['QB', 'DEF'])).toBe(false);
  });
});

describe('the order positions are read in', () => {
  /**
   * Not alphabetical, and shared.
   *
   * Sorting puts TE before WR, which reads as a bug to anyone who has used a
   * fantasy site. This lived privately in the draft board while two other chip
   * rows sorted their own — same chips, two orders, one app.
   */
  it('is the conventional fantasy order, not alphabetical', () => {
    expect(orderPositions(['TE', 'QB', 'WR', 'RB'])).toEqual(['QB', 'RB', 'WR', 'TE']);
    expect(orderPositions(['WR', 'TE'])).toEqual(['WR', 'TE']);
    expect(orderPositions(startablePositions(ONE_FLEX))).toEqual(['QB', 'RB', 'WR', 'TE']);
  });

  it('keeps a position it has never heard of, rather than dropping it', () => {
    expect(orderPositions(['DL', 'QB', 'LB'])).toEqual(['QB', 'DL', 'LB']);
  });

  it('is one list, so no screen can invent a second order', () => {
    expect(POSITION_ORDER).toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
  });
});

/**
 * The filter row's order, which is the reading order plus two rules.
 *
 * `orderPositions` answers "what order are positions read in" and is used for
 * roster summaries too. A *chip row* asks a narrower question, and the answer
 * has FLX after its parts and the defence at the very end.
 */
describe('the order a filter row draws its chips in', () => {
  it('is QB, RB, WR, TE, FLX, DEF in a league that starts a defence', () => {
    expect(orderFilterChips(startablePositions(WITH_DEF))).toEqual(['QB', 'RB', 'WR', 'TE', 'FLX', 'DEF']);
  });

  /**
   * The regression this exists for: DEF used to sit between TE and FLX, because
   * the row was `orderPositions(startable)` with FLX appended, and
   * `POSITION_ORDER` quite correctly reads the defence among the positions.
   */
  it('puts the defence after FLX, not among the positions', () => {
    const chips = orderFilterChips(startablePositions(WITH_DEF));
    expect(chips.indexOf('DEF')).toBe(chips.length - 1);
    expect(chips.indexOf('DEF')).toBeGreaterThan(chips.indexOf(FLX_FILTER));
  });

  it('leaves a Best Ball league without a defence exactly as it was', () => {
    expect(orderFilterChips(startablePositions(BEST_BALL))).toEqual(['QB', 'RB', 'WR', 'TE', 'FLX']);
  });

  /**
   * The FLX chip is offered on flex-eligible *positions*, not on the presence of
   * a flex slot — see `offersFlexFilter`, which is unchanged. A league starting
   * one of each still gets the view, and this row is here so that reordering
   * cannot quietly become a rule about which chips exist.
   */
  it('changes which order the chips are in and never which chips there are', () => {
    expect(orderFilterChips(startablePositions(NO_FLEX))).toEqual(['QB', 'RB', 'WR', 'TE', 'FLX']);
    for (const shape of [WITH_DEF, BEST_BALL, NO_FLEX, SUPERFLEX, ONE_FLEX]) {
      const startable = startablePositions(shape);
      const before = [...orderPositions(startable), ...(offersFlexFilter(startable) ? [FLX_FILTER] : [])];
      expect([...orderFilterChips(startable)].sort()).toEqual([...before].sort());
    }
  });

  /**
   * The kicker question, answered rather than guessed at.
   *
   * There is no K chip to order. `NON_PLAYING_SLOTS` drops a `K` roster slot
   * before it can ever become a startable position — "the app has no opinion
   * about them, so treating a kicker slot as a starting slot would produce a
   * lineup row it could never fill" — so a league that starts a kicker draws
   * exactly the same row as one that does not. Moving K was neither needed nor
   * possible, and `TRAILING_FILTER_POSITIONS` is the one line that would change
   * if kickers ever arrived.
   */
  it('has no kicker chip to place, in a league that starts one', () => {
    expect(startablePositions(WITH_K_AND_DEF).has('K')).toBe(false);
    expect(orderFilterChips(startablePositions(WITH_K_AND_DEF))).toEqual(['QB', 'RB', 'WR', 'TE', 'FLX', 'DEF']);
    expect(TRAILING_FILTER_POSITIONS).toEqual(['DEF']);
  });

  it('honours a caller that has already been told whether FLX is offered', () => {
    expect(orderFilterChips(['QB', 'RB', 'WR', 'TE', 'DEF'], false)).toEqual(['QB', 'RB', 'WR', 'TE', 'DEF']);
    expect(orderFilterChips(['QB', 'DEF'], true)).toEqual(['QB', 'FLX', 'DEF']);
  });

  it('keeps a slot it has never heard of, after the positions and before nothing', () => {
    expect(orderFilterChips(['DEF', 'QB', 'DL', 'WR'])).toEqual(['QB', 'WR', 'DL', 'FLX', 'DEF']);
  });
});

describe('slot eligibility comes from the league', () => {
  it('reads a plain slot as itself and a flex slot as its list', () => {
    expect(slotAccepts('QB')).toEqual(['QB']);
    expect(slotAccepts('REC_FLEX')).toEqual(['WR', 'TE']);
    expect(slotAccepts('WRRB_FLEX')).toEqual(['RB', 'WR']);
    // Sleeper spells a second quarterback as a slot, not a position.
    expect(slotAccepts('QB2')).toEqual(['QB']);
  });

  it('lists every distinct slot a league starts', () => {
    expect(slotsOf(ONE_FLEX)).toEqual([
      { slot: 'QB', accepts: ['QB'] },
      { slot: 'RB', accepts: ['RB'] },
      { slot: 'WR', accepts: ['WR'] },
      { slot: 'TE', accepts: ['TE'] },
      { slot: 'FLEX', accepts: ['RB', 'WR', 'TE'] },
    ]);
  });
});

describe('what a comparison is actually about', () => {
  it('two quarterbacks are competing for the QB slot', () => {
    const resolved = resolveComparisonSlot(['QB', 'QB'], ONE_FLEX);
    expect(resolved.comparable).toBe(true);
    expect(resolved.slot).toBe('QB');
  });

  it('prefers the most specific slot that takes all of them', () => {
    // Two running backs could share a flex; they are competing for RB.
    expect(resolveComparisonSlot(['RB', 'RB'], ONE_FLEX).slot).toBe('RB');
    // A back and a receiver cannot, so the flex is what is left.
    const mixed = resolveComparisonSlot(['RB', 'WR', 'TE'], ONE_FLEX);
    expect(mixed.comparable).toBe(true);
    expect(mixed.slot).toBe('FLEX');
  });

  it('honours the slot the comparison was launched from', () => {
    const fromFlex = resolveComparisonSlot(['RB', 'RB'], ONE_FLEX, 'FLEX');
    expect(fromFlex.slot).toBe('FLEX');
    expect(fromFlex.comparable).toBe(true);

    const illegal = resolveComparisonSlot(['RB', 'QB'], ONE_FLEX, 'FLEX');
    expect(illegal.comparable).toBe(false);
    expect(illegal.detail).toContain('QB');
  });

  /** Honesty rather than a forced ranking — the rule from the brief. */
  it('says so when the players share no legal slot', () => {
    const resolved = resolveComparisonSlot(['QB', 'WR'], ONE_FLEX);
    expect(resolved.comparable).toBe(false);
    expect(resolved.slot).toBeNull();
    expect(resolved.detail).toMatch(/do not share a lineup slot/);
  });

  it('gives the flex-eligible case its own sentence in a league with no flex', () => {
    const resolved = resolveComparisonSlot(['RB', 'WR'], NO_FLEX);
    expect(resolved.comparable).toBe(false);
    expect(resolved.detail).toMatch(/flex-eligible/);
  });

  it('lets a superflex league compare a quarterback against a running back', () => {
    const resolved = resolveComparisonSlot(['QB', 'RB'], SUPERFLEX);
    expect(resolved.comparable).toBe(true);
    expect(resolved.slot).toBe('SUPER_FLEX');
  });
});
