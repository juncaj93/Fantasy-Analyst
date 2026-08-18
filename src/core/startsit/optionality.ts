/**
 * What a bench player is worth for reasons that have nothing to do with how
 * good he is.
 *
 * Two backups project 8.2 points. One is a running back who can only fill an RB
 * slot and kicks off at one o'clock; the other is a receiver eligible for both
 * a WR slot and the flex, who plays on Sunday night. The second is worth more
 * to own and the projection cannot see it, because the difference is not about
 * football — it is about how many of the week's futures he covers.
 *
 * ## Kept out of the projection, deliberately
 *
 * This is the same rule the fragility score follows and it matters more here,
 * because the temptation is stronger: it would be easy to add a tenth of a
 * point for flex eligibility and let the lineup optimiser sort it out. That
 * would be wrong. A player's projection is an estimate of what he will score,
 * and a Sunday-night kickoff does not change that by one point. Optionality is
 * a *roster-management* value — it belongs in a drop decision, a waiver claim
 * and a trade, and it must never quietly become a reason to start somebody.
 *
 * So `points` is not a field here. The output is a 0–100 score with its reasons
 * attached, and no caller can accidentally add it to a lineup.
 *
 * ## Not the same "optionality" as `roster/bench.ts`
 *
 * That module scores a bench *slot* — what it earns, against what it could earn
 * — and one of its components is labelled `Optionality`, meaning **whether the
 * role could still grow**. This one asks a different question: **how many of
 * the week's futures does this player cover**, from slot eligibility, kickoff
 * time and positional scarcity. A settled every-down back has no upside in
 * their sense and enormous coverage in this one.
 *
 * Two useful quantities that share an English word, so the assessment carries
 * `kind: 'lineup_coverage'` and a consumer holding both can never print one
 * under the other's label.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { RoleAssessment } from './decisions.ts';

export const OPTIONALITY = {
  /** How the score is made up. Sums to 100 by construction. */
  weights: {
    /** How many of the league's starting slots he is legally eligible for. */
    eligibility: 35,
    /** How late he plays — a late kickoff is a decision you get to keep. */
    kickoff: 30,
    /** Whether the role is settled enough to be relied on. */
    roleStability: 20,
    /** Whether he covers a position the roster is thin at. */
    scarcity: 15,
  },
  /** Hours after the slate's first kickoff at which a game is genuinely late. */
  lateHours: 4,
} as const;

export interface OptionalityInput {
  playerId: string;
  name: string;
  position: string;
  kickoff: string | null;
  role?: RoleAssessment | null;
  /** How many players on the roster are playable at his position. */
  playableAtPosition: number;
  /** Slots the league starts at his position. */
  slotsAtPosition: number;
}

export interface OptionalityAssessment {
  /**
   * Which quantity this is, because the codebase has two.
   *
   * `roster/bench.ts` calls role growth "optionality" too. A consumer holding
   * both reads this discriminator rather than the variable name it happened to
   * be assigned to.
   */
  kind: 'lineup_coverage';
  playerId: string;
  name: string;
  /** 0–100. Roster-management value only. Never a projection. */
  score: number;
  band: 'low' | 'useful' | 'high';
  /** Which starting slots he could legally fill. */
  eligibleSlots: string[];
  reasons: string[];
}

/**
 * Score one bench player's flexibility.
 *
 * `firstKickoff` and `lastKickoff` frame the week: lateness is relative to the
 * slate actually being played, not to a clock, so a Thursday-night league and a
 * London-game Sunday are measured on their own terms.
 */
