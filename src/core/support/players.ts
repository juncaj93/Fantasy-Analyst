/**
 * A canonical player, reduced to what a decision actually reads, and back.
 *
 * Seven fields out of fifteen. The rest — aliases, external ids, height, weight,
 * age, experience — are read by the player profile and by the identity ladder,
 * and neither of those is on the path from a request to a recommendation on any
 * of the six surfaces.
 *
 * Shared rather than copied because two lanes need it for different reasons and
 * a second reduction would be a second chance to disagree about what a player
 * is: the Draft board scores from the Sleeper dictionary, and the waiver
 * competition read resolves every rival's roster to positions and availability.
 *
 * The absent fields are filled with the honest empty value rather than a
 * plausible one, so a component that started reading `age` tomorrow would replay
 * as "Sleeper did not say" instead of as a made-up number — and the comparison
 * would fail loudly rather than quietly agreeing with itself.
 *
 * `normalizedName` is derived with the app's own normaliser rather than stored,
 * because it is a pure function of the name and storing it would be a second
 * copy that could disagree with the first.
 */

import { normalizeName } from '../identity/normalize.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { SnapshotPlayer } from './schema.ts';

export function capturePlayer(player: CanonicalPlayer): SnapshotPlayer {
  return {
    id: player.id,
    name: player.fullName,
    position: player.position,
    team: player.team,
    active: player.active,
    status: player.status,
    searchRank: player.searchRank ?? null,
  };
}

export function rehydratePlayer(player: SnapshotPlayer): CanonicalPlayer {
  const [firstName = '', ...rest] = player.name.split(' ');
  return {
    id: player.id,
    sleeperPlayerId: player.id,
    fullName: player.name,
    firstName,
    lastName: rest.join(' '),
    team: player.team,
    position: player.position,
    status: player.status,
    active: player.active,
    normalizedName: normalizeName(player.name),
    aliases: [],
    searchRank: player.searchRank,
    jerseyNumber: null,
    heightInches: null,
    weightPounds: null,
    age: null,
    yearsExp: null,
  };
}
