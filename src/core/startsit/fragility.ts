/**
 * How much of this lineup depends on nothing going wrong.
 *
 * Two rosters can project the same total and be nothing like each other. One
 * has three receivers who could each fill the flex and a tight end who plays on
 * Monday night; the other has exactly one playable tight end, two starters on
 * the same bye, and a questionable receiver in the late window whose only cover
 * kicks off at one o'clock. The second is not worse *on Sunday morning* — it is
 * worse every time something happens, which is most weeks.
 *
 * ## It scores the roster, not the players
 *
 * Nothing here touches a projection, and that is a rule rather than an
 * accident: fragility is a property of the shape of a roster, and letting it
 * move a player's points would mean a receiver was worth less because his
 * team's tight end got hurt. The output is a score, a band and a list of
 * findings, all of which a screen may show beside the lineup and none of which
 * the lineup optimiser reads.
 *
 * ## Bounded, and additive by design
 *
 * Each vulnerability contributes at most its own weight and the total is capped
 * at 100. A roster with every problem at once reads as fragile once, not five
 * times, and no single finding can dominate the score on its own — because the
 * useful output is "which two things would I fix", not a number to rank against
 * other people's rosters.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { StartSitEvaluation } from './engine.ts';
import type { LineupRecommendation } from './lineup.ts';

export const FRAGILITY = {
  /** Hours after the first kickoff at which a game counts as "late". */
  lateWindowHours: 3,
  /** Points of each vulnerability, out of 100. */
  weights: {
    questionable_late: 30,
    no_backup: 25,
    shared_bye: 20,
    single_viable: 20,
    early_lock: 15,
  },
  /** Score at or above which the lineup is fragile rather than merely thin. */
  fragile: 45,
  brittle: 70,
} as const;

export type FragilityKind = keyof typeof FRAGILITY.weights;

export interface FragilityFinding {
  kind: FragilityKind;
  /** `Fragile at TE`, `Need late-game insurance` — short enough for a chip. */
  label: string;
  detail: string;
  /** Contribution to the score, 0–100. */
  weight: number;
  /** The position or player it is about, when it is about one. */
  subject: string | null;
}

export interface FragilityAssessment {
  score: number;
  band: 'solid' | 'thin' | 'fragile' | 'brittle';
  findings: FragilityFinding[];
  headline: string | null;
  /** Fragility never moves a projection. Stated as a value, not a promise. */
  readonly projectionEffect: 0;
}

export interface FragilityInput {
  lineup: LineupRecommendation;
  /** Every player on the roster, evaluated. Bench included. */
  evaluations: StartSitEvaluation[];
  shape: RosterShape;
  /** Bye weeks by player id, where the schedule is known. */
  byeWeeks?: Map<string, number | null>;
  currentWeek?: number;
}

export function assessFragility(input: FragilityInput): FragilityAssessment {
  const findings: FragilityFinding[] = [];
  const starters = input.lineup.slots.filter((s) => s.playerId != null);
  const starterIds = new Set(starters.map((s) => s.playerId!));
  const byId = new Map(input.evaluations.map((e) => [e.playerId, e]));

  /*
   * 1. A questionable starter in the late window, with no cover that survives
   *    to hear the news. This is the same exposure `replacement.ts` prices in
   *    the score; here it is stated as a roster problem rather than as a
   *    fraction of a point, because the fix is a transaction and not a swap.
   */
  for (const risk of input.lineup.lateSwapRisks) {
    if (!risk.starting) continue;
    if (risk.verdict !== 'late_swap_exposed' && risk.verdict !== 'thin_bench') continue;
    findings.push({
      kind: 'questionable_late',
      label: 'Need late-game insurance',
      detail: risk.detail,
      weight: FRAGILITY.weights.questionable_late,
      subject: risk.name,
    });
    break;
  }

  /*
   * 2. A starting slot with nobody behind it.
   *
   * Counted per position against the slots that require it, so a league
   * starting one tight end with one tight end on the roster is flagged and a
   * league starting two receivers with five is not.
   */
  for (const [position, required] of Object.entries(input.shape.starters)) {
    const playable = input.evaluations.filter(
      (e) => e.position.toUpperCase() === position.toUpperCase() && !e.ruledOut && e.score != null,
    );
    if (playable.length > required) continue;
    const single = required === 1 && playable.length <= 1;
    findings.push({
      kind: single ? 'single_viable' : 'no_backup',
      label: `Fragile at ${position.toUpperCase()}`,
      detail:
        playable.length === 0
          ? `No playable ${position.toUpperCase()} at all.`
          : `${playable.length} playable ${position.toUpperCase()}${playable.length === 1 ? '' : 's'} for ${required} starting slot${required === 1 ? '' : 's'} — an injury there has no answer on this roster.`,
      weight: single ? FRAGILITY.weights.single_viable : FRAGILITY.weights.no_backup,
      subject: position.toUpperCase(),
    });
  }

  /*
   * 3. A shared bye among starters.
   *
   * Only counted for a week that is still ahead: a bye that has already been
   * survived is not a vulnerability, it is a memory.
   */
  if (input.byeWeeks && input.currentWeek != null) {
    const byWeek = new Map<number, string[]>();
    for (const id of starterIds) {
      const bye = input.byeWeeks.get(id) ?? null;
      if (bye == null || bye <= input.currentWeek) continue;
      byWeek.set(bye, [...(byWeek.get(bye) ?? []), byId.get(id)?.name ?? id]);
    }
    for (const [week, names] of [...byWeek].sort((a, b) => a[0] - b[0])) {
      if (names.length < 2) continue;
      findings.push({
        kind: 'shared_bye',
        label: `${names.length} starters share the week ${week} bye`,
        detail: `${names.join(', ')} are all off in week ${week}.`,
        weight: FRAGILITY.weights.shared_bye,
        subject: `week ${week}`,
      });
      break;
    }
  }

  /*
   * 4. Everybody locks early.
   *
   * A lineup entirely in the first window has no late swap available at all:
   * whatever happens on Sunday morning is the whole of the week's information,
   * and every decision has to be made before any of it arrives.
   */
  const kickoffs = starters
    .map((s) => byId.get(s.playerId!)?.lock.kickoff ?? null)
    .filter((k): k is string => k != null)
    .map((k) => Date.parse(k))
    .filter((t) => Number.isFinite(t));
  if (kickoffs.length >= 2 && kickoffs.length === starters.length) {
    const first = Math.min(...kickoffs);
    const last = Math.max(...kickoffs);
    if (last - first < FRAGILITY.lateWindowHours * 3_600_000) {
      findings.push({
        kind: 'early_lock',
        label: 'No late-window flexibility',
        detail: 'Every starter kicks off in the same window, so there is no game left to swap into once news lands.',
        weight: FRAGILITY.weights.early_lock,
        subject: null,
      });
    }
  }

  const score = Math.min(100, findings.reduce((a, f) => a + f.weight, 0));
  const band: FragilityAssessment['band'] =
    score >= FRAGILITY.brittle ? 'brittle' : score >= FRAGILITY.fragile ? 'fragile' : score > 0 ? 'thin' : 'solid';

  return {
    score,
    band,
    findings: findings.sort((a, b) => b.weight - a.weight),
    headline: findings.length === 0 ? null : findings.sort((a, b) => b.weight - a.weight)[0]!.label,
    projectionEffect: 0,
  };
}
