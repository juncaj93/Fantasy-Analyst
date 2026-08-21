/**
 * One sentence about what to draft next.
 *
 * The Team screen shows a draft-state card while a draft is running, and the
 * lock asks for one concise recommendation on it — useful rather than generic,
 * and explicitly *not* a second opinion competing with the board's own. So
 * nothing here scores a player, reads ADP, or ranks anybody. It reads the need
 * breakdown the draft engine already computes from the league's own starting
 * slots and the roster as it stands, and says what that breakdown means.
 *
 * `computeNeed` sorts every position into exactly three states, and each one is
 * a different sentence:
 *
 *   - **a dedicated starting slot is empty** — the strongest signal it has, and
 *     the only one worth naming a position for. `WR is the priority`.
 *   - **starters covered, a flex slot open** — the position is not the question
 *     any more; which of several fills the flex is. `Fill the flex`.
 *   - **everything covered** — nothing is urgent, so the honest advice is about
 *     upside rather than need, and it names the two positions with the most
 *     room left. `Prioritise WR/TE upside depth`.
 *
 * If a later pass wants scarcity — "three teams ahead need one too" — the input
 * for it is `demandAhead`, and it belongs on this function's inputs rather than
 * in the screen.
 */

import type { NeedBreakdown } from './need.ts';

export interface BestMove {
  /** The sentence, ready to print. Never empty. */
  text: string;
  /** Positions named in it, for anything that wants to highlight them. */
  positions: string[];
  /** Which of the three states produced it. */
  kind: 'starter' | 'flex' | 'depth';
}

/**
 * Turn a need breakdown into the one line the draft card shows.
 *
 * `needs` is `computeNeed`'s output. Positions the league does not use score
 * 0.05 and carry the reason `position not used by this league`; they are
 * dropped here rather than filtered by the caller, because every caller would
 * have to remember to.
 */
export function bestMove(needs: Record<string, NeedBreakdown>): BestMove {
  const used = Object.values(needs).filter((n) => n.reason !== 'position not used by this league');
  if (used.length === 0) return { text: 'Take the best player available.', positions: [], kind: 'depth' };

  /*
   * Sorted by need, then by the size of the hole, then by name.
   *
   * The last key is not decoration: two positions with an identical score and
   * an identical shortfall would otherwise come out in object-key order, which
   * is insertion order, which is a detail of how the roster was counted. A
   * recommendation that changes when nothing about the roster did is worse
   * than one that is merely arbitrary.
   */
  const ranked = [...used].sort(
    (a, b) =>
      b.score - a.score ||
      b.startersUnfilled - a.startersUnfilled ||
      b.flexOpen - a.flexOpen ||
      a.position.localeCompare(b.position),
  );

  const unfilled = ranked.filter((n) => n.startersUnfilled > 0);
  if (unfilled.length > 0) {
    const names = unfilled.map((n) => n.position);
    /*
     * One name, or two, and then it stops counting.
     *
     * Early in a draft every position is unfilled, and `QB, RB, WR, TE and FLX
     * are the priority` is a list of the roster rather than advice. Past two,
     * the useful thing to say is how many holes there are.
     */
    if (names.length === 1) return { text: `${names[0]} is the priority.`, positions: names, kind: 'starter' };
    if (names.length === 2) {
      return { text: `${names[0]} and ${names[1]} are the priority.`, positions: names, kind: 'starter' };
    }
    const holes = unfilled.reduce((total, n) => total + n.startersUnfilled, 0);
    return {
      text: `${holes} starting slots still open — ${names[0]} and ${names[1]} first.`,
      positions: names.slice(0, 2),
      kind: 'starter',
    };
  }

  const flex = ranked.filter((n) => n.flexOpen > 0);
  if (flex.length > 0) {
    const names = flex.map((n) => n.position);
    return {
      text: `Starters are covered — fill the flex from ${names.slice(0, 3).join('/')}.`,
      positions: names.slice(0, 3),
      kind: 'flex',
    };
  }

  /*
   * Nothing is missing, so the advice is about upside.
   *
   * `computeNeed` scores depth as `0.4 - 0.08 per player past the requirement`,
   * so the highest remaining scores are the positions this roster is thinnest
   * behind — which is exactly where another body is worth most.
   */
  const thin = ranked.slice(0, 2).map((n) => n.position);
  return {
    text: `Every starting spot is filled — prioritise ${thin.join('/')} upside depth.`,
    positions: thin,
    kind: 'depth',
  };
}
