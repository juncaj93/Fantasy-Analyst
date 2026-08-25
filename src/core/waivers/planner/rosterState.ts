/**
 * One number for how good a roster is, and a way to ask what a move does to it.
 *
 * Everything else in this folder is subtraction. The drop cost, the add value,
 * the net gain of a pair, whether a second claim is worth making after the
 * first one landed, whether two targets are substitutes — all of them are two
 * calls to {@link RosterSimulation.utility} with a minus sign between them. That
 * is the whole design, and it is why there is no separate "add model" and "drop
 * model" here to drift apart from each other.
 *
 * ## Why a lineup total is not enough on its own
 *
 * The obvious utility function is the optimiser's recommended points, and it is
 * wrong in a way that matters specifically to waivers. A lineup total is blind
 * to the bench: it scores a roster holding one tight end exactly the same as a
 * roster holding two, right up until the moment the first one is ruled out on a
 * Sunday morning. A waiver claim is very often *about* that bench — a stash, a
 * handcuff, cover for a bye — so a planner that ranked by lineup points would
 * cheerfully recommend cutting the only backup at a position to add a fourth
 * receiver who never starts.
 *
 * So utility is three things, and they are genuinely different things rather
 * than one thing counted three times:
 *
 *   1. **the lineup**, which is what this Sunday is actually worth;
 *   2. **the bench, as options**, which is what the roster is worth if one of
 *      those starters does not play — discounted, because an option is not a
 *      certainty, and net of whatever would replace him, because a slot whose
 *      occupant the wire matches is a slot earning nothing;
 *   3. **cover**, a flat charge for every position the league must start and
 *      the roster has no spare body at.
 *
 * Term 2 is the existing bench valuation — `roster/bench.ts`, the same model
 * the Team screen ranks a bench with — and not a second opinion about it. This
 * module supplies the one thing that model cannot know on its own: what a slot
 * would be replaced by *in a hypothetical roster that does not exist yet*.
 *
 * ## Add-specificity is not a feature here, it is an accident of subtraction
 *
 * The brief asks for a drop ranking that changes depending on who is arriving.
 * Nothing below implements that. What it implements is a function of a set of
 * player ids, and the ranking changes because
 * `U(roster + TE − oldTE) − U(roster + TE)` and
 * `U(roster + QB − oldTE) − U(roster + QB)` are subtractions over different
 * sets. A hand-written "incoming player covers this one" adjustment would be a
 * second model to keep honest; this cannot disagree with itself.
 *
 * ## Pure, immutable, memoised
 *
 * A state is a sorted list of ids. Nothing is mutated, the same set is never
 * evaluated twice, and the optimiser call count is reported so a test can hold
 * the bound rather than trust it.
 */

import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from '../../startsit/engine.ts';
import { recommendLineup } from '../../startsit/lineup.ts';
import { valueOfSlot, type HeldPlayer } from '../../roster/bench.ts';
import { buildHeldPlayers } from '../../roster/held.ts';
import type { RosterShape, ScoringProfile } from '../../sleeper/scoring.ts';

/**
 * How much of a bench player's standing worth counts towards the roster.
 *
 * A bench slot pays only in the weeks it is called on, and the great majority
 * of bench players are never called on at all. Counting the whole of a backup's
 * value would make a roster of eleven usable players score like a roster of
 * eleven starters, and would price every drop as though the man being cut were
 * about to play.
 *
 * A third, roughly: the share of a season in which a given bench spot actually
 * decides something — a bye, an inactive, a late scratch. It is a blunt
 * constant rather than a per-player probability for the same reason
 * `INSURANCE_DISCOUNT` in `roster/bench.ts` is: this app cannot honestly
 * estimate the per-player version, and a confident number under the second
 * largest term in the model would be worse than an admitted approximation.
 */
export const BENCH_OPTION_WEIGHT = 0.35;

/**
 * What it costs to have no spare body at a position the league must start.
 *
 * Charged flat, and only once per position. The case it exists for is the one
 * where the arithmetic otherwise reads perfectly: dropping the only backup
 * tight end costs the lineup nothing this week, costs almost nothing in option
 * value if the wire has tight ends, and leaves the roster one hamstring from a
 * slot it cannot fill. That last fact is not visible in either of the other two
 * terms, so it is charged here.
 *
 * A position that is already *short* — fewer bodies than slots — is not charged
 * more, because the optimiser has already left a slot empty and that costs far
 * more than this.
 */
