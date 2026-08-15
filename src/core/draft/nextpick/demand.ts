/**
 * What the manager holding this pick still needs.
 *
 * The simulator asks this once per simulated pick, of the roster as it stands
 * *at that moment* — so a manager with two picks in a row is not asked the same
 * question twice, and the tight end he takes at 61 is why he is unlikely to
 * take another at 62.
 *
 * Two things about this deserve stating plainly, because the obvious version of
 * each is wrong.
 *
 * **Need is not a boolean.** "He has a running back, so running back is
 * covered" describes nobody. A league that starts two backs and a flex leaves a
 * manager with one back shopping hard, and a manager with three still
 * interested. The bar is the league's own starting requirement, then its flex
 * slots, then depth — read from Sleeper, never assumed.
 *
 * **Positions do not behave alike, and the league says which is which.** A
 * manager with one quarterback in a one-quarterback league has solved
 * quarterback; a manager with one receiver in a league that starts three has
 * not started. Rather than hardcode "QB and TE are the strict ones", the rule
 * is derived: a position the league starts two or more of behaves like depth,
 * and a position it starts one of behaves like a slot you close. In a superflex
 * league quarterback becomes a depth position by the same rule, which is
 * exactly how superflex drafts actually run.
 *
 * Nothing here is a hard exclusion. A manager who has his quarterback can still
 * take one — people do — and a model that said otherwise would be more confident
 * than the thing it is modelling.
 */

import type { RosterShape } from '../../sleeper/scoring.ts';

/**
 * Every number the demand model turns on, in one place, bounded on purpose.
 *
 * These are assumptions, not measurements. No public dataset of "how much more
 * likely is a manager to take a tight end when his tight end slot is empty"
 * exists that this project can use, so they are set to the smallest values that
 * reproduce the behaviour a drafter would recognise, and the directional tests
 * pin the behaviour rather than the numbers.
 */
export const DEMAND = {
  /** A position the league starts this many of is a depth position, not a slot. */
  depthThreshold: 2,
  /** How much an unfilled dedicated starting slot lifts a position. */
  starterBoost: 0.8,
  /** What is left of a single-slot position once its starter is in place. */
  singleFilled: 0.3,
  /**
   * What is left of a depth position once its starters are in place.
   *
   * Deliberately close to one. Managers keep taking backs and receivers all
   * draft — for the flex, for the bench, because they are the positions that
   * get hurt — and a model that dropped them to a quarterback's post-starter
   * level would have the room stop drafting them in round eight, which is
   * roughly when the room drafts most of them.
   */
  depthFilled: 0.85,
  /** An open flex slot this position could fill. */
  flexBoost: 0.35,
  /** Extra appetite for depth positions once the draft is mostly bench. */
  lateDepthAppetite: 0.2,
  /** Where "late" starts, as a share of the draft. */
  lateFrom: 0.6,
  /** Nothing is impossible and nothing is certain. */
  min: 0.15,
  max: 2.2,
  /**
   * How much of all this applies at the very start of a draft.
   *
   * In the first round every roster is empty, so every slot is unfilled and a
   * need model with full authority would have twelve managers all desperate for
   * a quarterback. They are not: early drafting is a market, and roster
   * construction is something that starts to bite once there are enough picks
   * behind it to have a shape. So the whole need signal is scaled from a
   * quarter at pick one up to its full (already bounded) strength by the middle
   * of the draft.
   */
  earlyPhaseWeight: 0.25,
  /** Share of the draft by which need carries its full weight. */
  fullPhaseBy: 0.45,
} as const;

/** Positions already on a manager's roster, by canonical position. */
export type PositionCounts = Record<string, number>;

export interface DemandContext {
  shape: RosterShape;
  /** 0 at the first pick of the draft, 1 at the last. */
  progress: number;
}

export interface PositionDemandDetail {
  position: string;
  /** Dedicated starting slots still empty. */
  startersUnfilled: number;
  /** Flex slots this position could still fill. */
  flexOpen: number;
  /** True when the league starts enough of this position for depth to matter. */
  depthPosition: boolean;
  /**
   * The multiplier the simulator uses, centred on 1.
   *
   * Above 1 the manager is likelier than the market alone to take this
   * position; below 1, less likely. Bounded by `DEMAND.min`/`DEMAND.max` and
   * pulled toward 1 early in the draft.
   */
  multiplier: number;
  /** 0..1, how much of a starting requirement is still open. Drives need share. */
  need: number;
}

/**
 * How the draft phase scales the whole need signal. In [earlyPhaseWeight, 1].
 */
export function phaseWeight(progress: number): number {
  const p = clamp(progress, 0, 1);
  const ramp = clamp(p / DEMAND.fullPhaseBy, 0, 1);
  return round3(DEMAND.earlyPhaseWeight + (1 - DEMAND.earlyPhaseWeight) * ramp);
}

