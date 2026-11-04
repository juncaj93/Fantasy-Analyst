/**
 * The trade ideas, held to the same answer Check a trade gives.
 *
 * Finding T3 (October 2026). The ideas on Trades are found and ranked on one
 * week of starting-lineup points; Check a trade judges the same deal over the
 * rest of the season. Both sat on one screen and could disagree about one deal:
 * a buy-low card saying "get him" above a check that said the trade favours the
 * other team. Alex asked for the two to agree.
 *
 * So every idea the board could show is put through Check a trade's own
 * evaluation (the caller does that; this module reaches no database), and:
 *
 *  - an idea is shown only when it is **fair to both sides** over the rest of
 *    the season (`fairToBoth.ts`, Alex's November 2026 rule, review T3): his
 *    value edge at most 10% and both lineups gaining by more than noise. A
 *    deal even on value that helps Alex's lineup more than theirs (his hole
 *    is bigger) stays: the other manager judges what he gets and what it
 *    costs, and both are fair. One that Check a trade says leans to the
 *    other team is still left off, as since October;
 *  - an idea the check could not value is left off: fair cannot be confirmed;
 *  - every idea that stays carries the season verdict, and the player Alex
 *    would have to drop to make room (review T6), so the card and the check
 *    cannot say different things about it;
 *  - the board asks for more ideas than it shows (`reserve`), so an idea left
 *    off is replaced by the next fair one rather than leaving a gap.
 *
 * The idea search itself still decides what to propose and in what order.
 */

import type { OfferEvaluation } from './bilateral.ts';
import { fairToBoth, sentValue, type UnfairReason } from './fairToBoth.ts';

/** The Check a trade verdict on one idea, from the user's side. */
export interface SeasonCheck {
  status: 'ok' | 'insufficient';
  /** `close`, or which way it goes: `a` is the user, `b` the other team. Null when not checked. */
  kind: 'close' | 'leans_a' | 'leans_b' | 'favors_a' | 'favors_b' | null;
  /** Check a trade's own sentence. */
  headline: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  /** Why it could not be checked, when it could not. */
  reason: string | null;
  /** Rest-of-season lineup points for the user and the partner. Optional: older bodies lack them. */
  you?: number | null;
  them?: number | null;
  /** The user's value edge over the rest of the season, signed, share of the larger side. */
  edge?: number | null;
  /** Why it is not fair to both sides, or null when it is. */
  unfair?: UnfairReason | null;
  /** The player the user would drop to make room, when the deal brings an extra one. */
  drop?: string | null;
}

interface SideLike {
  net: number;
  incoming: readonly { playerId: string; name?: string; rosValue: number | null }[];
  outgoing: readonly { playerId: string; name?: string; rosValue: number | null }[];
  mustDrop?: { playerId: string; name: string } | null;
}

/** The shape of a Check a trade evaluation this needs, so the module imports no service. */
export interface SeasonEvaluationLike {
  status: 'ok' | 'insufficient';
  insufficientReason: string | null;
  verdict: { kind: SeasonCheck['kind']; headline: string } | null;
  confidence: 'high' | 'medium' | 'low';
  /** Weighted weeks left, for the gain bars. */
  weightedWeeks?: number;
  /** The user's side (`a`) and the partner's (`b`). Absent on an older shape: then fairness is not read. */
  a?: SideLike | null;
  b?: SideLike | null;
}

export function seasonCheckOf(evaluation: SeasonEvaluationLike): SeasonCheck {
  if (evaluation.status !== 'ok' || evaluation.verdict == null) {
    return { status: 'insufficient', kind: null, headline: null, confidence: null, reason: evaluation.insufficientReason };
  }
  const base: SeasonCheck = {
    status: 'ok',
    kind: evaluation.verdict.kind,
    headline: evaluation.verdict.headline,
    confidence: evaluation.confidence,
    reason: null,
  };
  const { a, b } = evaluation;
  if (!a || !b) return base;
  /* A player the partner would cut on arrival is worth nothing to him (review T10). */
  const cuts = new Set(b.mustDrop ? [b.mustDrop.playerId] : []);
  const reading = fairToBoth({
    giveValue: sentValue(a.outgoing, cuts),
    getValue: a.incoming.reduce((sum, p) => sum + (p.rosValue ?? 0), 0),
    userGain: a.net,
    partnerGain: b.net,
    weightedWeeks: evaluation.weightedWeeks ?? null,
  });
  return {
    ...base,
    you: a.net,
    them: b.net,
    edge: reading.edge,
    unfair: reading.reason,
    drop: a.mustDrop?.name ?? null,
  };
}

