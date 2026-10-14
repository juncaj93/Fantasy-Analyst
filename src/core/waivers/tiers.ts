/**
 * Waiver moves in three tiers, scored by what they add to the lineup.
 *
 * ## Why this replaced one bar
 *
 * Until October 2026 a pickup was recommended only when it beat one specific
 * player by a fixed margin: 2.5 points over a starter on betting lines (3.0 on
 * Sleeper's projection), or 0.5 over the weakest bench player (1.0). The screen
 * was nearly empty most weeks while the bench held players with no real chance
 * of starting, because a fixed gap against one man ignores two things that
 * decide a waiver week: whether the lineup has a hole (a bye, an injury), and
 * whether the player being cut was ever going to play.
 *
 * ## One number: what the move does to your best lineup
 *
 * For each of the next three weeks, the best legal lineup is solved exactly by
 * the trade-value solver (`tradeValue/lineup.ts`: real slots, FLEX, every
 * player's points scaled by whether he plays that week). A move is worth
 *
 *     Σ week weight × (lineup after the move − lineup before)
 *   + the change in a small insurance credit for useful bench depth
 *   + Alex's roster preferences, labelled and small
 *
 * The first week counts in full and the next two at half, so a bye two weeks
 * out shows up without outweighing next Sunday. The player cut is inside the
 * subtraction: dropping someone who starts in week 3 costs exactly his week-3
 * points. Nothing here re-scores a player. Every number is the Start/Sit
 * decision number (`tradeValue/rate.ts`), so the betting line or projection is
 * about 90% of a value and soft factors stay a capped nudge.
 *
 * ## Tiers, in lineup points
 *
 * - **Do this** (at most one): fills a real hole in the first week (a starter
 *   on bye, Out, or no one to start), or a gain of {@link TIER_RULES.doThis}
 *   or more.
 * - **Worth considering** (up to four): a gain of {@link TIER_RULES.consider}
 *   or more: depth before a bye, a backup for a hurt starter, a moderate
 *   upgrade, or one injured-reserve stash.
 * - **Watch list**: better on paper, no move needed now.
 *
 * ## Dead roster spots
 *
 * A bench player is drop-ready when cutting him costs the lineup and the depth
 * credit almost nothing over the three weeks, he does not start in any of
 * them, and a free agent is about as good. He is listed even when no pickup is
 * worth it, so the spot is known before it is needed.
 *
 * ## One roster spot is used once
 *
 * Every pickup is paired with its best drop. When two pickups want the same
 * drop, the stronger one keeps it and the other is measured against its next
 * best, and both say they compete for that spot.
 *
 * Nothing here transacts. It returns recommendations and the numbers behind
 * them.
 */

import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import { TRADE_VALUE } from '../tradeValue/evaluate.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import type { WeekSource } from './aheadWeeks.ts';
import { DROP_RULES, dropScore, readDrops, type DropReading, type DropSignals } from './dropScore.ts';
import type { StashVerdict } from './stash.ts';

/**
 * The thresholds, in weighted lineup points over the three-week window.
 *
 * Set from this league's real board on 8 October 2026 (see
 * `scripts/waiver-tiers-report.ts` and the round's report): how many free agents
 * land near each line, and who they are.
 */
export const TIER_RULES = {
  /** Week weights: the first week the move counts, then the two after it. */
  weights: [1, 0.5, 0.5] as readonly number[],
  /**
   * While this week's games are still ahead, this week and next are both
   * "next week" to a reader: a free agent can still play Sunday, and a claim
   * entered now runs before next week. Both count in full.
   */
  openWeights: [1, 1, 0.5] as readonly number[],
  /** Moves for the same need (one bye, one injury) shown as alternatives on the best one, at most this many. */
  maxAlternatives: 3,
  /** A gain this large is "Do this" even without a hole. */
  doThis: 4,
  /** "Worth considering" from here. */
  consider: 1.5,
  /** The watch list from here. */
  watch: 0.4,
  maxConsider: 4,
  maxWatch: 6,
  /**
   * A starting slot counts as a hole when the best the roster can put there
   * projects under this many points that week (or nobody can play it).
   */
  holePoints: 3,
  /** A hole has to give the move at least this much in its week to be the reason. */
  holeGain: 1,
  /** Drop-ready: cutting him costs under this, lineup and depth together. */
  deadCost: 0.25,
  /** ...and he is no more than this many points a game above a free agent. */
  deadOverReplacement: 0.5,
  /** An injured-reserve stash has to be this far above a free agent when healthy. */
  stashOverReplacement: 3,
} as const;

/** Alex's preferences, as labelled line items. */
export const TIER_PREFS = {
  /** A QB or TE who would sit on the bench next week. */
  spareQbTe: -1.5,
  /** Ordering only: backs first when two moves are close. */
  rbLean: 0.25,
} as const;

export type TierName = 'do_this' | 'consider' | 'watch';

export type TierReasonCode =
  | 'hole_bye'
  | 'hole_injury'
  | 'hole_empty'
  | 'big_upgrade'
  | 'upgrade'
  | 'bye_depth'
  | 'injury_backup'
  | 'ir_stash'
  | 'depth';

/** One player as the planner reads him. */
export interface TierPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Healthy points a game, the Start/Sit decision number. Null: unvalued, never guessed. */
  rate: number | null;
  /** Availability for each window week, 0 to 1 (bye 0, Out 0, Questionable 0.8). */
  weekly: number[];
  /**
   * Points for each window week's game before availability, when a later week
   * has its own number (`aheadWeeks.ts`). Absent: `rate` for every week.
   */
  weekValues?: (number | null)[];
  /** Where each `weekValues` entry came from, for the row's sheet. */
  weekSources?: WeekSource[];
  /** `out`, `questionable`, `ir`... from the injury layer. */
  designation: string;
  byeWeek: number | null;
  /** In an injured-reserve slot. */
  onReserve?: boolean;
}