/**
 * Which positions the league starts, in the order the caller will iterate them.
 *
 * Dedicated slots first, then anything only a flex slot accepts, so a league
 * with a flex and no tight-end slot still has tight ends in play.
 */
export function positionsInPlay(shape: RosterShape): string[] {
  const out: string[] = [];
  for (const position of Object.keys(shape.starters)) if (!out.includes(position)) out.push(position);
  for (const flex of shape.flex) for (const position of flex.positions) if (!out.includes(position)) out.push(position);
  return out;
}

/**
 * The league's roster rules, flattened into arrays indexed by position.
 *
 * Built once per board and reused for every simulated pick. The simulator asks
 * this question tens of thousands of times per board — once per pick, per
 * simulation, because a manager's second pick has to see the roster his first
 * pick produced — and the readable version of the calculation allocates a map, a
 * pile of small objects and two records each time it is called. At that
 * frequency the allocation costs several times what the arithmetic does.
 *
 * So there is one implementation, in `demandInto` below, working on numbers; the
 * map-returning `positionDemand` is a thin wrapper over it for tests,
 * diagnostics and anything else that would rather read the result than count it.
 */
export interface DemandPlan {
  positions: string[];
  /** Dedicated starting slots the league requires, per position. */
  required: Float64Array;
  /** 1 where the league starts enough of a position for depth to matter. */
  depth: Uint8Array;
  /** Each flex slot, as the position indices it accepts. */
  flexSlots: Int32Array[];
}

export function buildDemandPlan(shape: RosterShape, positions: string[] = positionsInPlay(shape)): DemandPlan {
  const index = new Map(positions.map((position, i) => [position, i]));
  const required = new Float64Array(positions.length);
  positions.forEach((position, i) => (required[i] = shape.starters[position] ?? 0));

  /*
   * A superflex slot is a quarterback slot, and is counted as one.
   *
   * Sleeper's `SUPER_FLEX` accepts quarterbacks, backs, receivers and tight
   * ends, which as a shared flex would leave a superflex league's quarterback
   * demand looking like a normal league's: one starter, filled, done. That is
   * the single most wrong thing this model could say about a superflex draft,
   * where the second quarterback is the whole point and the room takes twenty
   * of them. So the slot is folded into the quarterback requirement instead of
   * being shared — which is the league's own roster definition deciding, not a
   * hardcoded opinion about football, and it keeps ordinary W/R/T flex
   * semantics exactly as they were everywhere else.
   *
   * Counted in one place only. A slot that raises the requirement must not also
   * appear as an open flex slot for the same position, or the two boosts stack.
   */
  const qb = index.get('QB');
  const sharedFlex: Int32Array[] = [];
  for (const flex of shape.flex) {
    if (qb != null && flex.positions.includes('QB')) {
      required[qb] = required[qb]! + 1;
      continue;
    }
    sharedFlex.push(new Int32Array(flex.positions.map((p) => index.get(p) ?? -1).filter((i) => i >= 0)));
  }

  const depth = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i++) depth[i] = required[i]! >= DEMAND.depthThreshold ? 1 : 0;
  return { positions, required, depth, flexSlots: sharedFlex };
}

/** Scratch space for `demandInto`, so the hot path allocates nothing at all. */
export interface DemandScratch {
  surplus: Float64Array;
  flexOpen: Float64Array;
}

export function createDemandScratch(size: number): DemandScratch {
  return { surplus: new Float64Array(size), flexOpen: new Float64Array(size) };
}

/**
 * The model itself: fill `outMultiplier` and `outNeed` for one manager.
 *
 * `counts` is indexed the same way as `plan.positions`, offset by `countsFrom`
 * so a caller can keep every manager's roster in one flat array.
 */
