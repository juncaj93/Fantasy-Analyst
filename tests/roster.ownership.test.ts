/**
 * The ownership filter, as a rule rather than as a screen.
 *
 * Pinned here because two handlers apply it — the live one and Demo Mode's —
 * and the whole reason it is a core module is that neither is allowed to have
 * its own opinion about what "available" means. What a browser test could show
 * is that the chips are drawn and the rows change; what it could never show is
 * that an unparseable parameter opens the list rather than emptying it, or that
 * a player on a roster is excluded from "available" *because* of that roster
 * rather than because he happens to be missing from a page.
 */

import { describe, expect, it } from 'vitest';
import {
  ANYONE_OWNER,
  ANY_OWNER,
  AVAILABLE_OWNER,
  matchesOwner,
  narrowsByOwner,
  ownerFilterParam,
  ownerTeams,
  parseOwnerFilter,
  rosterOwnership,
} from '../src/core/roster/ownership.ts';

/** Two managers, five players between them, and a wire nobody has claimed. */
const ROSTERS = [
  { rosterId: 2, ownerName: 'Rival', playerIds: ['1002', '1003'], isMine: false },
  { rosterId: 1, ownerName: 'You', playerIds: ['1001'], isMine: true },
  { rosterId: 3, ownerName: null, playerIds: [], isMine: false },
];

describe('reading the owner parameter', () => {
  it('reads the absent parameter, and the control’s own word for it, as everybody', () => {
    expect(parseOwnerFilter(null)).toEqual(ANY_OWNER);
    expect(parseOwnerFilter('')).toEqual(ANY_OWNER);
    expect(parseOwnerFilter(ANYONE_OWNER)).toEqual(ANY_OWNER);
  });

  it('reads the two shapes a filter actually has', () => {
    expect(parseOwnerFilter(AVAILABLE_OWNER)).toEqual({ kind: 'available' });
    expect(parseOwnerFilter('3')).toEqual({ kind: 'roster', rosterId: 3 });
  });

  /**
   * The failure this is really about: a filter nobody can name must not empty
   * the list.
   *
   * A client asking wrongly — an old deployment, a hand-edited URL, a roster id
   * that is a word — is still a client whose reader wants to see players, and
   * "no players found" is the one answer that reads as broken data rather than
   * as a bad question.
   */
  it('falls back to everybody rather than to nothing', () => {
    for (const nonsense of ['roster-3', '3.5', 'NaN', 'AVAILABLE', 'mine']) {
      expect(parseOwnerFilter(nonsense), nonsense).toEqual(ANY_OWNER);
    }
  });

  /** Whitespace around a value is a transport artefact, not a different answer. */
  it('trims before it decides', () => {
    expect(parseOwnerFilter(' available ')).toEqual({ kind: 'available' });
    expect(parseOwnerFilter(' 2 ')).toEqual({ kind: 'roster', rosterId: 2 });
  });

  it('sends nothing at all for the unfiltered list', () => {
    expect(ownerFilterParam(ANY_OWNER)).toBe('');
    expect(ownerFilterParam({ kind: 'available' })).toBe(AVAILABLE_OWNER);
    expect(ownerFilterParam({ kind: 'roster', rosterId: 7 })).toBe('7');
  });

  it('round-trips every state it can be in', () => {
    for (const filter of [ANY_OWNER, { kind: 'available' } as const, { kind: 'roster', rosterId: 4 } as const]) {
      expect(parseOwnerFilter(ownerFilterParam(filter))).toEqual(filter);
    }
  });

  it('knows which states need the rosters read', () => {
    expect(narrowsByOwner(ANY_OWNER)).toBe(false);
    expect(narrowsByOwner({ kind: 'available' })).toBe(true);
    expect(narrowsByOwner({ kind: 'roster', rosterId: 1 })).toBe(true);
  });
});

describe('matching a player against it', () => {
  const owned = rosterOwnership(ROSTERS);

  it('keeps everybody when nothing is asked', () => {
    expect(matchesOwner('1001', ANY_OWNER, owned)).toBe(true);
    expect(matchesOwner('9999', ANY_OWNER, owned)).toBe(true);
  });

  /** Available means unrostered *in this league*, and nothing else. */
  it('calls a player available only when no roster holds him', () => {
    expect(matchesOwner('9999', { kind: 'available' }, owned)).toBe(true);
    expect(matchesOwner('1001', { kind: 'available' }, owned)).toBe(false);
    expect(matchesOwner('1002', { kind: 'available' }, owned)).toBe(false);
  });

  it('gives a team exactly its own players', () => {
    expect(matchesOwner('1002', { kind: 'roster', rosterId: 2 }, owned)).toBe(true);
    expect(matchesOwner('1003', { kind: 'roster', rosterId: 2 }, owned)).toBe(true);
    // Mine, so not Rival's.
    expect(matchesOwner('1001', { kind: 'roster', rosterId: 2 }, owned)).toBe(false);
    // Nobody's, so not Rival's either — an empty answer, not a free pass.
    expect(matchesOwner('9999', { kind: 'roster', rosterId: 2 }, owned)).toBe(false);
  });

  /**
   * The contradiction the single control exists to make unrepresentable, stated
   * as arithmetic: no player is ever both.
   */
  it('never calls one player both available and somebody’s', () => {
    for (const id of ['1001', '1002', '1003', '9999']) {
      const available = matchesOwner(id, { kind: 'available' }, owned);
      const held = ROSTERS.some((r) => matchesOwner(id, { kind: 'roster', rosterId: r.rosterId }, owned));
      expect(available && held, id).toBe(false);
    }
  });

  /** An empty roster is a real answer — pre-draft, every roster is one. */
  it('answers an empty roster with an empty list rather than with everybody', () => {
    const ids = ['1001', '1002', '9999'].filter((id) => matchesOwner(id, { kind: 'roster', rosterId: 3 }, owned));
    expect(ids).toEqual([]);
  });
});

describe('the teams a row may offer', () => {
  it('lists the room in its own roster order, whatever order the rows arrived in', () => {
    expect(ownerTeams(ROSTERS).map((t) => t.rosterId)).toEqual([1, 2, 3]);
  });

  /** A seat Sleeper never named stays unnamed here; naming it is the screen's job. */
  it('carries the name, or the absence of one, without inventing a stand-in', () => {
    expect(ownerTeams(ROSTERS)).toEqual([
      { rosterId: 1, ownerName: 'You', isMine: true },
      { rosterId: 2, ownerName: 'Rival', isMine: false },
      { rosterId: 3, ownerName: null, isMine: false },
    ]);
  });

  it('offers nothing for a league with no rosters', () => {
    expect(ownerTeams([])).toEqual([]);
  });
});
