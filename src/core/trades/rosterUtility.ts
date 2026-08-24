/**
 * What a roster actually needs, and what one specific swap would do to it.
 *
 * The brief's §6 asks for a deterministic marginal-roster-utility model and is
 * explicit about what it must not be: "do not use raw position counts as the
 * primary model". Counting bodies says a roster with four running backs is deep;
 * it cannot say that three of them are unstartable, that the fourth is the only
 * one clearing a flex, or that the position is thin *for this league's slots*.
 *
 * So the primary model here is the lineup itself. Every question §6 lists —
 * does the acquired player enter the lineup, who is displaced, does sending a
 * player open a worse hole, is the outcome legal — is answered by running the
 * app's own optimiser twice and subtracting:
 *
 *     starterGain = points(roster − out + in) − points(roster)
 *
 * That is the same currency `ladderInputs.ts` already prices a ladder in, and
 * the same optimiser the Team screen draws, so a trade cannot be worth one thing
 * here and another thing on the screen the reader checks it against. Nothing in
 * this module invents a value universe.
 *
 * Two things the subtraction alone cannot see, and which are therefore modelled
 * beside it:
 *
 *   - **depth**, because a lineup total is blind to the bench behind it. Two
 *     rosters can start the same points and be one hamstring apart.
 *   - **need**, because "who should start on Sunday" is not "where is this
 *     roster weak against the rest of the league". Need is measured against what
 *     the *other rosters in this league* start at the same slot rank, which is a
 *     real replacement benchmark that costs nothing extra — every roster has
 *     already been evaluated by the time it is asked for.
 *
 * Pure. No database, no network, no clock beyond what the caller injects.
 */

import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from '../startsit/engine.ts';
import { recommendLineup } from '../startsit/lineup.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/**
 * How much of a starting slot's worth a flex-eligible position is charged for.
 *
 * A league with two RB slots and one RB/WR/TE flex does not need three running
 * backs, and it does not need two either — it needs two plus whatever share of
 * the flex running backs usually win. Half is the honest reading of a slot that
 * two or three positions compete for, and it is a constant rather than a model
 * because the alternative is guessing at league-wide flex behaviour from one
 * league's rosters.
 */
export const FLEX_SLOT_SHARE = 0.5;

/**
 * A score at or below which a player is not depth.
 *
 * Zero rather than a threshold: the start/sit engine already floors an
 * unplayable player, and inventing a second bar here would mean this module and
 * the lineup screen disagreeing about who is startable.
 */
export const STARTABLE_FLOOR = 0;

export type NeedLevel = 'hole' | 'weak' | 'adequate' | 'surplus';

export interface PositionNeed {
  position: string;
  /** Dedicated starting slots, plus this position's share of every flex. */
  slots: number;
  /** Players at this position who clear the startable bar. */
  startable: number;
  /** This roster's values at the position, best first. */
  values: number[];
  /**
   * What the rest of the league starts at each slot rank of this position.
   *
   * The replacement benchmark, and the reason need is not a count: a roster
   * whose RB2 is worth four points less than everybody else's RB2 has a hole
   * whether it holds two running backs or six.
   */
  benchmark: number[];
  /** Points the weakest required starter sits below that benchmark. Positive is a hole. */
  shortfall: number;
  /** Startable players beyond what the lineup can use. */
  surplus: number;
  level: NeedLevel;
}

/** What one swap does to one roster. Every field is a fact about the lineup. */
export interface RosterDelta {
  /** points(roster − out + in) − points(roster). The leading term. */
  starterGain: number;
  /** Startable bench players gained or lost. */
  depthChange: number;
  /** Incoming players who are in the recommended lineup afterwards. */
  entersLineup: string[];
  /** Players who started before this swap and do not afterwards. */
  displaced: string[];
  /**
   * True when a slot that was filled before is empty afterwards.
   *
   * The "does sending a player create a worse hole" question, answered by the
   * optimiser rather than by counting: a slot goes empty only when nothing left
   * on the roster can legally fill it.
   */
  opensSlot: boolean;
  /** Roster size after the swap. */
  sizeAfter: number;
  /** False when the swap would leave the roster unable to field its starters. */
  legal: boolean;
  pointsBefore: number;
  pointsAfter: number;
}

/**
 * One roster, evaluated once, ready to be asked about swaps.
 *
 * The evaluations and the baseline lineup are computed on construction because
 * every candidate against this roster needs them, and a candidate generator that
 * re-evaluated a roster per package would run the engine thousands of times for
 * an answer that never changes.
 */
