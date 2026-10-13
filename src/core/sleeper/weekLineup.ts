/**
 * Each team's lineup for the current week, the way Sleeper's own app shows it.
 *
 * Sleeper answers the question in two places. `/league/:id/matchups/:week` holds
 * the lineup a manager set for that week; `/league/:id/rosters` holds a single
 * `starters` list that can lag a week behind it. On Tuesday 13 October 2026,
 * after Monday night's game, Sleeper's state already read week 6 and Alex's app
 * showed his Week 6 lineup (Burrow, Bijan at RB, Egbuka...), while this app's
 * Team page, built only from `/rosters`, still showed Week 5's slots (Will
 * Shipley, Tre' Harris at FLEX, the Vikings) through any number of refreshes.
 *
 * The Matchup screen already had the rule (`startersFor` in
 * `core/matchup/build.ts`): the matchup row is the authority when it has a
 * lineup, and `/rosters` fills in when Sleeper returns `starters: null` on the
 * row, which it does for a team that has not touched its lineup since the week
 * rolled over (measured 16 September 2026). This applies the same rule once, at
 * the point the rosters are stored, so Team, Start/Sit, Compare and Matchup all
 * read one lineup.
 */

import type { SleeperMatchup, SleeperRoster } from './types.ts';

/** True when a lineup has at least one real player in it (`"0"` is an empty slot). */
function hasLineup(starters: readonly (string | null)[] | null | undefined): starters is string[] {
  return (starters ?? []).some((id) => id != null && id !== '' && id !== '0');
}

/**
 * The rosters with each `starters` replaced by that roster's lineup for the week,
 * where the week's matchup row carries one. Everything else is left as Sleeper
 * sent it, and a roster with no matchup row (a bye week, or no matchups yet)
 * keeps its own `starters`.
 */
export function withWeekLineup(rosters: readonly SleeperRoster[], matchups: readonly SleeperMatchup[] | null | undefined): SleeperRoster[] {
  const byRoster = new Map((matchups ?? []).map((m) => [m.roster_id, m]));
  return rosters.map((roster) => {
    const row = byRoster.get(roster.roster_id);
    if (!row || !hasLineup(row.starters)) return roster;
    return { ...roster, starters: [...row.starters] };
  });
}
