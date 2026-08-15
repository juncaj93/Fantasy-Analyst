/**
 * What you do if he does not play — worked out before you need it.
 *
 * A questionable starter is two decisions, not one. The first is whether to
 * start him, which the lineup optimiser already answers. The second is what
 * happens at 11:58 on Sunday when he is inactive, and that one is always made
 * badly, because it is made in two minutes by somebody who has just seen the
 * news. This precomputes it.
 *
 * ## The three plans, and why the last two are different
 *
 * *Plan A* is the lineup as recommended. *Plan B* is the same roster with him
 * out and **the news arriving early** — before the rest of the slate has
 * kicked off, so everybody is still available to move into the slot. *Plan C*
 * is the news arriving **late**, at his own kickoff, when the one o'clock games
 * have started and every player in them is frozen wherever Plan A left them.
 *
 * B and C are not the same lineup and are frequently not close. A bench
 * receiver who covers the slot beautifully at ten in the morning is unavailable
 * at four; that is the entire reason this module exists, and it is why the two
 * are computed separately rather than one being derived from the other.
 *
 * ## Computed by the optimiser, not beside it
 *
 * Every plan is a real {@link recommendLineup} call with one input removed and
 * the clock moved. Slot legality, flex rules, the Out gate, locked starters and
 * the mode all come from the optimiser because they *are* the optimiser — a
 * second implementation of "which slots may this player fill" is exactly the
 * kind of thing that agrees for a season and then disagrees in week 15 of a
 * league with a REC_FLEX.
 *
 * ## Waiver pivots are labelled, and never assumed
 *
 * A plan may only use players on the roster. When a free agent would genuinely
 * cover the hole better than anybody rostered, it is reported as a separate,
 * explicitly-labelled `waiverPivot` — advisory, never folded into a plan's
 * points, and never added, claimed or queued by anything in this app.
 *
 * ## And it stays quiet
 *
 * A tree is built only where the risk is material: a starter whose availability
 * is genuinely in question, or one whose absence would leave a slot that cannot
 * be filled. Everybody else produces nothing, because a contingency plan for a
 * healthy player is clutter with a chart on it.
 */

import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { evaluatePlayer, type StartSitInput } from './engine.ts';
import { recommendLineup, type LineupRecommendation } from './lineup.ts';
import type { StartSitMode } from './mode.ts';

export const CONTINGENCY = {
  /**
   * How long before his kickoff the "late" news is modelled as arriving.
   *
   * One minute. Inactives are published ninety minutes out, but the case worth
   * planning for is the one where the decision is taken as late as it can be
   * taken — anything earlier is a strictly easier version of the same problem.
   */
  lateNewsLeadMinutes: 1,
  /** Points a waiver pivot must beat the best rostered cover by to be named. */
  waiverPivotGain: 1.5,
} as const;

export type PlanKey = 'active' | 'inactive_early' | 'inactive_late';

export const PLAN_LABEL: Record<PlanKey, string> = {
  active: 'Plan A · he plays',
  inactive_early: 'Plan B · out, and you know before kickoff',
  inactive_late: 'Plan C · out, announced at his kickoff',
};

export interface ContingencyPlan {
  key: PlanKey;
  label: string;
  /** The slot that changes hands, when one does. */
  slot: string | null;
  replacementId: string | null;
  replacementName: string | null;
  /** The whole lineup's points under this plan. Null when nothing is scorable. */
  points: number | null;
  /** Points below Plan A. Zero for Plan A itself. */
  loss: number | null;
  /** False when no legal replacement exists and the slot would sit empty. */
  feasible: boolean;
  detail: string;
}

export interface WaiverPivot {
  playerId: string;
  name: string;
  position: string;
  /** Points better than the best rostered cover under the late plan. */
  gain: number;
  detail: string;
}

export interface ReplacementTree {
  playerId: string;
  name: string;
  position: string;
  slot: string | null;
  plans: ContingencyPlan[];
  waiverPivot: WaiverPivot | null;
  /** True when this is worth showing at all. */
  material: boolean;
  reason: string;
  notes: string[];
}