export const BARE_POSITION_COST = 1.5;

/**
 * A score at or below which a player is not a body.
 *
 * Zero, matching the start/sit engine's own floor for an unplayable player.
 * Inventing a second bar here would mean this module and the Team screen
 * disagreeing about who is startable.
 */
export const STARTABLE_FLOOR = 0;

/**
 * Positions this planner does not have an opinion about.
 *
 * A defence is a waiver claim, frequently the most consequential one of the
 * week — and it belongs to the DST planner, which knows about transaction cost,
 * how long a streamed defence survives and what a playoff stash is worth. None
 * of that is in this file, and a generic net-roster-gain number computed
 * without it would be a second, worse answer to a question already owned
 * elsewhere.
 *
 * So a defence is excluded from the *cover* term and from generic drop
 * eligibility, and defences on the roster still contribute their real points to
 * the lineup total, because pretending a rostered defence scores nothing would
 * corrupt every other number here. See `boundaries` in `index.ts` for where the
 * hand-off is made explicit.
 */
export const PLANNER_EXCLUDED_POSITIONS: ReadonlySet<string> = new Set(['DEF']);

export function plannerExcluded(position: string | null | undefined): boolean {
  return PLANNER_EXCLUDED_POSITIONS.has(String(position ?? '').toUpperCase());
}

/** A slot the league starts, and the positions it accepts. */
interface SlotSpec {
  slot: string;
  accepts: ReadonlySet<string>;
}

/**
 * The starting slots, rebuilt from the league's own shape.
 *
 * The optimiser builds the same list privately and this cannot read it. Rather
 * than export a function out of `lineup.ts` — a file two other lanes are
 * actively editing — the four lines are derived here from the public
 * {@link RosterShape}, which is the same source the optimiser derives them
 * from. If the two ever disagree, they disagree about `RosterShape`, and that
 * is a fact worth finding out.
 */
function slotsOf(shape: RosterShape): SlotSpec[] {
  const slots: SlotSpec[] = [];
  for (const [position, count] of Object.entries(shape.starters ?? {})) {
    for (let i = 0; i < count; i++) slots.push({ slot: position, accepts: new Set([position]) });
  }
  for (const flex of shape.flex ?? []) slots.push({ slot: flex.slot, accepts: new Set(flex.positions) });
  return slots;
}

/** One evaluated roster, or hypothetical roster. Immutable. */
export interface RosterStateView {
  /** Sorted, so two spellings of one set are one state. */
  playerIds: readonly string[];
  /** Who the optimiser starts. */
  starterIds: ReadonlySet<string>;
  /** Everybody else, startable or not. */
  benchIds: readonly string[];
  /**
   * Players who could actually be put in a slot: scorable, above the floor, not
   * ruled out, and not on an injured-reserve slot. Every one of those
   * exclusions is the difference between a roster that is covered and one that
   * only looks covered.
   */
  startableIds: readonly string[];
  /** Recommended starting points. */
  lineupPoints: number;
  /** Starting slots nothing on this roster can fill. */
  emptySlots: number;
  /** The whole number: lineup, plus discounted bench options, less cover. */
  utility: number;
  /** Per-bench-player option value, for explaining a drop cost. */
  optionValueOf: ReadonlyMap<string, number>;
  /** Positions the league must start and this roster has no spare at. */
  barePositions: readonly string[];
}

export interface RosterSimulationInput {
  /** Every player the plan can reason about: the roster and the targets. */
  pool: readonly StartSitInput[];
  /** The user's own players, as the roster stands. */
  rosterIds: readonly string[];
  /** The subset of the pool that is unrostered — the wire. */
  wireIds: readonly string[];
  shape: RosterShape;
  profile: ScoringProfile;
  /** Caller-supplied expendability signals, per player id. Optional. */
  held?: readonly HeldPlayer[];
  reserveIds?: readonly string[];
  now?: string | Date;
}

