/**
 * The vocabulary a waiver plan is written in.
 *
 * Everything in this folder answers one question — *who should I add, what
 * should I bid, who should I drop, and in what order should I enter the claims*
 * — and this file is the shape of the answer. It is deliberately the only file
 * here with no arithmetic in it, so that the contract the future Waivers UI
 * reads can be changed, reviewed and argued about without touching a model.
 *
 * ## Reason codes, not sentences
 *
 * Every other recommendation surface in this app carries `reasons: string[]`,
 * and that is right for a module whose output is already a card. This one is
 * not: a claim plan is read three ways — as a numbered list of instructions, as
 * a **See Why** sheet, and as an outcome tree — and prose written here would be
 * prose written for whichever of the three was imagined first. So a reason is a
 * {@link WaiverReasonCode} and the numbers behind it, and the wording belongs
 * to the lane that draws it.
 *
 * The codes are the *complete* list of things this planner knows how to say. A
 * new one is a deliberate act, which is the point: it makes the set of claims
 * the engine can make reviewable in one screen.
 *
 * ## Nothing here transacts
 *
 * Same rule as the rest of the app, restated because this is the module closest
 * to breaking it. A plan is a list of claims to type into Sleeper by hand. There
 * is no write path, no queue, no automation, and no function in this folder
 * that takes a session.
 */

import type { RosterShape, ScoringProfile } from '../../sleeper/scoring.ts';
import type { StartSitInput } from '../../startsit/engine.ts';
import { ROSTER_SPOT_GAIN } from '../../startsit/waivers.ts';
import type { HeldPlayer } from '../../roster/bench.ts';

/**
 * Everything the planner is able to say, said once.
 *
 * Grouped by what they are about rather than alphabetically, because the group
 * is the useful thing when a reader is deciding whether a new code is really
 * new.
 */
export type WaiverReasonCode =
  /* Why this add. */
  | 'add_enters_lineup'
  | 'add_fills_empty_slot'
  | 'add_bench_depth'
  | 'add_no_lineup_effect'
  /* Why this drop. */
  | 'drop_outside_lineup'
  | 'drop_covered_by_add'
  | 'drop_at_or_below_replacement'
  | 'drop_costs_lineup_points'
  | 'drop_leaves_position_bare'
  /* Why not this drop. */
  | 'protected_in_lineup'
  | 'protected_reserve_slot'
  | 'protected_core_value'
  | 'protected_unscorable'
  /* Why the pair was or was not worth it. */
  | 'net_gain_below_bar'
  | 'pair_opens_starting_slot'
  | 'no_eligible_drop'
  /* How this claim relates to the ones above it. */
  | 'blocked_by_earlier_claim'
  | 'fallback_for_earlier_claim'
  | 'independent_of_earlier_claim'
  | 'redundant_after_earlier_claim'
  | 'requires_second_drop'
  /* Money. */
  | 'bid_reused_from_pricing'
  | 'bid_unavailable'
  | 'budget_caps_simultaneous_claims'
  /* Not knowing things. */
  | 'roster_not_scorable'
  | 'target_not_scorable';

/**
 * One structured reason, and the numbers that make it checkable.
 *
 * `value` is in the same currency as everything else the planner produces —
 * roster utility, which is fantasy points — or null when the code is a
 * statement rather than a measurement. `playerId` is whoever the code is about,
 * which is not always the add or the drop: `blocked_by_earlier_claim` is about
 * a third player entirely.
 */
export interface WaiverReason {
  code: WaiverReasonCode;
  playerId?: string;
  position?: string;
  value?: number | null;
  /** The claim this reason points at, for the relationship codes. */
  claimId?: string;
}

/** How a claim stands to the claims listed above it. */
export type ClaimRelation = 'primary' | 'fallback' | 'compatible';

/**
 * How two targets stand to each other, worked out by simulation.
 *
 * Derived rather than labelled: the planner acquires A, re-runs the roster
 * utility, and asks what B is still worth. The four readings below are bands on
 * that one ratio — see `RELATION_BANDS` in `claimPlanner.ts`.
 */
export type TargetRelation = 'complement' | 'conditional_complement' | 'substitute' | 'redundant';

/** Why a rostered player is not on offer as a drop. */
export type ProtectionReason =
  | 'in_lineup'
  | 'reserve_slot'
  | 'core_value'
  | 'unscorable';

/**
 * What removing one rostered player costs, given one specific incoming player.
 *
 * The add is part of the question and not context around it: what a roster
 * loses by cutting its second tight end is a different number when a better
 * tight end is arriving than when a quarterback is.
 */
