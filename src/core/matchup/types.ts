/**
 * The vocabulary the whole Matchup feature is written in.
 *
 * Three separations are enforced by these types rather than by convention, and
 * every one of them is a mistake this feature would otherwise make:
 *
 *  1. **`actual` is Sleeper's and nothing else's.** It is the league's own
 *     settled score, computed by Sleeper under the league's own scoring, and no
 *     module below is allowed to write it. `projection` sits in a different
 *     field with a different name because it is a different kind of statement,
 *     and the one failure this feature must never have is a projected number
 *     rendered where a real one belongs.
 *  2. **A projection is Fantasy Analyst's, or it is absent.** Sleeper publishes
 *     its own projection on the same payload (`custom_points`), and it is never
 *     read. A player the start/sit engine could not score arrives with
 *     `projection: null`, which the model treats as unknown rather than zero.
 *  3. **Game state is a fact about a clock, not about a player.** Whether an
 *     outcome is still uncertain is decided once, from kickoff and now, and
 *     every downstream module reads that decision rather than re-deriving it —
 *     because a player who is simulated on one screen and locked on another is
 *     two different win probabilities.
 */

import type { AvailabilityConfidence } from '../startsit/availabilityConfidence.ts';

/**
 * The version of the whole forecast — distributions, correlation, simulation,
 * insight ranking.
 *
 * Recorded on every stored forecast so a calibration bucket can never mix two
 * models, and bumped whenever a change would move a win probability for an
 * unchanged matchup state. This is the number a 2027 comparison is made
 * against; without it, "our 70% happened 61% of the time" is a sentence about
 * no particular model.
 */
export const MATCHUP_MODEL_VERSION = 'matchup-1.0.0';

/** Where a player's game is, in the only three states that change the maths. */
export type GamePhase = 'not_started' | 'live' | 'final';

/**
 * Which side of the matchup a player is on.
 *
 * `mine` is the roster marked as the user's in Sleeper. There is no third
 * value: a matchup has two sides, and a player who belongs to neither is not in
 * this feature's input at all.
 */
export type MatchupSide = 'mine' | 'theirs';

/**
 * One player, as the model needs him.
 *
 * Deliberately flat and free of the start/sit evaluation it was built from: the
 * simulator must be testable from a fixture somebody can read, and an input
 * that required a full `StartSitEvaluation` would be testable only by building
 * one.
 */
export interface MatchupPlayerInput {
  playerId: string;
  name: string;
  position: string;
  /** The NFL club, canonical Sleeper abbreviation. `''` for a free agent. */
  team: string;
  /** The club he faces this week, when the schedule is known. */
  opponent: string | null;
  /** The lineup slot he fills, or null when he is on the bench. */
  slot: string | null;
  /** True when Sleeper has him in a starting slot right now. */
  starting: boolean;
  side: MatchupSide;
  /**
   * Fantasy Analyst's own full-game projection, in this league's scoring, for
   * the case where he plays his ordinary role.
   *
   * **Availability is deliberately not in this number.** The start/sit score it
   * comes from carries an availability penalty as a component, and this model
   * carries availability as a mixture over playing, playing limited and not
   * playing (§8). Leaving the penalty in would charge the same Questionable
   * twice — once as points off the mean and again as an inactive branch — which
   * is precisely the double-counting §3 forbids. The service strips the
   * component; see `matchupService`.
   *
   * Null when the engine could not score him, which is a real state in
   * September and is never substituted with Sleeper's projection or a zero.
   */
  projection: number | null;
  /** Sleeper's settled points for him so far. Never written by this app. */
  actual: number;
  /** ISO kickoff for his game, when the schedule is known. */
  kickoff: string | null;
  /**
   * What kind of player the usage says he is, from the existing role
   * classifier. Drives volatility, because a downfield receiver's week has a
   * genuinely wider distribution than a checkdown back's.
   */
  roleBucket: string;
  /** The existing availability read, which is what the injury mixture keys on. */
  availability: AvailabilityConfidence;
  /** True when he is Out, IR, PUP or suspended — a fact, not a risk. */
  ruledOut: boolean;
}

/**
 * How much of the truth behind a forecast is actually known.
 *
 * Carried rather than computed at the edge because a confidence line that
 * disagrees with the model that produced it is worse than no line at all.
 */
export interface SourceFreshness {
  /** Starters whose availability is genuinely unresolved. */
  unresolvedAvailability: number;
  /** Starters with no Fantasy Analyst projection at all. */
  missingProjection: number;
  /** Starters whose game could not be placed on a clock. */
  unknownKickoff: number;
  /** How much weight to put on the answer. */
  level: 'high' | 'medium' | 'low';
  /** The one clause a card prints, or null when nothing is materially weak. */
  detail: string | null;
}
