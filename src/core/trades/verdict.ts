/**
 * One verdict on a trade, from Alex's side. Round 19 (November 2026).
 *
 * Check a trade says one line, and the trade finder labels its offers, from
 * the same function, so a deal cannot read "Fair" in the list and "Bad for
 * you" when it is tapped:
 *
 *  - **Bad for you**: his lineup does not get better over the rest of the
 *    season, or the other team gains more than he does by more than Check a
 *    trade's close-call band (its "leans to them"; Alex's rule since October
 *    that such a deal is never suggested).
 *  - **Fair**: fair to both sides by Alex's rule (`fairToBoth.ts`, unchanged):
 *    his value edge at most 10% (and he overpays by at most 25%), his lineup
 *    gains about 0.9 points a weighted week left and theirs a third of one.
 *  - **Good for you**: everything else where his lineup gains at least his
 *    bar: he comes out ahead, and the other team may say no.
 *  - Otherwise **Fair**: both sides come out about even, on a gain smaller
 *    than his bar.
 *
 * A deal that is not fair to both sides by the rule but is not bad either is
 * "close", with the first rule it breaks as the reason. The finder shows the
 * closest few only when nothing is fully fair, always labelled.
 *
 * Pure.
 */

import { fairToBoth, gainBars, sentValue, wholePercent, type UnfairReason } from './fairToBoth.ts';

export type TradeVerdict = 'good' | 'fair' | 'bad';

export const VERDICT_WORDS: Record<TradeVerdict, string> = {
  good: 'Good for you',
  fair: 'Fair',
  bad: 'Bad for you',
};

/** Why a near-fair deal is not fair to both sides, in Alex's words. */
export const CLOSE_LABELS: Record<UnfairReason, string> = {
  user_edge: 'Close: you get a bit more than you give',
  partner_edge: 'Close: you give a bit more than you get',
  user_gain: 'Close: small gain for you',
  partner_gain: 'Close: small gain for them',
};

export interface VerdictInput {
  /** Alex's rest-of-season lineup change (depth and his preferences included), the number Check a trade prints. */
  you: number;
  /** The other team's rest-of-season lineup change. */
  them: number;
  /** Value Alex sends, with a player the partner would cut counted at zero. */
  giveValue: number;
  /** Value Alex receives. */
  getValue: number;
  /** Weighted weeks left, for the gain bars. */
  weightedWeeks: number | null;
  /** Check a trade's close-call band, in points. */
  band: number;
}

export interface VerdictReading {
  verdict: TradeVerdict;
  /** Alex's rule, exactly as `fairToBoth` reads it. */
  fairToBoth: boolean;
  /** The first rule it breaks, or null when fair to both sides. */
  unfair: UnfairReason | null;
  /** Signed share of the larger side, positive Alex's way. */
  edge: number;
  /** Whole percent of `edge`. */
  edgePercent: number;
  bars: { user: number; partner: number };
  /** One short reason, plain English, for the line under the verdict. */
  reason: string;
}

export function tradeVerdict(input: VerdictInput): VerdictReading {
  const reading = fairToBoth({
    giveValue: input.giveValue,
    getValue: input.getValue,
    userGain: input.you,
    partnerGain: input.them,
    weightedWeeks: input.weightedWeeks,
  });
  const bars = gainBars(input.weightedWeeks);
  const edgePercent = wholePercent(reading.edge);
  const round = (v: number) => Math.round(v);
  const base = { fairToBoth: reading.fair, unfair: reading.reason, edge: reading.edge, edgePercent, bars };

  if (!(input.you > 0)) {
    return { ...base, verdict: 'bad', reason: 'Your lineup does not get better.' };
  }
  /* Check a trade's own "leans to them": their gain past yours by more than the close-call band. */
  if (input.them - input.you > input.band) {
    return { ...base, verdict: 'bad', reason: `They gain more: ${signed(round(input.them))} for them, ${signed(round(input.you))} for you.` };
  }
  if (reading.fair) {
    return { ...base, verdict: 'fair', reason: 'Fair to both sides: both lineups get better.' };
  }
  if (input.you >= bars.user) {
    const why =
      reading.reason === 'user_edge'
        ? `You get ${edgePercent}% more value than you give, so they may say no.`
        : reading.reason === 'partner_gain'
          ? 'It helps them little, so they may say no.'
          : reading.reason === 'partner_edge'
            ? `You give ${Math.abs(edgePercent)}% more value than you get.`
            : 'You come out ahead.';
    return { ...base, verdict: reading.reason === 'partner_edge' ? 'fair' : 'good', reason: why };
  }
  return { ...base, verdict: 'fair', reason: `About even, but a small gain for you (${signed(round(input.you))}).` };
}

