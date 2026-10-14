/**
 * What to bid: just above the competition this league is likely to bring.
 *
 * ## Why not the old price band
 *
 * The pricing pass (`pricing.ts`, `faab/strategy.ts`) answers "what is he worth
 * to you" and "what has the room paid", and its band came from the league's
 * whole distribution of winning bids. On 7 October 2026 Alex won his top two
 * claims at $2 and $1 when the screen suggested about $10. A winning bid is the
 * second-highest bid plus a dollar, and in this league the second-highest bid
 * is usually nobody.
 *
 * ## The model
 *
 * For each rival, the chance he bids on this player:
 *
 *     chance = his claims per run ÷ targets per run × how much this player draws him
 *
 * - **Claims per run** is his own record this season, blended with the seed
 *   profile in `managerSeeds.ts` (the seed counts as three runs of history).
 * - **What draws him**: last week's fantasy points in this league's scoring
 *   (the strongest pull for most managers, by Alex's read), Sleeper's trending
 *   adds (a minor pull, except for the savvy manager), a rising role, and a
 *   fresh drop of a player the room drafted early.
 * - **What he bids** when he does: his own bids this season, blended with the
 *   seed's typical bid, read higher for a player who draws him more.
 *
 * The recommended bid is the smallest whole dollar that beats the expected
 * competition three times in four. The range under it runs from even odds to
 * nine in ten. With few claims on record the range widens; the bid does not.
 *
 * ## Honest limits
 *
 * Sleeper does publish this league's losing claims, with their amounts, so the
 * record is more complete than most. It is still a young season: a few dozen
 * claims, and Sleeper's trending list is current only, so a backtest cannot see
 * it. The screen says so whenever the sample is thin.
 *
 * Nothing here places a bid. It returns a number and the sentence for it.
 */

import { seedFor, STYLE_PRIORS, type BidderStyle } from './managerSeeds.ts';
import type { PositionNeed } from './rivalNeed.ts';
import type { RivalTendency } from './rivalHistory.ts';

export const BID_MODEL = {
  /** The seed counts as this many runs of a manager's history. */
  priorRuns: 3,
  /** ...and its typical bid as this many bids. */
  priorBids: 3,
  /** Distinct players drawing a claim in a typical run, before this league has any. */
  defaultTargetsPerRun: 8,
  /** The average target's pull, so a typical target gets chance = claims ÷ targets. */
  typicalPull: 0.5,
  /** The most any one rival's chance may reach. */
  maxChance: 0.9,
  /** Points scale: this many last week draws nobody, this many draws everybody. */
  points: { from: 4, to: 20 },
  /** No points on record (the first week): read as a middling pull, and said. */
  unknownPointsPull: 0.3,
  /** A fresh drop of a player the room drafted early pulls everybody. */
  freshDropPull: 0.5,
  /** Win this often at the recommended bid. */
  target: 0.75,
  /** The range: from even odds to nine in ten, or 19 in 20 on a thin record. */
  low: 0.5,
  high: 0.9,
  thinHigh: 0.95,
  /** Fewer valid claims than this on record is a thin sample. */
  thinClaims: 30,
  /** No bid below this is recommended on a player still on waivers. */
  minBid: 1,
} as const;

/** One claim from this season's log, as the model reads it. */
export interface ClaimRecord {
  rosterId: number;
  playerId: string;
  amount: number;
  won: boolean;
  /** A claim Sleeper voided because the roster was full: it never competed. */
  voided?: boolean;
  /** The run it belongs to: the week, or a finer key when known. */
  run: string;
}

export interface RivalSeat {
  rosterId: number;
  name: string;
  isMine: boolean;
  /** A seeded style carried past an alias; wins over the lookup by `name`. */
  style?: BidderStyle | null;
}

export interface RivalProfile {
  rosterId: number;
  name: string;
  style: BidderStyle;
  /** Where the style came from: Alex's seed, or the default. */
  styleSource: 'seed' | 'default';
  seedNote: string | null;
  /** Posterior players bid on per run. */
  claimsPerRun: number;
  /** His bids this season, ascending, voided claims excluded. */
  bids: number[];
  runsSeen: number;
}

