/**
 * One yardstick per comparison, and one answer to "who would you cut for him".
 *
 * ## Why this file exists
 *
 * On 30 September 2026 every Waivers card read `Better than Jaylen Wright`
 * while the plan above them said `Drop Emmett Johnson` three times. Two rules
 * for the same question, in two files: the cards measured free agents only
 * against bench players with a betting line, and the claim planner scored an
 * unpriced bench player on usage scraps (0.08 pts) and called him the cheapest
 * cut. Worse, both compared numbers that were not the same kind of number. A
 * free agent with no props was scored on news and usage alone and subtracted
 * from a bench player's market total, and Jaylen Wright's market total was one
 * 2+ touchdown line read as an any-touchdown line: −6.1 against a published
 * projection of 3.5. Against that bar almost anybody looked like an upgrade.
 *
 * So this file owns both halves, and nothing else decides them:
 *
 *  - **The yardstick.** Two players are compared on their market points only
 *    when *both* are fully priced: every yardage and reception market their
 *    position is priced on, and a touchdown line at the any-TD line (0.5).
 *    Otherwise both are compared on Sleeper's published projection. A market
 *    number is never subtracted from a non-market one. See
 *    {@link compareOnYardstick}.
 *  - **The cut.** {@link planMoves} decides, for every free agent, the one
 *    rostered player a claim for him would drop, and groups the claims by that
 *    drop. The cards print that name after `Better than` and the plan prints it
 *    after `Drop`, from the same object, so they cannot disagree.
 *
 * The 2+ TD misread itself lives in odds ingestion and is fixed elsewhere. This
 * file only refuses to call such a player fully priced, which is enough to keep
 * the misread out of a waiver comparison.
 *
 * Sleeper's published projection is Rotowire's model, relayed by Sleeper. The
 * owner approved it as the fallback yardstick on 30 September 2026, labelled
 * `Sleeper projection` wherever it is shown. It arrives here as a plain map of
 * numbers; this file never reads the feed. See
 * `tests/sleeperProjectionFallback.test.ts` for the boundary.
 *
 * Nothing here transacts.
 */

import type { PlayerProp } from '../vegas/types.ts';
import { marketIsComplete } from '../startsit/projection.ts';

export type YardstickBasis = 'market' | 'sleeper';

/** The gap a claim has to clear on market numbers. Half a point, the roster-spot bar. */
export const MARKET_BAR = 0.5;
/**
 * The gap it has to clear on Sleeper's projection. A full point: a borrowed
 * number from a model this app has never checked against its own earns a
 * wider bar than two betting lines do.
 */
export const SLEEPER_BAR = 1;
/** The any-touchdown line. A 2+ TD line (1.5) is a different market. */
export const ANY_TD_LINE = 0.5;

/** Points off for a player whose Sunday is in doubt. Ordering and bar only; never a projection. */
export const QUESTIONABLE_CHARGE = 0.5;
export const DOUBTFUL_OR_DNP_CHARGE = 1;

/** Positions where "the backup to your starter" is a clear, single role. */
export const HANDCUFF_POSITIONS: ReadonlySet<string> = new Set(['RB', 'QB', 'TE']);

/** At most this many claims hang off one drop, and at most this many drops a week. */
export const CLAIMS_PER_DROP = 3;
export const MAX_DROPS = 2;

/** The slice of an evaluation this file reads. Structural, so tests need not build a whole one. */
export interface YardstickEvaluation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  expectation?: { points: number | null; missingMarkets?: readonly string[] } | null;
  injury?: {
    designation: string;
    bodyPart?: string | null;
    practice?: { latest: string } | null;
  } | null;
}

/** One player, read for a waiver comparison. */
export interface YardstickReading {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Market points, only when fully priced. */
  market: number | null;
  /** Sleeper's published projection, when there is one. */
  sleeper: number | null;
  /** Zero or negative. Questionable −0.5; Doubtful or an injured DNP −1. */
  availability: number;
  /** `Questionable, did not practise`, or null. */
  availabilityNote: string | null;
  /** `practised fully` and the like, for a claim's detail line. Null when unknown. */
  practiceNote: string | null;
}