export interface RosterSimulation {
  /** Every player scored once, whether or not any state contains them. */
  evaluationOf: ReadonlyMap<string, StartSitEvaluation>;
  positionOf: ReadonlyMap<string, string>;
  nameOf: ReadonlyMap<string, string>;
  valueOf: ReadonlyMap<string, number>;
  /** Players the engine could not score. Never cut, never counted as depth. */
  unscored: ReadonlySet<string>;
  /** Standing worth of holding each player, from the existing bench model. */
  slotValueOf: ReadonlyMap<string, number>;
  reserveIds: ReadonlySet<string>;
  /** The roster as it stands. */
  baseline: RosterStateView;
  /** Evaluate any hypothetical roster. Memoised on the id set. */
  stateOf(playerIds: readonly string[]): RosterStateView;
  /** Roster utility of a hypothetical roster. */
  utility(playerIds: readonly string[]): number;
  /** The baseline with these players added and those removed. Pure. */
  after(opts: { add?: readonly string[]; remove?: readonly string[] }): readonly string[];
  /** How many distinct lineups the optimiser was actually asked for. */
  lineupsEvaluated(): number;
}

/**
 * Score the pool once, then answer any number of what-ifs from it.
 *
 * Construction is the expensive half — one `evaluatePlayer` per player in the
 * pool and one optimiser run for the baseline — and it happens exactly once
 * per plan. Every hypothetical afterwards is one optimiser call on a set that
 * has not been seen before, and none at all on a set that has.
 */
