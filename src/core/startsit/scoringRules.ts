/**
 * What the Start/Sit score is allowed to be built from.
 *
 * Settled with Alex in October 2026: do not try to be smarter than Vegas. The
 * market's number, converted properly (see `propConversion.ts`), is about 90%
 * of the score. Role, game script, matchup and weather are already priced into
 * the lines, so adding them again as points double counts them.
 *
 * So a set of components that used to add points are now **text only**: they
 * are still computed, they still explain a player in the breakdown, and they
 * add exactly zero. Availability is not in this list and never will be. It is a
 * gate (Out, Doubtful, a bye) and sits outside every cap.
 *
 * One object, passed down rather than read from a global, so the backtest can
 * score the same week under the old rules and the new ones side by side
 * without either run seeing the other's settings.
 */

import { LINE_AS_MEDIAN, type ConversionRules } from './propConversion.ts';

export interface ScoringRules {
  conversion: ConversionRules;
  /**
   * Component keys that are computed and shown but add zero points.
   *
   * `uncertainty`, `matchup_role` and `usage_level` were kept or dropped on the
   * backtest's evidence; the rest are dropped on principle (they restate what
   * the line already prices).
   */
  textOnly: readonly string[];
  /**
   * Scale a prop taken before the latest game total or spread by how far the
   * team's implied total has moved since. See `staleLine.ts`.
   */
  staleScaling: boolean;
}

/** Dropped on principle: the market already prices every one of these. */
export const ALWAYS_TEXT_ONLY = ['news_raw', 'role_trend', 'td_dependency', 'game_script', 'explosiveness'] as const;

export const SCORING_RULES: ScoringRules = {
  conversion: { devig: true, skew: true, tdRate: true },
  textOnly: [...ALWAYS_TEXT_ONLY, 'usage_level'],
  staleScaling: true,
};

/** The rules before October 2026, kept so the backtest can replay them. */
export const LEGACY_RULES: ScoringRules = {
  conversion: LINE_AS_MEDIAN,
  textOnly: [],
  staleScaling: false,
};
