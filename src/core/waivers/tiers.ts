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
  holeGain: 3,
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
  /** A gain this large overrides the spare QB/TE charge: a standout. */
  standout: TIER_RULES.doThis,
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
  kind: 'handcuff' | 'market_hold';
  /** `backs up Kenneth Walker`, `drafted around pick 41`. */
  note: string;
}

export interface TierRequest {
  shape: RosterShape;
  /** The NFL weeks of the window, oldest first. Same length as `weights`. */
  weeks: readonly number[];
  weights?: readonly number[];
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
  prefs: TierPreference[];
  /** Who he would replace on the roster. Null: an open spot. */
  drop: { playerId: string; name: string; position: string } | null;
  /** What cutting the drop costs on its own, weighted (lineup and depth). */
  dropCost: number | null;
  /** Other moves on this list that want the same roster spot. */
  competesWith: string[];
  /** Set when he is an alternative to the "Do this" move rather than a second one. */
  alternativeTo: string | null;
  planExcluded: string | null;
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
  doThis: TierMove | null;
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
    lineup: number;
    insurance: number;
    after: Valuation;
  }
  const optionsFor = (c: TierCandidate, roster: readonly TierPlayer[], spots: number): Option[] => {
    const before = value(roster);
    const out: Option[] = [];
    const tryDrop = (drop: TierPlayer | null) => {
      const after = value([...roster.filter((p) => p.playerId !== drop?.playerId), c]);
      out.push({
        drop,
        lineup: round2(after.lineup - before.lineup),
        insurance: round2(after.insurance - before.insurance),
        after,
      });
    };
    if (spots > 0) tryDrop(null);
    const cOver = overReplacement(c) ?? 0;
    const allowed = roster.filter(
      (p) =>
        !p.onReserve &&
        !excluded.has(p.position) &&
        p.rate != null &&
        /* Never cut a better player for a worse one because of a short-term bye or injury. */
        (overReplacement(p) ?? 0) < cOver,
    );
    const open = allowed.filter((p) => !request.protections.has(p.playerId));
    for (const p of open.length > 0 ? open : allowed) tryDrop(p);
    return out.sort((a, b) => b.lineup + b.insurance - (a.lineup + a.insurance) || (a.drop?.name ?? '').localeCompare(b.drop?.name ?? ''));
  };

  const prefsFor = (c: TierCandidate, option: Option, gain: number): TierPreference[] => {
    const prefs: TierPreference[] = [];
    if ((c.position === 'QB' || c.position === 'TE') && !option.after.starters[0]?.has(c.playerId) && gain < TIER_PREFS.standout) {
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
    const prefs = prefsFor(c, option, raw);
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
      prefs,
      drop: option.drop ? { playerId: option.drop.playerId, name: option.drop.name, position: option.drop.position } : null,
      dropCost: option.drop ? (dropCost.get(option.drop.playerId) ?? null) : null,
      competesWith: [],
      alternativeTo: null,
      planExcluded: c.planExcluded ?? null,
    };
  };

  const options = new Map<string, Option[]>();
  const best: TierMove[] = [];
  for (const c of candidates) {
    const list = optionsFor(c, valued, request.openSpots);
    options.set(c.playerId, list);
    if (list.length === 0) continue;
    best.push(moveFor(c, list[0]!, base));
  }

  /*
   * An injured-reserve stash is measured past the window: three weeks of an Out
   * player are zero, and the reason to hold him is the weeks after.
   */
  const stashable = (m: TierMove) => {
    const c = candidates.find((x) => x.playerId === m.playerId);
    if (!c || request.openReserve <= 0) return false;
    if (!['out', 'ir', 'pup'].includes(c.designation)) return false;
    return (overReplacement(c) ?? 0) >= TIER_RULES.stashOverReplacement;
  };
  for (const m of best) {
    if (m.gain < TIER_RULES.consider && stashable(m)) {
      m.reasonCode = 'ir_stash';
      m.reason = `Out now, worth a starting spot when back; you have an open IR slot to hold him`;
    }
  }

  const order = (a: TierMove, b: TierMove) =>
    sortKey(b) - sortKey(a) || b.gain - a.gain || a.name.localeCompare(b.name);
  const ranked = best.filter((m) => m.planExcluded == null).sort(order);

  /* Do this: a hole in the first week, or a big gain. */
  const isHole = (m: TierMove) => m.reasonCode === 'hole_bye' || m.reasonCode === 'hole_injury' || m.reasonCode === 'hole_empty';
  const doThis =
    ranked.find((m) => (isHole(m) && m.gain >= TIER_RULES.consider) || m.gain >= TIER_RULES.doThis) ?? null;
  if (doThis) {
    doThis.tier = 'do_this';
    if (doThis.reasonCode === 'upgrade') doThis.reasonCode = 'big_upgrade';
  }

  /* Spots: one roster spot is used once, strongest move first. */
  const used = new Map<string, string>();
  let openLeft = request.openSpots;
  const assign = (m: TierMove): boolean => {
    const list = options.get(m.playerId) ?? [];
    for (const option of list) {
      if (option.drop == null) {
        if (openLeft <= 0) continue;
      } else if (used.has(option.drop.playerId)) {
        const holder = used.get(option.drop.playerId)!;
        if (!m.competesWith.includes(holder)) m.competesWith.push(holder);
        continue;
      }
      if (option !== list[0]) {
        const replaced = moveFor(candidates.find((c) => c.playerId === m.playerId)!, option, base);
        Object.assign(m, { ...replaced, tier: m.tier, competesWith: m.competesWith, reasonCode: m.reasonCode === 'ir_stash' ? 'ir_stash' : replaced.reasonCode, reason: m.reasonCode === 'ir_stash' ? m.reason : replaced.reason });
      }
      if (option.drop == null) openLeft -= 1;
      else used.set(option.drop.playerId, m.name);
      return true;
    }
    return false;
  };
  if (doThis) assign(doThis);

  const consider: TierMove[] = [];
  const watch: TierMove[] = [];
  let stashTaken = false;
  for (const m of ranked) {
    if (m === doThis) continue;
    const stash = m.reasonCode === 'ir_stash' && !stashTaken;
    const qualifies = m.gain >= TIER_RULES.consider || stash;
    if (qualifies && consider.length < TIER_RULES.maxConsider && assign(m)) {
      m.tier = 'consider';
      if (stash) stashTaken = true;
      consider.push(m);
      continue;
    }
    if (m.gain >= TIER_RULES.watch && watch.length < TIER_RULES.maxWatch) {
      m.tier = 'watch';
      watch.push(m);
    }
  }

  /*
   * The "Do this" move and a consider move can fill the same hole. Measured on
   * the roster after the first one lands, a consider move that adds little is
   * an alternative, not a second claim.
   */
  if (doThis) {
    const after = [...valued.filter((p) => p.playerId !== doThis.drop?.playerId), candidates.find((c) => c.playerId === doThis.playerId)!];
    for (const m of consider) {
      const c = candidates.find((x) => x.playerId === m.playerId)!;
      const list = optionsFor(c, after, Math.max(0, openLeft));
      const top = list.find((o) => o.drop == null || o.drop.playerId === m.drop?.playerId) ?? list[0];
      const second = top ? round2(top.lineup + top.insurance) : 0;
      if (second < TIER_RULES.consider && m.reasonCode !== 'ir_stash') m.alternativeTo = doThis.name;
    }
  }

  /* Who competes for whose spot, both ways. */
  const listed = [...(doThis ? [doThis] : []), ...consider];
  for (const m of listed) {
    if (!m.drop) continue;
    for (const other of listed) {
      if (other === m || !other.competesWith.includes(m.name)) continue;
      if (!m.competesWith.includes(other.name)) m.competesWith.push(other.name);
    }
  }

  return {
    doThis,
    consider,
    watch,
    dropReady,
    window: { weeks, weights },
    thresholds: { doThis: TIER_RULES.doThis, consider: TIER_RULES.consider, watch: TIER_RULES.watch },
    valued: candidates.length,
    unvalued,
    all: best.sort(order),
  };
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
      value: (p.rate ?? 0) * (p.weekly[k] ?? 1),
    }));
    const result = bestLineup(slots, pool);
    const started = new Set(result.picks.filter((x): x is LineupCandidate => x != null).map((x) => x.id));
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
      const first = k === 0;
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
    if (k > 0 && startsThen) {
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