export function buildRosterSimulation(input: RosterSimulationInput): RosterSimulation {
  const { shape, profile } = input;
  const now = input.now ?? new Date();
  const slots = slotsOf(shape);

  const inputOf = new Map<string, StartSitInput>();
  for (const player of input.pool) inputOf.set(player.player.id, player);

  const evaluationOf = new Map<string, StartSitEvaluation>();
  const positionOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const valueOf = new Map<string, number>();
  const unscored = new Set<string>();
  for (const [id, player] of inputOf) {
    const evaluation = evaluatePlayer({ ...player, now: player.now ?? now }, profile);
    evaluationOf.set(id, evaluation);
    positionOf.set(id, evaluation.position);
    nameOf.set(id, evaluation.name);
    /*
     * Ruled out is not unscorable.
     *
     * A player on injured reserve has a score and cannot start. Counting him as
     * a body would let the cover term believe a position is covered by somebody
     * who is not going to play; counting him as unscorable would make him
     * uncuttable for the wrong reason. He keeps his value and is excluded from
     * the startable counts below, which is what both terms actually need.
     */
    if (evaluation.score == null) unscored.add(id);
    else valueOf.set(id, evaluation.score);
  }

  const reserveIds = new Set(input.reserveIds ?? []);

  /*
   * The starting slots each position can legally occupy.
   *
   * The basis of "does the incoming player cover the one being cut": two
   * positions are interchangeable to the extent that they compete for the same
   * slots, which is a property of this league rather than of football. In a
   * one-quarterback league a quarterback covers nothing a running back was
   * doing; in superflex he covers a great deal of it, and this reads that
   * difference off the shape instead of being told about it.
   */
  const slotsForPosition = new Map<string, Set<number>>();
  slots.forEach((slot, index) => {
    for (const position of slot.accepts) {
      const current = slotsForPosition.get(position) ?? new Set<number>();
      current.add(index);
      slotsForPosition.set(position, current);
    }
  });

  /** How much of `to`'s slot coverage `from` can take over. 0 when none. */
  const coverShare = (from: string, to: string): number => {
    const target = slotsForPosition.get(to);
    if (!target || target.size === 0) return 0;
    const source = slotsForPosition.get(from);
    if (!source) return 0;
    let shared = 0;
    for (const index of target) if (source.has(index)) shared++;
    return shared / target.size;
  };

  /** Dedicated starting slots per position, ignoring flex. */
  const requiredSlots = new Map<string, number>();
  for (const [position, count] of Object.entries(shape.starters ?? {})) {
    if (count > 0) requiredSlots.set(position, count);
  }

  /*
   * The standing worth of holding each player, from the model that already
   * owns that question.
   *
   * `buildHeldPlayers` is the Team screen's own mapping and it needs a lineup
   * to say who is starting; the baseline one is passed because `slotValue` —
   * the only field read out of the result — does not depend on the role. What
   * the role decides is `protected`, and protection here is computed per
   * hypothetical state instead, which is the whole point of the exercise.
   *
   * A caller-supplied `held` wins wherever it overlaps: it is strictly better
   * information, since it can carry handcuff and bye-cover facts this mapping
   * has no source for.
   */
  const baseInputs = input.rosterIds.map((id) => inputOf.get(id)).filter((i): i is StartSitInput => i != null);
  const wireInputs = input.wireIds.map((id) => inputOf.get(id)).filter((i): i is StartSitInput => i != null);
  const seedLineup = recommendLineup(baseInputs, shape, profile, { now });
  let lineupCalls = 1;

  const derivedHeld = buildHeldPlayers({
    rosterInputs: [...baseInputs, ...wireInputs],
    candidateInputs: wireInputs,
    lineup: seedLineup,
    profile,
    reserveIds: [...reserveIds],
  });
  const heldOf = new Map<string, HeldPlayer>(derivedHeld.map((h) => [h.playerId, h]));
  for (const supplied of input.held ?? []) heldOf.set(supplied.playerId, supplied);

  const slotValueOf = new Map<string, number>();
  for (const [id, held] of heldOf) slotValueOf.set(id, valueOfSlot(held).slotValue);

  const cache = new Map<string, RosterStateView>();

  const stateOf = (playerIds: readonly string[]): RosterStateView => {
    const ids = [...new Set(playerIds)].sort();
    const key = ids.join(',');
    const hit = cache.get(key);
    if (hit) return hit;

    const inputs = ids.map((id) => inputOf.get(id)).filter((i): i is StartSitInput => i != null);
    const lineup = recommendLineup(inputs, shape, profile, { now });
    lineupCalls++;

    const starterIds = new Set(
      lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null),
    );
    const benchIds = ids.filter((id) => !starterIds.has(id));

    /*
     * Who is actually a body, in this state.
     *
     * Scorable, above the floor, not ruled out, and not sitting on an
     * injured-reserve slot. Every one of those exclusions is the difference
     * between a roster that is covered and a roster that only looks covered.
     */
    const startable = ids.filter((id) => {
      const evaluation = evaluationOf.get(id);
      if (!evaluation || evaluation.score == null || evaluation.score <= STARTABLE_FLOOR) return false;
      if (evaluation.ruledOut) return false;
      return !reserveIds.has(id);
    });

    /* What the wire would replace a departing player with, in this state. */
    const bestFree = new Map<string, number>();
    for (const id of input.wireIds) {
      if (ids.includes(id)) continue;
      const evaluation = evaluationOf.get(id);
      if (!evaluation || evaluation.score == null || evaluation.ruledOut) continue;
      const current = bestFree.get(evaluation.position) ?? 0;
      if (evaluation.score > current) bestFree.set(evaluation.position, evaluation.score);
    }

    /*
     * The bench, as options.
     *
     * Each bench player is worth what he would be worth if you had to start him
     * — the existing slot valuation — less whatever would step in if he were
     * gone. That replacement is the better of two things, and the second one is
     * where add-specificity comes from without anybody writing it down: the
     * wire at his position, or *another player already on this roster* who can
     * fill the slots he fills. Add a strong tight end and the old backup tight
     * end's replacement becomes the new arrival, so his option value collapses
     * and cutting him becomes cheap. Add a quarterback and nothing about the
     * tight end changes.
     */
    const optionValueOf = new Map<string, number>();
    for (const id of benchIds) {
      const position = positionOf.get(id);
      if (position == null) continue;
      const slotValue = slotValueOf.get(id) ?? valueOf.get(id) ?? 0;
      const value = valueOf.get(id) ?? 0;

      /*
       * What a replacement is actually worth *in this player's role*.
       *
       * Two caps, and both matter. The share is how much of his slot coverage
       * the other player can take over, read off the league's own shape — a
       * flex-eligible back covers the half of a tight end's job that is the
       * flex, and none of the half that is the tight-end slot. And the value is
       * capped at what the man being replaced was worth in the first place,
       * because a fourteen-point back standing behind a four-point tight end
       * does not make that tight end worth minus ten; he makes him worth
       * nothing, which is where the clamp below already puts him.
       *
       * Without the second cap a good flex body appears to cover every thin
       * position at once, and the roster reads as though it needs no backups at
       * all.
       */
      const coverFrom = (value: number, share: number) => share * Math.min(value, slotValue);

      let cover = coverFrom(bestFree.get(position) ?? 0, 1);
      for (const other of benchIds) {
        if (other === id) continue;
        const otherPosition = positionOf.get(other);
        const otherValue = valueOf.get(other);
        if (otherPosition == null || otherValue == null) continue;
        /*
         * Only a *better* bench player counts as cover, and the asymmetry is
         * load-bearing rather than fastidious.
         *
         * Let two similar backs cover each other and each one's option value is
         * cancelled by the other's presence — so cutting either appears to make
         * the roster better, because the survivor's value is suddenly
         * uncovered. That is not a subtle bias; it produces negative drop costs
         * and a planner that recommends dropping people for the pleasure of it.
         * Ranking the bench and letting cover flow only downwards removes the
         * cycle, and it is also the truer statement: a backup is insurance
         * against a starter, and the man behind him is not insurance against
         * *him*.
         *
         * Ties break on the id so the direction of cover between two players of
         * identical value is fixed rather than dependent on iteration order.
         */
        const better = otherValue > value || (otherValue === value && other < id);
        if (!better) continue;
        const share = coverShare(otherPosition, position);
        if (share <= 0) continue;
        cover = Math.max(cover, coverFrom(otherValue, share));
      }
      optionValueOf.set(id, round2(Math.max(0, slotValue - cover)));
    }

    /*
     * Positions with nobody spare.
     *
     * Counted over startable bodies against dedicated slots, so a league that
     * starts two receivers and holds two receivers is bare at WR however many
     * running backs are on the bench behind them.
     */
    const bodiesAt = new Map<string, number>();
    for (const id of startable) {
      const position = positionOf.get(id);
      if (position == null) continue;
      bodiesAt.set(position, (bodiesAt.get(position) ?? 0) + 1);
    }
    const barePositions: string[] = [];
    for (const [position, required] of requiredSlots) {
      if (plannerExcluded(position)) continue;
      if ((bodiesAt.get(position) ?? 0) - required <= 0) barePositions.push(position);
    }
    barePositions.sort();

    const optionTotal = [...optionValueOf.values()].reduce((a, b) => a + b, 0);
    const utility = round2(
      lineup.recommendedPoints + BENCH_OPTION_WEIGHT * optionTotal - BARE_POSITION_COST * barePositions.length,
    );

    const view: RosterStateView = {
      playerIds: ids,
      starterIds,
      benchIds,
      startableIds: startable,
      lineupPoints: round2(lineup.recommendedPoints),
      emptySlots: lineup.slots.filter((s) => s.playerId == null).length,
      utility,
      optionValueOf,
      barePositions,
    };
    cache.set(key, view);
    return view;
  };

  const baseline = stateOf(input.rosterIds);

  return {
    evaluationOf,
    positionOf,
    nameOf,
    valueOf,
    unscored,
    slotValueOf,
    reserveIds,
    baseline,
    stateOf,
    utility: (ids) => stateOf(ids).utility,
    after: ({ add = [], remove = [] }) => {
      const leaving = new Set(remove);
      return [...baseline.playerIds.filter((id) => !leaving.has(id)), ...add];
    },
    lineupsEvaluated: () => lineupCalls,
  };
}

/** Apply a set of successful claims to a roster, in order. Pure. */
export function applyClaims(
  playerIds: readonly string[],
  claims: readonly { addPlayerId: string; dropPlayerId: string | null }[],
): readonly string[] {
  let ids: readonly string[] = playerIds;
  for (const claim of claims) {
    const without = claim.dropPlayerId == null ? ids : ids.filter((id) => id !== claim.dropPlayerId);
    ids = without.includes(claim.addPlayerId) ? without : [...without, claim.addPlayerId];
  }
  return ids;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