/** The verdict for a Check a trade evaluation, side A being Alex. Null without both sides. */
export function verdictOfEvaluation(evaluation: {
  status: 'ok' | 'insufficient';
  weightedWeeks?: number;
  verdict: { band: number } | null;
  a: { net: number; incoming: readonly { rosValue: number | null }[]; outgoing: readonly { playerId: string; rosValue: number | null }[] } | null;
  b: { net: number; mustDrop?: { playerId: string } | null } | null;
}): VerdictReading | null {
  const { a, b } = evaluation;
  if (evaluation.status !== 'ok' || !a || !b) return null;
  const cuts = new Set(b.mustDrop ? [b.mustDrop.playerId] : []);
  return tradeVerdict({
    you: a.net,
    them: b.net,
    giveValue: sentValue(a.outgoing, cuts),
    getValue: a.incoming.reduce((sum, p) => sum + (p.rosValue ?? 0), 0),
    weightedWeeks: evaluation.weightedWeeks ?? null,
    band: evaluation.verdict?.band ?? 4,
  });
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

/** What Check a trade's one line needs, from Alex's side (side A). */
export interface CheckSummary {
  verdict: TradeVerdict;
  /** "Good for you", "Fair" or "Bad for you". */
  word: string;
  reason: string;
  fairToBoth: boolean;
  edgePercent: number;
  you: { thisWeek: number; restOfSeason: number };
  them: { thisWeek: number; restOfSeason: number };
  /** Positions where each side's new player starts most weeks, and where a starter leaves. */
  positions: { you: { better: string[]; thinner: string[] }; them: { better: string[]; thinner: string[] } };
}

interface SideLine {
  position: string;
  startsWeeks: number;
}

interface SideForSummary {
  net: number;
  incoming: readonly (SideLine & { rosValue: number | null })[];
  outgoing: readonly (SideLine & { playerId: string; rosValue: number | null })[];
  weekly?: readonly { lineupBefore: number; lineupAfter: number; depthBefore: number; depthAfter: number }[];
  mustDrop?: { playerId: string } | null;
}

/**
 * Check a trade's one line: the verdict, both sides' this-week and
 * rest-of-season change, the edge, and who gets better where. Null when the
 * check has no verdict (a player with no number).
 */
export function checkSummary(evaluation: {
  status: 'ok' | 'insufficient';
  weeks: { count: number };
  weightedWeeks?: number;
  verdict: { band: number } | null;
  a: SideForSummary | null;
  b: SideForSummary | null;
}): CheckSummary | null {
  const reading = verdictOfEvaluation(evaluation);
  const { a, b } = evaluation;
  if (!reading || !a || !b) return null;
  const week = (side: SideForSummary) => {
    const w = side.weekly?.[0];
    return w ? Math.round((w.lineupAfter + w.depthAfter - w.lineupBefore - w.depthBefore) * 10) / 10 : 0;
  };
  const half = Math.max(1, Math.ceil(evaluation.weeks.count / 2));
  const where = (side: SideForSummary) => {
    const better = [...new Set(side.incoming.filter((p) => p.startsWeeks >= half).map((p) => p.position))];
    const thinner = [...new Set(side.outgoing.filter((p) => p.startsWeeks >= half).map((p) => p.position))].filter((p) => !better.includes(p));
    return { better, thinner };
  };
  return {
    verdict: reading.verdict,
    word: VERDICT_WORDS[reading.verdict],
    reason: reading.reason,
    fairToBoth: reading.fairToBoth,
    edgePercent: reading.edgePercent,
    you: { thisWeek: week(a), restOfSeason: Math.round(a.net * 10) / 10 },
    them: { thisWeek: week(b), restOfSeason: Math.round(b.net * 10) / 10 },
    positions: { you: where(a), them: where(b) },
  };
}
