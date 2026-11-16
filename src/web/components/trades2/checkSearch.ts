/**
 * Check a trade by typed names (Round 32, audit finding 10).
 *
 * Checking an offer Alex received took 10 to 11 taps: pick the team, then add
 * each player on both sides through a list. Sleeper's documented API does not
 * show pending offers, so the names are still typed; what changes is that one
 * field takes them for both sides:
 *
 *  - a player on Alex's roster goes to "You give";
 *  - anyone else's player goes to "You get", and his manager becomes the
 *    trade partner, so there is no team to pick first;
 *  - a player from a different manager than the one already chosen starts a
 *    new "You get" with that manager, as changing the team picker always has.
 *
 * Matching is the app's one player search (`core/search/players.ts`), so a
 * typo, an apostrophe or a missing hyphen finds the player here as it does on
 * Players. Nothing here judges the trade: the verdict is the same request and
 * the same shared function Check has always used.
 */

import { rankByQuery } from '../../search.ts';
import type { ScreensTeams } from '../../../core/trades/screensWire.ts';

/** At most this many players per side, as the picker has always allowed. */
export const CHECK_MAX_SIDE = 3;

/** Results shown under the field: enough for a common first name, short enough for a phone. */
export const CHECK_MAX_RESULTS = 6;

export interface CheckState {
  partnerId: number | null;
  give: string[];
  get: string[];
}

export interface CheckCandidate {
  playerId: string;
  name: string;
  position: string;
  team: string;
  rosterId: number;
  mine: boolean;
  /** The manager's label. */
  owner: string;
}

/** Every rostered player in the league, each with his manager. */
export function checkPool(teams: ScreensTeams | null | undefined): CheckCandidate[] {
  return (teams?.teams ?? []).flatMap((t) =>
    t.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      rosterId: t.rosterId,
      mine: t.isMine,
      owner: t.label,
    })),
  );
}

/**
 * The players a typed name finds, best match first. Two characters before
 * anything is listed; players already in the trade are left out, and so is
 * a side that is already full.
 */
export function checkMatches(pool: readonly CheckCandidate[], text: string, state: CheckState): CheckCandidate[] {
  if (text.trim().length < 2) return [];
  const taken = new Set([...state.give, ...state.get]);
  const giveFull = state.give.length >= CHECK_MAX_SIDE;
  const getFull = state.get.length >= CHECK_MAX_SIDE;
  const open = pool.filter((p) => {
    if (taken.has(p.playerId)) return false;
    if (p.mine) return !giveFull;
    /* A player from another manager starts a new "You get", so it is never full for him. */
    return !(getFull && p.rosterId === state.partnerId);
  });
  return rankByQuery(open, text, (p) => p.name).slice(0, CHECK_MAX_RESULTS);
}

/** The trade after tapping one result. */
export function addToCheck(state: CheckState, pick: CheckCandidate): CheckState {
  if (pick.mine) {
    if (state.give.includes(pick.playerId) || state.give.length >= CHECK_MAX_SIDE) return state;
    return { ...state, give: [...state.give, pick.playerId] };
  }
  if (state.partnerId !== pick.rosterId) return { ...state, partnerId: pick.rosterId, get: [pick.playerId] };
  if (state.get.includes(pick.playerId) || state.get.length >= CHECK_MAX_SIDE) return state;
  return { ...state, get: [...state.get, pick.playerId] };
}

/** An offer card's trade, as Check's starting state: both sides filled, the partner chosen. */
export function checkFromOffer(offer: {
  partner: { rosterId: number };
  give: readonly { playerId: string }[];
  get: readonly { playerId: string }[];
}): CheckState {
  return {
    partnerId: offer.partner.rosterId,
    give: offer.give.map((p) => p.playerId).slice(0, CHECK_MAX_SIDE),
    get: offer.get.map((p) => p.playerId).slice(0, CHECK_MAX_SIDE),
  };
}
