/**
 * The room drafts where it lives.
 *
 * A Detroit-area league takes Lions earlier than the national market does. That
 * is not a claim about the Lions — it is a claim about twelve people, and it
 * belongs in exactly one place in this app: the model of what *those people*
 * are about to do. It changes `Next%`. It does not change whether a player is
 * any good.
 *
 * ## What this is allowed to touch, and what it is not
 *
 * Allowed: the hazard a simulated manager takes a given player, which is what
 * `Next%` is computed from and what the "cost of waiting" reads out of it.
 *
 * Not allowed, by construction rather than by convention: this module exports a
 * multiplier on opponent demand and nothing else. It is consumed by the
 * simulator alone. It never reaches `marketValueComponent`, the tier ladders,
 * `Val`, the season market, the tally or the composite's weights — a Lions
 * receiver is priced by the market at exactly what he was priced at before, and
 * ranks exactly where he ranked, and the only thing that changes is the app's
 * estimate of whether he will still be there in eleven picks.
 *
 * (`Score` does move a little, and it should. The board has always carried a
 * `survivalUrgency` component: a player about to be taken is more urgent than
 * one who is not. That channel is bounded at 0.22 of composite, it existed
 * before this file and it applies to every player for every reason — a run at
 * the position, a manager with an empty slot, a thinning tier. A Lion who is
 * genuinely likelier to be taken becoming slightly more urgent is that same
 * mechanism working, not a quality bonus sneaking in the back door.)
 *
 * ## Evidence first, prior second, market third
 *
 * The hierarchy the brief sets, implemented in that order:
 *
 *  1. **What this room has actually done.** If Lions have been going eleven
 *     picks ahead of their ADP in this draft, that is a measurement, and it is
 *     used in preference to any assumption. It is shrunk hard by sample size,
 *     because four picks is not a tendency.
 *  2. **The bounded local prior**, when there is not enough draft to measure —
 *     which is most of round one and all of the pre-draft board. Capped at the
 *     brief's range and applied to one team only.
 *  3. **The market**, when neither applies: multiplier exactly 1, no effect.
 *
 * With a full sample the prior disappears entirely and the observation carries
 * the whole effect. That is the correct limit: the assumption exists to cover
 * the period before the room has said anything about itself, and stops mattering
 * the moment it has.
 */

import type { CompletedPick } from './room.ts';

/**
 * Every number the local prior turns on.
 *
 * The cap is the brief's: a bounded 10–20% increase in selection hazard, after
 * calibration, and never a flat subtraction from `Next%`. The difference
 * matters — a hazard multiplier compounds over the picks a player has to
 * survive, so the same 15% produces a small effect over three intervening picks
 * and a large one over eighteen, which is the shape reality has. Taking 20% off
 * a survival percentage directly would instead produce the same effect
 * regardless of how many picks were in the way, which is the shape nothing has.
 */
export const TEAM_PRIOR = {
  /** The most the assumed local prior may lift demand, before evidence. */
  maxPrior: 0.2,
  /** Where it starts, and where it sits until calibration says otherwise. */
  defaultPrior: 0.15,
  /** Picks of this team's players before the observation is worth anything. */
  minSample: 4,
  /**
   * Shrinkage constant: at n picks the observation keeps n/(n+k) of itself, and
   * the prior covers the rest. At the minimum sample of four that is a third
   * observation, two thirds prior; by a dozen picks it is essentially all
   * observation.
   */
  shrink: 8,
  /** How much of a pick-versus-ADP gap becomes demand, per round-length. */
  gain: 0.6,
  /** The whole effect, observed or assumed, is capped here. */
  bounds: { min: 0.9, max: 1.25 },
} as const;

export interface TeamPriorInput {
  /**
   * The NFL teams this room is expected to favour, upper-case (`['DET']`).
   *
   * A list rather than a constant because "which teams is this room local to"
   * is a property of the league, not of this file. Empty means no prior at all,
   * which is the right default for a room nobody has said anything about.
   */
  teams: readonly string[];
  /** Completed picks, with the NFL team of the player taken. */
  picks: readonly (CompletedPick & { team: string | null })[];
  /** Picks per round, used to scale "how early is early". */
  teamsInLeague: number;
  /** Overridden only by the calibration probe. */
  prior?: number;
}