export interface ContingencyOptions {
  roster: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
  mode?: StartSitMode;
  now?: string | Date;
  currentStarterIds?: string[];
  /**
   * Unrostered players worth considering as a pivot.
   *
   * Bounded by the caller, exactly as `recommendWaiverUpgrades` expects it to
   * be: this module scores what it is given and does not go looking.
   */
  waiverCandidates?: StartSitInput[];
}

/**
 * Every tree worth showing, biggest exposure first.
 *
 * The starters are read off Plan A rather than off Sleeper's current lineup,
 * because a contingency for a player the app is not recommending is a plan for
 * a lineup nobody is going to field.
 */
export function contingencyPlans(opts: ContingencyOptions): ReplacementTree[] {
  const now = opts.now ?? new Date();
  const planA = recommendLineup(opts.roster, opts.shape, opts.profile, {
    mode: opts.mode,
    now,
    currentStarterIds: opts.currentStarterIds,
  });

  const trees = planA.slots
    .filter((slot) => slot.playerId != null)
    .map((slot) => replacementTree(slot.playerId!, { ...opts, now }, planA))
    .filter((tree): tree is ReplacementTree => tree != null && tree.material);

  return trees.sort((a, b) => worstLoss(b) - worstLoss(a));
}

/**
 * One starter's tree.
 *
 * Returns null when he is not in the recommended lineup at all — a bench
 * player's absence changes nothing that needs planning.
 */
export function replacementTree(
  playerId: string,
  opts: ContingencyOptions,
  precomputedPlanA?: LineupRecommendation,
): ReplacementTree | null {
  const now = opts.now ?? new Date();
  const planA =
    precomputedPlanA ??
    recommendLineup(opts.roster, opts.shape, opts.profile, {
      mode: opts.mode,
      now,
      currentStarterIds: opts.currentStarterIds,
    });

  const slot = planA.slots.find((s) => s.playerId === playerId);
  if (!slot || !slot.playerId) return null;

  const input = opts.roster.find((r) => r.player.id === playerId);
  if (!input) return null;
  const evaluation = evaluatePlayer({ ...input, mode: opts.mode ?? 'balanced', now: input.now ?? now }, opts.profile);

  // Already kicked off: there is no decision left to plan.
  if (evaluation.lock.locked) return null;

  const without = opts.roster.filter((r) => r.player.id !== playerId);
  const kickoff = evaluation.lock.kickoff;

  const early = recommendLineup(without, opts.shape, opts.profile, {
    mode: opts.mode,
    now,
    currentStarterIds: planA.slots.map((s) => s.playerId).filter((id): id is string => id != null),
  });

  /*
   * The late plan runs the clock forward to just before his kickoff.
   *
   * That single argument is what makes Plan C real: `recommendLineup` locks
   * everybody whose game has started, keeps locked starters in their slots, and
   * fills what is left from whoever can still be moved. The plan therefore
   * inherits every rule about lock and legality without restating one of them.
   */
  const lateClock = kickoff
    ? new Date(Date.parse(kickoff) - CONTINGENCY.lateNewsLeadMinutes * 60_000)
    : new Date(now);
  const late = kickoff
    ? recommendLineup(without, opts.shape, opts.profile, {
        mode: opts.mode,
        now: lateClock,
        currentStarterIds: planA.slots.map((s) => s.playerId).filter((id): id is string => id != null),
      })
    : early;

  const plans: ContingencyPlan[] = [
    {
      key: 'active',
      label: PLAN_LABEL.active,
      slot: slot.slot,
      replacementId: slot.playerId,
      replacementName: slot.name,
      points: round2(planA.recommendedPoints),
      loss: 0,
      feasible: true,
      detail: `${slot.name} starts at ${slot.slot}.`,
    },
    planFrom('inactive_early', slot.slot, planA, early, playerId),
    planFrom('inactive_late', slot.slot, planA, kickoff ? late : early, playerId),
  ];

  if (!kickoff) {
    plans[2] = {
      ...plans[2]!,
      detail: `${plans[2]!.detail} Kickoff time unknown, so early and late are the same plan.`,
    };
  }

  const waiverPivot = bestWaiverPivot(opts, plans[2]!, playerId, lateClock);

  const material =
    evaluation.availability.risky ||
    plans.some((p) => !p.feasible) ||
    (plans[2]!.loss ?? 0) >= 3;

  return {
    playerId,
    name: evaluation.name,
    position: evaluation.position,
    slot: slot.slot,
    plans,
    waiverPivot,
    material,
    reason: material
      ? evaluation.availability.risky
        ? (evaluation.availability.detail ?? evaluation.availability.label)
        : plans.some((p) => !p.feasible)
          ? 'no legal replacement for this slot'
          : 'losing him late would cost the lineup real points'
      : 'no material risk',
    notes: kickoff ? [] : ['no kickoff time for his game, so the late plan could not be separated from the early one'],
  };
}

