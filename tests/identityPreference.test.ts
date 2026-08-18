/**
 * The stable identifier is consulted before the name.
 *
 * The case this is about is not a tie-break. It is a player the two sources
 * spell differently — "Cam Ward" in Sleeper, "Cameron Ward" in the published
 * file — where the name lookup returns *nothing*, so under the old ordering the
 * GSIS id sitting in the same row was never read and the row silently vanished.
 * A missing injury and a missing week of usage, indistinguishable in the counts
 * from a source that simply did not mention him.
 *
 * The negative cases matter as much: an identifier two players claim must
 * settle nothing, and an identifier that is present but wrong must never be
 * allowed to attach evidence to the wrong person.
 */

import { describe, expect, it } from 'vitest';
import { buildIdentityIndex, resolveToCanonical } from '../src/server/services/injuryService.ts';
import { normalizeName } from '../src/core/identity/normalize.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';

function player(over: Partial<CanonicalPlayer> & Pick<CanonicalPlayer, 'id' | 'fullName'>): CanonicalPlayer {
  return {
    sleeperPlayerId: over.id,
    firstName: over.fullName.split(' ')[0] ?? '',
    lastName: over.fullName.split(' ').slice(1).join(' '),
    team: 'TEN',
    position: 'QB',
    status: null,
    active: true,
    normalizedName: normalizeName(over.fullName),
    aliases: [],
    externalIds: {},
    ...over,
  } as CanonicalPlayer;
}

describe('the identifier is tried first', () => {
  it('finds a player the two sources spell differently', () => {
    /*
     * The whole point. Sleeper calls him Cam; the file calls him Cameron. Four
     * inserted characters is past any sane fuzzy threshold, the name lookup
     * returns nothing, and before this the row was dropped without a word.
     */
    const cam = player({ id: 'P1', fullName: 'Cam Ward', externalIds: { gsis: '00-0039163' } });
    const index = buildIdentityIndex([], [cam]);

    const match = resolveToCanonical({ fullName: 'Cameron Ward', gsisId: '00-0039163' }, index);
    expect(match).toEqual({ playerId: 'P1', by: 'id' });
  });

  it('finds a player whose suffix one source keeps and the other drops', () => {
    const marvin = player({ id: 'P2', fullName: 'Marvin Harrison Jr.', externalIds: { gsis: '00-0039910' } });
    const index = buildIdentityIndex([], [marvin]);
    expect(resolveToCanonical({ fullName: 'Marvin Harrison III', gsisId: '00-0039910' }, index)?.playerId).toBe('P2');
  });

  it('prefers the identifier even when the name would also have matched', () => {
    // Same answer either way here, but the *route* is reported, and the counts
    // in Setup are how the health of the mapping is judged.
    const p = player({ id: 'P3', fullName: 'Kai Brennan', externalIds: { gsis: '00-0011111' } });
    const index = buildIdentityIndex([p], [p]);
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: '00-0011111' }, index)).toEqual({
      playerId: 'P3',
      by: 'id',
    });
  });
});

describe('the name is still there as a fallback', () => {
  it('resolves on the name when the row carries no identifier', () => {
    const p = player({ id: 'P4', fullName: 'Kai Brennan' });
    const index = buildIdentityIndex([p], []);
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: null }, index)).toEqual({
      playerId: 'P4',
      by: 'name',
    });
  });

  it('resolves on the name when the identifier is one this app has never seen', () => {
    // A new player the dictionary has not caught up with, or a source that
    // emits an id from a namespace we do not index. Falling through to the
    // name is right; refusing outright would be worse than the old behaviour.
    const p = player({ id: 'P5', fullName: 'Kai Brennan' });
    const index = buildIdentityIndex([p], []);
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: '00-0099999' }, index)?.playerId).toBe('P5');
  });

  it('uses the identifier to break a tie between two players sharing a name', () => {
    const a = player({ id: 'A', fullName: 'Josh Allen', position: 'QB', externalIds: { gsis: '00-0034857' } });
    const b = player({ id: 'B', fullName: 'Josh Allen', position: 'LB', externalIds: { gsis: '00-0035263' } });
    const index = buildIdentityIndex([a, b], [a, b]);
    expect(resolveToCanonical({ fullName: 'Josh Allen', gsisId: '00-0035263' }, index)).toEqual({
      playerId: 'B',
      by: 'id',
    });
  });

  it('declines two players sharing a name with nothing to tell them apart', () => {
    const a = player({ id: 'A', fullName: 'Josh Allen', position: 'QB' });
    const b = player({ id: 'B', fullName: 'Josh Allen', position: 'LB' });
    const index = buildIdentityIndex([a, b], []);
    // An injury attached to the wrong player is worse than one attached to
    // nobody, and declining is counted rather than swallowed.
    expect(resolveToCanonical({ fullName: 'Josh Allen', gsisId: null }, index)).toBeNull();
  });

  it('declines a name it has never seen and an identifier it has never seen', () => {
    expect(resolveToCanonical({ fullName: 'Nobody At All', gsisId: '00-0000000' }, buildIdentityIndex([], []))).toBeNull();
  });
});

describe('an identifier that settles nothing settles nothing', () => {
  it('falls through to the name when two players claim the same id', () => {
    /*
     * A data fault, not a disambiguation problem. The identifier is supposed to
     * be the thing that resolves questions, so an ambiguous one has to abstain
     * rather than pick — otherwise the map's insertion order decides who gets
     * somebody else's injury.
     */
    const a = player({ id: 'A', fullName: 'Kai Brennan', externalIds: { gsis: '00-0011111' } });
    const b = player({ id: 'B', fullName: 'Silas Mbeki', externalIds: { gsis: '00-0011111' } });
    const index = buildIdentityIndex([a, b], [a, b]);

    const match = resolveToCanonical({ fullName: 'Silas Mbeki', gsisId: '00-0011111' }, index);
    expect(match).toEqual({ playerId: 'B', by: 'name' });
  });

  it('ignores blank and whitespace identifiers rather than matching on them', () => {
    const p = player({ id: 'P6', fullName: 'Kai Brennan' });
    const index = buildIdentityIndex([p], []);
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: '   ' }, index)?.by).toBe('name');
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: '' }, index)?.by).toBe('name');
  });

  it('does not index a player whose external ids carry no GSIS entry', () => {
    const p = player({ id: 'P7', fullName: 'Kai Brennan', externalIds: { espn: '4242' } });
    const index = buildIdentityIndex([], [p]);
    expect(index.byGsis?.size).toBe(0);
  });
});

describe('an index built without identifiers still works', () => {
  it('behaves exactly as the name-only ladder always did', () => {
    // The optional second argument matters: callers and tests that only have
    // names must keep working rather than fail to compile or silently decline.
    const p = player({ id: 'P8', fullName: 'Kai Brennan', externalIds: { gsis: '00-0011111' } });
    const index = buildIdentityIndex([p]);
    expect(resolveToCanonical({ fullName: 'Kai Brennan', gsisId: '00-0011111' }, index)).toEqual({
      playerId: 'P8',
      by: 'id',
    });
  });
});
