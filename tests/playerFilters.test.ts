/**
 * The Players chip row, in the one order it is allowed to have.
 *
 * Asserted here rather than in the browser suite for a reason that is the whole
 * point of the rule: the demo league starts no defence, so the chip this is
 * about would not be drawn at any width. A browser test would have asserted
 * `ALL · QB · RB · WR · TE · FLX` and passed just as happily with DEF back in
 * the middle of the row.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_FILTER,
  ownerButtonLabel,
  ownerFilterOptions,
  playerFilterChips,
  playersEmptyLine,
  teamLabel,
} from '../src/web/playerFilters.ts';
import { ANY_OWNER, ANYONE_OWNER, AVAILABLE_OWNER } from '../src/core/roster/ownership.ts';

describe('the Players position filters', () => {
  /**
   * The order the brief asks for, exactly.
   *
   * DEF last, after FLX, rather than between the tight ends and the flex view
   * where `orderPositions` puts it — that helper is shared with the draft board
   * and Team and is deliberately not changed for this.
   */
  it('puts the defence last, after the flex view', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE', 'DEF'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'DEF',
    ]);
  });

  /** The order the league starts them in cannot change the row's own order. */
  it('reads the same however the league lists its slots', () => {
    expect(playerFilterChips(['DEF', 'TE', 'QB', 'WR', 'RB'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'DEF',
    ]);
  });

  /**
   * The kicker joins it at the end, between the flex view and the defence.
   *
   * Same argument as the defence and the same place for it: one slot filled
   * once a week against a schedule rather than against the rest of the pool, so
   * it belongs where a chip nobody is hunting for belongs. The order between
   * the two is the roster's own — kicker, then defence.
   */
  it('puts the kicker after the flex view and before the defence', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'K',
      'DEF',
    ]);
  });

  /** Each of the two can arrive without the other, and keeps its own place. */
  it('offers whichever of the kicker and the defence the league starts', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE', 'K'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'K',
    ]);
  });

  /**
   * A chip that could only ever return nothing is worse than no chip.
   *
   * The demo league's own shape, and the reason this rule needed a unit test:
   * no defence slot, so no defence chip to put anywhere.
   */
  it('offers no defence chip to a league that starts none', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE'])).toEqual(['ALL', 'QB', 'RB', 'WR', 'TE', 'FLX']);
  });

  /** No flex-eligible positions, no flex view — and the defence still last. */
  it('drops the flex view when nothing is flex-eligible', () => {
    expect(playerFilterChips(['QB', 'DEF'])).toEqual(['ALL', 'QB', 'DEF']);
  });

  /** Nothing to derive a row from means no row, rather than a lone ALL. */
  it('draws no row at all for a league that starts nothing', () => {
    expect(playerFilterChips([])).toEqual([]);
  });
});

/** The room the seed and the demo both describe: me, a rival, an unnamed seat. */
const TEAMS = [
  { rosterId: 1, ownerName: 'You', isMine: true },
  { rosterId: 2, ownerName: 'Rival', isMine: false },
  { rosterId: 3, ownerName: null, isMine: false },
];