export interface TierCandidate extends TierPlayer {
  /** Why he may not be planned, said on his row. */
  planExcluded?: string | null;
}

export interface TierProtection {
  kind: 'handcuff' | 'market_hold' | 'draft_capital';
  /** `backs up Kenneth Walker`, `drafted around pick 41`. */
  note: string;
}

export interface TierRequest {
  shape: RosterShape;
  /** The NFL weeks of the window, oldest first. Same length as `weights`. */
  weeks: readonly number[];
  weights?: readonly number[];
  /**
   * How many leading weeks count as "next week" for a hole: 2 while this
   * week's games are still ahead, else 1.
   */
  leadWeeks?: number;
  roster: readonly TierPlayer[];
  candidates: readonly TierCandidate[];
  /** Free bench spots (IR excluded). Each one is a move that needs no drop. */
  openSpots: number;
  /** Open injured-reserve slots, for a stash. */
  openReserve: number;
  /** Rostered players cut only when nobody else can be. */
  protections: ReadonlyMap<string, TierProtection>;
  /** Positions another planner owns (defence). Never added or dropped here. */
  excludedPositions: ReadonlySet<string>;
  /** Replacement level by position: the free agents' points a game. */
  replacement: ReadonlyMap<string, number>;
  /**
   * The drop score's inputs for each rostered player (`dropScore.ts`): season
   * and recent points, how long he has been held, his role, whether he is in
   * Alex's Sleeper lineup, whether he is an elite back's handcuff. Absent or
   * empty: the drop is the cheapest one for the lineup, as before.
   */
  dropSignals?: ReadonlyMap<string, DropSignals> | undefined;
  /**
   * The stash verdict for each injured free agent (`stash.ts`). Absent: the
   * old rule (Out or IR, good when healthy).
   */
  stash?: ReadonlyMap<string, StashVerdict> | undefined;
  /**
   * Rostered players who may go to an open injured-reserve slot under this
   * league's rules (IR always; Out, Doubtful, suspended where the league allows
   * them). Moving one there frees a bench spot with no drop. Absent: none.
   */
  reserveEligible?: ReadonlySet<string> | undefined;
}

export interface TierPreference {
  key: 'spare_qb_te' | 'rb_lean';
  label: string;
  points: number;
}

export interface TierMove {
  playerId: string;
  name: string;
  position: string;
  team: string;
  tier: TierName;
  reasonCode: TierReasonCode;
  /** Plain English: `Your QB Joe Burrow is on bye in week 6`. */
  reason: string;
  /** Weighted lineup gain + insurance + preferences. The number the tier rests on. */
  gain: number;
  /** The lineup part alone, weighted. */
  lineupGain: number;
  /** The insurance part alone, weighted. */
  insurance: number;
  /** Lineup change week by week, unweighted. */
  byWeek: { week: number; change: number }[];
  /** Points a game, healthy. */
  rate: number;
  /** His number for each window week and where it came from. */
  weekNumbers: { week: number; points: number; source: WeekSource }[];
  prefs: TierPreference[];
  /**
   * Who he would replace on the roster. Null: an open spot. `reason` says why
   * this player is the drop, `score` is his drop score, when the drop score
   * was read.
   */
  drop: {
    playerId: string;
    name: string;
    position: string;
    reason?: string | null;
    score?: number | null;
    handcuff?: boolean;
    /** Not a drop: he moves to an open IR slot, which frees the spot. */
    viaReserve?: boolean;
  } | null;
  /**
   * Set when no honest drop is left for this move: every remaining bench
   * player is protected. The cheapest few to free a spot with, each with a
   * one-line reason; Alex picks.
   */
  needsSpot?: { playerId: string; name: string; reason: string }[];
  /** What cutting the drop costs on its own, weighted (lineup and depth). */
  dropCost: number | null;
  /** Other moves on this list that want the same roster spot. */
  competesWith: string[];
  /** Other free agents who answer the same need, weaker first-choice alternatives. */
  alternatives: string[];
  /** Set when he is an alternative to the "Do this" move rather than a second one. */
  alternativeTo: string | null;
  planExcluded: string | null;
  /** For a stash: `back around week 9`, `return unknown`. */
  stashLabel?: string | null;
}

export interface DeadSpot {
  playerId: string;
  name: string;
  position: string;
  /** Weighted cost of cutting him: lineup and depth together. */
  cost: number;
  /** Points a game above a free agent at his position (can be negative). */
  overReplacement: number | null;
  /** `no start in weeks 6 to 8; a free agent is as good`. */
  reason: string;
}

export interface WaiverTierPlan {
  /** The first "Do this" move, kept for older readers. */
  doThis: TierMove | null;
  /**
   * Every "Do this" move: one for each different starting hole this week (a QB
   * bye and a TE bye are two), plus at most one big upgrade. Each has its own
   * drop.
   */
  doThese: TierMove[];
  consider: TierMove[];
  watch: TierMove[];
  dropReady: DeadSpot[];
  /** The window, so a reader can see which weeks were counted. */
  window: { weeks: number[]; weights: number[] };
  thresholds: { doThis: number; consider: number; watch: number };
  /** How many free agents were valued, and how many had no number. */
  valued: number;
  unvalued: number;
  /** Every valued free agent's best move, for the audit report. Not drawn. */
  all: TierMove[];
  /** Free agents never offered, and why: out for the season, back too late. */
  excluded: { playerId: string; name: string; reason: string }[];
  /** Each bench player's drop score, lowest first, when it was read. */
  dropScores: { playerId: string; name: string; score: number; reason: string; protectedAs: string | null }[];
}

