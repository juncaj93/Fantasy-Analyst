/**
 * Is this free agent only playing because somebody else is hurt?
 *
 * It changes what he is worth by more than almost anything else on the waiver
 * card — a back-up running back with a two-week job and a back-up running back
 * with a season are the same player at wildly different prices — and nothing in
 * this app detected it before.
 *
 * The inference is deliberately narrow, because a wide one would be wrong most
 * of the time. Two conditions, both checkable from data already stored:
 *
 * - The absent player plays the **same position for the same NFL club**. That
 *   is what makes the opening his.
 * - The absent player is **rostered in this league**. Somebody in a
 *   twelve-team league spent a pick or a claim on him, which is the closest
 *   available witness that he was the starter — and it is a fact rather than an
 *   opinion about a depth chart the app does not have.
 *
 * The second condition is what keeps this honest. Without it, every fourth
 * receiver on a club with an injured fifth receiver would be labelled a
 * beneficiary, and the label would mean nothing.
 */

/** Sleeper statuses that mean the player is not available to play. */
export const RULED_OUT_STATUSES = new Set([
  'Injured Reserve',
  'IR',
  'PUP',
  'Physically Unable to Perform',
  'NFI',
  'Non Football Injury',
  'Out',
  'Doubtful',
  'Suspended',
  'COV',
]);

/**
 * Statuses whose absence is measured in weeks rather than in months.
 *
 * `Out` and `Doubtful` are this week's designation and imply a return question
 * that is asked again in seven days. A reserve list is not a week-to-week
 * absence and gets no estimate at all, because guessing one would be the single
 * most consequential number on the card and the app has no basis for it.
 */
const WEEK_TO_WEEK = new Set(['Out', 'Doubtful']);

export interface BeneficiaryPlayer {
  playerId: string;
  name: string;
  team: string;
  position: string;
  status: string | null;
}

export interface BeneficiaryFinding {
  /** Who is absent. */
  absentPlayerId: string;
  absentName: string;
  status: string;
  /** Weeks until he is expected back, when that is actually knowable. */
  returnsInWeeks: number | null;
  note: string;
}

/**
 * Find the absence that created this opening, if there is one.
 *
 * Returns the most severe absence rather than the first, so a club with an IR
 * and a Doubtful reports the IR — the longer job is the one that prices the
 * player.
 */
export function beneficiaryOf(
  candidate: { playerId: string; team: string; position: string },
  clubmates: BeneficiaryPlayer[],
  rosteredInLeague: Set<string>,
): BeneficiaryFinding | null {
  const absences = clubmates.filter(
    (p) =>
      p.playerId !== candidate.playerId &&
      p.team === candidate.team &&
      p.position === candidate.position &&
      p.status != null &&
      RULED_OUT_STATUSES.has(p.status) &&
      rosteredInLeague.has(p.playerId),
  );

  if (absences.length === 0) return null;

  // Longest absence first: a reserve list outranks a weekly designation.
  const chosen =
    absences.find((p) => !WEEK_TO_WEEK.has(String(p.status))) ?? absences[0]!;
  const status = String(chosen.status);
  const returnsInWeeks = WEEK_TO_WEEK.has(status) ? 1 : null;

  return {
    absentPlayerId: chosen.playerId,
    absentName: chosen.name,
    status,
    returnsInWeeks,
    note:
      returnsInWeeks != null
        ? `has the job while ${chosen.name} is ${status.toLowerCase()} — reassess next week`
        : `has the job while ${chosen.name} is on ${status} — no published return date`,
  };
}