describe('the Players ownership control', () => {
  /**
   * One list, and the two questions the brief asks for are both in it.
   *
   * Asserted as a whole list rather than option by option because the claim is
   * about the shape of the control: "available" and a named team are
   * alternatives in one exclusive choice, not two controls that have to be told
   * not to contradict each other. A test that only checked "there is an
   * Available option" would pass just as happily with the two filters split
   * back into controls that can disagree.
   */
  it('offers everybody, the wire, and then each team', () => {
    expect(ownerFilterOptions(TEAMS)).toEqual([
      { id: ANYONE_OWNER, label: 'Anyone' },
      { id: AVAILABLE_OWNER, label: 'Available' },
      { id: '1', label: 'You' },
      { id: '2', label: 'Rival' },
      { id: '3', label: 'Team 3' },
    ]);
  });

  /** Nothing to derive it from means no control — the position chips' own rule. */
  it('offers nothing at all for a league with no teams', () => {
    expect(ownerFilterOptions([])).toEqual([]);
  });

  /**
   * The shut control says the answer, and names the question only while there
   * is no answer worth saying.
   */
  it('says the current answer, and the noun while there is none', () => {
    expect(ownerButtonLabel(ANY_OWNER, null)).toBe('Owner');
    expect(ownerButtonLabel({ kind: 'available' }, null)).toBe('Available');
    expect(ownerButtonLabel({ kind: 'roster', rosterId: 2 }, 'Rival')).toBe('Rival');
    // A chip whose team has gone from the response still names a seat.
    expect(ownerButtonLabel({ kind: 'roster', rosterId: 5 }, null)).toBe('Team 5');
  });

  /**
   * A seat Sleeper never named gets a label that says which seat and claims
   * nothing else. `Team 3` is positional; a stand-in name would be a fiction
   * that then has to be believed everywhere else it appears.
   */
  it('names a seat by its roster when Sleeper has not named it', () => {
    expect(teamLabel({ rosterId: 3, ownerName: null, isMine: false })).toBe('Team 3');
    expect(teamLabel({ rosterId: 3, ownerName: '   ', isMine: false })).toBe('Team 3');
    expect(teamLabel({ rosterId: 3, ownerName: 'Rival', isMine: false })).toBe('Rival');
  });
});

describe('what an empty Players list is allowed to say', () => {
  const empty = { query: '', position: ALL_FILTER, owner: ANY_OWNER, ownerLabel: null };

  /**
   * The one case that sends the reader to Setup, and it has to stay the one
   * case: with a filter on, an empty list is a fact about the filter, and
   * advising a player sync would be advice about the wrong problem.
   */
  it('blames the data only when nothing is narrowing the list', () => {
    expect(playersEmptyLine(empty)).toContain('Sleeper player sync');
    expect(playersEmptyLine({ ...empty, position: 'QB' })).toBe('No QB players found.');
    expect(playersEmptyLine({ ...empty, owner: { kind: 'available' } })).not.toContain('sync');
  });

  it('names the search when there was one', () => {
    expect(playersEmptyLine({ ...empty, query: 'burrow' })).toBe('Nobody matching “burrow”.');
    expect(playersEmptyLine({ ...empty, query: 'burrow', position: 'RB' })).toBe(
      'Nobody matching “burrow” under RB.',
    );
  });

  it('says available rather than missing when the wire is what is empty', () => {
    expect(playersEmptyLine({ ...empty, owner: { kind: 'available' } })).toBe('No players are available.');
    expect(playersEmptyLine({ ...empty, owner: { kind: 'available' }, position: 'TE' })).toBe(
      'No TE players are available.',
    );
    expect(playersEmptyLine({ ...empty, owner: { kind: 'available' }, query: 'burrow' })).toBe(
      'Nobody available matching “burrow”.',
    );
  });

  /**
   * A manager is the subject of his own empty roster, which is how these read
   * without ever needing a possessive — `Chris's` against `Chris'` is an
   * argument nobody should be having with a Sleeper display name.
   */
  it('makes the manager the subject when a team is what is empty', () => {
    const rival = { ...empty, owner: { kind: 'roster' as const, rosterId: 2 }, ownerLabel: 'Rival' };
    expect(playersEmptyLine(rival)).toBe('Rival has no players.');
    expect(playersEmptyLine({ ...rival, position: 'QB' })).toBe('Rival has no QB players.');
    expect(playersEmptyLine({ ...rival, query: 'burrow', position: 'QB' })).toBe(
      'Rival has nobody matching “burrow” under QB.',
    );
  });

  /** A chip whose team has gone from the response still names a seat, not a blank. */
  it('falls back to the roster when the label has gone', () => {
    expect(playersEmptyLine({ ...empty, owner: { kind: 'roster', rosterId: 5 }, ownerLabel: null })).toBe(
      'Team 5 has no players.',
    );
  });
});