interface Valuation {
  /** Σ weight × lineup total. */
  lineup: number;
  /** Σ weight × insurance credit. */
  insurance: number;
  /** Unweighted lineup total per week. */
  weekly: number[];
  /** Per week, who started. */
  starters: Set<string>[];
  /** Per week, the lineup's picks by slot. */
  picks: (LineupCandidate | null)[][];
}

export function planWaiverTiers(request: TierRequest): WaiverTierPlan {
  const weights = [...(request.weights ?? TIER_RULES.weights)].slice(0, request.weeks.length);
  while (weights.length < request.weeks.length) weights.push(weights[weights.length - 1] ?? 0.5);
  const weeks = [...request.weeks];
  const slots = slotsOf(request.shape);
  const excluded = request.excludedPositions;

  const valued = request.roster.filter((p) => p.rate != null);
  const memo = new Map<string, Valuation>();
  const value = (players: readonly TierPlayer[]): Valuation => {
    const key = players
      .map((p) => p.playerId)
      .sort()
      .join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    const result = valueRoster(players, slots, weeks, weights, request.replacement);
    memo.set(key, result);
    return result;
  };

  const base = value(valued);
  const overReplacement = (p: TierPlayer): number | null =>
    p.rate == null ? null : round2(p.rate - (request.replacement.get(p.position) ?? 0));

  /* Who may be cut, and what each cut costs on its own. */
  const cuttable = valued.filter((p) => !p.onReserve && !excluded.has(p.position));
  const dropCost = new Map<string, number>();
  for (const p of cuttable) {
    const without = value(valued.filter((q) => q.playerId !== p.playerId));
    dropCost.set(p.playerId, round2(base.lineup + base.insurance - without.lineup - without.insurance));
  }
  const startsAny = (id: string) => base.starters.some((s) => s.has(id));

  /* Dead roster spots. */
  const dropReady: DeadSpot[] = [];
  for (const p of cuttable) {
    if (request.protections.has(p.playerId)) continue;
    const cost = dropCost.get(p.playerId) ?? 0;
    const over = overReplacement(p);
    if (startsAny(p.playerId) || cost >= TIER_RULES.deadCost) continue;
    if (over != null && over > TIER_RULES.deadOverReplacement) continue;
    dropReady.push({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      cost,
      overReplacement: over,
      reason: deadReason(weeks, over),
    });
  }
  dropReady.sort((a, b) => a.cost - b.cost || (a.overReplacement ?? 0) - (b.overReplacement ?? 0) || a.name.localeCompare(b.name));

  /* Every free agent with a number, against every drop he could use. */
  const candidates = request.candidates.filter((c) => c.rate != null && !excluded.has(c.position));
  const unvalued = request.candidates.filter((c) => c.rate == null && !excluded.has(c.position)).length;

  interface Option {
    drop: TierPlayer | null;
    /** The drop goes to an open IR slot instead of being cut. */
    viaReserve?: boolean;
    lineup: number;
    insurance: number;
    after: Valuation;
  }

  /*
   * The drop score, read once over every player who could be cut. With it,
   * a player in Alex's Sleeper lineup is not a drop (unless the add is the
   * same position and clearly better), and among drops that cost the move
   * about the same, the lowest score goes first.
   */
  const signals = request.dropSignals && request.dropSignals.size > 0 ? request.dropSignals : null;
  const readings: Map<string, DropReading> = new Map();
  if (signals) {
    const all = cuttable.map((p) => signals.get(p.playerId)).filter((x): x is DropSignals => x != null);
    /* "Lowest on your bench" compares the bench: a lineup player is scored but not compared. */
    for (const [id, r] of readDrops(all.filter((x) => !x.inLineup))) readings.set(id, r);
    for (const x of all) if (!readings.has(x.playerId)) readings.set(x.playerId, { ...dropScore(x), reason: 'in your Sleeper lineup' });
  }
  const scoreOf = (id: string): number | null => readings.get(id)?.score ?? null;
  const lineupLocked = (p: TierPlayer, c: TierCandidate): boolean => {
    const sig = signals?.get(p.playerId);
    if (!sig || !sig.inLineup) return false;
    /* An injured starter is still a starter: an injury never makes him cheaper to cut. */
    return !(p.position === c.position && (c.rate ?? 0) >= (p.rate ?? 0) + DROP_RULES.clearlyBetter);
  };
  const optionsFor = (c: TierCandidate, roster: readonly TierPlayer[], spots: number): Option[] => {
    const before = value(roster);
    const out: Option[] = [];
    const tryDrop = (drop: TierPlayer | null, viaReserve = false) => {
      const after = value([...roster.filter((p) => p.playerId !== drop?.playerId), c]);
      out.push({
        drop,
        ...(viaReserve ? { viaReserve: true } : {}),
        lineup: round2(after.lineup - before.lineup),
        insurance: round2(after.insurance - before.insurance),
        after,
      });
    };
    if (spots > 0) tryDrop(null);
    /*
     * An injured player who can go to an open IR slot frees a spot with no
     * drop. Valued as if he were gone, which is what IR means while he is
     * there; he stays on the roster.
     */
    const reserveIds = request.openReserve > 0 ? (request.reserveEligible ?? new Set<string>()) : new Set<string>();
    for (const p of roster) if (reserveIds.has(p.playerId) && !p.onReserve && !excluded.has(p.position)) tryDrop(p, true);
    const cOver = overReplacement(c) ?? 0;
    const allowed = roster.filter(
      (p) =>
        !p.onReserve &&
        !excluded.has(p.position) &&
        p.rate != null &&
        !lineupLocked(p, c) &&
        /*
         * Never cut a better player for a worse one because of a short-term bye
         * or injury: nobody further above a free agent at his position than the
         * add is at his, and with the drop score, nobody scoring above the
         * add's own points a game. Both, because points are not comparable
         * across positions (a quarterback's 21 is not a back's 21).
         */
        (overReplacement(p) ?? 0) < cOver &&
        (!signals || !readings.has(p.playerId) || (scoreOf(p.playerId) ?? 0) < (c.rate ?? 0)),
    );
    /*
     * With the drop score (round 2), a protected player (a high pick held as a
     * market hold, an elite back's handcuff) is never cut: when only protected
     * players are left, the move says it needs a spot first and lists the
     * cheapest candidates instead. Without it, as before: protected players
     * only when nobody else can be.
     */
    const open = allowed.filter((p) => !request.protections.has(p.playerId));
    for (const p of signals ? open : open.length > 0 ? open : allowed) tryDrop(p);
    const gainOf = (o: Option) => o.lineup + o.insurance;
    const order = (list: Option[]): Option[] => {
      if (!signals) return list.sort((a, b) => gainOf(b) - gainOf(a) || (a.drop?.name ?? '').localeCompare(b.drop?.name ?? ''));
      /* About as good for the lineup, then the lowest drop score; an open spot first. */
      const top = list.reduce((m, o) => Math.max(m, gainOf(o)), -Infinity);
      const near = (o: Option) => gainOf(o) >= top - DROP_RULES.gainSlack;
      return list.sort(
        (a, b) =>
          Number(near(b)) - Number(near(a)) ||
          (near(a) ? (a.drop ? (scoreOf(a.drop.playerId) ?? 99) : -1) - (b.drop ? (scoreOf(b.drop.playerId) ?? 99) : -1) : 0) ||
          gainOf(b) - gainOf(a) ||
          (a.drop?.name ?? '').localeCompare(b.drop?.name ?? ''),
      );
    };
    /* An open spot or an IR move costs nobody: those first, then the drops. */
    const free = out.filter((o) => o.drop == null || o.viaReserve);
    return [...order(free), ...order(out.filter((o) => o.drop != null && !o.viaReserve))];
  };

  const prefsFor = (c: TierCandidate, option: Option): TierPreference[] => {
    const prefs: TierPreference[] = [];
    /* Clearly better means he starts next week; a body for a later bye is still a spare. */
    if ((c.position === 'QB' || c.position === 'TE') && !option.after.starters[0]?.has(c.playerId)) {
      prefs.push({
        key: 'spare_qb_te',
        label: `You don’t carry a spare ${c.position} unless he is clearly better`,
        points: TIER_PREFS.spareQbTe,
      });
    }
    return prefs;
  };

  const moveFor = (c: TierCandidate, option: Option, before: Valuation): TierMove => {
    const raw = round2(option.lineup + option.insurance);
    const prefs = prefsFor(c, option);
    const gain = round2(raw + prefs.reduce((s, p) => s + p.points, 0));
    const byWeek = weeks.map((week, k) => ({ week, change: round2((option.after.weekly[k] ?? 0) - (before.weekly[k] ?? 0)) }));
    const { code, reason } = reasonFor(c, option, before, byWeek, request, weeks);
    return {
      playerId: c.playerId,
      name: c.name,
      position: c.position,
      team: c.team,
      tier: 'watch',
      reasonCode: code,
      reason,
      gain,
      lineupGain: option.lineup,
      insurance: option.insurance,
      byWeek,
      rate: c.rate ?? 0,
      weekNumbers: weeks.map((week, k) => ({ week, points: round2(pointsIn(c, k)), source: c.weekSources?.[k] ?? 'this_week' })),
      prefs,
      drop: option.drop
        ? {
            playerId: option.drop.playerId,
            name: option.drop.name,
            position: option.drop.position,
            reason: readings.get(option.drop.playerId)?.reason ?? null,
            score: scoreOf(option.drop.playerId),
            handcuff: request.protections.get(option.drop.playerId)?.kind === 'handcuff',
            ...(option.viaReserve
              ? { viaReserve: true, reason: `${injuryWord(option.drop.designation)}; your open IR slot holds him, so no drop` }
              : {}),
          }
        : null,
      dropCost: option.drop ? (dropCost.get(option.drop.playerId) ?? null) : null,
      competesWith: [],
      alternatives: [],
      alternativeTo: null,
      planExcluded: c.planExcluded ?? null,
    };
  };

  const options = new Map<string, Option[]>();
  const best: TierMove[] = [];
  const excludedFas: { playerId: string; name: string; reason: string }[] = [];
  for (const c of candidates) {
    /* A season-ending injury, or a return after the playoffs start, is never offered. */
    const verdict = request.stash?.get(c.playerId);
    if (verdict && (verdict.kind === 'season_ending' || verdict.kind === 'too_late')) {
      excludedFas.push({ playerId: c.playerId, name: c.name, reason: verdict.label });
      continue;
    }
    const list = optionsFor(c, valued, request.openSpots);
    options.set(c.playerId, list);
    if (list.length === 0) continue;
    best.push(moveFor(c, list[0]!, base));
  }

  /*
   * An injured-reserve stash is measured past the window: three weeks of an Out
   * player are zero, and the reason to hold him is the weeks after. With the
   * stash verdicts, only a return before the playoffs counts, and an unknown
   * return is a Watch list name.
   */
  const stashable = (m: TierMove) => {
    const c = candidates.find((x) => x.playerId === m.playerId);
    if (!c || request.openReserve <= 0) return false;
    if (!['out', 'ir', 'pup'].includes(c.designation)) return false;
    return (overReplacement(c) ?? 0) >= TIER_RULES.stashOverReplacement;
  };
  const stashUnknown = new Set<string>();
  for (const m of best) {
    if (m.gain < TIER_RULES.consider && stashable(m)) {
      const verdict = request.stash?.get(m.playerId) ?? null;
      m.reasonCode = 'ir_stash';
      if (verdict == null) {
        m.reason = `Out now, worth a starting spot when back; you have an open IR slot to hold him`;
      } else if (verdict.kind === 'back_by') {
        m.stashLabel = verdict.label;
        m.reason = `Out now, ${verdict.label}; worth a starting spot then, and you have an open IR slot`;
      } else {
        m.stashLabel = 'return unknown';
        m.reason = `Out now, return unknown; a name to watch, not a stash yet`;
        stashUnknown.add(m.playerId);
      }
    }
  }

  const order = (a: TierMove, b: TierMove) =>
    sortKey(b) - sortKey(a) || b.gain - a.gain || a.name.localeCompare(b.name);
  const ranked = best.filter((m) => m.planExcluded == null).sort(order);

  const isHole = (m: TierMove) => m.reasonCode === 'hole_bye' || m.reasonCode === 'hole_injury' || m.reasonCode === 'hole_empty';
  /*
   * One row per need. Four quarterbacks for one bye are one decision: the best
   * is listed and the rest ride on it as alternatives, sharing its drop rather
   * than reaching for a starter to cut.
   */
  const needOf = (m: TierMove) =>
    isHole(m) || m.reasonCode === 'bye_depth' || m.reasonCode === 'injury_backup' ? m.reason : null;

  /*
   * Do this: every different starting hole in the coming week (a QB bye and a
   * TE bye are two), and at most one big upgrade. Depth for a bye two weeks
   * out is worth considering however large, because nothing needs doing about
   * it yet.
   */
  const doThese: TierMove[] = [];
  const holeNeeds = new Set<string>();
  for (const m of ranked) {
    if (!isHole(m) || m.gain < TIER_RULES.consider) continue;
    if (holeNeeds.has(m.reason)) continue;
    holeNeeds.add(m.reason);
    doThese.push(m);
  }
  const big = ranked.find((m) => m.reasonCode === 'upgrade' && m.gain >= TIER_RULES.doThis);
  if (big) {
    big.reasonCode = 'big_upgrade';
    doThese.push(big);
  }
  for (const m of doThese) m.tier = 'do_this';

  const byNeed = new Map<string, TierMove>();
  for (const m of doThese) if (needOf(m)) byNeed.set(needOf(m)!, m);
  const consider: TierMove[] = [];
  const watch: TierMove[] = [];
  let stashTaken = false;
  for (const m of ranked) {
    if (doThese.includes(m)) continue;
    const need = needOf(m);
    const holder = need ? byNeed.get(need) : undefined;
    if (holder) {
      if (holder.alternatives.length < TIER_RULES.maxAlternatives) holder.alternatives.push(m.name);
      continue;
    }
    const stash = m.reasonCode === 'ir_stash' && !stashUnknown.has(m.playerId) && !stashTaken;
    const qualifies = (m.gain >= TIER_RULES.consider && m.reasonCode !== 'ir_stash') || stash;
    if (qualifies && consider.length < TIER_RULES.maxConsider) {
      m.tier = 'consider';
      if (stash) stashTaken = true;
      consider.push(m);
      if (need) byNeed.set(need, m);
      continue;
    }
    if ((m.gain >= TIER_RULES.watch || stashUnknown.has(m.playerId)) && watch.length < TIER_RULES.maxWatch) {
      m.tier = 'watch';
      watch.push(m);
      if (need) byNeed.set(need, m);
    }
  }

  /*
   * Drops, assigned together: every move shown gets a different drop, chosen
   * to keep the most lineup points across all of them (and, between equals,
   * to cut the lowest drop scores). "Do this" moves are placed first; a
   * "consider" move with no drop left is moved to the Watch list, except a
   * move that fills a real starting hole, which is never on the Watch list.
   */
  const candidateOf = (m: TierMove) => candidates.find((c) => c.playerId === m.playerId)!;
  const shown = [...doThese, ...consider];
  const choice = assignDrops(
    shown.map((m) => ({
      id: m.playerId,
      priority: m.tier === 'do_this' || isHole(m) ? 1 : 0,
      options: (options.get(m.playerId) ?? []).slice(0, 8).map((o) => ({
        dropId: o.drop?.playerId ?? null,
        gain: round2(o.lineup + o.insurance),
        score: o.drop == null || o.viaReserve ? -1 : (scoreOf(o.drop.playerId) ?? 0),
        held: o.drop && !o.viaReserve ? (request.protections.get(o.drop.playerId)?.kind === 'handcuff' ? 2 : request.protections.has(o.drop.playerId) ? 1 : 0) : 0,
        ...(o.viaReserve ? { reserve: true } : {}),
      })),
    })),
    request.openSpots,
    request.openReserve,
  );
  const used = new Map<string, string>();
  let openUsed = 0;
  const apply = (m: TierMove, index: number | null) => {
    const list = options.get(m.playerId) ?? [];
    const option = index == null ? null : list[index];
    if (!option) return false;
    if (option !== list[0]) {
      const replaced = moveFor(candidateOf(m), option, base);
      Object.assign(m, {
        ...replaced,
        tier: m.tier,
        competesWith: m.competesWith,
        alternatives: m.alternatives,
        ...(m.stashLabel !== undefined ? { stashLabel: m.stashLabel } : {}),
        reasonCode: m.reasonCode === 'ir_stash' || m.reasonCode === 'big_upgrade' ? m.reasonCode : replaced.reasonCode,
        reason: m.reasonCode === 'ir_stash' ? m.reason : replaced.reason,
      });
    }
    if (option.drop) used.set(option.drop.playerId, m.name);
    else openUsed += 1;
    return true;
  };
  const firstChoice = new Map(shown.map((m) => [m.playerId, (options.get(m.playerId) ?? [])[0]?.drop?.playerId ?? null]));
  const unplaced: TierMove[] = [];
  for (const m of shown) if (!apply(m, choice.get(m.playerId) ?? null)) unplaced.push(m);
  /* A move that did not get the spot it wanted most says who has it. */
  for (const m of shown) {
    const want = firstChoice.get(m.playerId);
    const holder = want ? used.get(want) : undefined;
    if (holder && holder !== m.name && !m.competesWith.includes(holder)) m.competesWith.push(holder);
  }
  /*
   * No honest drop left. A move that fills a real starting hole stays "Do
   * this" with "Pick your drop:" and the cheapest few players to free a spot
   * with, high draft picks last; Alex picks (Alex, 14 October: Andrews for
   * LaPorta's bye). Any other move goes to the Watch list.
   */
  const spotCandidates = (taken: ReadonlySet<string>) =>
    [...readings.entries()]
      .filter(([id]) => !taken.has(id))
      .map(([id, r]) => {
        const p = valued.find((x) => x.playerId === id);
        const sig = signals?.get(id);
        if (!p || p.onReserve || excluded.has(p.position) || sig?.inLineup) return null;
        const kind = request.protections.get(id);
        const label = kind?.kind === 'handcuff' ? 'handcuff' : kind?.kind === 'draft_capital' ? kind.note : kind ? 'kept as a high pick' : null;
        const why = label ? `${label}; ${r.reason}` : r.reason;
        /* High draft capital last: offered only when the cheaper options run out. */
        return { playerId: id, name: p.name, reason: why, score: r.score + (kind?.kind === 'draft_capital' ? 100 : 0) };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(({ playerId, name, reason }) => ({ playerId, name, reason }));
  for (const m of unplaced) {
    if (signals && isHole(m)) {
      m.drop = null;
      m.dropCost = null;
      m.needsSpot = spotCandidates(new Set(used.keys()));
      continue;
    }
    if (m.tier === 'consider' && !isHole(m)) {
      consider.splice(consider.indexOf(m), 1);
      m.tier = 'watch';
      watch.unshift(m);
    }
  }
  /*
   * The Watch list: never two rows on one drop, anywhere on the screen. Each
   * name takes a spot nobody above (or above it on this list) is using: an
   * open spot, else an honest drop. With none left it says it needs a roster
   * spot rather than naming somebody else's.
   */
  for (const m of watch) {
    const list = options.get(m.playerId) ?? [];
    const free = list.findIndex((o) =>
      o.drop == null ? openUsed < request.openSpots : !o.viaReserve && !used.has(o.drop.playerId) && !request.protections.has(o.drop.playerId),
    );
    if (free >= 0) {
      apply(m, free);
      continue;
    }
    const want = list[0]?.drop ? used.get(list[0].drop.playerId) : undefined;
    if (want && !m.competesWith.includes(want)) m.competesWith.push(want);
    m.drop = null;
    m.dropCost = null;
    m.needsSpot = [];
  }

  /*
   * A "Do this" move and a consider move can fill the same hole. Measured on
   * the roster after the "Do this" move at his position lands, a consider move
   * that adds little is an alternative, not a second claim.
   */
  for (const m of consider) {
    const first = doThese.find((d) => d.position === m.position) ?? null;
    if (!first || m.reasonCode === 'ir_stash') continue;
    const after = [...valued.filter((p) => p.playerId !== first.drop?.playerId), candidateOf(first)];
    const list = optionsFor(candidateOf(m), after, Math.max(0, request.openSpots - (first.drop ? 0 : 1)));
    const top = list.find((o) => o.drop == null || o.drop.playerId === m.drop?.playerId) ?? list[0];
    const second = top ? round2(top.lineup + top.insurance) : 0;
    if (second < TIER_RULES.consider) m.alternativeTo = first.name;
  }

  /* Who competes for whose spot, both ways. */
  const listed = [...doThese, ...consider];
  for (const m of listed) {
    for (const other of listed) {
      if (other === m || !other.competesWith.includes(m.name)) continue;
      if (!m.competesWith.includes(other.name)) m.competesWith.push(other.name);
    }
  }

  const dropScores = [...readings.entries()]
    .map(([id, r]) => {
      const p = valued.find((x) => x.playerId === id);
      const sig = signals?.get(id);
      const protectedAs = sig?.inLineup ? 'in your lineup' : (request.protections.get(id)?.kind ?? null);
      return { playerId: id, name: p?.name ?? id, score: r.score, reason: r.reason, protectedAs };
    })
    .sort((a, b) => a.score - b.score);

  return {
    doThis: doThese[0] ?? null,
    doThese,
    consider,
    watch,
    dropReady,
    window: { weeks, weights },
    thresholds: { doThis: TIER_RULES.doThis, consider: TIER_RULES.consider, watch: TIER_RULES.watch },
    valued: candidates.length,
    unvalued,
    all: best.sort(order),
    excluded: excludedFas,
    dropScores,
  };
}

/**
 * Give each move a different drop (or an open spot), keeping the most lineup
 * points across all of them.
 *
 * Small and exact: at most five moves and eight options each, searched
 * depth-first. The objective, in order: place as many priority moves ("Do
 * this", or a hole) as possible; then as many moves; then the most total
 * gain, less {@link PROTECTED_CUT_COST} points for each protected player cut
 * (a handcuff counts double); then the lowest total drop score. Returns each
 * placed move's option index.
 */
/** What cutting a protected player costs the joint assignment, in lineup points (a handcuff twice). */
export const PROTECTED_CUT_COST = 2;

export function assignDrops(
  moves: readonly {
    id: string;
    priority: number;
    options: readonly { dropId: string | null; gain: number; score: number; held?: number; reserve?: boolean }[];
  }[],
  openSpots: number,
  /** Open IR slots: an option with `reserve` moves its player there instead of cutting him. */
  openReserve = 0,
): Map<string, number> {
  let bestKey: number[] | null = null;
  let bestPick: (number | null)[] = [];
  const pick: (number | null)[] = [];
  const taken = new Set<string>();
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-9) return a[i]! > b[i]!;
    return false;
  };
  const walk = (i: number, open: number, prio: number, count: number, gain: number, score: number, held = 0, ir = openReserve) => {
    if (i === moves.length) {
      const key = [prio, count, Math.round((gain - PROTECTED_CUT_COST * held) * 100) / 100, -score];
      if (bestKey == null || better(key, bestKey)) {
        bestKey = key;
        bestPick = [...pick];
      }
      return;
    }
    const m = moves[i]!;
    m.options.forEach((o, k) => {
      if (o.dropId == null) {
        if (open <= 0) return;
        pick[i] = k;
        walk(i + 1, open - 1, prio + m.priority, count + 1, gain + o.gain, score + Math.max(0, o.score), held, ir);
        return;
      }
      if (taken.has(o.dropId)) return;
      if (o.reserve && ir <= 0) return;
      taken.add(o.dropId);
      pick[i] = k;
      walk(i + 1, open, prio + m.priority, count + 1, gain + o.gain, score + Math.max(0, o.score), held + (o.held ?? 0), ir - (o.reserve ? 1 : 0));
      taken.delete(o.dropId);
    });
    pick[i] = null;
    walk(i + 1, open, prio, count, gain, score, held, ir);
  };
  walk(0, openSpots, 0, 0, 0, 0);
  const out = new Map<string, number>();
  bestPick.forEach((k, i) => {
    if (k != null) out.set(moves[i]!.id, k);
  });
  return out;
}