/**
 * Whether the market number is the whole week, on lines that mean what they say.
 *
 * Complete by `marketIsComplete` (every market the position is priced on), and
 * the touchdown line that went into the total is the any-TD line. Odds
 * ingestion currently files a 2+ TD line (1.5) under the any-TD market; such a
 * player is not fully priced here, whatever else he has.
 *
 * The TD prop read is the one `buildExpectation` used: the last prop in the
 * list with a line or a probability.
 */
export function fullyPriced(evaluation: YardstickEvaluation, props: readonly PlayerProp[]): boolean {
  const points = evaluation.expectation?.points;
  if (points == null || !Number.isFinite(points)) return false;
  if (!marketIsComplete({ score: 0, expectation: evaluation.expectation ?? null })) return false;
  let td: PlayerProp | null = null;
  for (const prop of props) {
    if (prop.market !== 'anytime_td') continue;
    if (prop.line == null && prop.impliedProbability == null) continue;
    td = prop;
  }
  if (td && td.line != null && td.line > ANY_TD_LINE) return false;
  return true;
}

export function readYardstick(
  evaluation: YardstickEvaluation,
  props: readonly PlayerProp[],
  published: number | null | undefined,
): YardstickReading {
  const priced = fullyPriced(evaluation, props);
  const sleeper = published != null && Number.isFinite(published) ? round2(Math.max(0, published)) : null;
  const { charge, note, practice } = availabilityOf(evaluation);
  return {
    playerId: evaluation.playerId,
    name: evaluation.name,
    position: evaluation.position,
    team: evaluation.team,
    market: priced ? round2(Math.max(0, evaluation.expectation?.points ?? 0)) : null,
    sleeper,
    availability: charge,
    availabilityNote: note,
    practiceNote: practice,
  };
}

/**
 * The availability charge, read off the injury layer the engine already uses.
 *
 * A DNP counts only for a player carrying an injury. A healthy veteran's
 * Wednesday rest day is a DNP in the report and is not news.
 */
function availabilityOf(evaluation: YardstickEvaluation): { charge: number; note: string | null; practice: string | null } {
  const designation = evaluation.injury?.designation ?? 'unknown';
  const latest = evaluation.injury?.practice?.latest ?? 'unknown';
  const injured =
    designation === 'questionable' || designation === 'doubtful' || (evaluation.injury?.bodyPart ?? null) != null;

  let charge = 0;
  const notes: string[] = [];
  if (designation === 'doubtful') {
    charge = Math.max(charge, DOUBTFUL_OR_DNP_CHARGE);
    notes.push('Doubtful');
  } else if (designation === 'questionable') {
    charge = Math.max(charge, QUESTIONABLE_CHARGE);
    notes.push('Questionable');
  }
  if (latest === 'dnp' && injured) {
    charge = Math.max(charge, DOUBTFUL_OR_DNP_CHARGE);
    notes.push('did not practise');
  }

  const practice =
    latest === 'full' ? 'practised fully' : latest === 'limited' ? 'limited in practice' : latest === 'dnp' ? 'did not practise' : null;
  return { charge: charge === 0 ? 0 : -charge, note: notes.length > 0 ? notes.join(', ') : null, practice };
}

/** How one add measures against one drop, on one yardstick. */
export interface YardstickComparison {
  basis: YardstickBasis;
  /** The two projections as published or priced, before any charge. */
  addPoints: number;
  dropPoints: number;
  /** `addPoints − dropPoints`, the number a card prints. */
  projectionGap: number;
  /** The same gap with both availability charges applied. The number a decision is made on. */
  gap: number;
  /** What `gap` had to clear. */
  bar: number;
}

/**
 * The comparison, or null when there is no fair one.
 *
 * Market against market when both are fully priced; Sleeper against Sleeper
 * otherwise. Null when neither pair exists, which is an honest "cannot say"
 * and never a zero.
 */