export function assessOptionality(
  input: OptionalityInput,
  shape: RosterShape,
  window: { firstKickoff: string | null; lastKickoff: string | null },
): OptionalityAssessment {
  const position = input.position.toUpperCase();
  const eligibleSlots = [
    ...Object.keys(shape.starters).filter((slot) => slot.toUpperCase() === position),
    ...shape.flex.filter((f) => f.positions.map((p) => p.toUpperCase()).includes(position)).map((f) => f.slot),
  ];

  const reasons: string[] = [];
  let score = 0;

  /*
   * Eligibility, measured against the most flexible player this league allows.
   *
   * Against the league rather than against a constant: in a league with no
   * flex, being eligible for one slot is the maximum available and should not
   * read as inflexible.
   */
  const maxSlots = Math.max(1, ...positionsOf(shape).map((p) => slotsFor(p, shape).length));
  const eligibilityShare = eligibleSlots.length / maxSlots;
  score += eligibilityShare * OPTIONALITY.weights.eligibility;
  if (eligibleSlots.length > 1) reasons.push(`covers ${eligibleSlots.join(' and ')}`);
  else if (eligibleSlots.length === 1) reasons.push(`${eligibleSlots[0]} only`);
  else reasons.push('cannot fill any slot this league starts');

  // Lateness: a player who kicks off after everybody else is an option you
  // still hold when the rest of the week has already happened.
  const lateness = latenessOf(input.kickoff, window);
  score += lateness * OPTIONALITY.weights.kickoff;
  if (lateness >= 0.75) reasons.push('plays late, so he can still be swapped in after the early games');
  else if (lateness <= 0.1 && input.kickoff) reasons.push('locks with the first games');

  // A role that moves is a role that might not be there when it is needed.
  const stability = stabilityOf(input.role ?? null);
  score += stability.share * OPTIONALITY.weights.roleStability;
  if (stability.reason) reasons.push(stability.reason);

  /*
   * Scarcity: covering a slot the roster is thin at.
   *
   * The only place this file looks at the rest of the roster, and it is what
   * separates "a fourth receiver" from "the only other tight end".
   */
  const spare = input.playableAtPosition - input.slotsAtPosition;
  const scarcityShare = spare <= 0 ? 1 : spare === 1 ? 0.6 : spare === 2 ? 0.3 : 0;
  score += scarcityShare * OPTIONALITY.weights.scarcity;
  if (scarcityShare >= 0.6) reasons.push(`one of few playable ${position}s on the roster`);

  const rounded = Math.round(score);
  return {
    kind: 'lineup_coverage',
    playerId: input.playerId,
    name: input.name,
    score: rounded,
    band: rounded >= 70 ? 'high' : rounded >= 45 ? 'useful' : 'low',
    eligibleSlots,
    reasons,
  };
}

function positionsOf(shape: RosterShape): string[] {
  const out = new Set<string>(Object.keys(shape.starters).map((p) => p.toUpperCase()));
  for (const flex of shape.flex) for (const p of flex.positions) out.add(p.toUpperCase());
  return [...out];
}

function slotsFor(position: string, shape: RosterShape): string[] {
  return [
    ...Object.keys(shape.starters).filter((slot) => slot.toUpperCase() === position),
    ...shape.flex.filter((f) => f.positions.map((p) => p.toUpperCase()).includes(position)).map((f) => f.slot),
  ];
}

/** 0 at the first kickoff of the slate, 1 at the last. Unknown reads as 0.5. */
function latenessOf(kickoff: string | null, window: { firstKickoff: string | null; lastKickoff: string | null }): number {
  if (!kickoff || !window.firstKickoff || !window.lastKickoff) return 0.5;
  const start = Date.parse(window.firstKickoff);
  const end = Date.parse(window.lastKickoff);
  const at = Date.parse(kickoff);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(at) || end <= start) return 0.5;
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}

function stabilityOf(role: RoleAssessment | null): { share: number; reason: string | null } {
  if (!role || role.trend === 'insufficient_data') return { share: 0.5, reason: null };
  switch (role.trend) {
    case 'rising_high':
    case 'rising_moderate':
      return { share: 1, reason: 'his role is growing, so the option is getting better' };
    case 'stable':
      return { share: 0.8, reason: 'a settled role' };
    case 'spike':
      return { share: 0.5, reason: 'one big week inside an otherwise flat role' };
    default:
      return { share: 0.2, reason: 'his role is shrinking, so this cover may not be there when it is needed' };
  }
}