/** A player's points for window week `k` before availability: that week's own number, else his rate. */
function pointsIn(p: TierPlayer, k: number): number {
  return p.weekValues?.[k] ?? p.rate ?? 0;
}

/** The ordering number: the gain, with the RB lean. Never printed as points. */
function sortKey(m: TierMove): number {
  return m.gain + (m.position === 'RB' ? TIER_PREFS.rbLean : 0);
}

function valueRoster(
  players: readonly TierPlayer[],
  slots: readonly LineupSlotSpec[],
  weeks: readonly number[],
  weights: readonly number[],
  replacement: ReadonlyMap<string, number>,
): Valuation {
  let lineup = 0;
  let insurance = 0;
  const weekly: number[] = [];
  const starters: Set<string>[] = [];
  const picks: (LineupCandidate | null)[][] = [];
  weeks.forEach((_, k) => {
    const pool: LineupCandidate[] = players.map((p) => ({
      id: p.playerId,
      position: p.position,
      value: pointsIn(p, k) * (p.weekly[k] ?? 1),
    }));
    const result = bestLineup(slots, pool);
    /* A zero-point pick (a bye, Out) fills nothing: he is not "starting" that week. */
    const started = new Set(result.picks.filter((x): x is LineupCandidate => x != null && x.value > 0).map((x) => x.id));
    /*
     * The insurance credit, exactly as Check a trade counts it: the best few
     * bench players' edge over a free agent, times the share of a week a
     * starter is expected to miss. Small on purpose.
     */
    const credit =
      pool
        .filter((c) => !started.has(c.id))
        .map((c) => Math.max(0, c.value - (replacement.get(c.position) ?? c.value)))
        .filter((x) => x > 0)
        .sort((a, b) => b - a)
        .slice(0, TRADE_VALUE.depth.creditedBench)
        .reduce((s, x) => s + x, 0) * TRADE_VALUE.depth.injuryRate;
    const w = weights[k] ?? 0;
    lineup += w * result.total;
    insurance += w * credit;
    weekly.push(result.total);
    starters.push(started);
    picks.push(result.picks);
  });
  return { lineup, insurance, weekly, starters, picks };
}

