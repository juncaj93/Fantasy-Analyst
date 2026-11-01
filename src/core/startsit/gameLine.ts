/**
 * The two Vegas numbers for a player's game, for reading (1 November 2026).
 *
 * Alex reads the game total and his team's points before a start/sit call, so
 * the Compare table shows them. They come from the same game line the engine
 * already holds for him (`StartSitInput.game`, built once per team by
 * `startSitInputs.ts`), so two players in one game print the same total and
 * every screen reads the same spread. Nothing here is part of any score.
 *
 * Team points is `impliedTeamTotal` from `staleLine.ts`: total / 2 − spread / 2,
 * with the spread from his team's side (negative when favoured). A 47.5 game
 * with a 3-point favourite is 25.25 for the favourite and 22.25 for the other
 * side. A missing total or spread is a null, never a guess.
 */

import type { GameContext } from './gameScript.ts';
import { impliedTeamTotal } from './staleLine.ts';

export interface GameLine {
  /** The game's over/under. Null when the game is not priced. */
  total: number | null;
  /** His team's implied points. Null without both a total and a spread. */
  teamPoints: number | null;
}

export function gameLineOf(game: GameContext | null | undefined): GameLine | null {
  if (!game) return null;
  const total = game.total != null && Number.isFinite(game.total) ? game.total : null;
  const teamPoints = impliedTeamTotal({ total, spread: game.spread });
  if (total == null && teamPoints == null) return null;
  return { total, teamPoints };
}