export interface TeamPriorResult {
  /** Per NFL team, a demand multiplier centred on 1. Only favoured teams appear. */
  multipliers: Map<string, number>;
  /** What was actually measured, per team, for the diagnostics. */
  observed: Map<string, { picks: number; meanPicksEarly: number; shrinkage: number }>;
  /** Which source decided each team's number. */
  basis: 'observed' | 'prior' | 'blended' | 'none';
  /** Said plainly, for the board's `nextPickModel` diagnostics. */
  notes: string[];
}

const NEUTRAL: TeamPriorResult = {
  multipliers: new Map(),
  observed: new Map(),
  basis: 'none',
  notes: [],
};

/**
 * The room's appetite for a favoured team's players, as a demand multiplier.
 *
 * Pure and deterministic: the same picks and the same league produce the same
 * numbers, every time, which is what lets the diagnostics below be checked
 * against a live board rather than believed.
 */
export function readTeamPrior(input: TeamPriorInput): TeamPriorResult {
  const favoured = [...new Set(input.teams.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (favoured.length === 0) return { ...NEUTRAL, multipliers: new Map(), observed: new Map() };

  const prior = clamp(input.prior ?? TEAM_PRIOR.defaultPrior, 0, TEAM_PRIOR.maxPrior);
  const multipliers = new Map<string, number>();
  const observed = new Map<string, { picks: number; meanPicksEarly: number; shrinkage: number }>();
  const notes: string[] = [];
  let sawObservation = false;
  let sawPrior = false;

  // A round's worth of picks is the yardstick: going four picks early in a
  // twelve-team league says more than going four picks early in a thirty-team one.
  const roundLength = Math.max(4, Math.round(input.teamsInLeague) || 12);

  for (const team of favoured) {
    const rows = input.picks.filter(
      (p) => (p.team ?? '').trim().toUpperCase() === team && p.position != null && p.adp != null,
    );

    /*
     * How early this room has been taking them, in picks.
     *
     * Negative `pickNo - adp` means taken before the market expected, which is
     * demand. The same sign convention `room.ts` uses for positional bias, so
     * the two reads cannot disagree about what "early" means.
     */
    const meanEarly =
      rows.length > 0 ? rows.reduce((a, p) => a + (p.adp! - p.pickNo), 0) / rows.length : 0;

    const shrinkage =
      rows.length >= TEAM_PRIOR.minSample ? rows.length / (rows.length + TEAM_PRIOR.shrink) : 0;

    // The observation, scaled to a round and shrunk by how little of it there is.
    const fromObservation = (TEAM_PRIOR.gain * meanEarly * shrinkage) / roundLength;
    // The assumption, covering whatever the observation has not earned.
    const fromPrior = prior * (1 - shrinkage);

    const lift = fromObservation + fromPrior;
    const multiplier = round3(clamp(1 + lift, TEAM_PRIOR.bounds.min, TEAM_PRIOR.bounds.max));
    multipliers.set(team, multiplier);
    observed.set(team, { picks: rows.length, meanPicksEarly: round1(meanEarly), shrinkage: round3(shrinkage) });

    if (shrinkage > 0) sawObservation = true;
    if (fromPrior > 0) sawPrior = true;

    if (shrinkage > 0) {
      notes.push(
        `${team}: this room has taken them ${Math.abs(round1(meanEarly))} picks ${
          meanEarly >= 0 ? 'earlier' : 'later'
        } than the market over ${rows.length} picks — demand ×${multiplier}`,
      );
    } else if (fromPrior > 0) {
      notes.push(
        `${team}: too few ${team} picks (${rows.length}) to measure this room, so a bounded local prior of +${Math.round(
          prior * 100,
        )}% applies — demand ×${multiplier}`,
      );
    }
  }

  return {
    multipliers,
    observed,
    basis: sawObservation && sawPrior ? 'blended' : sawObservation ? 'observed' : sawPrior ? 'prior' : 'none',
    notes,
  };
}

/**
 * The multiplier for one player's team. 1 for everybody the room has no
 * particular appetite for, which is almost everybody.
 */
export function teamMultiplier(result: TeamPriorResult, team: string | null | undefined): number {
  if (!team) return 1;
  return result.multipliers.get(team.trim().toUpperCase()) ?? 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