export interface BidSignals {
  /** Fantasy points last week in this league's scoring. Null: not on record. */
  lastWeekPoints: number | null;
  /** Sleeper trending adds, 0 to 1. */
  trendHeat: number | null;
  trendRank: number | null;
  roleRising: boolean;
  /** Just dropped and drafted early by this room. */
  freshDrop: boolean;
}

export interface RivalOdds {
  rosterId: number;
  name: string;
  style: BidderStyle;
  chance: number;
  /** His likely bid if he does bid. */
  likelyBid: number;
  /** Why, in a few words: `QB on bye in week 6, no backup`, `has 3 QBs, unlikely`. Need-aware model only. */
  why?: string | null;
  /** The pieces of the chance, for the trace. Need-aware model only. */
  parts?: { rate: number; interest: number; need: number; pull: number; chase: number; remaining: number | null };
}

/**
 * What the need-aware model knows about one rival: his record, his roster's
 * need at this player's position, and his FAAB left. Absent for a rival: the
 * old model reads him.
 */
export interface RivalContext {
  tendency: RivalTendency;
  need: PositionNeed | null;
  /** FAAB left. Null: unknown, no cap. */
  remaining: number | null;
}

/**
 * How much to bid, by tier (Alex, 13 October 2026).
 *
 * - `do_this`: a real starting hole this week. Win about three times in four,
 *   with a range from even odds to nine in ten.
 * - `consider`: a real upgrade. Balanced: win about one time in two, and
 *   protect FAAB, with a range from about one in three to three in four.
 * - `stash`: an injured-reserve or bench stash, and the Watch list. $0 to $1,
 *   never more.
 */
export type BidPosture = 'do_this' | 'consider' | 'stash';

export const BID_POSTURE: Readonly<Record<BidPosture, { target: number; low: number; high: number; cap: number | null; words: string }>> = {
  do_this: { target: 0.75, low: 0.5, high: 0.9, cap: null, words: 'to win about 3 times in 4' },
  consider: { target: 0.5, low: 0.35, high: 0.75, cap: null, words: 'to win about 1 time in 2' },
  stash: { target: 0.5, low: 0, high: 0.5, cap: 1, words: 'a stash, so $0 to $1' },
};

export interface BidAdvice {
  recommended: number;
  low: number;
  high: number;
  /** Expected number of rival bidders. */
  expectedRivals: number;
  /** Chance nobody else bids. */
  noRival: number;
  rivals: RivalOdds[];
  /** One plain sentence: why this number. */
  reason: string;
  /** The same, without the closing "so bid $N": for a caller that ends it differently. */
  why: string;
  /** Set when the record is thin, said on screen. */
  thin: string | null;
}

/** Each rival's profile, blended from the seeds and this season's claims. */
export function buildRivalProfiles(opts: { seats: readonly RivalSeat[]; claims: readonly ClaimRecord[] }): {
  profiles: RivalProfile[];
  targetsPerRun: number;
  runs: number;
  validClaims: number;
} {
  const valid = opts.claims.filter((c) => !c.voided);
  const runs = [...new Set(opts.claims.map((c) => c.run))];
  const targets = runs.map((run) => new Set(valid.filter((c) => c.run === run).map((c) => c.playerId)).size).filter((n) => n > 0);
  const targetsPerRun = targets.length > 0 ? targets.reduce((a, b) => a + b, 0) / targets.length : BID_MODEL.defaultTargetsPerRun;

  const profiles = opts.seats
    .filter((s) => !s.isMine)
    .map((seat): RivalProfile => {
      const seed = seat.style ? { style: seat.style, note: seedFor(seat.name)?.note ?? null } : seedFor(seat.name);
      const style: BidderStyle = seed?.style ?? 'chaser';
      const prior = STYLE_PRIORS[style];
      const mine = valid.filter((c) => c.rosterId === seat.rosterId);
      const distinct = new Set(mine.map((c) => `${c.run}|${c.playerId}`)).size;
      const claimsPerRun =
        (prior.claimsPerRun * BID_MODEL.priorRuns + distinct) / (BID_MODEL.priorRuns + runs.length);
      return {
        rosterId: seat.rosterId,
        name: seat.name,
        style,
        styleSource: seed ? 'seed' : 'default',
        seedNote: seed?.note ?? null,
        claimsPerRun: round2(claimsPerRun),
        bids: highestPerPlayer(mine).sort((a, b) => a - b),
        runsSeen: runs.length,
      };
    });
  return { profiles, targetsPerRun: round2(targetsPerRun), runs: runs.length, validClaims: valid.length };
}

