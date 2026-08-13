/** Canonical player fixtures shared across tests. */

import { PlayerIndex } from '../../src/core/identity/index.ts';
import { normalizeName } from '../../src/core/identity/normalize.ts';
import type { CanonicalPlayer } from '../../src/core/identity/types.ts';

export function player(partial: Partial<CanonicalPlayer> & { id: string; fullName: string }): CanonicalPlayer {
  const [first = '', ...rest] = partial.fullName.split(' ');
  return {
    sleeperPlayerId: partial.id,
    firstName: first,
    lastName: rest.join(' '),
    team: '',
    position: 'WR',
    status: null,
    active: true,
    normalizedName: normalizeName(partial.fullName),
    aliases: [],
    externalIds: {},
    ...partial,
  } as CanonicalPlayer;
}

/**
 * Fixture roster covering the hard identity cases:
 *  - two active players named "Chris Johnson" (name collision)
 *  - a suffix name, an apostrophe name, an accented name, a hyphenated name
 *  - an inactive player sharing a surname with an active one
 */
export const TEST_PLAYERS: CanonicalPlayer[] = [
  player({ id: '1', fullName: 'Chris Johnson', team: 'KC', position: 'RB' }),
  player({ id: '2', fullName: 'Chris Johnson', team: 'BUF', position: 'WR' }),
  player({ id: '3', fullName: "D'Andre Swift", team: 'CHI', position: 'RB' }),
  player({ id: '4', fullName: 'Marvin Harrison Jr.', team: 'ARI', position: 'WR' }),
  player({ id: '5', fullName: 'Amon-Ra St. Brown', team: 'DET', position: 'WR' }),
  player({ id: '6', fullName: 'José Ramírez', team: 'MIA', position: 'TE' }),
  player({ id: '7', fullName: 'Tyler Boyd', team: 'TEN', position: 'WR' }),
  player({ id: '8', fullName: 'Old Boyd', team: 'FA', position: 'WR', active: false }),
  player({ id: '9', fullName: 'Jordan Love', team: 'GB', position: 'QB' }),
  player({ id: '10', fullName: 'Bijan Robinson', team: 'ATL', position: 'RB', aliases: ['B. Rob'] }),
  player({ id: '11', fullName: 'Puka Nacua', team: 'LAR', position: 'WR' }),
];

export const TEST_INDEX = new PlayerIndex(TEST_PLAYERS);