/**
 * Why a move is worth what it is worth, in one sentence.
 *
 * A hole is named by the starter who leaves it: the rostered player at a slot
 * the candidate fills who starts in the most window weeks but cannot play in
 * the week the move pays.
 */
function reasonFor(
  c: TierCandidate,
  option: { drop: TierPlayer | null; lineup: number; insurance: number; after: Valuation },
  before: Valuation,
  byWeek: { week: number; change: number }[],
  request: TierRequest,
  weeks: readonly number[],
): { code: TierReasonCode; reason: string } {
  const slots = slotsOf(request.shape);
  const fits = slots.filter((s) => s.eligible.has(c.position));
  /* The week the move pays most, and whether that week had a hole he fills. */
  const k = byWeek.reduce((bestK, w, i) => (w.change > (byWeek[bestK]?.change ?? -Infinity) ? i : bestK), 0);
  const startsThen = option.after.starters[k]?.has(c.playerId) ?? false;
  const week = weeks[k] ?? weeks[0] ?? 0;

  if (startsThen && (byWeek[k]?.change ?? 0) >= TIER_RULES.holeGain) {
    const weak = (before.picks[k] ?? []).some(
      (pick, i) => fits.some((f) => f === slots[i]) && (pick == null || pick.value < TIER_RULES.holePoints),
    );
    if (weak) {
      const missing = missingStarter(c, request, before, k);
      const first = k < (request.leadWeeks ?? 1);
      if (missing) {
        const out = missing.weekly[k] === 0 && missing.byeWeek === week;
        const label = `${missing.position} ${missing.name}`;
        if (out) {
          return {
            code: first ? 'hole_bye' : 'bye_depth',
            reason: `Your ${label} is on bye in week ${week}`,
          };
        }
        return {
          code: first ? 'hole_injury' : 'bye_depth',
          reason: `Your ${label} is ${injuryWord(missing.designation)}${first ? '' : ` for week ${week}`}`,
        };
      }
      return {
        code: first ? 'hole_empty' : 'bye_depth',
        reason: `Nobody on your roster can start at ${c.position} in week ${week}`,
      };
    }
  }

  /* A backup for a starter whose Sunday is in doubt. */
  const hurt = request.roster.find(
    (p) =>
      p.position === c.position &&
      (p.designation === 'questionable' || p.designation === 'doubtful') &&
      before.starters[0]?.has(p.playerId),
  );
  if (hurt && option.insurance > 0 && !option.after.starters[0]?.has(c.playerId)) {
    return { code: 'injury_backup', reason: `Backup for your ${hurt.position} ${hurt.name}, who is ${injuryWord(hurt.designation)}` };
  }

  if (option.lineup > 0 && option.after.starters.some((s) => s.has(c.playerId))) {
    /* He pays in a later week because somebody is away then: that is bye depth. */
    if (k >= (request.leadWeeks ?? 1) && startsThen) {
      const missing = missingStarter(c, request, before, k);
      if (missing && (missing.weekly[k] ?? 1) === 0) {
        const bye = missing.byeWeek === week;
        return {
          code: 'bye_depth',
          reason: bye
            ? `Your ${missing.position} ${missing.name} is on bye in week ${week}`
            : `Your ${missing.position} ${missing.name} is ${injuryWord(missing.designation)} for week ${week}`,
        };
      }
    }
    const replaced = replacedStarter(c, option.after, before, request, k);
    const change = byWeek[k]?.change ?? 0;
    return {
      code: 'upgrade',
      reason: replaced
        ? `Starts over ${replaced.name}${change > 0 ? `, +${change.toFixed(1)} pts in week ${week}` : ''}`
        : `Makes your lineup better by ${option.lineup.toFixed(1)} pts over the three weeks`,
    };
  }
  return { code: 'depth', reason: `Better depth than ${option.drop ? option.drop.name : 'what you hold'}; he would not start yet` };
}

