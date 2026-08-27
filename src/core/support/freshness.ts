/**
 * How old, how thin and how borrowed the state behind a decision was.
 *
 * Its own module because it is the same eight questions for all five in-season
 * lanes, and because the answer has to be *derived from the inputs the replay
 * compares* rather than measured separately. A freshness block assembled from a
 * second reading of the database would be a claim about the app rather than
 * about the decision, and the first time the two disagreed the file would be
 * lying in the section a reader consults to decide whether to trust it.
 *
 * ## Unknown is never zero
 *
 * The rule this module exists to keep. A player with no betting market is
 * counted under `withoutProps`, not folded into a mean of zero. A player whose
 * availability nobody has published is `unknown`, not `healthy`. A slate that
 * has not been ingested leaves `withoutGame` at the roster's size rather than
 * putting everybody in a game with no line. Each of those is the difference
 * between "the engine is wrong" and "the engine was right about what it was
 * given", which is the first fork of every diagnosis.
 */

import { normalizeDesignation } from '../injury/model.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { NflState } from '../sleeper/phase.ts';
import type { InSeasonFreshness } from './payloads.ts';

export interface FreshnessSources {
  /**
   * Every set of inputs the decision read, so nothing is counted twice.
   *
   * Waivers hands two — the roster and the wire — because a board built on a
   * priced roster and an unpriced wire is a specific and very common state, and
   * a single merged count would hide it. Deduplicated by player id.
   */
  inputs: readonly (readonly StartSitInput[])[];
  props: { fetchedAt: string | null; provider: string | null; events: number };
  nflState: NflState | null;
  unknownPlayers: number;
}

export function summariseFreshness(sources: FreshnessSources): InSeasonFreshness {
  const seen = new Set<string>();
  let withProps = 0;
  let withoutProps = 0;
  let stale = 0;
  let withoutGame = 0;
  let known = 0;
  let unknown = 0;
  let conflicting = 0;
  const byFreshness: Record<string, number> = {};

  for (const bundle of sources.inputs) {
    for (const input of bundle) {
      const id = input.player.id;
      if (seen.has(id)) continue;
      seen.add(id);

      if ((input.props?.length ?? 0) > 0) withProps += 1;
      else withoutProps += 1;
      if (input.propsStale === true) stale += 1;
      if (input.game == null) withoutGame += 1;

      /*
       * Availability, counted as three states rather than two, and read the way
       * the engine reads it.
       *
       * `unknown` is a designation the injury model produces on purpose — see
       * `injury/model.ts` — and it means nobody has published anything about
       * this player, which is different from a published clean bill of health.
       * Collapsing the two here would be the flattening this module refuses.
       *
       * The bare Sleeper status counts too, because the engine counts it: a
       * caller without the injury layer passes `injuryStatus` alone and
       * `evaluatePlayer` normalises it into the same shape. Reading only the
       * richer field would have reported a roster of Questionable players as
       * an availability nobody had measured.
       */
      const injury = input.injury ?? null;
      const designation =
        injury?.designation ?? normalizeDesignation(input.injuryStatus ?? null).designation;
      if (designation === 'unknown') unknown += 1;
      else known += 1;
      if (injury?.conflict === true) conflicting += 1;
      if (injury != null) {
        const bucket = String(injury.freshness);
        byFreshness[bucket] = (byFreshness[bucket] ?? 0) + 1;
      }
    }
  }

  return {
    props: sources.props,
    nflState:
      sources.nflState == null
        ? null
        : {
            season: sources.nflState.season ?? null,
            week: sources.nflState.week ?? null,
            seasonType: sources.nflState.seasonType ?? null,
          },
    priced: { withProps, withoutProps, stale },
    injury: { known, unknown, conflicting, byFreshness },
    withoutGame,
    unknownPlayers: sources.unknownPlayers,
  };
}

/**
 * How many of each position a set of inputs holds.
 *
 * For the one sentence at the top of a snapshot that tells a reader whether they
 * are looking at the right file — "12-team half-PPR, 2 RB, 3 WR" — and for
 * nothing else. Derived from the inputs rather than from the roster record, so
 * it counts the players the engine could actually see.
 */
export function countPositions(inputs: readonly StartSitInput[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const input of inputs) {
    const position = (input.player.position ?? 'UNKNOWN').toUpperCase();
    counts[position] = (counts[position] ?? 0) + 1;
  }
  return counts;
}