/** One bid per player per run: a manager's conditional duplicates are one interest. */
function highestPerPlayer(claims: readonly ClaimRecord[]): number[] {
  const best = new Map<string, number>();
  for (const c of claims) {
    const key = `${c.run}|${c.playerId}`;
    best.set(key, Math.max(best.get(key) ?? 0, c.amount));
  }
  return [...best.values()];
}

/** How much a player draws one style of manager, 0 to 1. */
export function pullFor(style: BidderStyle, signals: BidSignals): number {
  const w = STYLE_PRIORS[style].weights;
  const { from, to } = BID_MODEL.points;
  const points =
    signals.lastWeekPoints == null ? BID_MODEL.unknownPointsPull : clamp01((signals.lastWeekPoints - from) / (to - from));
  const trend = clamp01(signals.trendHeat ?? 0);
  const role = signals.roleRising ? 1 : 0;
  const pull = w.points * points + w.trend * trend + w.role * role + (signals.freshDrop ? BID_MODEL.freshDropPull : 0);
  return clamp01(pull);
}

/** What a manager bids when he bids, read higher for a player who draws him more. */
function likelyBidOf(profile: RivalProfile, pull: number): number[] {
  const prior = STYLE_PRIORS[profile.style].typicalBid;
  const sample = [...profile.bids, ...Array.from({ length: BID_MODEL.priorBids }, () => prior)].sort((a, b) => a - b);
  const q = 0.35 + 0.6 * pull;
  return [q - 0.2, q, q + 0.2].map((p) => quantile(sample, clamp01(p)));
}

