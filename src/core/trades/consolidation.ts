/**
 * Two good players into one better one — and when that is a mistake.
 *
 * Consolidation is the trade every fantasy article recommends and half of
 * fantasy managers should not make. The arithmetic that makes it attractive is
 * real: a lineup starts a fixed number of players, so the ninth-best player on
 * your roster scores you nothing, and converting two startable players into one
 * excellent one raises the points you actually start.
 *
 * The arithmetic that makes it dangerous is equally real and gets left out. A
 * 2-for-1 removes a body. Every remaining starter now has less cover, the bye
 * weeks have fewer answers, and the injury that used to cost you a bench player
 * now costs you a starting slot. **Consolidation converts depth into ceiling and
 * fragility in the same move.**
 *
 * So this module refuses to have a house view. It measures four things — how
 * much of your depth is genuinely startable, how exposed the lineup already is,
 * how much ceiling the swap actually buys, and how late it is — and returns a
 * verdict that goes either way, with the reason it went that way.
 */

export interface ConsolidationInput {
  /** Weekly points of the players you would send, best first. */
  sending: { playerId: string; name: string; position: string; weeklyValue: number }[];
  /** The single player you would receive. */
  receiving: { playerId: string; name: string; position: string; weeklyValue: number };
  /**
   * What the roster starts with, and what it would start with afterwards. Both
   * in weekly points, from the same optimiser, so the difference means something.
   */
  startingPointsNow: number;
  startingPointsAfter: number;
  /** Bench players who could legally start if somebody went down, by position. */
  usableDepth: Record<string, number>;
  /** Starters currently carrying an injury designation. */
  fragileStarters: number;
  /** Starting slots in the lineup — the number that makes depth "spare". */
  startingSlots: number;
  /** Players on the roster in total. Below the league's own minimum, no trade. */
  rosterSize: number;
  week: number;
  finalWeek: number;
  /** Upcoming byes the roster cannot currently cover, by position. */
  uncoveredByes: number;
}

export type ConsolidationVerdict = 'consolidate' | 'keep_depth' | 'neutral';

export interface ConsolidationAdvice {
  verdict: ConsolidationVerdict;
  /** `2-for-1 consolidation makes sense` / `Keep depth; consolidation increases fragility` */
  headline: string;
  /** Weekly starting points gained. Can be negative, and often is. */
  lineupGain: number;
  /** How much cover the move removes, in bench players who could start. */
  depthCost: number;
  reasons: string[];
  counterpoints: string[];
  confidence: 'high' | 'medium' | 'low';
}

/**
 * The weekly starting-lineup gain below which the ceiling is not worth a body.
 *
 * A point and a half a week over ten weeks is fifteen points, which is roughly
 * one start-worthy performance — about what one injury to a now-uncovered
 * starter costs. Below it the trade is a coin flip dressed up as strategy.
 */
export const MEANINGFUL_CONSOLIDATION_GAIN = 1.5;

/** Startable bench players below which a roster is thin whatever the gain. */
export const THIN_DEPTH = 2;

export function assessConsolidation(input: ConsolidationInput): ConsolidationAdvice {
  const reasons: string[] = [];
  const counterpoints: string[] = [];

  const lineupGain = round2(input.startingPointsAfter - input.startingPointsNow);
  const totalDepth = Object.values(input.usableDepth).reduce((a, b) => a + b, 0);
  /*
   * The depth cost is the bodies leaving minus the body arriving — one, for a
   * 2-for-1 — but only the *startable* ones count. Trading away two players
   * nobody would ever start costs no depth at all, and calling that fragility
   * is how a tool talks somebody out of a free upgrade.
   */
  const startableSent = input.sending.filter((p) => p.weeklyValue > 0).length;
  const depthCost = Math.max(0, startableSent - 1);
  const depthAfter = Math.max(0, totalDepth - depthCost);

  const weeksLeft = Math.max(0, input.finalWeek - input.week);
  const late = weeksLeft <= 4;

  if (lineupGain > 0) {
    reasons.push(`Starts ${lineupGain.toFixed(1)} more points a week.`);
  } else {
    counterpoints.push(`Starts ${Math.abs(lineupGain).toFixed(1)} fewer points a week.`);
  }

  if (depthCost === 0) {
    reasons.push('Costs no startable depth — the players leaving were not in the picture anyway.');
  } else {
    counterpoints.push(`Leaves ${depthAfter} startable bench player(s), down from ${totalDepth}.`);
  }

  if (input.fragileStarters > 0) {
    counterpoints.push(`${input.fragileStarters} starter(s) already carry an injury designation.`);
  }
  if (input.uncoveredByes > 0) {
    counterpoints.push(`${input.uncoveredByes} upcoming bye(s) are not currently covered.`);
  }
  if (late) {
    reasons.push('Late enough in the season that ceiling beats insurance — there are few weeks left to be injured in.');
  }

  /*
   * The verdict, and the two ways it can go.
   *
   * Fragility wins ties. A roster that is already thin or already hurt is one
   * that will spend the rest of the season starting free agents, and the extra
   * point a week from a better starter does not survive one Sunday of that.
   */
  const fragile = depthAfter < THIN_DEPTH || input.fragileStarters >= 2 || input.uncoveredByes > 0;
  const worthwhile = lineupGain >= MEANINGFUL_CONSOLIDATION_GAIN;

  let verdict: ConsolidationVerdict;
  if (!worthwhile) {
    verdict = 'keep_depth';
  } else if (fragile && !late) {
    verdict = 'keep_depth';
  } else if (depthCost === 0 || late || depthAfter >= THIN_DEPTH) {
    verdict = 'consolidate';
  } else {
    verdict = 'neutral';
  }

  if (input.rosterSize - depthCost < input.startingSlots) {
    /*
     * Not advice, arithmetic: a roster that cannot fill its own lineup after the
     * trade is not consolidating, it is forfeiting slots.
     */
    return {
      verdict: 'keep_depth',
      headline: 'Keep depth; this trade would leave the lineup unable to fill its own slots',
      lineupGain,
      depthCost,
      reasons: [],
      counterpoints: [`Only ${input.rosterSize - depthCost} players would remain for ${input.startingSlots} starting slots.`],
      confidence: 'high',
    };
  }

  const headline =
    verdict === 'consolidate'
      ? `${input.sending.length}-for-1 consolidation makes sense`
      : verdict === 'keep_depth'
        ? 'Keep depth; consolidation increases fragility'
        : 'Close either way — the ceiling and the risk are roughly matched';

  return {
    verdict,
    headline,
    lineupGain,
    depthCost,
    reasons,
    counterpoints,
    confidence: Math.abs(lineupGain) >= 3 ? 'high' : Math.abs(lineupGain) >= 1 ? 'medium' : 'low',
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
