/**
 * What this player will actually cost, in this league's dollars.
 *
 * The whole model is an empirical quantile lookup against the league's own
 * record of winning bids, moved by how much demand this particular player
 * creates and bounded by what the people who want him can still spend. There is
 * no external "generic FAAB value" input, and there is deliberately no
 * point estimate: the output is a range, because a point estimate would be a
 * confidence this data cannot support.
 *
 * Why quantiles rather than a fitted curve. A league's bid distribution is
 * violently skewed — dozens of $1 claims, a handful of $40 ones — so a mean is
 * a number nobody ever bid and a regression on eleven points is a straight line
 * through noise. The quantile of the league's own history is always a price
 * somebody in this league actually paid.
 *
 * Three things this file refuses to do:
 *
 * - **Invent a price with no history.** A first-year league returns `unknown`
 *   and says why. A default of "$5–8, probably" would be a made-up number with
 *   a plausible shape, which is the worst kind.
 * - **Ignore the wallets.** You cannot be outbid above what the other managers
 *   have left. When the needy teams are broke, the range comes down, and the
 *   reason is one of the stated drivers.
 * - **Let a manager profile dominate.** Every profile effect is bounded by
 *   `MAX_AGGRESSION_EFFECT` in `managers.ts` — ±25%, applied once.
 */

import { aggressionModifier, type ManagerProfile } from './managers.ts';
import { winningBids, type LeagueTransaction } from './transactions.ts';

/** Recency weights. A bid two seasons ago is evidence; it is not this season. */
export const RECENCY_WEIGHTS = { current: 3, previous: 1.5, older: 0.75 } as const;

/** The narrowest band the model will report, as a quantile half-width. */
export const BAND_HALF_WIDTH = 0.15;

/** Winning bids below which no distribution is reported at all. */
export const MIN_PRICED_HISTORY = 6;

export interface FaabDriver {
  label: string;
  /** Signed, in the same units as `demand` — a share of the 0–1 demand scale. */
  effect: number;
}

export interface DemandInput {
  /**
   * How good the player is *for this league*, 0–1, supplied by the ranking
   * layer. This is the dominant term and it is not computed here: pricing must
   * not become a second, quieter opinion about who is good.
   */
  value: number;
  /** How many teams have a real need at his position. */
  needyTeams: number;
  /** Teams in the league, so "four needy teams" scales with league size. */
  totalTeams: number;
  /** True when he only has a job because somebody else is hurt. */
  injuryBeneficiary?: boolean;
  /** True when his role has grown on its own merits. */
  roleRising?: boolean;
  /** True when the position is thin league-wide. */
  scarcePosition?: boolean;
  /** He fills a hole in the lineup this week rather than being a stash. */
  immediateStarter?: boolean;
}

export interface FaabEstimate {
  /** Dollars. Null together when there is no history to price against. */
  low: number | null;
  high: number | null;
  /** `$8–12 expected`, or an honest sentence when unknown. */
  display: string;
  known: boolean;
  /** 0–1, before it was turned into money. Shown in the breakdown. */
  demand: number;
  drivers: FaabDriver[];
  /** Priced bids the distribution rests on. */
  sample: number;
  notes: string[];
}

export interface FaabInput {
  demand: DemandInput;
  transactions: LeagueTransaction[];
  /** Season → that season's budget. Bids are only comparable within one. */
  budgetBySeason: Map<string, number>;
  currentSeason: string;
  /** This season's budget, which the answer is denominated in. */
  budget: number | null;
  /** The managers judged likely to bid, for the bounded aggression effect. */
  likelyBidders?: ManagerProfile[];
  /** League-wide mean bid share, the baseline a profile is compared against. */
  leagueMeanShare?: number | null;
  /** What each rival can still spend, so the ceiling is real money. */
  rivalRemaining?: number[];
}

/**
 * Turn the situation into a single 0–1 demand number.
 *
 * Kept separate from the money so the two can be tested apart, and so the card
 * can show which parts of the situation moved the price rather than only the
 * price. Every term is bounded and the sum is clamped; nothing here can run
 * away because three modest factors all pointed the same way.
 */
export function demandOf(input: DemandInput): { demand: number; drivers: FaabDriver[] } {
  const drivers: FaabDriver[] = [];
  const value = clamp01(input.value);
  drivers.push({ label: `player value in this league (${Math.round(value * 100)}%)`, effect: round3(value * 0.55) });

  const needShare = input.totalTeams > 0 ? clamp01(input.needyTeams / Math.max(1, input.totalTeams - 1)) : 0;
  if (input.needyTeams > 0) {
    drivers.push({
      label: `${input.needyTeams} other team(s) have a real need at the position`,
      effect: round3(needShare * 0.25),
    });
  }

  if (input.scarcePosition) drivers.push({ label: 'the position is thin league-wide', effect: 0.08 });
  if (input.immediateStarter) drivers.push({ label: 'starts somewhere this week', effect: 0.07 });
  if (input.roleRising) drivers.push({ label: 'role has grown on merit', effect: 0.05 });

  /*
   * An injury beneficiary is worth less than the same production would
   * otherwise be, and this is the one negative term in the model. He is not a
   * player who got better; he is a player standing in a job with a return date
   * on it, and a league that has watched a handbook full of these prices them
   * accordingly.
   */
  if (input.injuryBeneficiary) {
    drivers.push({ label: 'only has the job while somebody is hurt', effect: -0.1 });
  }

  const demand = clamp01(drivers.reduce((a, d) => a + d.effect, 0));
  return { demand: round3(demand), drivers };
}