export function adviseBid(opts: {
  signals: BidSignals;
  profiles: readonly RivalProfile[];
  targetsPerRun: number;
  validClaims: number;
  /** Money left; nothing above it is recommended. */
  remaining: number | null;
  /**
   * The need-aware read, by roster id: each rival's record, need and FAAB.
   * A rival missing here is read by the old model, so a partial league still
   * prices.
   */
  rivals?: ReadonlyMap<number, RivalContext> | undefined;
  /** The player's position, for need and interest. */
  position?: string | null | undefined;
  /** How hard to try. Absent: three times in four, as before. */
  posture?: BidPosture | undefined;
}): BidAdvice {
  const rivals: RivalOdds[] = [];
  const dists: { chance: number; bids: number[] }[] = [];
  for (const profile of opts.profiles) {
    const pull = pullFor(profile.style, opts.signals);
    const context = opts.rivals?.get(profile.rosterId);
    if (context) {
      const read = needAwareOdds(profile, context, pull, opts.signals, opts.position ?? null);
      dists.push({ chance: read.chance, bids: read.bids });
      rivals.push(read.odds);
      continue;
    }
    const chance = Math.min(
      BID_MODEL.maxChance,
      (profile.claimsPerRun / Math.max(1, opts.targetsPerRun)) * (pull / BID_MODEL.typicalPull),
    );
    const bids = likelyBidOf(profile, pull);
    dists.push({ chance, bids });
    rivals.push({ rosterId: profile.rosterId, name: profile.name, style: profile.style, chance: round2(chance), likelyBid: bids[1]! });
  }

  /* The chance a bid of b wins: every rival either stays out, bids lower, or ties (a coin flip). */
  const winAt = (b: number): number =>
    dists.reduce((p, d) => {
      const each = 1 / d.bids.length;
      let beat = 0;
      for (const x of d.bids) beat += x < b ? each : x === b ? each / 2 : 0;
      return p * (1 - d.chance + d.chance * beat);
    }, 1);

  const cap = Math.max(BID_MODEL.minBid, opts.remaining ?? 100);
  const smallest = (target: number): number => {
    for (let b = BID_MODEL.minBid; b <= cap; b++) if (winAt(b) >= target) return b;
    return cap;
  };
  const thin =
    opts.validClaims < BID_MODEL.thinClaims
      ? `Only ${opts.validClaims} claims on record this season, so the range is wide.`
      : null;
  /* A thin record widens the range rather than raising the bid: the advice is "just above the competition". */
  const posture = opts.posture ? BID_POSTURE[opts.posture] : null;
  const atLeast = (target: number) => (target <= 0 ? 0 : smallest(target));
  let recommended = smallest(posture?.target ?? BID_MODEL.target);
  let low = Math.min(recommended, posture ? atLeast(posture.low) : smallest(BID_MODEL.low));
  let high = Math.max(recommended, smallest(posture ? posture.high : thin ? BID_MODEL.thinHigh : BID_MODEL.high));
  if (posture?.cap != null) {
    /* A stash: $0 when nobody is likely to want him, else $1. Never more. */
    const anyone = dists.reduce((s, d) => s + d.chance, 0) >= 0.3;
    recommended = anyone ? posture.cap : 0;
    low = 0;
    high = posture.cap;
  }
  const expectedRivals = round2(dists.reduce((s, d) => s + d.chance, 0));
  const noRival = round2(dists.reduce((p, d) => p * (1 - d.chance), 1));
  rivals.sort((a, b) => b.chance - a.chance || a.name.localeCompare(b.name));

  const needAware = rivals.some((r) => r.why !== undefined);
  return {
    recommended,
    low,
    high,
    expectedRivals,
    noRival,
    rivals,
    reason: needAware ? postureReason(recommended, rivals, expectedRivals, opts.posture ?? 'do_this') : reasonFor(recommended, opts.signals, rivals, expectedRivals),
    why: needAware ? postureWhy(rivals, expectedRivals) : whyFor(opts.signals, rivals, expectedRivals),
    thin,
  };
}

/**
 * One rival's chance and likely bid, from his record, his need and his money.
 *
 *     chance = his bid rate on contested players
 *            × his interest in the position
 *            × his roster's need there over the next two weeks
 *            × how much this player draws him (last week's points and
 *              Sleeper's trend, a small signal: 0.85 to 1.45)
 *            × his taste for last week's scorers, when the player was one
 *
 * His likely bid is his own bids as shares of the FAAB he had left, applied to
 * what he has left now, and never above it.
 */
export function needAwareOdds(
  profile: RivalProfile,
  context: RivalContext,
  pull: number,
  signals: BidSignals,
  position: string | null,
): { chance: number; bids: number[]; odds: RivalOdds } {
  const pos = (position ?? '').toUpperCase();
  const t = context.tendency;
  const interest = t.interest[pos] ?? 1;
  const need = context.need?.factor ?? 1;
  const pullFactor = NEED_MODEL.pullFloor + NEED_MODEL.pullSpan * pull;
  const hot = signals.lastWeekPoints != null && signals.lastWeekPoints >= NEED_MODEL.hotPoints;
  const chase = hot ? t.chase : 1;
  const broke = context.remaining != null && context.remaining < 1;
  const chance = Math.min(BID_MODEL.maxChance, t.rate * interest * need * pullFactor * chase);

  const left = context.remaining ?? 100;
  const q = 0.35 + 0.6 * pull;
  const bids = broke
    ? [0, 0, 0]
    : [q - 0.2, q, q + 0.2].map((p) => Math.min(left, Math.round(quantile(t.shares, clamp01(p)) * left)));
  const why = rivalWhy(context, interest, pos, t);
  return {
    chance,
    bids,
    odds: {
      rosterId: profile.rosterId,
      name: profile.name,
      style: profile.style,
      chance: round2(chance),
      likelyBid: bids[1]!,
      why,
      parts: { rate: t.rate, interest, need, pull: round2(pullFactor), chase, remaining: context.remaining },
    },
  };
}