export function compareOnYardstick(add: YardstickReading, drop: YardstickReading): YardstickComparison | null {
  let basis: YardstickBasis;
  let a: number;
  let d: number;
  if (add.market != null && drop.market != null) {
    basis = 'market';
    a = add.market;
    d = drop.market;
  } else if (add.sleeper != null && drop.sleeper != null) {
    basis = 'sleeper';
    a = add.sleeper;
    d = drop.sleeper;
  } else {
    return null;
  }
  return {
    basis,
    addPoints: a,
    dropPoints: d,
    projectionGap: round2(a - d),
    gap: round2(a + add.availability - (d + drop.availability)),
    bar: basis === 'market' ? MARKET_BAR : SLEEPER_BAR,
  };
}

/**
 * One number for ordering the roster's cut candidates against each other.
 *
 * Sleeper's projection first, because it is the one number nearly every player
 * has, so the cut order reads one scale; the full market where Sleeper has
 * nothing. Null when neither exists, and such a player is never a cut: an
 * unreadable player is an unknown one, not a cheap one.
 */
export function standingOf(reading: YardstickReading): number | null {
  const base = reading.sleeper ?? reading.market;
  return base == null ? null : round2(base + reading.availability);
}

export { basisLabel } from './wording.ts';

// ------------------------------------------------------------------ cuts --

/** Why a rostered player is only cut when nothing else can be. */
export type CutProtection = 'handcuff' | 'market_hold';

export interface CutCandidate {
  reading: YardstickReading;
  standing: number;
  starting: boolean;
  protection: CutProtection | null;
  /** For a handcuff: the starter he backs up. */
  backs: { playerId: string; name: string } | null;
  /** For a market hold: the short reason, `#7 add in Sleeper this week`. */
  holdNote: string | null;
}

export interface CutPool {
  /** Everyone a claim may drop, protected ones included, weakest first. */
  candidates: CutCandidate[];
  /** Rostered players the plan will never name: no reading at all. */
  unreadable: YardstickReading[];
}

export function buildCutPool(opts: {
  roster: readonly YardstickReading[];
  starterIds: ReadonlySet<string>;
  /** Players on an IR slot: not the spot a claim frees. */
  reserveIds: ReadonlySet<string>;
  /** Players ruled out this week. A zero for one Sunday is not a reason to cut. */
  ruledOutIds: ReadonlySet<string>;
  /** The market hold, with its short reason. */
  held: ReadonlyMap<string, string>;
  handcuffs: ReadonlyMap<string, { playerId: string; name: string }>;
  /** Positions another planner owns (defence). */
  excludedPositions: ReadonlySet<string>;
}): CutPool {
  const candidates: CutCandidate[] = [];
  const unreadable: YardstickReading[] = [];
  for (const reading of opts.roster) {
    if (opts.reserveIds.has(reading.playerId) || opts.ruledOutIds.has(reading.playerId)) continue;
    if (opts.excludedPositions.has(reading.position)) continue;
    const standing = standingOf(reading);
    if (standing == null) {
      unreadable.push(reading);
      continue;
    }
    const backs = opts.handcuffs.get(reading.playerId) ?? null;
    const hold = opts.held.get(reading.playerId) ?? null;
    candidates.push({
      reading,
      standing,
      starting: opts.starterIds.has(reading.playerId),
      protection: backs ? 'handcuff' : hold ? 'market_hold' : null,
      backs,
      holdNote: hold,
    });
  }
  candidates.sort((a, b) => a.standing - b.standing || a.reading.name.localeCompare(b.reading.name));
  return { candidates, unreadable };
}

/**
 * The cheapest cut a claim for a player at `position` could make.
 *
 * `competes` says which rostered positions contest his slots (read off the
 * league's shape by the caller). An ordinary add displaces a bench player; an
 * add at a position already at its cap (a third tight end) is measured against
 * the weakest man at his own position, starters included, because that is the
 * only swap that makes sense. Protected players are skipped while anybody else
 * qualifies, and yield when nobody does. `exclude` removes drops already spent.
 */