/** The rostered starter who cannot play in window week `k`, at a slot the candidate fills. */
function missingStarter(c: TierCandidate, request: TierRequest, before: Valuation, k: number): TierPlayer | null {
  const slots = slotsOf(request.shape);
  const positions = new Set(slots.filter((s) => s.eligible.has(c.position)).flatMap((s) => [...s.eligible]));
  const startsCount = (id: string) => before.starters.filter((s) => s.has(id)).length;
  const out = request.roster
    .filter((p) => positions.has(p.position) && p.rate != null && (p.weekly[k] ?? 1) === 0)
    .filter((p) => before.starters.some((s, i) => i !== k && s.has(p.playerId)) || p.position === c.position)
    .sort((a, b) => Number(b.position === c.position) - Number(a.position === c.position) || startsCount(b.playerId) - startsCount(a.playerId) || (b.rate ?? 0) - (a.rate ?? 0));
  return out[0] ?? null;
}

/** Who leaves the lineup when he arrives, in the week he pays most. */
function replacedStarter(
  c: TierCandidate,
  after: Valuation,
  before: Valuation,
  request: TierRequest,
  k: number,
): TierPlayer | null {
  const was = before.starters[k] ?? new Set<string>();
  const now = after.starters[k] ?? new Set<string>();
  const gone = request.roster.filter((p) => was.has(p.playerId) && !now.has(p.playerId));
  return gone.sort((a, b) => Number(b.position === c.position) - Number(a.position === c.position))[0] ?? null;
}

function injuryWord(designation: string): string {
  switch (designation) {
    case 'out':
      return 'Out';
    case 'ir':
      return 'on IR';
    case 'pup':
      return 'on PUP';
    case 'suspended':
      return 'suspended';
    case 'doubtful':
      return 'Doubtful';
    case 'questionable':
      return 'Questionable';
    default:
      return 'unavailable';
  }
}

function deadReason(weeks: readonly number[], over: number | null): string {
  const span = weeks.length > 1 ? `weeks ${weeks[0]} to ${weeks[weeks.length - 1]}` : `week ${weeks[0]}`;
  const fa = over == null ? '' : over <= 0 ? '; a free agent is as good' : '; barely better than a free agent';
  return `No start in ${span}${fa}`;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