export const NEED_MODEL = {
  /**
   * The player's pull is a small signal: it moves a chance between 0.85 and
   * 1.45. Set so the average multiplier on this league's contested players is
   * about 1 (the backtest's calibration line).
   */
  pullFloor: 0.85,
  pullSpan: 0.6,
  /** Last week's points that count as "a scorer" for the chase reading. */
  hotPoints: 12,
} as const;

/** The few words beside a rival's percent. Need first, then money, then record. */
function rivalWhy(context: RivalContext, interest: number, pos: string, t: RivalTendency): string {
  const need = context.need;
  if (need && (need.state === 'hole' || need.state === 'soon' || need.state === 'surplus')) return need.reason;
  if (context.remaining != null && context.remaining < 1) return 'no FAAB left, $0 bids only';
  if (context.remaining != null && context.remaining <= 5) return `only $${context.remaining} left`;
  if (interest <= 0.5 && pos) return `rarely bids on ${pos === 'DEF' ? 'defences' : `${pos}s`}`;
  if (interest >= 1.6 && pos) return `often bids on ${pos === 'DEF' ? 'defences' : `${pos}s`}`;
  if (need) return need.reason;
  return t.rate >= 0.2 ? 'bids often' : t.rate <= 0.06 ? 'rarely bids' : 'bids now and then';
}

function postureReason(bid: number, rivals: readonly RivalOdds[], expected: number, posture: BidPosture): string {
  const words = BID_POSTURE[posture].words;
  if (posture === 'stash') return expected < 0.3 ? 'A stash, and nobody is likely to want him: $0 should do.' : `A stash, so $0 to $1, never more.`;
  return `${postureWhy(rivals, expected)}, so $${bid} ${words}.`;
}

/** How much competition, in words. The names, percents and reasons are on their own lines. */
function postureWhy(rivals: readonly RivalOdds[], expected: number): string {
  if (expected < 0.3) return 'Nobody is likely chasing him';
  const top = rivals[0];
  if (expected < 0.8 && top) return `${top.name} is the only likely bidder`;
  return expected < 1.5 ? 'About one other manager is likely to bid' : 'Two or more other managers are likely to bid';
}

function reasonFor(bid: number, signals: BidSignals, rivals: readonly RivalOdds[], expected: number): string {
  if (expected < 0.3) return `Nobody is likely chasing him, so $${bid} should win.`;
  return `${whyFor(signals, rivals, expected)}, so bid $${bid}.`;
}

/** What draws the competition, or how much of it there is: one clause, no closing number. */
function whyFor(signals: BidSignals, rivals: readonly RivalOdds[], expected: number): string {
  if (expected < 0.3) return 'Nobody is likely chasing him';
  const drivers: string[] = [];
  if (signals.freshDrop) drivers.push('just dropped, and the room rated him');
  if (signals.lastWeekPoints != null && signals.lastWeekPoints >= 12) {
    drivers.push(`scored ${signals.lastWeekPoints.toFixed(1)} last week, which draws the chasers`);
  }
  const savvy = rivals.find((r) => r.style === 'savvy' && r.chance >= 0.25);
  if (savvy) {
    const why = signals.trendRank != null && signals.trendRank <= 25 ? `#${signals.trendRank} on Sleeper's adds` : signals.roleRising ? 'a rising role' : null;
    drivers.push(`a likely ${savvy.name} target${why ? ` (${why})` : ''}`);
  }
  if (drivers.length > 0) return capitalise(drivers.join('; '));
  return expected < 1.5 ? 'One other manager is likely to bid' : 'Two or more other managers are likely to bid';
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
