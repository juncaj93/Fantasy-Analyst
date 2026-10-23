/**
 * What version of the matchup reasoning produced a forecast.
 *
 * Composed on the start/sit engine, because every projection in a matchup is
 * one: `build.ts` asks `evaluatePlayer` for each starter and turns the result
 * into a distribution. A weight change under `core/startsit/` moves the
 * projected final and the win probability with it.
 *
 * Bump the head — `matchup@N` — when a change to `core/matchup/` could move a
 * projected final, a win probability, a Best Move or an insight card for
 * unchanged evaluations: the distribution shape, the correlation model, the
 * simulation count, the swap search, the insight thresholds.
 *
 * Not for a comment, a rename or a new diagnostic field. See
 * `core/draft/version.ts` for the full argument.
 */

import { composeEngineVersion } from '../engineVersion.ts';
import { STARTSIT_ENGINE_VERSION } from '../startsit/version.ts';

/**
 * `matchup@3`, 23 October 2026: availability is Team's rule
 * (`core/injury/weekAvailability.ts`). No play-chance mix: a Questionable
 * player is simulated at full value, a Doubtful one six points down, and the
 * "genuine question" alert is gone with the mix it priced.
 */
export const MATCHUP_ENGINE_VERSION = composeEngineVersion('matchup@3', STARTSIT_ENGINE_VERSION);