export function cutFor(
  position: string,
  pool: CutPool,
  opts: {
    competes: (dropPosition: string) => boolean;
    overCap: boolean;
    exclude?: ReadonlySet<string>;
    /**
     * Whether a protected player may be the answer when nobody else qualifies.
     * True for a claim's own cut; false when looking for a *second* drop, which
     * is never worth spending a handcuff or a held player on.
     */
    allowProtected?: boolean;
  },
): CutCandidate | null {
  const eligible = pool.candidates.filter((c) => {
    if (opts.exclude?.has(c.reading.playerId)) return false;
    if (opts.overCap) return c.reading.position === position;
    return !c.starting && opts.competes(c.reading.position);
  });
  const open = eligible.find((c) => c.protection == null);
  if (open) return open;
  return opts.allowProtected === false ? null : (eligible[0] ?? null);
}

/**
 * Which bench players are the direct backup to one of your own starters.
 *
 * Read off the stored depth chart (nflverse, captured daily): the bench player
 * is #2 at his position on the same club where your starter is #1. Where the
 * chart knows neither of them, a bench back on the same club and position as
 * a starting back is taken as his handcuff: that is what the pairing almost
 * always is, and the cost of being wrong is keeping a bench back one more
 * week. A rank the chart does know that says otherwise (a #3 behind a #1)
 * overrides that fallback.
 */
