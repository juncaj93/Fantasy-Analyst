/**
 * One string that answers "has anything actually changed?".
 *
 * It does two jobs at once, and it is one function because the two must never
 * disagree:
 *
 *  1. **It seeds the simulation.** Same state, same random numbers, same win
 *     probability — the property §5 asks for, and the reason a screen polled
 *     every thirty seconds does not flicker between 61% and 62% while nothing
 *     is happening.
 *  2. **It gates the recompute.** A poll whose fingerprint matches the last one
 *     is served from the cached forecast and costs no simulation at all. If the
 *     seed and the cache key were two different strings, a state could change
 *     the seed without invalidating the cache — and the app would serve a
 *     forecast computed for a different afternoon.
 *
 * ## What is deliberately *not* in it
 *
 * The clock, at any resolution finer than a quarter of a game. A live matchup's
 * elapsed time changes every second, and folding it in raw would mean the whole
 * model rebuilt on every request for a change of no consequence — which is
 * precisely the refresh storm §35 forbids. Points, designations and game phase
 * are the things that actually move a forecast, and all three are in here at
 * full resolution.
 *
 * Nothing about the *view* is in it either: no mode, no expanded bench, no
 * selected insight. A harmless UI change must not be able to invalidate a
 * forecast — that is §34's "no expensive full rebuild from harmless UI changes"
 * expressed as a key that cannot express the difference.
 */

import { MATCHUP_MODEL_VERSION, type MatchupPlayerInput } from './types.ts';
import type { GameClock } from './distribution.ts';

/** How finely the game clock is allowed to move the fingerprint. */
export const CLOCK_BUCKETS = 8;

export interface FingerprintInput {
  leagueId: string;
  season: string;
  week: number;
  matchupId: number | null;
  players: MatchupPlayerInput[];
  clocks: Map<string, GameClock>;
}

/**
 * The state of one matchup, as a stable string.
 *
 * Readable rather than hashed, for the same reason the season keys are: this
 * ends up in a cache and in a log, and "which of these two is stale" has to be
 * answerable by looking. It is hashed once, at the point it seeds the
 * generator, and never before.
 *
 * The season and the week are in it, which is what makes week 16 of one season
 * incapable of colliding with week 16 of another (§47).
 */
export function matchupFingerprint(input: FingerprintInput): string {
  const players = [...input.players]
    .sort((a, b) => a.playerId.localeCompare(b.playerId))
    .map((player) => {
      const clock = input.clocks.get(player.playerId);
      return [
        player.playerId,
        player.side === 'mine' ? 'm' : 't',
        player.starting ? 's' : 'b',
        player.slot ?? '-',
        // Sleeper publishes two decimal places; this is the whole of it.
        player.actual.toFixed(2),
        // A tenth of a point. A projection that drifts by less than that has
        // not changed anything a person could see, and rebuilding for it would
        // be spending a simulation on rounding.
        player.projection == null ? 'x' : player.projection.toFixed(1),
        player.availability,
        player.ruledOut ? 'out' : 'in',
        clock?.phase ?? 'unknown',
        clock ? String(Math.floor(clock.elapsed * CLOCK_BUCKETS)) : '0',
      ].join('/');
    });

  return [
    MATCHUP_MODEL_VERSION,
    input.season,
    `w${input.week}`,
    input.leagueId,
    input.matchupId == null ? 'no-matchup' : `m${input.matchupId}`,
    ...players,
  ].join('|');
}
