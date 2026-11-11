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
 * player is simulated at full value, a Doubtful one six points down (zero since
 * `matchup@5`), and the
 * "genuine question" alert is gone with the mix it priced.
 */
/**
 * `matchup@4`, 23 October 2026: every player is simulated on Team's decision
 * number (`decisionPoints`: the market or Sleeper's week plus the Opponent and
 * Recent news nudges), and the card prints that number, not the bare market.
 */
/**
 * `matchup@5`, 5 November 2026: the win-chance swap search is gone (its own
 * 2% bar and favorite/underdog reasoning, never drawn on a screen). The model
 * only names who takes a real hole, by Team's ranking rule (`decision.ts`).
 * A Doubtful player is simulated at zero, as Out.
 */
/**
 * `matchup@6`, 8 November 2026 (round 13): a hole is filled the way Team
 * fills it, with the other starters moving between slots that take them, so
 * Live insights names the same player Best move does.
 */
/**
 * `matchup@7`, 11 November 2026 (round 17): a hole is filled on the ranking
 * numbers with the Sleeper-only discount at one point, not two.
 */
export const MATCHUP_ENGINE_VERSION = composeEngineVersion('matchup@7', STARTSIT_ENGINE_VERSION);