export interface RosterView {
  key: string;
  playerIds: string[];
  /** Objective value: the comparable start/sit score, per player. */
  valueOf: ReadonlyMap<string, number>;
  positionOf: ReadonlyMap<string, string>;
  nameOf: ReadonlyMap<string, string>;
  /** Players the engine could not score at all. Never traded, never counted. */
  unscored: ReadonlySet<string>;
  /** Who the optimiser starts as the roster stands. */
  starterIds: ReadonlySet<string>;
  /** Startable players who are not starting, by position. */
  benchDepth: ReadonlyMap<string, number>;
  needs: ReadonlyMap<string, PositionNeed>;
  baselinePoints: number;
  /** Starting slots the roster cannot currently fill. */
  emptySlots: number;
  size: number;
  /** What one swap would do. Memoised — the same package is priced once. */
  delta(out: readonly string[], incoming: readonly string[]): RosterDelta;
}

export interface RosterViewInput {
  key: string;
  playerIds: readonly string[];
}

/**
 * Evaluate every roster in the league once, against one shared player pool.
 *
 * Built together rather than one at a time because the need benchmark is a
 * statement about the league: what an RB2 is worth here can only be known from
 * everybody's RB2. Doing this per roster would either need a second pass or a
 * benchmark invented from a constant, and a constant is exactly the "arbitrary
 * value universe" the brief forbids.
 */
export function buildRosterViews(opts: {
  rosters: readonly RosterViewInput[];
  /** Every player on every roster, keyed by id. */
  pool: ReadonlyMap<string, StartSitInput>;
  shape: RosterShape;
  profile: ScoringProfile;
}): Map<string, RosterView> {
  const { pool, shape, profile } = opts;

  /*
   * One evaluation per player for the whole league.
   *
   * `recommendLineup` re-evaluates internally — it has to, because the
   * replacement-risk pass mutates scores against the specific bench in front of
   * it — so this map is the *objective* reading of a player, independent of
   * whose roster he is on. That separation is deliberate: §5 requires objective
   * value and roster fit to be distinct quantities, and they cannot be if the
   * only number available is the one a particular lineup produced.
   */
  const evaluations = new Map<string, StartSitEvaluation>();
  for (const [id, input] of pool) evaluations.set(id, evaluatePlayer(input, profile));

  const slotsFor = positionSlots(shape);

  /*
   * Every roster's values by position, for the benchmark.
   *
   * Collected before any view is built, because each view needs the finished
   * table. Only rosters actually being modelled contribute — a benchmark built
   * from free agents would describe a different question.
   */
  const byPosition = new Map<string, number[][]>();
  const rosterValues = new Map<string, Map<string, number[]>>();
  for (const roster of opts.rosters) {
    const perPosition = new Map<string, number[]>();
    for (const id of roster.playerIds) {
      const evaluation = evaluations.get(id);
      if (!evaluation || evaluation.score == null) continue;
      const list = perPosition.get(evaluation.position) ?? [];
      list.push(evaluation.score);
      perPosition.set(evaluation.position, list);
    }
    for (const list of perPosition.values()) list.sort((a, b) => b - a);
    rosterValues.set(roster.key, perPosition);
    for (const [position, list] of perPosition) {
      const rows = byPosition.get(position) ?? [];
      rows.push(list);
      byPosition.set(position, rows);
    }
  }

  const benchmarks = new Map<string, number[]>();
  for (const [position, rows] of byPosition) benchmarks.set(position, medianByRank(rows));

  const views = new Map<string, RosterView>();
  for (const roster of opts.rosters) {
    views.set(
      roster.key,
      buildView({
        roster,
        pool,
        shape,
        profile,
        evaluations,
        slotsFor,
        benchmarks,
        values: rosterValues.get(roster.key) ?? new Map(),
      }),
    );
  }
  return views;
}

