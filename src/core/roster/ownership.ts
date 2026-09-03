/**
 * Who holds a player, as a thing a list can be narrowed by.
 *
 * The Players tab asks two questions that are really one question: *show me
 * only the players I could add*, and *show me only Joe's team*. Both are
 * answered by the same fact — which roster in this league holds this player —
 * and neither can be true at once. A player nobody rosters is not on Joe's
 * team, and a player on Joe's team is not available. So this is one filter with
 * three states rather than two filters that contradict each other:
 *
 *   anyone · available · a named roster
 *
 * The screen draws it as one exclusive picker for exactly that reason (see
 * `web/playerFilters.ts`), and the wire carries one parameter. Two controls
 * whose only interesting combination can only ever return nothing would have
 * needed a disabled state, a rule about which one wins, and a reader working
 * out why the list went empty; one choice makes the contradiction
 * unrepresentable instead of handling it.
 *
 * It lives in core, not in the API handler, because Demo Mode answers
 * `/api/players` itself. A filter implemented twice is a filter that means two
 * things by the third change to it — the same argument that put the position
 * filter in `sleeper/eligibility.ts`.
 *
 * **Ownership is a fact about a league, never about a player.** Nothing here
 * can be evaluated without the rosters, and there is deliberately no fallback
 * for the case where they are missing: a caller that does not name a league has
 * no answer to give, and inventing "available" for everybody would be the app
 * claiming something it does not know.
 */

/** The three states, and the only three. */
export type OwnerFilter =
  | { kind: 'anyone' }
  | { kind: 'available' }
  | { kind: 'roster'; rosterId: number };

/** The unfiltered list, which is what every screen opens on. */
export const ANY_OWNER: OwnerFilter = { kind: 'anyone' };

/** The wire word for "unrostered". A roster is named by its own id. */
export const AVAILABLE_OWNER = 'available';

/**
 * The word a *control* uses for the unfiltered state.
 *
 * Never sent: `anyone` on the wire is the absent parameter, which is what
 * `ownerFilterParam` returns for it. It exists because the control's options
 * need ids and an empty string is a poor one — a React key, a `data-state`
 * attribute and the comparison that marks the chosen row all read better with a
 * word in them. Parsed back to the same state either way, so a client that does
 * send it is not wrong.
 */
export const ANYONE_OWNER = 'anyone';

/**
 * One roster, as a filter chip needs it.
 *
 * `ownerName` is null wherever Sleeper has not named the seat, and it stays
 * null — the label a screen prints for a nameless seat is the screen's
 * decision, and a stand-in invented here would travel everywhere.
 */
export interface OwnerTeam {
  rosterId: number;
  ownerName: string | null;
  isMine: boolean;
}

/** What this module needs off a roster row, and nothing else. */
interface RosterHolding {
  rosterId: number;
  ownerName: string | null;
  playerIds: string[];
  isMine: boolean;
}

/**
 * Read the `owner` query parameter.
 *
 * Anything unrecognised — an empty string, a word from a future version, a
 * roster id that is not a number — reads as `anyone`. A filter nobody can name
 * should show the whole list rather than an empty one, because a client that
 * asked wrongly is still a client whose reader wants to see players.
 */
export function parseOwnerFilter(raw: string | null | undefined): OwnerFilter {
  const value = (raw ?? '').trim();
  if (value === '' || value === ANYONE_OWNER) return ANY_OWNER;
  if (value === AVAILABLE_OWNER) return { kind: 'available' };
  const rosterId = Number(value);
  if (!Number.isInteger(rosterId)) return ANY_OWNER;
  return { kind: 'roster', rosterId };
}

/** The same value on the way out. `anyone` is the absent parameter. */
export function ownerFilterParam(filter: OwnerFilter): string {
  if (filter.kind === 'anyone') return '';
  if (filter.kind === 'available') return AVAILABLE_OWNER;
  return String(filter.rosterId);
}

/** Whether the rosters have to be read before this filter can be applied. */
export function narrowsByOwner(filter: OwnerFilter): boolean {
  return filter.kind !== 'anyone';
}

/**
 * Player id to the roster holding him.
 *
 * A player absent from the map is unrostered *in this league*, which is what
 * "available" means here: a free agent, or somebody on waivers, both of which
 * are an add rather than a trade. Sleeper's roster rows are the whole answer —
 * it publishes no separate free-agent pool, and one derived from the player
 * table minus the rosters is the same set by a longer route.
 */
export function rosterOwnership(rosters: readonly RosterHolding[]): Map<string, number> {
  const owned = new Map<string, number>();
  for (const roster of rosters) {
    for (const id of roster.playerIds) owned.set(id, roster.rosterId);
  }
  return owned;
}

/** Does this player survive the filter? */
export function matchesOwner(playerId: string, filter: OwnerFilter, owned: Map<string, number>): boolean {
  if (filter.kind === 'anyone') return true;
  const holder = owned.get(playerId);
  if (filter.kind === 'available') return holder === undefined;
  return holder === filter.rosterId;
}

/**
 * The teams a list may be narrowed to, in the league's own roster order.
 *
 * Roster order rather than anything cleverer: it is the order every other
 * screen in the app lists a room in, and a filter row that reorders the league
 * on its own authority is a row the reader has to re-read every visit.
 */
export function ownerTeams(rosters: readonly RosterHolding[]): OwnerTeam[] {
  return [...rosters]
    .sort((a, b) => a.rosterId - b.rosterId)
    .map((r) => ({ rosterId: r.rosterId, ownerName: r.ownerName, isMine: r.isMine }));
}
