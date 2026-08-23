/**
 * The imported preseason projection, as a bounded draft signal.
 *
 * StartWho's number is a season fantasy-points estimate it derived from betting
 * markets under this league's own scoring. That makes it an answer to the
 * question the board already asks — "what does the market expect of him this
 * season" — arriving by a different route from the raw season lines.
 *
 * ## Why it is a fallback rather than an addition
 *
 * Because they are the same claim. A raw season baseline and a market-derived
 * projection both say how much the market expects a player to produce, and
 * letting each contribute its own boost would count one opinion twice: a player
 * both sources like would be rewarded for the coincidence of being covered
 * twice, and a player only one covers would look worse than he is. So exactly
 * one of them fills the slot, the raw lines win where they exist, and the
 * projection answers only where they are silent.
 *
 * That is also the honest ordering. A line a book is taking bets on is a
 * stronger fact than a model's estimate derived from lines, even a good model's
 * — so where the app holds the stronger fact it uses it, and where it does not
 * it says so rather than reaching for nothing.
 *
 * ## Why it is a standing rather than the points
 *
 * 386 is a quarterback's number and 292 is a running back's, and neither is
 * "better". What the ranking can use is where a player sits **among the players
 * he is actually competing with**, which is what `positionalStanding` measures
 * — median-centred, so an ordinary player scores zero and a player with no
 * projection at all contributes exactly what an ordinary one does.
 *
 * Nothing here decides how much that standing is worth. It returns a number on
 * the same [-1, 1] scale the raw baseline produces, and the weight it is
 * multiplied by is the one the market component already had.
 */

import { positionalStanding } from '../vegas/season.ts';

/** One player's imported projection, with the position it competes in. */
export interface PreseasonPointsEntry {
  playerId: string;
  position: string;
  points: number;
}

/**
 * Positional peer groups, keyed by position.
 *
 * Built once for a board rather than per player: a standing needs the same peer
 * set every time it is asked, and rebuilding it per row would make the answer
 * depend on which rows happened to be on screen.
 */
export function preseasonPointsPool(entries: readonly PreseasonPointsEntry[]): Map<string, number[]> {
  const byPosition = new Map<string, number[]>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.points)) continue;
    const position = (entry.position ?? '').toUpperCase();
    if (!position) continue;
    const list = byPosition.get(position);
    if (list) list.push(entry.points);
    else byPosition.set(position, [entry.points]);
  }
  return byPosition;
}

/**
 * Where this player's projection sits among players at his position.
 *
 * Null when he has no projection, or when too few of his peers do for a
 * standing to mean anything — never zero, which the ranking would read as "an
 * ordinary player" rather than as "we do not know".
 *
 * His own number is removed from the comparison pool first. Leaving it in would
 * let a player drag the median toward himself, which flatters the outliers at
 * both ends and is worst exactly where the board is being asked to separate
 * players.
 */
export function preseasonPointsScore(
  player: { position: string; points: number | null } | null,
  pool: Map<string, number[]>,
): number | null {
  if (!player || player.points == null || !Number.isFinite(player.points)) return null;
  const position = (player.position ?? '').toUpperCase();
  const all = pool.get(position);
  if (!all) return null;

  const peers = [...all];
  const at = peers.indexOf(player.points);
  if (at >= 0) peers.splice(at, 1);

  return positionalStanding(player.points, peers);
}