/** One alternative lineup, described as the change it makes to Plan A. */
function planFrom(
  key: PlanKey,
  slotName: string,
  planA: LineupRecommendation,
  plan: LineupRecommendation,
  removedPlayerId: string,
): ContingencyPlan {
  /*
   * The replacement is whoever is now starting who was not before.
   *
   * Found that way rather than by reading the slot the missing player had:
   * `RB`, `WR` and `FLEX` are slot *names* and a league starts several of some
   * of them, so a lookup by name returns whichever one came first in the shape
   * — usually a player who was already starting and has not moved at all. What
   * a person wants to be told is who came off the bench.
   */
  const before = new Set(planA.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const replacement =
    plan.slots
      .filter((s) => s.playerId != null && s.playerId !== removedPlayerId && !before.has(s.playerId))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  const points = round2(plan.recommendedPoints);
  const loss = round2(planA.recommendedPoints - plan.recommendedPoints);

  /*
   * "Feasible" is about the whole lineup, not about one slot.
   *
   * With a real flex, losing a receiver is often covered by moving somebody
   * across rather than by filling his slot with another receiver — so a slot
   * that reads empty here can still be a perfectly good lineup. The honest test
   * is whether every slot the league starts has somebody in it.
   */
  const empty = plan.slots.filter((s) => s.playerId == null);
  const feasible = empty.length === 0;

  return {
    key,
    label: PLAN_LABEL[key],
    slot: slotName,
    replacementId: replacement?.playerId ?? null,
    replacementName: replacement?.name ?? null,
    points,
    loss,
    feasible,
    detail: feasible
      ? replacement
        ? `${replacement.name} takes ${replacement.slot === slotName ? slotName : `${replacement.slot} and the lineup shifts around it`}, giving up ${loss.toFixed(1)} pts.`
        : `The lineup reshuffles around the hole and gives up ${loss.toFixed(1)} pts.`
      : `No legal starter is left for ${empty.map((s) => s.slot).join(', ')} — that slot sits empty.`,
  };
}

/**
 * The best unrostered cover, when one is genuinely better than the bench.
 *
 * Measured against the *late* plan, because that is the plan a pickup is for:
 * if the bench covers it early, the answer is the bench. Scored on the same
 * clock as that plan so an added player whose own game has already started is
 * not offered as a solution.
 */
function bestWaiverPivot(
  opts: ContingencyOptions,
  latePlan: ContingencyPlan,
  removedPlayerId: string,
  lateClock: Date,
): WaiverPivot | null {
  const candidates = opts.waiverCandidates ?? [];
  if (candidates.length === 0) return null;

  const roster = opts.roster.filter((r) => r.player.id !== removedPlayerId);
  let best: WaiverPivot | null = null;

  for (const candidate of candidates) {
    const plan = recommendLineup([...roster, candidate], opts.shape, opts.profile, {
      mode: opts.mode,
      now: lateClock,
      currentStarterIds: opts.currentStarterIds,
    });
    const started = plan.slots.some((s) => s.playerId === candidate.player.id);
    if (!started) continue;
    const gain = round2(plan.recommendedPoints - (latePlan.points ?? 0));
    if (gain < CONTINGENCY.waiverPivotGain) continue;
    if (best && gain <= best.gain) continue;
    best = {
      playerId: candidate.player.id,
      name: candidate.player.fullName,
      position: candidate.player.position,
      gain,
      detail: `${candidate.player.fullName} is unrostered and would cover this better than the bench, by ${gain.toFixed(1)} pts — a waiver pivot, not a lineup move.`,
    };
  }
  return best;
}

function worstLoss(tree: ReplacementTree): number {
  return Math.max(...tree.plans.map((p) => p.loss ?? 0));
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