/**
 * Whether the season check keeps an idea off the board.
 *
 * Off when Check a trade could not value it (fair cannot be confirmed), when
 * it says the deal favors or leans to the other team, or when it is not fair
 * to both sides.
 */
export function contradicts(check: SeasonCheck | undefined): boolean {
  if (!check) return false;
  if (check.status !== 'ok') return true;
  if (check.kind === 'leans_b' || check.kind === 'favors_b') return true;
  return check.unfair != null;
}

/**
 * The idea's one line, on the season (review T1): both sides' rest-of-season
 * gains, the numbers the fair-to-both rule reads. Null without them.
 */
export function seasonHeadline(check: SeasonCheck | undefined): string | null {
  if (!check || check.status !== 'ok' || check.you == null || check.them == null) return null;
  const signed = (v: number) => {
    const n = Math.round(v);
    return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : '0';
  };
  return `You ${signed(check.you)}, them ${signed(check.them)} over the season`;
}

/** The short form for a card: four words at most. */
export function seasonCheckLabel(check: SeasonCheck | undefined): string | null {
  if (!check) return null;
  if (check.status !== 'ok') return 'Season: not checked';
  switch (check.kind) {
    case 'favors_a':
      return 'Season: favors you';
    case 'leans_a':
      return 'Season: leans you';
    case 'close':
      return 'Season: close call';
    default:
      return null;
  }
}

export interface SeasonAgreement<T extends { offers: OfferEvaluation[]; notes: string[]; reserve?: OfferEvaluation[] }> {
  board: T;
  /** The ideas left off, for the probe. */
  dropped: OfferEvaluation[];
}

/** Every idea the season check should look at: the ones shown, then the reserve behind them. */
export function ideasToCheck(board: { offers: readonly OfferEvaluation[]; reserve?: readonly OfferEvaluation[] }): OfferEvaluation[] {
  return [...board.offers, ...(board.reserve ?? [])];
}

/**
 * The board with every idea checked, the unfair ones left off, and the gaps
 * filled from the reserve.
 *
 * `checks` is keyed by offer id. With no checks at all (the check failed to
 * run) the board is shown as the idea search produced it: the weekly gates
 * still hold, and a check that cannot run must not be able to empty the board.
 * The reserve never reaches the screen.
 */
export function applySeasonChecks<T extends { offers: OfferEvaluation[]; notes: string[]; reserve?: OfferEvaluation[] }>(
  board: T,
  checks: ReadonlyMap<string, SeasonCheck>,
): SeasonAgreement<T> {
  const { reserve, ...rest } = board;
  const shown = rest as unknown as T;
  if (checks.size === 0) return { board: reserve === undefined ? board : shown, dropped: [] };

  const room = board.offers.length;
  const kept: OfferEvaluation[] = [];
  const dropped: OfferEvaluation[] = [];
  const spoken = new Set<string>();
  for (const offer of ideasToCheck(board)) {
    if (kept.length >= room) break;
    const check = checks.get(offer.id);
    if (contradicts(check)) {
      dropped.push(offer);
      continue;
    }
    /* One idea per player, as the board itself keeps it: a reserve idea may share a player with one left off, never with one shown. */
    const involved = [...offer.give, ...offer.get].map((p) => p.playerId);
    if (involved.some((id) => spoken.has(id))) continue;
    for (const id of involved) spoken.add(id);
    /* The row's one line reads the season, not one week, once the season is known. */
    const headline = seasonHeadline(check);
    kept.push(check ? { ...offer, seasonCheck: check, ...(headline ? { headline } : {}) } : offer);
  }
  const notes = [...board.notes];
  if (kept.length === 0 && dropped.length > 0) {
    notes.push('No trade in this league is fair to both sides right now.');
  }
  return { board: { ...shown, offers: kept, notes }, dropped };
}