export interface DropCost {
  playerId: string;
  name: string;
  position: string;
  /**
   * Roster utility lost by removing him, once the add is already on the roster.
   *
   * `U(roster + add) − U(roster + add − drop)`, so it is add-specific by
   * construction rather than by adjustment. Null when he cannot be scored at
   * all, which is a protection reason rather than a zero.
   */
  cost: number | null;
  /** Points the recommended lineup loses. Zero for a player who is not in it. */
  lineupCost: number;
  /** What the bench slot was standing worth, net of what would replace it. */
  optionValue: number;
  /**
   * What holding him is worth before anything is netted off.
   *
   * The existing bench model's `slotValue`, carried so the ranking can break a
   * tie on *who is worth least* once several drops have come out equally free —
   * see `compareDrops`.
   */
  standingValue: number;
  /** True when the incoming player covers the slots this one was covering. */
  coveredByAdd: boolean;
  /** Set whenever he is not an ordinary waiver cut. */
  protection: ProtectionReason | null;
  reasons: WaiverReason[];
}

/** One add weighed against one drop. The real unit of a waiver decision. */
export interface AddDropPair {
  addPlayerId: string;
  addName: string;
  addPosition: string;
  /** Null only in the roster-has-room case, which waivers rarely is. */
  dropPlayerId: string | null;
  dropName: string | null;
  /** `U(roster + add) − U(roster)`. What he is worth before paying for him. */
  addValue: number;
  /** What the drop costs, given this add. Mirrors {@link DropCost.cost}. */
  dropCost: number;
  /** `addValue − dropCost`. The number the ranking is on. */
  netGain: number;
  /** Points the recommended starting lineup gains. A subset of `netGain`. */
  lineupGain: number;
  /** Startable bench bodies gained or lost. */
  depthChange: number;
  /** True when the move would leave a starting slot nothing can fill. */
  opensSlot: boolean;
  confidence: 'high' | 'medium' | 'low';
  reasons: WaiverReason[];
}

/**
 * One line of the plan: add this player, bid this, drop this one.
 *
 * `id` is stable within a plan and is what `dependsOn`, `blockedBy` and
 * `mutuallyExclusiveWith` point at, because a claim is identified by the pair
 * and not by the player — the A/B/C/D structure has the same target twice.
 */
export interface WaiverClaimRecommendation {
  id: string;
  /** 1-based, and the order the claims should be entered in Sleeper. */
  rank: number;
  addPlayerId: string;
  addName: string;
  addPosition: string;
  dropPlayerId: string | null;
  dropName: string | null;
  /**
   * What to bid, taken whole from the existing FAAB pass.
   *
   * Null when that pass withheld a figure, and never computed here — see
   * `claimPlanner.ts`. Two claims for the same target carry the same bid.
   */
  bid: number | null;
  doNotExceed: number | null;
  /** The pricing pass's own headline, carried unchanged for the sheet. */
  bidHeadline: string | null;
  netGain: number | null;
  relation: ClaimRelation;
  /** Claims that must succeed before this one can execute. */
  dependsOn: string[];
  /** Claims whose success makes this one impossible or pointless. */
  blockedBy: string[];
  /** Claims that cannot both execute, in either order. */
  mutuallyExclusiveWith: string[];
  reasons: WaiverReason[];
  /** The full pair arithmetic, for the See Why sheet. */
  pair: AddDropPair;
}

/** How two targets in the same plan interact. */
export interface TargetRelationship {
  firstPlayerId: string;
  secondPlayerId: string;
  relation: TargetRelation;
  /** What the second target is worth once the first has been acquired. */
  incrementalGain: number;
  /** What it was worth on its own. */
  standaloneGain: number;
  reasons: WaiverReason[];
}

/** One way the week can actually go. */
export interface WaiverOutcome {
  id: string;
  /** Claims that executed, in order. */
  claimIds: string[];
  addedPlayerIds: string[];
  droppedPlayerIds: string[];
  /** Roster utility against doing nothing. */
  netGain: number;
  /** What it costs, if every claim in it is won at the recommended bid. */
  spend: number | null;
  kind: 'best' | 'partial' | 'none';
}

/**
 * Bounds on a search that would otherwise be combinatorial.
 *
 * Every one of these is a product decision rather than a performance one: a
 * plan with nine claims in it is not a plan anybody follows, and a tenth waiver
 * target is not a target. They are exposed so a caller — or a test — can prove
 * the bound rather than trust it.
 */
export interface WaiverPlannerLimits {
  /** Waiver targets considered at all, best first. */
  maxTargets: number;
  /** Drops ranked per target. */
  maxDropsPerTarget: number;
  /** Claims a plan may contain. */
  maxClaims: number;
  /** Outcomes reported. */
  maxOutcomes: number;
  /** Roster utility a pair has to gain before it is worth recommending. */
  minNetGain: number;
}

