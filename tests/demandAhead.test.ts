/**
 * Who picks before you do again, and whether they still need one.
 *
 * The whole value of this is that it is measured rather than assumed. "Four
 * teams pick before me and they probably want receivers" is a guess anybody can
 * make; the point of reading the actual pick stream is to be able to say the
 * opposite when it is true.
 */

import { describe, expect, it } from 'vitest';
import { demandBetweenPicks, slotAtPick, type DemandInput } from '../src/core/draft/demandAhead.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const TEAMS = 12;
/** Starts 1 QB, 2 RB, 3 WR, 1 TE. RB and WR are the strict ones. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const POSITIONS: Record<string, string> = {};
/** `rb-3-1` is the first running back taken by slot 3. */
function pick(pickNo: number, slot: number, position: string | null) {
  const id = position ? `${position}-${slot}-${pickNo}` : null;
  if (id && position) POSITIONS[id] = position;
  return { playerId: id, pickNo, draftSlot: slot };
}

function demand(over: Partial<DemandInput> = {}) {
  return demandBetweenPicks({
    picks: [],
    positionOf: (id) => POSITIONS[id] ?? null,
    currentPick: 13,
    horizonPick: 17,
    mySlot: 12,
    teams: TEAMS,
    type: 'snake',
    shape: SHAPE,
    ...over,
  });
}

describe('which slot owns a pick', () => {
  it('reads a snake forwards on odd rounds and backwards on even ones', () => {
    expect(slotAtPick(1, TEAMS, 'snake')).toBe(1);
    expect(slotAtPick(12, TEAMS, 'snake')).toBe(12);
    // Round two reverses: pick 13 is slot 12 again, back to back.
    expect(slotAtPick(13, TEAMS, 'snake')).toBe(12);
    expect(slotAtPick(24, TEAMS, 'snake')).toBe(1);
    expect(slotAtPick(25, TEAMS, 'snake')).toBe(1);
  });

  it('reads a linear draft in the same order every round', () => {
    expect(slotAtPick(13, TEAMS, 'linear')).toBe(1);
    expect(slotAtPick(24, TEAMS, 'linear')).toBe(12);
  });
});

describe('demand between now and your next pick', () => {
  it('looks only at the teams picking in between', () => {
    // On the clock at 13 (slot 12's own pick), next at 17. Picks 14, 15, 16
    // belong to slots 11, 10 and 9.
    const out = demand();
    expect(out.get('WR')!.teamsAhead).toBe(3);
  });

  it('never counts your own team as competition', () => {
    // Slot 1 picks at 24 and 25 — back to back at the turn — so nobody is
    // between them.
    const out = demand({ currentPick: 24, horizonPick: 25, mySlot: 1 });
    expect(out.size).toBe(0);
  });

  it('says nothing when there is no next pick', () => {
    expect(demand({ horizonPick: null }).size).toBe(0);
  });

  /**
   * One is enough at the single-slot positions: a team with a tight end has
   * solved tight end for the purposes of "will somebody take one before me".
   */
  it('counts a team with one tight end as covered at tight end', () => {
    const picks = [pick(1, 11, 'TE'), pick(2, 10, 'TE')];
    const out = demand({ picks });
    expect(out.get('TE')).toMatchObject({ teamsAhead: 3, needing: 1 });
    expect(out.get('QB')).toMatchObject({ needing: 3 });
  });

  /**
   * The stricter half, and the reason the two rules exist. A team holding one
   * back in a league that starts two is still shopping for backs; counting it
   * as covered is how a board tells you a run is not coming while it is
   * happening.
   */
  it('needs the starting slots filled before a team is covered at RB or WR', () => {
    const picks = [
      // Slot 11 has one back of the two he starts: still needs one.
      pick(1, 11, 'RB'),
      // Slot 10 has both: covered.
      pick(2, 10, 'RB'),
      pick(3, 10, 'RB'),
    ];
    const out = demand({ picks });
    expect(out.get('RB')).toMatchObject({ teamsAhead: 3, needing: 2 });

    // The same two backs would have covered both teams at tight end.
    const asTe = demandBetweenPicks({
      picks: [pick(4, 11, 'TE'), pick(5, 10, 'TE')],
      positionOf: (id) => POSITIONS[id] ?? null,
      currentPick: 13,
      horizonPick: 17,
      mySlot: 12,
      teams: TEAMS,
      type: 'snake',
      shape: SHAPE,
    });
    expect(asTe.get('TE')!.needing).toBe(1);
  });

  it('counts three receivers as covering a three-receiver league', () => {
    const picks = [pick(1, 11, 'WR'), pick(2, 11, 'WR'), pick(3, 11, 'WR')];
    expect(demand({ picks }).get('WR')!.needing).toBe(2);
  });

  /**
   * The difference between "nobody ahead has a tight end" in round one and in
   * round nine. Without this the clause fires on every position in round one,
   * where it is true of everybody and distinguishes nothing.
   */
  it('reports how many teams ahead have even had the chance', () => {
    expect(demand({ picks: [] }).get('TE')!.couldHaveCovered).toBe(0);
    const someHavePicked = demand({ picks: [pick(1, 11, 'QB'), pick(2, 10, 'QB')] });
    expect(someHavePicked.get('TE')!.couldHaveCovered).toBe(2);
    // At RB the bar is two picks, so one pick each is not yet a chance.
    expect(someHavePicked.get('RB')!.couldHaveCovered).toBe(0);
  });

  it('ignores picks by teams that are not ahead of you', () => {
    // Slot 1 is nowhere near this window.
    const out = demand({ picks: [pick(1, 1, 'TE'), pick(2, 1, 'TE'), pick(3, 1, 'TE')] });
    expect(out.get('TE')).toMatchObject({ teamsAhead: 3, needing: 3, couldHaveCovered: 0 });
  });

  it('counts the pick on the clock when it is not yours', () => {
    // Waiting, not picking: the team on the clock is competition too.
    const out = demand({ currentPick: 14, horizonPick: 17, mySlot: 12 });
    expect(out.get('WR')!.teamsAhead).toBe(3);
  });
});