function buildView(args: {
  roster: RosterViewInput;
  pool: ReadonlyMap<string, StartSitInput>;
  shape: RosterShape;
  profile: ScoringProfile;
  evaluations: ReadonlyMap<string, StartSitEvaluation>;
  slotsFor: ReadonlyMap<string, number>;
  benchmarks: ReadonlyMap<string, number[]>;
  values: ReadonlyMap<string, number[]>;
}): RosterView {
  const { roster, pool, shape, profile, evaluations } = args;
  const playerIds = [...roster.playerIds];

  const valueOf = new Map<string, number>();
  const positionOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const unscored = new Set<string>();
  for (const id of playerIds) {
    const evaluation = evaluations.get(id);
    if (!evaluation) {
      unscored.add(id);
      continue;
    }
    positionOf.set(id, evaluation.position);
    nameOf.set(id, evaluation.name);
    if (evaluation.score == null) unscored.add(id);
    else valueOf.set(id, evaluation.score);
  }

  /*
   * The lineup, memoised on the exact set of players it was computed for.
   *
   * The cache is what makes candidate scoring affordable: a bounded generator
   * still asks about the same package from two directions and about the same
   * "roster without my RB3" for every player it might come back for. Keyed on
   * the sorted ids so two spellings of one set are one entry.
   */
  const cache = new Map<string, { points: number; starters: Set<string>; empty: number; depth: Map<string, number> }>();
  const lineupFor = (ids: readonly string[]) => {
    const key = [...ids].sort().join(',');
    const hit = cache.get(key);
    if (hit) return hit;

    const inputs = ids.map((id) => pool.get(id)).filter((i): i is StartSitInput => i != null);
    const lineup = recommendLineup(inputs, shape, profile);
    const starters = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
    const depth = new Map<string, number>();
    for (const id of ids) {
      if (starters.has(id)) continue;
      const value = valueOf.get(id) ?? evaluations.get(id)?.score ?? null;
      if (value == null || value <= STARTABLE_FLOOR) continue;
      const position = positionOf.get(id) ?? evaluations.get(id)?.position;
      if (!position) continue;
      depth.set(position, (depth.get(position) ?? 0) + 1);
    }
    const entry = {
      points: lineup.recommendedPoints,
      starters,
      empty: lineup.slots.filter((s) => s.playerId == null).length,
      depth,
    };
    cache.set(key, entry);
    return entry;
  };

  const base = lineupFor(playerIds);

  const needs = new Map<string, PositionNeed>();
  for (const position of allPositions(shape, args.values)) {
    needs.set(
      position,
      needFor({
        position,
        values: args.values.get(position) ?? [],
        slots: args.slotsFor.get(position) ?? 0,
        benchmark: args.benchmarks.get(position) ?? [],
      }),
    );
  }

  return {
    key: roster.key,
    playerIds,
    valueOf,
    positionOf,
    nameOf,
    unscored,
    starterIds: base.starters,
    benchDepth: base.depth,
    needs,
    baselinePoints: base.points,
    emptySlots: base.empty,
    size: playerIds.length,
    delta(out, incoming) {
      const leaving = new Set(out);
      const after = [...playerIds.filter((id) => !leaving.has(id)), ...incoming];
      const next = lineupFor(after);

      const entersLineup = incoming.filter((id) => next.starters.has(id));
      const displaced = playerIds.filter((id) => base.starters.has(id) && !leaving.has(id) && !next.starters.has(id));

      const depthBefore = [...base.depth.values()].reduce((a, b) => a + b, 0);
      const depthAfter = [...next.depth.values()].reduce((a, b) => a + b, 0);

      return {
        starterGain: round2(next.points - base.points),
        depthChange: depthAfter - depthBefore,
        entersLineup,
        displaced,
        opensSlot: next.empty > base.empty,
        sizeAfter: after.length,
        /*
         * Legality is about fielding a lineup, not about a roster-size setting.
         *
         * Sleeper's own maximum is enforced by Sleeper, and a suggestion that
         * needs one bench spot the reader can clear by dropping a kicker is not
         * illegal — it is a trade with a step in it. What is genuinely illegal
         * is a roster that can no longer fill a slot it could fill before, and
         * that is exactly `opensSlot`.
         */
        legal: next.empty <= base.empty,
        pointsBefore: base.points,
        pointsAfter: next.points,
      };
    },
  };
}

/**
 * How thin a position is, measured against the league rather than a count.
 *
 * `shortfall` is the load-bearing number: what the weakest *required* starter at
 * this position gives up against what everybody else starts in that same slot.
 * A roster three points light at RB2 has a hole; one holding a single elite
 * tight end in a one-TE league does not, however few tight ends it owns.
 */
