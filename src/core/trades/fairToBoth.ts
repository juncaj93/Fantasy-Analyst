/**
 * Fair to both sides: the one rule a trade idea or a built package must pass.
 *
 * Alex, November 2026 (review T3, T4, T10), replacing his 15 September "lean
 * my way" instruction: a good trade is fair to both sides, because a deal the
 * other manager would refuse is a wasted conversation. So:
 *
 *  - **Alex's edge is at most 10%.** Rest-of-season value over a free agent,
 *    what Alex receives against what he sends, as a share of the larger side.
 *  - **Alex does not overpay by much either.** At most 25% the other way, the
 *    same band the ideas have always used. A 2-for-1 consolidation, or a
 *    player who fills a hole in his lineup, is worth some value to him, and
 *    his own gain (below) is what protects him: the November "43 for 3" deal
 *    gained him 1.4 points.
 *  - **Both lineups gain over the rest of the season**, by more than noise:
 *    about 0.9 points a week for Alex and a third of a point for the partner,
 *    over the weeks left with a playoff week counted 1.5 times
 *    (`restOfSeason.ts`). From week 9 that is 10.5 weighted weeks: 9.5 points
 *    for Alex and 3.5 for the partner, the November rule's 8 and 3 (a point a
 *    week, a third of one, over nine plain weeks) on the new scale. The bars
 *    shrink as the weeks run out, so a week-11 deal is held to the same rate
 *    as a week-9 one. Not losing 0.75 this Sunday is not a reason for anyone
 *    to say yes.
 *
 * One function, read by the trade ideas (through the season check) and by
 * Build a trade, so the two cannot disagree about what fair means.
 *
 * Pure.
 */

export const FAIR_TO_BOTH = {
  /** The most Alex may come out ahead on value, as a share of the larger side. */
  userEdgeMax: 0.1,
  /** The most the partner may come out ahead on value. */
  partnerEdgeMax: 0.25,
  /** Rest-of-season lineup points Alex must gain, per weighted week left. */
  userPerWeek: 0.9,
  /** Rest-of-season lineup points the partner must gain, per weighted week left. */
  partnerPerWeek: 1 / 3,
  /** The bars for a caller that does not say how many weeks are left: weeks 9 to 17, 10.5 weighted weeks. */
  userMinGain: 9.5,
  partnerMinGain: 3.5,
} as const;

/**
 * The two gain bars for this many weighted weeks left, to the half point.
 * `weighted` absent: the week-9 bars, {@link FAIR_TO_BOTH.userMinGain} and
 * {@link FAIR_TO_BOTH.partnerMinGain}.
 */
export function gainBars(weighted?: number | null): { user: number; partner: number } {
  if (weighted == null || !(weighted > 0)) return { user: FAIR_TO_BOTH.userMinGain, partner: FAIR_TO_BOTH.partnerMinGain };
  const half = (v: number) => Math.round(v * 2) / 2;
  return { user: half(FAIR_TO_BOTH.userPerWeek * weighted), partner: half(FAIR_TO_BOTH.partnerPerWeek * weighted) };
}

export type UnfairReason = 'user_edge' | 'partner_edge' | 'user_gain' | 'partner_gain';

export interface FairReading {
  fair: boolean;
  /** Signed: positive is Alex's way. Share of the larger side. */
  edge: number;
  /** The first rule it breaks, or null when it is fair. */
  reason: UnfairReason | null;
}

/**
 * Whole percent, which is as fine as these numbers can be read: a value edge
 * of 10.4% is "10%", inside the rule, and 10.6% is "11%", outside it.
 */
export function wholePercent(share: number): number {
  return Math.round(share * 100);
}

/** Alex's value edge: what he gets against what he gives, as a share of the larger. Positive is his way. */
export function valueEdge(giveValue: number, getValue: number): number {
  const larger = Math.max(giveValue, getValue);
  if (!(larger > 0)) return 0;
  return Math.round(((getValue - giveValue) / larger) * 1000) / 1000;
}

export function fairToBoth(args: {
  /** Rest-of-season value of what Alex sends. A player the partner would cut counts zero. */
  giveValue: number;
  /** Rest-of-season value of what Alex receives. */
  getValue: number;
  /** Alex's rest-of-season lineup change, the drop he has to make included. */
  userGain: number;
  /** The partner's rest-of-season lineup change. */
  partnerGain: number;
  /** Weighted weeks left (`totalWeight`), for the gain bars. Absent: the week-9 bars. */
  weightedWeeks?: number | null;
}): FairReading {
  const edge = valueEdge(args.giveValue, args.getValue);
  const bars = gainBars(args.weightedWeeks);
  let reason: UnfairReason | null = null;
  if (wholePercent(edge) > wholePercent(FAIR_TO_BOTH.userEdgeMax)) reason = 'user_edge';
  else if (wholePercent(-edge) > wholePercent(FAIR_TO_BOTH.partnerEdgeMax)) reason = 'partner_edge';
  else if (!(args.userGain >= bars.user)) reason = 'user_gain';
  else if (!(args.partnerGain >= bars.partner)) reason = 'partner_gain';
  return { fair: reason == null, edge, reason };
}

/** The value Alex sends, with any player the partner would cut counted at zero for him. */
export function sentValue(
  outgoing: readonly { playerId: string; rosValue: number | null }[],
  partnerCuts: ReadonlySet<string>,
): number {
  return outgoing.reduce((sum, p) => sum + (partnerCuts.has(p.playerId) ? 0 : (p.rosValue ?? 0)), 0);
}
