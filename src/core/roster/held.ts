/**
 * Turn a roster and a free-agent pool into bench slots to be valued.
 *
 * The mapping that makes the bench view possible: a bench player's slot value
 * needs what the wire offers *at his position*, which is a fact about the pool
 * rather than about him. Computed once here and handed to the pure valuation
 * module, which then never has to know a free agent exists.
 *
 * Shared rather than private to the API handler, so Demo Mode values a bench
 * through exactly the arithmetic the live screen uses.
 */

import { evaluatePlayer, type StartSitInput } from '../startsit/engine.ts';
import type { LineupRecommendation } from '../startsit/lineup.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { HeldPlayer } from './bench.ts';

export function buildHeldPlayers(opts: {
  rosterInputs: StartSitInput[];
  candidateInputs: StartSitInput[];
  lineup: LineupRecommendation;
  profile: ScoringProfile;
  reserveIds: string[];
}): HeldPlayer[] {
  const starters = new Set(opts.lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const reserve = new Set(opts.reserveIds);

  /* The best freely available score at each position — the replacement level. */
  const bestFree = new Map<string, number>();
  for (const candidate of opts.candidateInputs) {
    const evaluation = evaluatePlayer(candidate, opts.profile);
    if (evaluation.score == null || evaluation.ruledOut) continue;
    const current = bestFree.get(evaluation.position) ?? 0;
    if (evaluation.score > current) bestFree.set(evaluation.position, evaluation.score);
  }

  return opts.rosterInputs.map((input) => {
    const evaluation = evaluatePlayer(input, opts.profile);
    const rising = evaluation.role.trend === 'rising_high' || evaluation.role.trend === 'rising_moderate';
    return {
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      role: reserve.has(evaluation.playerId) ? 'reserve' : starters.has(evaluation.playerId) ? 'starter' : 'bench',
      restOfSeasonValue: evaluation.score,
      fourWeekValue: evaluation.score,
      /*
       * Insurance is left unmeasured rather than guessed.
       *
       * Knowing that a back handcuffs a specific starter needs a depth chart
       * this app does not hold; inventing one would put a confident number
       * under the single most consequential term in the slot valuation. Zero
       * here means "no insurance credit claimed", and the module's own comment
       * explains why an unclaimed credit is safer than an invented one.
       */
      insuranceValue: 0,
      upside: rising ? 'high' : evaluation.role.games >= 6 ? 'none' : 'unknown',
      coversBye: false,
      streamingReplacement: bestFree.get(evaluation.position) ?? null,
    } satisfies HeldPlayer;
  });
}
