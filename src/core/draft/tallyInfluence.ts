/**
 * What a tally point is actually worth — the audit, written down.
 *
 * Two observations prompted this, and both are correct:
 *
 *   1. `+5` in the tally looks like about `+2.5` of influence.
 *   2. `+13` moves a player much less than 2.6× what `+5` moves him.
 *
 * They are correct about **two different screens**, which is the finding. There
 * is not one transfer function in this app; there are two, they were designed
 * separately for different jobs, and neither is a bug.
 *
 * ## The Players list: linear, half a pick per point
 *
 * `playerOrder.ts` adjusts a player's draft rank by `TALLY_WEIGHT × net`, and
 * `TALLY_WEIGHT` is 0.5. So `+5` moves him 2.5 picks earlier and `+13` moves
 * him 6.5 — exactly linear, forever, with no cap. Observation 1 is this, seen
 * directly: the number *is* half the tally.
 *
 * ## The draft board: saturating, three windows, capped
 *
 * The board does not use that function at all. It scores three separate news
 * windows, each `clamp(net / saturation, -1, 1) × weight`:
 *
 *   | window   | saturates at | weight |
 *   |----------|--------------|--------|
 *   | lifetime | ±10          | 0.35   |
 *   | 30 days  | ±5           | 0.20   |
 *   | 7 days   | ±3           | 0.12   |
 *
 * Two consequences, and observation 2 is the second of them:
 *
 *  - Below saturation it *is* linear. A lifetime tally of +5 contributes
 *    `5/10 × 0.35 = 0.175`, and +8 contributes 0.28 — 1.6× the tally, 1.6× the
 *    contribution.
 *  - At and beyond saturation it stops. +10 and +13 and +40 all contribute
 *    0.35, so +13 is worth 2× what +5 is worth rather than 2.6×.
 *
 * ## Is the cap right?
 *
 * Yes, and deliberately so. The saturation point is the answer to "how emphatic
 * can this evidence get", not "how much evidence is there". A player the
 * newsletters have been positive about ten net times is a player they like; the
 * eleventh mention is not new information about him, it is the same information
 * again. Without the cap a player with a long, mildly positive history would
 * eventually outrank a better player with a shorter one, purely on volume — and
 * the tally is a *secondary* input by design (see `DEFAULT_WEIGHTS`), worth
 * about ten places when the market is close and never enough to beat a large
 * ADP gap.
 *
 * The shorter windows saturate sooner because they hold fewer items: `+3` in a
 * week is as emphatic as a week gets, while `+10` over a career is merely
 * strong.
 *
 * ## What this module is
 *
 * Not a change to either function — the brief says not to force linearity, and
 * nothing here does. It is the transfer function, exposed as something that can
 * be evaluated, printed and tested, so that "how much did my +13 move him" has
 * an answer that does not require reading the engine.
 */

import { DEFAULT_WEIGHTS, NEWS_SATURATION, NEWS_CONFLICT_DAMPING, type DraftComponentWeights } from './engine.ts';
import { TALLY_WEIGHT } from './playerOrder.ts';

/**
 * How a contribution translates into places on the board.
 *
 * The same conversion the card's own "about 4 spots" uses: in the reach regime
 * a point of ADP is worth about 0.05 of composite, so a contribution divided by
 * 0.05 is the number of players it moves him past. Approximate by nature — it
 * depends on how tightly packed that part of the board is — and stated as an
 * approximation everywhere it is shown.
 */
export const COMPOSITE_PER_PICK = 0.05;

export interface TallyWindows {
  lifetime: number;
  last30: number;
  last7: number;
}

export interface WindowInfluence {
  window: 'lifetime' | 'last30' | 'last7';
  net: number;
  /** Where this window stops responding to more of the same. */
  saturation: number;
  /** The normalised score, in [-1, 1]. */
  score: number;
  weight: number;
  contribution: number;
  /** True once more tally in this window buys nothing. */
  saturated: boolean;
}

export interface TallyInfluence {
  windows: WindowInfluence[];
  /** Sum of the three windows' contributions. */
  contribution: number;
  /** Roughly how many places on the board that is worth. */
  approximateSpots: number;
  /** True when the recent windows were damped for contradicting lifetime. */
  damped: boolean;
  /** The most the tally could ever contribute, in either direction. */
  ceiling: number;
  note: string;
}

/** The board's transfer function, evaluated. Pure; same input, same answer. */
export function draftBoardTallyInfluence(
  windows: TallyWindows,
  weights: DraftComponentWeights = DEFAULT_WEIGHTS,
): TallyInfluence {
  // The same rule the engine applies: recent windows are trusted half as much
  // when they point the opposite way to the lifetime record.
  const conflicted =
    windows.lifetime !== 0 && windows.last30 !== 0 && Math.sign(windows.lifetime) !== Math.sign(windows.last30);
  const damping = conflicted ? NEWS_CONFLICT_DAMPING : 1;

  const rows: WindowInfluence[] = [
    build('lifetime', windows.lifetime, NEWS_SATURATION.lifetime, weights.newsLifetime, 1),
    build('last30', windows.last30, NEWS_SATURATION.last30, weights.news30, damping),
    build('last7', windows.last7, NEWS_SATURATION.last7, weights.news7, damping),
  ];

  const contribution = round3(rows.reduce((a, r) => a + r.contribution, 0));
  const ceiling = round3(weights.newsLifetime + weights.news30 + weights.news7);
  const saturated = rows.filter((r) => r.saturated).map((r) => r.window);

  return {
    windows: rows,
    contribution,
    approximateSpots: Math.round(Math.abs(contribution) / COMPOSITE_PER_PICK),
    damped: conflicted,
    ceiling,
    note:
      saturated.length === 0
        ? 'every window is still responding to more evidence'
        : `${saturated.join(', ')} ${saturated.length === 1 ? 'has' : 'have'} saturated — more of the same evidence adds nothing`,
  };
}

/**
 * The Players list's transfer function, evaluated.
 *
 * Linear and uncapped, in picks of rank rather than composite points. Kept here
 * beside the board's so the two can be compared without holding both files in
 * your head — which is the confusion that produced the original question.
 */
export function playersListTallyInfluence(net: number): { picks: number; linear: true } {
  return { picks: round1(TALLY_WEIGHT * net), linear: true };
}

/**
 * Where the board's response to a lifetime tally stops being linear.
 *
 * Exposed as a number rather than left implicit in a clamp, because "when does
 * this stop working" is the question the audit was really asking.
 */
export function lifetimeSaturationPoint(): number {
  return NEWS_SATURATION.lifetime;
}

function build(
  window: WindowInfluence['window'],
  net: number,
  saturation: number,
  weight: number,
  damping: number,
): WindowInfluence {
  const raw = net / saturation;
  const score = clamp(raw, -1, 1) * damping;
  return {
    window,
    net,
    saturation,
    score: round3(score),
    weight,
    contribution: round3(score * weight),
    saturated: Math.abs(net) >= saturation,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