export function findHandcuffs(opts: {
  roster: readonly { playerId: string; name: string; position: string; team: string }[];
  starterIds: ReadonlySet<string>;
  depth: ReadonlyMap<string, { rank: number }>;
}): Map<string, { playerId: string; name: string }> {
  const out = new Map<string, { playerId: string; name: string }>();
  const starters = opts.roster.filter((p) => opts.starterIds.has(p.playerId));
  for (const bench of opts.roster) {
    if (opts.starterIds.has(bench.playerId)) continue;
    if (!HANDCUFF_POSITIONS.has(bench.position) || !bench.team) continue;
    for (const starter of starters) {
      if (starter.position !== bench.position || starter.team !== bench.team) continue;
      const mine = opts.depth.get(bench.playerId)?.rank ?? null;
      const theirs = opts.depth.get(starter.playerId)?.rank ?? null;
      const known = mine != null || theirs != null;
      const backs = known
        ? (mine == null || mine === 2) && (theirs == null || theirs === 1) && (mine != null || bench.position === 'RB')
        : bench.position === 'RB';
      if (backs) {
        out.set(bench.playerId, { playerId: starter.playerId, name: starter.name });
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ moves --

/** One free agent, ready to be weighed against a cut. */
export interface MoveCandidate {
  reading: YardstickReading;
  /** `upgrade` beats a starter; `value` beats a bench player. Upgrades are planned first. */
  tier: 'upgrade' | 'value';
  /** Competes for the slots of a rostered player at this position. */
  competes: (dropPosition: string) => boolean;
  overCap: boolean;
  /** The bar a comparison has to clear, when not the yardstick's own (the over-cap upgrade bar). */
  minBar?: number;
  /**
   * Ordering nudges, in points: added to the gap to rank the claims. `lift` is
   * the part allowed to carry a borderline gap over the bar (trending adds,
   * unchanged from before); `order` never admits anybody (trending drops,
   * Vegas props, the running-back lean).
   */
  nudges: { lift: number; order: number };
  /** Kept out of the plan, with the reason shown on his card. */
  planExcluded: string | null;
  /**
   * Already cleared a bar of its own: a starter upgrade beat the man in his
   * slot by the starter bar, or filled an empty one. Its comparison against the
   * cut is kept for the card and never vetoes it.
   */
  cleared?: boolean;
  /**
   * The starting slot a starter upgrade answers. Claims into open roster spots
   * all run, so only one per slot is planned there: three quarterbacks for one
   * empty QB slot would all land.
   */
  slot?: string;
}

export interface WaiverMove {
  playerId: string;
  tier: 'upgrade' | 'value';
  cut: CutCandidate | null;
  comparison: YardstickComparison | null;
  /** The comparison cleared its bar (with the trending lift). */
  clears: boolean;
  priority: number;
  planExcluded: string | null;
}

export interface WaiverMoveGroup {
  /** Null when the roster has an open spot and nothing needs to go. */
  drop: { playerId: string; name: string; position: string } | null;
  /** Adds to try, in the order to enter them. */
  addIds: string[];
  /** Protected players this group's drop was chosen over, with why. */
  kept: {
    playerId: string;
    name: string;
    why: string;
    /** Set for a handcuff: the starter he backs up. */
    backs?: string;
  }[];
}

export interface WaiverMovePlan {
  moves: Map<string, WaiverMove>;
  groups: WaiverMoveGroup[];
}

/**
 * Every free agent's cut and comparison, and the claims grouped by drop.
 *
 * The one function both the cards and the plan read. Each move's `cut` is the
 * drop the plan would make for him, and it is what his card names.
 *
 * 1. Each candidate is measured against the cheapest cut for his slots.
 * 2. The claims that clear are taken best first: upgrades before bench value,
 *    then by gap plus nudges. Each joins the group for his cut, up to three
 *    claims a group (the numbered list under "Drop Jaylen Wright").
 * 3. A claim whose group is full, or who would open a group beyond the second,
 *    is measured against the next cut instead. If he clears against that cut on
 *    his own, a second drop is spent on him; his card names that cut. If not,
 *    he stays an option under his first cut.
 * 4. An open roster spot is used before any drop.
 */
export function planMoves(opts: {
  candidates: readonly MoveCandidate[];
  pool: CutPool;
  /** Free roster spots, bench included, IR excluded. */
  openSpots?: number;
}): WaiverMovePlan {
  const moves = new Map<string, WaiverMove>();
  const measure = (candidate: MoveCandidate, cut: CutCandidate | null): WaiverMove => {
    const comparison = cut ? compareOnYardstick(candidate.reading, cut.reading) : null;
    const bar = comparison ? Math.max(comparison.bar, candidate.minBar ?? 0) : Infinity;
    const clears =
      candidate.cleared === true ||
      (comparison != null && comparison.gap > 0 && comparison.gap + candidate.nudges.lift >= bar);
    const own = standingOf(candidate.reading) ?? 0;
    return {
      playerId: candidate.reading.playerId,
      tier: candidate.tier,
      cut,
      comparison: comparison ? { ...comparison, bar } : null,
      clears,
      priority: round2((comparison ? comparison.gap : candidate.cleared ? own : -1000) + candidate.nudges.lift + candidate.nudges.order),
      planExcluded: candidate.planExcluded,
    };
  };

  for (const candidate of opts.candidates) {
    const cut = cutFor(candidate.reading.position, opts.pool, {
      competes: candidate.competes,
      overCap: candidate.overCap,
    });
    moves.set(candidate.reading.playerId, measure(candidate, cut));
  }

  const byId = new Map(opts.candidates.map((c) => [c.reading.playerId, c]));
  const ordered = [...moves.values()]
    .filter((m) => m.clears && m.planExcluded == null)
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || b.priority - a.priority || a.playerId.localeCompare(b.playerId));

  const groups: WaiverMoveGroup[] = [];
  const groupOf = (dropId: string | null) => groups.find((g) => (g.drop?.playerId ?? null) === dropId) ?? null;
  const drops = () => groups.filter((g) => g.drop != null);
  const hasRoom = (g: WaiverMoveGroup) => g.addIds.length < CLAIMS_PER_DROP;
  const openSlotsTaken = new Set<string>();

  for (const move of ordered) {
    const candidate = byId.get(move.playerId);
    if (!candidate) continue;

    /*
     * Open roster spots first: a claim with no drop costs nobody, and each one
     * runs on its own, so the group holds one claim per open spot rather than
     * a list of fallbacks.
     */
    const spots = Math.min(CLAIMS_PER_DROP, Math.max(0, opts.openSpots ?? 0));
    if (spots > 0 && !(candidate.slot != null && openSlotsTaken.has(candidate.slot))) {
      const free = groupOf(null) ?? pushGroup(groups, null);
      if (free.addIds.length < spots) {
        free.addIds.push(move.playerId);
        if (candidate.slot != null) openSlotsTaken.add(candidate.slot);
        continue;
      }
    }
    /* A second candidate for a slot an open spot already fills is an option, not a claim. */
    if (candidate.slot != null && openSlotsTaken.has(candidate.slot)) continue;

    /* No open spot and nobody a claim may cut: nothing to plan for him. */
    if (!move.cut) continue;
    const home = groupOf(move.cut.reading.playerId);
    if (home && hasRoom(home)) {
      home.addIds.push(move.playerId);
      continue;
    }
    if (!home && drops().length < MAX_DROPS) {
      pushGroup(groups, move.cut).addIds.push(move.playerId);
      continue;
    }

    /*
     * His drop's group is full, or there is no room for his drop. Another drop,
     * only if he clears against it on his own: an existing group with room
     * first, then a fresh cut while a second drop is still allowed.
     */
    const onlyThis = (keep: string) =>
      new Set(opts.pool.candidates.map((c) => c.reading.playerId).filter((id) => id !== keep));
    const alternatives: CutCandidate[] = [];
    for (const g of drops()) {
      if (g === home || !hasRoom(g)) continue;
      const cut = cutFor(candidate.reading.position, opts.pool, {
        competes: candidate.competes,
        overCap: candidate.overCap,
        exclude: onlyThis(g.drop!.playerId),
        allowProtected: false,
      });
      if (cut) alternatives.push(cut);
    }
    if (drops().length < MAX_DROPS) {
      const fresh = cutFor(candidate.reading.position, opts.pool, {
        competes: candidate.competes,
        overCap: candidate.overCap,
        exclude: new Set(drops().map((g) => g.drop!.playerId)),
        allowProtected: false,
      });
      if (fresh) alternatives.push(fresh);
    }
    for (const cut of alternatives) {
      const retried = measure(candidate, cut);
      if (!retried.clears) continue;
      moves.set(move.playerId, retried);
      (groupOf(cut.reading.playerId) ?? pushGroup(groups, cut)).addIds.push(move.playerId);
      break;
    }
  }

  /* Who each drop was chosen over, and why they stay. */
  for (const group of groups) {
    if (!group.drop) continue;
    const first = group.addIds[0] ? byId.get(group.addIds[0]) : undefined;
    if (!first) continue;
    for (const c of opts.pool.candidates) {
      if (c.protection == null || c.reading.playerId === group.drop.playerId) continue;
      if (first.overCap ? c.reading.position !== first.reading.position : c.starting || !first.competes(c.reading.position)) continue;
      const why =
        c.protection === 'handcuff' && c.backs
          ? `he backs up ${c.backs.name}, your starting ${c.reading.position}`
          : `the market still rates him (${c.holdNote ?? 'held'})`;
      group.kept.push({
        playerId: c.reading.playerId,
        name: c.reading.name,
        why,
        ...(c.protection === 'handcuff' && c.backs ? { backs: c.backs.name } : {}),
      });
    }
  }

  return { moves, groups };
}

function pushGroup(groups: WaiverMoveGroup[], cut: CutCandidate | null): WaiverMoveGroup {
  const group: WaiverMoveGroup = {
    drop: cut ? { playerId: cut.reading.playerId, name: cut.reading.name, position: cut.reading.position } : null,
    addIds: [],
    kept: [],
  };
  groups.push(group);
  return group;
}

function tierRank(tier: 'upgrade' | 'value'): number {
  return tier === 'upgrade' ? 0 : 1;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
