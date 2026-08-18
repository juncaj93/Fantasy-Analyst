/**
 * `1.04`, `#8`, and `Drafted 1.02 by Joe`.
 *
 * Three ways of saying where a player came from, one rule for each, and one
 * shared conversion — because the failure this replaces was a Team row printing
 * `#40`, which is a pick number formatted as a jersey number and is therefore
 * wrong twice over.
 */

import { describe, expect, it } from 'vitest';
import {
  draftPickLabel,
  draftProvenanceLine,
  jerseyLabel,
  rosterRowLabel,
} from '../src/core/draft/provenance.ts';
import { pickLabel } from '../src/core/draft/boardGrid.ts';

describe('a pick is said the way the room said it', () => {
  it('turns an overall pick into round.pick', () => {
    expect(draftPickLabel(1, 12)).toBe('1.01');
    expect(draftPickLabel(4, 12)).toBe('1.04');
    expect(draftPickLabel(13, 12)).toBe('2.01');
    expect(draftPickLabel(40, 12)).toBe('4.04');
  });

  it('pads the pick within a round so the column lines up', () => {
    expect(draftPickLabel(2, 12)).toBe('1.02');
    expect(draftPickLabel(12, 12)).toBe('1.12');
  });

  it('follows the league’s own round length', () => {
    // The same overall pick is a different round in a ten-team league.
    expect(draftPickLabel(13, 10)).toBe('2.03');
    expect(draftPickLabel(13, 12)).toBe('2.01');
  });

  it('is the same conversion the draft board grid uses', () => {
    // Two implementations of "which round is pick 40" is two chances to be off
    // by one, so there is only one.
    for (const pick of [1, 7, 12, 13, 25, 96, 180]) {
      expect(draftPickLabel(pick, 12)).toBe(pickLabel(pick, 12));
    }
  });

  it('has nothing to say about a player who was not drafted', () => {
    expect(draftPickLabel(null, 12)).toBeNull();
    expect(draftPickLabel(0, 12)).toBeNull();
    expect(draftPickLabel(undefined, 12)).toBeNull();
  });
});

describe('a jersey number is a jersey number', () => {
  it('prints it with a hash', () => {
    expect(jerseyLabel(8)).toBe('#8');
    expect(jerseyLabel(97)).toBe('#97');
  });

  /** `#0` is a number real players wear; it must not read as "unknown". */
  it('keeps zero', () => {
    expect(jerseyLabel(0)).toBe('#0');
  });

  it('shows nothing rather than inventing one', () => {
    expect(jerseyLabel(null)).toBeNull();
    expect(jerseyLabel(undefined)).toBeNull();
  });
});

describe('the same row means two things at two times', () => {
  const teams = 12;

  it('shows the pick while the draft is running', () => {
    expect(rosterRowLabel({ drafting: true, pickNo: 4, jerseyNumber: 8, teams })).toBe('1.04');
  });

  it('shows the shirt number once it is over', () => {
    expect(rosterRowLabel({ drafting: false, pickNo: 4, jerseyNumber: 8, teams })).toBe('#8');
  });

  it('falls back the other way when the preferred fact is missing', () => {
    // A keeper mid-draft: no pick, but a number.
    expect(rosterRowLabel({ drafting: true, pickNo: null, jerseyNumber: 8, teams })).toBe('#8');
    // A drafted player whose number this app does not know, in season.
    expect(rosterRowLabel({ drafting: false, pickNo: 4, jerseyNumber: null, teams })).toBe('1.04');
  });

  it('says "held" rather than nothing for a mid-draft player with neither', () => {
    expect(rosterRowLabel({ drafting: true, pickNo: null, jerseyNumber: null, teams })).toBe('held');
  });

  it('never prints an overall pick number', () => {
    // The defect this replaces: `#40` for pick 40.
    const label = rosterRowLabel({ drafting: true, pickNo: 40, jerseyNumber: null, teams });
    expect(label).toBe('4.04');
    expect(label).not.toBe('#40');
  });
});

describe('the provenance line names the pick, and the manager only when known', () => {
  it('says the whole thing when everything is known', () => {
    expect(draftProvenanceLine({ pickNo: 14, teams: 12, managerName: 'Joe', season: '2026' })).toBe(
      'Drafted 2.02 by Joe · 2026',
    );
  });

  it('matches the brief’s own example', () => {
    expect(draftProvenanceLine({ pickNo: 2, teams: 12, managerName: 'Joe' })).toBe('Drafted 1.02 by Joe');
  });

  /**
   * A pick with no named seat still says which pick — most of the value — and
   * does not guess at a person. Attributing a pick to somebody is the worst
   * thing on this card to get wrong.
   */
  it('degrades to the pick alone when Sleeper never named the seat', () => {
    expect(draftProvenanceLine({ pickNo: 2, teams: 12, managerName: null })).toBe('Drafted 1.02');
    expect(draftProvenanceLine({ pickNo: 2, teams: 12, managerName: '   ' })).toBe('Drafted 1.02');
  });

  it('says nothing at all about a player nobody drafted', () => {
    expect(draftProvenanceLine({ pickNo: null, teams: 12, managerName: 'Joe' })).toBeNull();
  });
});
