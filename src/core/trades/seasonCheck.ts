/**
 * The trade ideas, held to the same answer Check a trade gives.
 *
 * Finding T3 (October 2026). The ideas on Trades are found and ranked on one
 * week of starting-lineup points; Check a trade judges the same deal over the
 * rest of the season. Both sat on one screen and could disagree about one deal:
 * a buy-low card saying "get him" above a check that said the trade favours the
 * other team. Alex asked for the two to agree.
 *
 * So every surfaced idea is put through Check a trade's own evaluation (the
 * caller does that; this module reaches no database), and:
 *
 *  - an idea the season check says favours or leans to the other team is left
 *    off the board, and the board says how many were;
 *  - every idea that stays carries the season verdict, so the card and the
 *    check cannot say different things about it;
 *  - an idea the check could not value (a player with no number this week) is
 *    kept, and says it was not checked. Dropping it would hide a real idea on
 *    the strength of a missing number, which is the "no number" rule's mistake
 *    in reverse.
 *
 * The idea search itself is untouched: it still decides what to propose and in
 * what order. This only refuses to show what the season check contradicts.
 */

import type { OfferEvaluation } from './bilateral.ts';

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
}

/** The shape of a Check a trade evaluation this needs, so the module imports no service. */
export interface SeasonEvaluationLike {
  status: 'ok' | 'insufficient';
  insufficientReason: string | null;
  verdict: { kind: SeasonCheck['kind']; headline: string } | null;
  confidence: 'high' | 'medium' | 'low';
}

export function seasonCheckOf(evaluation: SeasonEvaluationLike): SeasonCheck {
  if (evaluation.status !== 'ok' || evaluation.verdict == null) {
    return { status: 'insufficient', kind: null, headline: null, confidence: null, reason: evaluation.insufficientReason };
  }
  return {
    status: 'ok',
    kind: evaluation.verdict.kind,
    headline: evaluation.verdict.headline,
    confidence: evaluation.confidence,
    reason: null,
  };
}

/** Whether the season check contradicts an idea that is meant to help the user. */
export function contradicts(check: SeasonCheck | undefined): boolean {
  return check?.status === 'ok' && (check.kind === 'leans_b' || check.kind === 'favors_b');
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

export interface SeasonAgreement<T extends { offers: OfferEvaluation[]; notes: string[] }> {
  board: T;
  /** The ideas left off, for the probe. */
  dropped: OfferEvaluation[];
}

/**
 * The board with every idea checked, and the contradicted ones left off.
 *
 * `checks` is keyed by offer id. An idea with no entry is shown as it was: the
 * check is an addition to a screen that worked without it, and a check that
 * failed to run must not be able to empty the board.
 */
export function applySeasonChecks<T extends { offers: OfferEvaluation[]; notes: string[] }>(
  board: T,
  checks: ReadonlyMap<string, SeasonCheck>,
): SeasonAgreement<T> {
  if (checks.size === 0) return { board, dropped: [] };
  const kept: OfferEvaluation[] = [];
  const dropped: OfferEvaluation[] = [];
  for (const offer of board.offers) {
    const check = checks.get(offer.id);
    if (contradicts(check)) {
      dropped.push(offer);
      continue;
    }
    kept.push(check ? { ...offer, seasonCheck: check } : offer);
  }
  const notes = [...board.notes];
  if (dropped.length > 0) {
    notes.push(
      `${dropped.length} idea${dropped.length === 1 ? ' was' : 's were'} left off: over the rest of the season, Check a trade says ${dropped.length === 1 ? 'it favors' : 'they favor'} the other team.`,
    );
  }
  return { board: { ...board, offers: kept, notes }, dropped };
}