export function needFor(args: {
  position: string;
  values: readonly number[];
  slots: number;
  benchmark: readonly number[];
}): PositionNeed {
  const values = [...args.values];
  /*
   * Two different readings of the same slot count, and they must not be one.
   *
   * `dedicated` is how many bodies the lineup cannot be filled without — the
   * league's own fixed slots, and nothing else. `measured` is how many ranks are
   * worth comparing against the league, which includes this position's share of
   * the flex: a roster whose third running back is four points light is thin at
   * RB in a league that flexes them, and is not missing a starter.
   *
   * Collapsing them would either call every flex-eligible position a hole
   * (`ceil`) or never notice a thin flex at all (`floor`).
   */
  const dedicated = Math.max(0, Math.floor(args.slots));
  const measured = Math.max(dedicated, Math.round(args.slots));
  const required = measured;
  const startable = values.filter((v) => v > STARTABLE_FLOOR).length;

  /*
   * Missing players are a shortfall against the benchmark, not a zero.
   *
   * A roster with no second running back is compared against what a second
   * running back is worth in this league, which is the same comparison every
   * other roster gets. Treating the empty slot as "worth zero, so no gap" is how
   * a genuine hole reads as adequate.
   */
  let shortfall = 0;
  for (let rank = 0; rank < required; rank++) {
    const mine = values[rank] ?? 0;
    const par = args.benchmark[rank] ?? 0;
    if (par > mine) shortfall = Math.max(shortfall, round2(par - mine));
  }

  const surplus = Math.max(0, startable - required);

  let level: NeedLevel;
  if (dedicated > 0 && startable < dedicated) level = 'hole';
  else if (shortfall >= HOLE_SHORTFALL) level = 'hole';
  else if (shortfall >= WEAK_SHORTFALL) level = 'weak';
  else if (surplus >= SURPLUS_DEPTH) level = 'surplus';
  else level = 'adequate';

  return {
    position: args.position,
    slots: args.slots,
    startable,
    values,
    benchmark: [...args.benchmark],
    shortfall,
    surplus,
    level,
  };
}

/**
 * Points below the league's own median at a slot before a position is a hole.
 *
 * Three points a week is about a fifth of a starting lineup's spread and is the
 * kind of gap a trade can actually close. Below `WEAK_SHORTFALL` the difference
 * is inside the noise of a weekly projection and calling it a need would put
 * every roster in the league in the market for every position.
 */
export const HOLE_SHORTFALL = 3;
export const WEAK_SHORTFALL = 1.5;

/** Startable bench players at one position above which it is genuinely spare. */
export const SURPLUS_DEPTH = 2;

/**
 * A position's share of the starting lineup.
 *
 * Dedicated slots count whole; flex slots are split between the positions that
 * compete for them. This is what makes need a statement about *this league*: a
 * superflex league needs two quarterbacks and a one-QB league does not, and
 * neither fact is available from a position count.
 */
export function positionSlots(shape: RosterShape): Map<string, number> {
  const out = new Map<string, number>();
  for (const [position, count] of Object.entries(shape.starters)) {
    out.set(position, (out.get(position) ?? 0) + count);
  }
  /*
   * A flex charges every position that can fill it, and they do not sum to one.
   *
   * That is intentional and is not double counting: these are per-position
   * requirements, not a partition of the slot. A league with two RB slots and
   * one RB/WR/TE flex needs a roster able to start two-and-a-bit running backs
   * *and* three-and-a-bit receivers, because the flex has to come from
   * somewhere and which position fills it is decided weekly.
   */
  for (const flex of shape.flex) {
    for (const position of flex.positions) {
      out.set(position, round2((out.get(position) ?? 0) + FLEX_SLOT_SHARE));
    }
  }
  return out;
}

/** Every position this league starts, plus every position the roster holds. */
function allPositions(shape: RosterShape, values: ReadonlyMap<string, number[]>): string[] {
  const out = new Set<string>(Object.keys(shape.starters));
  for (const flex of shape.flex) for (const position of flex.positions) out.add(position);
  for (const position of values.keys()) out.add(position);
  return [...out].sort();
}

/**
 * The league's median value at each slot rank of a position.
 *
 * Median rather than mean because one roster holding both elite tight ends
 * should not make every other roster's tight end look like a hole, and a roster
 * that holds none should not drag the bar down for everybody. Ranks are compared
 * like against like: every league's RB1 against every other RB1.
 */
export function medianByRank(rows: readonly (readonly number[])[]): number[] {
  const depth = Math.max(0, ...rows.map((r) => r.length));
  const out: number[] = [];
  for (let rank = 0; rank < depth; rank++) {
    /*
     * A roster with nobody at this rank counts as a zero rather than being
     * skipped. Skipping would measure "the median of rosters that have three
     * running backs", which is a benchmark that gets *higher* the scarcer the
     * position is — the exact inverse of what scarcity means.
     */
    const column = rows.map((r) => r[rank] ?? 0).sort((a, b) => a - b);
    if (column.length === 0) break;
    const mid = Math.floor(column.length / 2);
    out.push(
      column.length % 2 === 0
        ? round2(((column[mid - 1] ?? 0) + (column[mid] ?? 0)) / 2)
        : round2(column[mid] ?? 0),
    );
  }
  return out;
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