/**
 * The league's own winning-bid shares, recency weighted, sorted.
 *
 * Weighting is done by repetition rather than by a weighted-quantile formula:
 * the numbers are small, repetition is exactly equivalent for a quantile, and
 * it keeps every value in the array a price somebody in this league paid.
 */
export function weightedBidShares(
  transactions: LeagueTransaction[],
  budgetBySeason: Map<string, number>,
  currentSeason: string,
): number[] {
  const seasons = [...new Set(transactions.map((t) => t.season))].sort();
  const previousSeason = seasons.filter((s) => s < currentSeason).pop() ?? null;
  const out: number[] = [];

  for (const t of winningBids(transactions)) {
    const budget = budgetBySeason.get(t.season);
    if (!budget || budget <= 0) continue;
    const share = (t.waiverBid ?? 0) / budget;
    const weight =
      t.season === currentSeason
        ? RECENCY_WEIGHTS.current
        : t.season === previousSeason
          ? RECENCY_WEIGHTS.previous
          : RECENCY_WEIGHTS.older;
    for (let i = 0; i < Math.round(weight * 2); i++) out.push(share);
  }

  return out.sort((a, b) => a - b);
}

/** Linear-interpolated quantile over a sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = clamp01(q) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function expectedFaabCost(input: FaabInput): FaabEstimate {
  const { demand, drivers } = demandOf(input.demand);
  const notes: string[] = [];

  const shares = weightedBidShares(input.transactions, input.budgetBySeason, input.currentSeason);
  const distinctBids = winningBids(input.transactions).filter((t) => (input.budgetBySeason.get(t.season) ?? 0) > 0).length;

  if (distinctBids < MIN_PRICED_HISTORY || input.budget == null || input.budget <= 0) {
    return {
      low: null,
      high: null,
      known: false,
      display:
        distinctBids === 0
          ? 'no priced waiver history in this league yet'
          : `only ${distinctBids} priced claim(s) on record — not enough to price against`,
      demand,
      drivers,
      sample: distinctBids,
      notes:
        input.budget == null || input.budget <= 0
          ? [...notes, 'this league has no FAAB budget recorded, so a dollar figure would be meaningless']
          : notes,
    };
  }

  const centre = quantile(shares, demand);
  let low = quantile(shares, Math.max(0, demand - BAND_HALF_WIDTH));
  let high = quantile(shares, Math.min(1, demand + BAND_HALF_WIDTH));

  /*
   * The bounded manager effect, applied once to the whole band.
   *
   * The bidders' own aggression is averaged rather than taken at its maximum:
   * one aggressive manager does not set the price unless he wins, and if he
   * wins at his usual share the distribution already contains that bid.
   */
  const modifiers = (input.likelyBidders ?? [])
    .map((p) => aggressionModifier(p, input.leagueMeanShare ?? 0))
    .filter((m) => m !== 1);
  if (modifiers.length > 0) {
    const m = modifiers.reduce((a, b) => a + b, 0) / modifiers.length;
    low *= m;
    high *= m;
    drivers.push({
      label:
        m > 1
          ? 'the managers who need him bid above this league’s average'
          : 'the managers who need him bid below this league’s average',
      effect: round3((m - 1) * 0.2),
    });
  }

  let lowDollars = Math.max(1, Math.round(low * input.budget));
  let highDollars = Math.max(lowDollars + 1, Math.round(high * input.budget));

  /*
   * You cannot be outbid by money that does not exist.
   *
   * The ceiling is the deepest rival wallet. A league where everybody has spent
   * down to $3 cannot produce a $20 winning bid however badly they want the
   * player, and saying otherwise would talk the user into overpaying by an
   * order of magnitude at exactly the point in the season when FAAB is most
   * decisive.
   */
  const wallets = (input.rivalRemaining ?? []).filter((n) => Number.isFinite(n));
  if (wallets.length > 0) {
    const deepest = Math.max(...wallets);
    if (highDollars > deepest) {
      highDollars = Math.max(1, deepest);
      lowDollars = Math.min(lowDollars, highDollars);
      drivers.push({ label: `no rival has more than $${deepest} left to spend`, effect: -0.1 });
      notes.push('capped by what the other managers can still afford');
    }
  }

  if (centre > 0 && shares.length < 12) {
    notes.push('thin history — the range is wider than the numbers suggest');
  }

  return {
    low: lowDollars,
    high: highDollars,
    known: true,
    display: lowDollars === highDollars ? `$${lowDollars} expected` : `$${lowDollars}–${highDollars} expected`,
    demand,
    drivers: drivers.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 5),
    sample: distinctBids,
    notes,
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