export function demandInto(
  counts: Float64Array,
  countsFrom: number,
  plan: DemandPlan,
  progress: number,
  scratch: DemandScratch,
  outMultiplier: Float64Array,
  outNeed: Float64Array,
  outFlexOpen?: Float64Array,
): void {
  const n = plan.positions.length;

  /*
   * Flex first, because it depends on what the dedicated slots did not use.
   *
   * A receiver only fills a flex once the receiver slots are full, so the
   * surplus is counted, spent greedily against the flex slots the league
   * actually has, and whatever is left over is a flex slot still shopping.
   */
  for (let i = 0; i < n; i++) {
    scratch.surplus[i] = Math.max(0, counts[countsFrom + i]! - plan.required[i]!);
    scratch.flexOpen[i] = 0;
  }
  for (const slot of plan.flexSlots) {
    let filled = false;
    for (let k = 0; k < slot.length; k++) {
      const i = slot[k]!;
      if (scratch.surplus[i]! > 0) {
        scratch.surplus[i] = scratch.surplus[i]! - 1;
        filled = true;
        break;
      }
    }
    if (filled) continue;
    for (let k = 0; k < slot.length; k++) scratch.flexOpen[slot[k]!] = scratch.flexOpen[slot[k]!]! + 1;
  }

  const weight = phaseWeight(progress);
  const lateness = clamp((clamp(progress, 0, 1) - DEMAND.lateFrom) / (1 - DEMAND.lateFrom), 0, 1);

  for (let i = 0; i < n; i++) {
    const required = plan.required[i]!;
    const startersUnfilled = Math.max(0, required - counts[countsFrom + i]!);
    const flexOpen = scratch.flexOpen[i]!;
    const depthPosition = plan.depth[i] === 1;

    let raw =
      startersUnfilled > 0
        ? 1 + DEMAND.starterBoost * Math.min(1, startersUnfilled)
        : depthPosition
          ? DEMAND.depthFilled
          : DEMAND.singleFilled;

    /*
     * An open flex slot is a real reason to take a player, and the only reason
     * a tight end is still in play once the TE slot is full.
     *
     * `flexOpen` is already the league's own answer — it is counted from the
     * slots this league actually has and what each of them accepts — so there is
     * no second eligibility test here. Adding one was a bug: it applied the
     * generic W/R/T rule on top, which silently excluded every position a
     * league's own flex accepts and the standard flex does not.
     */
    if (flexOpen > 0) raw *= 1 + DEMAND.flexBoost;
    if (outFlexOpen) outFlexOpen[i] = flexOpen;

    // Late on, the bench is what is being drafted, and benches are made of
    // backs and receivers.
    if (depthPosition) raw *= 1 + DEMAND.lateDepthAppetite * lateness;

    // Pulled toward 1 — "the market decides" — by however early it still is.
    outMultiplier[i] = 1 + (clamp(raw, DEMAND.min, DEMAND.max) - 1) * weight;

    /*
     * The share of this manager's attention that is need rather than market.
     *
     * Separate from the multiplier, and deliberately so: the multiplier says
     * how much this position is favoured, while `need` says how much of the
     * decision is about filling a slot at all. The simulator uses the first to
     * tilt the market and the second to decide how many alternatives protect a
     * player — a need-driven manager takes *a* tight end, so eight of them
     * share the risk; a market-driven one takes *the best player*, and having
     * seven similar teammates does not help the eighth.
     */
    outNeed[i] =
      startersUnfilled > 0
        ? Math.min(1, startersUnfilled / Math.max(1, required))
        : flexOpen > 0
          ? 0.5
          : depthPosition
            ? 0.2
            : 0.05;
  }
}

/**
 * The demand multiplier for every position in play, for one manager, right now.
 *
 * The readable face of `demandInto` — same arithmetic, same constants, one
 * implementation. Used by the tests, the probe and anything that wants to look
 * at the answer rather than sample from it.
 */
export function positionDemand(
  counts: PositionCounts,
  ctx: DemandContext,
  positions: string[] = positionsInPlay(ctx.shape),
): Map<string, PositionDemandDetail> {
  const plan = buildDemandPlan(ctx.shape, positions);
  const flat = new Float64Array(positions.length);
  positions.forEach((position, i) => (flat[i] = counts[position] ?? 0));
  const multiplier = new Float64Array(positions.length);
  const need = new Float64Array(positions.length);
  const flexOpen = new Float64Array(positions.length);
  demandInto(flat, 0, plan, ctx.progress, createDemandScratch(positions.length), multiplier, need, flexOpen);

  const out = new Map<string, PositionDemandDetail>();
  positions.forEach((position, i) => {
    out.set(position, {
      position,
      // From the plan's requirement, not the league's raw starter count, so a
      // superflex league reports the second quarterback slot it really has.
      startersUnfilled: Math.max(0, plan.required[i]! - (counts[position] ?? 0)),
      flexOpen: flexOpen[i]!,
      depthPosition: plan.depth[i] === 1,
      multiplier: round3(multiplier[i]!),
      need: round3(need[i]!),
    });
  });
  return out;
}

/**
 * What a manager whose roster could not be read is assumed to want.
 *
 * A middling, position-blind need: enough that he still behaves like somebody
 * building a team rather than a pure market index, and not so much that the
 * model invents a specific hole he may not have. His multiplier stays at 1
 * throughout — the market alone decides *which* position — and the degraded
 * flag says out loud that this happened.
 */
export const UNKNOWN_MANAGER_NEED = 0.35;

/** The same thing as a readable map, for diagnostics and tests. */
export function unknownManagerDemand(positions: string[]): Map<string, PositionDemandDetail> {
  const out = new Map<string, PositionDemandDetail>();
  for (const position of positions) {
    out.set(position, {
      position,
      startersUnfilled: 0,
      flexOpen: 0,
      depthPosition: false,
      multiplier: 1,
      need: UNKNOWN_MANAGER_NEED,
    });
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