export const DEFAULT_LIMITS: WaiverPlannerLimits = {
  maxTargets: 6,
  maxDropsPerTarget: 3,
  maxClaims: 4,
  maxOutcomes: 6,
  /*
   * Half a point of roster utility, and now the board's number too.
   *
   * Deliberately far below the start/sit engine's own `MIN_SWAP_GAIN` of 0.75,
   * because these are different transactions: a lineup swap that gains half a
   * point is noise the reader should not be asked to act on, and a waiver claim
   * that gains half a point is a free upgrade to a bench slot that was doing
   * nothing. What stops trivial claims being recommended is the bid, not this.
   *
   * It used to be a number this file owned alone, and that was the bug: the
   * planner takes its targets from the board, and the board admitted nobody
   * under a much higher bar, so this threshold could never actually be reached.
   * Reading the shared constant is what keeps the two from drifting apart
   * again — see `ROSTER_SPOT_GAIN`.
   */
  minNetGain: ROSTER_SPOT_GAIN,
};

/**
 * What the existing FAAB pass already decided about one target.
 *
 * A structural subset of `BidRecommendation` rather than that type itself, so
 * this folder never reaches into the pricing pipeline and a caller holding a
 * `PricedBid` satisfies it by construction. **The planner reads these fields
 * and computes none of them.**
 */
export interface PlannerBid {
  playerId: string;
  recommended: number | null;
  doNotExceed: number | null;
  headline?: string;
  /** Set when the pricing pass deliberately refused to quote a number. */
  withheld?: string | null;
}

/** One waiver target, as the planner needs it. */
export interface WaiverPlannerTarget {
  /** The same input shape the start/sit engine scores everybody else with. */
  input: StartSitInput;
  /** What the existing pricing pass said about him, when it ran. */
  bid?: PlannerBid | null;
  /**
   * Where the waiver board put him, when the caller has a ranking.
   *
   * Used only to choose *which* targets are considered when there are more than
   * {@link WaiverPlannerLimits.maxTargets} of them. It never overrides the pair
   * arithmetic, because a board rank is a statement about a player and a claim
   * is a statement about a roster.
   */
  boardRank?: number | null;
}

export interface WaiverPlannerInput {
  /** The user's own players. */
  roster: StartSitInput[];
  targets: WaiverPlannerTarget[];
  shape: RosterShape;
  profile: ScoringProfile;
  /**
   * Richer expendability signals, when the caller has them.
   *
   * Defaults to `buildHeldPlayers`, which is what the Team screen's bench view
   * already uses — so a drop this planner recommends and a drop that screen
   * ranks are working from one model. A caller that knows about handcuffs or
   * bye coverage can say so here.
   */
  held?: HeldPlayer[];
  /** Players on an injured-reserve slot, which is not a bench spot. */
  reserveIds?: string[];
  /**
   * What is left in the wallet, read from the existing budget state.
   *
   * `remaining: null` and `usesFaab: false` both mean the plan carries no
   * money — the claims are still ordered and still say who to drop.
   */
  budget?: { remaining: number | null; usesFaab: boolean } | null;
  limits?: Partial<WaiverPlannerLimits>;
  /** Reference time, injected so a plan is reproducible. */
  now?: string | Date;
  /** Stamped on the plan. Injected for the same reason. */
  generatedAt?: string;
}

/**
 * Whether the drop half of the advice can be given at all.
 *
 * `unavailable` is a real answer and the reason §20 of the brief exists: a
 * roster nothing can be scored on still deserves its add recommendation, and
 * must not be handed a confident cut to go with it.
 */
export type DropAdviceState = 'available' | 'unavailable';

export interface WaiverPlan {
  claims: WaiverClaimRecommendation[];
  outcomes: WaiverOutcome[];
  relationships: TargetRelationship[];
  /** Everybody the plan refuses to cut, and why. */
  protectedPlayers: { playerId: string; name: string; reason: ProtectionReason }[];
  /** Ranked drop cost per target, so **See Why** can show the runners-up. */
  dropRanking: { addPlayerId: string; drops: DropCost[] }[];
  dropAdvice: DropAdviceState;
  /** Highest total spend across any outcome where every claim in it wins. */
  maxSimultaneousSpend: number | null;
  reasons: WaiverReason[];
  limits: WaiverPlannerLimits;
  /** How much work the search actually did, for the bound to be provable. */
  search: { targetsConsidered: number; pairsEvaluated: number; lineupsEvaluated: number };
  generatedAt: string;
}
