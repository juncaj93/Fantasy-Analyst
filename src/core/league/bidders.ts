/**
 * Who, by name, is likely to bid — and roughly how much.
 *
 * `competition.ts` answers *how many* rivals want a player and can pay for him.
 * This answers the next question, which is the one a manager actually asks
 * before typing a number: **which of them, and what will they put in?**
 *
 * ---
 *
 * ## The double-counting rule, which governs this whole file
 *
 * The expected market price already exists and is computed elsewhere
 * (`core/faab/strategy.ts`). Manager tendency reaches that price through exactly
 * one path: `rivalsWithNeed`, a *count* of rivals normalised against the funded
 * field. It carries no magnitude — no manager's spending habit moves the market
 * price today, and nothing here changes that.
 *
 * So a named estimate here is a **decomposition of the aggregate, never an
 * addition to it**. It takes the market range as given and asks how one
 * particular manager sits inside it. Concretely:
 *
 *   - the aggregate price is an input to this module and never an output;
 *   - `expected`, `recommended` and `doNotExceed` are untouched — this module
 *     cannot reach them, and a test asserts the three are identical with the
 *     named pass on and off;
 *   - a manager's tendency multiplies *his own* estimate and nothing else.
 *
 * Get that backwards and the aggressive manager raises the market price, which
 * raises his own estimate, which is a number with no evidence under it.
 *
 * ---
 *
 * ## What is never done
 *
 * A measured tendency is never fabricated. Below `MIN_BIDS_FOR_TENDENCY` a
 * manager has a history, not a habit, and his estimate falls back to the
 * league's own range with the reason stated. When even the aggregate cannot be
 * priced, there is no estimate at all — a name and a need, or nothing.
 *
 * And when the naming itself is too weak to support, the caller is told to show
 * the aggregate pressure alone. A card that says *Joe will bid $17–22* on the
 * strength of two observations is worse than one that says *high pressure*.
 */

import type { BidObservation, PriceSummary } from '../faab/bids.ts';
import type { LeagueBudgetRule } from '../faab/budget.ts';
import type { CompetitionAssessment, LikelyBidder, NeedLevel, TeamNeed } from './competition.ts';

/** Bids by one manager below which no tendency is claimed about him. */
export const MIN_BIDS_FOR_TENDENCY = 3;

/** The most a manager's own history may move his estimate, either way. */
export const MAX_TENDENCY_EFFECT = 0.4;

/**
 * Named rivals shown at once.
 *
 * The card summarises as `Joe, Ryan +1`; the expanded view lists them. Past
 * four the list stops being a list of people and becomes a list of the league.
 */
export const MAX_NAMED = 4;

/** How much a thin manager sample widens his estimate, as a share either way. */
export const THIN_SAMPLE_WIDENING = 0.25;

export type EstimateBasis = 'manager_history' | 'league_price' | 'none';

export interface BidderTendency {
  rosterId: number;
  /** Bids observed for this manager, won and lost. */
  sample: number;
  /** His median bid as a share of the season budget. Null below threshold. */
  medianShare: number | null;
  /**
   * His median share divided by the league's. Above 1 means he spends more than
   * the room. Null below threshold, and bounded when present.
   */
  relative: number | null;
  confident: boolean;
  /** One phrase, only when the sample supports it. */
  note: string | null;
}

export interface NamedBidder {
  rosterId: number;
  displayName: string;
  need: NeedLevel;
  /** `needs RB2` — the slot he cannot fill, not a general observation. */
  needReason: string;
  remaining: number | null;
  /** Dollars. Null when nothing supportable can be said about the amount. */
  estimate: { low: number; high: number } | null;
  basis: EstimateBasis;
  confidence: 'high' | 'medium' | 'low';
  tendency: string | null;
  /** The sample caveat, when one is owed. */
  caveat: string | null;
  /** `Joe · likely $17–22 · $41 left · needs RB2 · bids big on scarce backs` */
  display: string;
}

export interface BidderIntel {
  /** Ranked, most likely and most dangerous first. Empty when names are withheld. */
  named: NamedBidder[];
  /** `3 likely bidders` / `Joe, Ryan +1`. Null when there is nothing to say. */
  summary: string | null;
  /**
   * False when the evidence does not support naming anybody, in which case the
   * caller shows aggregate pressure alone. This is a deliberate output rather
   * than an empty list, so a screen can tell "nobody is bidding" from "we are
   * not confident enough to say who".
   */
  namesShown: boolean;
  /** Why names were withheld, or what the named list rests on. */
  notes: string[];
}

export interface BidderIntelInput {
  competition: CompetitionAssessment;
  /** The needs the competition was assessed from, for the slot wording. */
  needs: TeamNeed[];
  /** Every bid this league has published, from `collectBids`. */
  observations: BidObservation[];
  /** The league's own price summary. The aggregate this decomposes. */
  prices: PriceSummary | null;
  rule: LeagueBudgetRule;
  position: string;
}

/**
 * What one manager's own bids say about him, if anything.
 *
 * The median rather than the mean: a manager with nine $1 claims and one $60
 * splash has a habit of $1 claims, and the mean says $7, which is a number he
 * has never bid. Shares of budget rather than dollars, so a league that changed
 * its budget does not read as a league that changed its managers.
 */
export function tendencyFor(
  rosterId: number,
  observations: BidObservation[],
  budgetTotal: number | null,
  leagueMedianShare: number | null,
): BidderTendency {
  const mine = observations.filter((o) => o.rosterId === rosterId);
  const base: BidderTendency = {
    rosterId,
    sample: mine.length,
    medianShare: null,
    relative: null,
    confident: false,
    note: null,
  };

  if (mine.length < MIN_BIDS_FOR_TENDENCY || !budgetTotal || budgetTotal <= 0) return base;

  const shares = mine.map((o) => o.amount / budgetTotal).sort((a, b) => a - b);
  const medianShare = median(shares);
  const relative =
    leagueMedianShare && leagueMedianShare > 0
      ? clamp(medianShare / leagueMedianShare, 1 - MAX_TENDENCY_EFFECT, 1 + MAX_TENDENCY_EFFECT)
      : null;

  return {
    rosterId,
    sample: mine.length,
    medianShare: round3(medianShare),
    relative: relative == null ? null : round3(relative),
    confident: true,
    note: noteFor(relative, mine.length),
  };
}

function noteFor(relative: number | null, sample: number): string | null {
  if (relative == null) return `${sample} bids on record`;
  if (relative >= 1.2) return 'bids above the room';
  if (relative <= 0.85) return 'bids below the room';
  return 'bids around the room';
}

/**
 * The named list, ranked, with the amounts each rival plausibly puts in.
 *
 * Every estimate starts from the league's own expected range and is moved only
 * by that manager's own history and capped by his own wallet. Nothing here can
 * produce a number larger than the money a manager actually has.
 */
export function namedBidders(input: BidderIntelInput): BidderIntel {
  const notes: string[] = [];
  const budgetTotal = input.rule.total;
  const bidding = input.rule.usesFaab;

  const needByRoster = new Map(input.needs.map((n) => [n.rosterId, n]));
  const leagueMedianShare =
    input.prices?.median != null && budgetTotal && budgetTotal > 0 ? input.prices.median / budgetTotal : null;

  /*
   * Naming requires a reason to name somebody.
   *
   * The reason is the need, which `competition.ts` already established from
   * rosters rather than from anybody's habits. Without a need there is no
   * bidder to name, however much money is lying around.
   */
  if (input.competition.bidders.length === 0) {
    return {
      named: [],
      summary: null,
      namesShown: false,
      notes: ['nobody else has a hole at the position, so there is no rival to name'],
    };
  }

  const named = input.competition.bidders
    .map((bidder) => toNamed(bidder, {
      need: needByRoster.get(bidder.rosterId) ?? null,
      tendency: tendencyFor(bidder.rosterId, input.observations, budgetTotal, leagueMedianShare),
      prices: input.prices,
      budgetTotal,
      bidding,
      position: input.position,
    }))
    .sort(compareBidders)
    .slice(0, MAX_NAMED);

  /*
   * Withhold the names when not one of them rests on anything.
   *
   * A named list where every entry is "we know he has a hole and nothing else"
   * is the aggregate pressure with twelve extra words. The bar is one named
   * rival whose wallet or whose history is actually known.
   */
  const supportable = named.filter((b) => b.remaining != null || b.basis === 'manager_history');
  if (supportable.length === 0) {
    return {
      named: [],
      summary: null,
      namesShown: false,
      notes: [
        'the rivals with a need cannot be told apart — no wallet and no bid history is on record for any of them',
      ],
    };
  }

  if (!bidding) notes.push('this league does not bid, so the names are who wants him rather than who outspends you');
  if (input.prices == null || input.prices.sample === 0) {
    notes.push('no winning bid is on record in this league, so the amounts are withheld rather than estimated');
  }

  return { named, summary: summarize(named, input.competition), namesShown: true, notes };
}

function toNamed(
  bidder: LikelyBidder,
  ctx: {
    need: TeamNeed | null;
    tendency: BidderTendency;
    prices: PriceSummary | null;
    budgetTotal: number | null;
    bidding: boolean;
    position: string;
  },
): NamedBidder {
  const needReason = needWording(ctx.need, ctx.position);
  const { estimate, basis, caveat } = estimateFor(bidder, ctx);

  const confidence: NamedBidder['confidence'] =
    basis === 'manager_history' && bidder.remaining != null
      ? 'high'
      : basis === 'none'
        ? 'low'
        : 'medium';

  const parts = [bidder.displayName];
  if (estimate) parts.push(`likely $${estimate.low}–${estimate.high}`);
  else if (ctx.bidding) parts.push('amount unknown');
  if (bidder.remaining != null) parts.push(`$${bidder.remaining} left`);
  parts.push(needReason);
  if (ctx.tendency.note && ctx.tendency.confident) parts.push(ctx.tendency.note);

  return {
    rosterId: bidder.rosterId,
    displayName: bidder.displayName,
    need: bidder.need,
    needReason,
    remaining: bidder.remaining,
    estimate,
    basis,
    confidence,
    tendency: ctx.tendency.confident ? ctx.tendency.note : null,
    caveat,
    display: parts.join(' · '),
  };
}

/**
 * The slot he cannot fill, named as a slot.
 *
 * `needs RB2` is a fact about his roster — he has one back and starts two.
 * "Needs a running back" is the same fact with the useful part removed.
 */
function needWording(need: TeamNeed | null, position: string): string {
  if (!need) return `needs ${position}`;
  if (need.level === 'urgent') return `needs ${position}${need.healthy + 1}`;
  return `could use ${position} depth`;
}

/**
 * What this manager plausibly puts in.
 *
 * Three gates, in order, and each one can end it:
 *
 *   1. the league must price at all — no market range, no estimate;
 *   2. his own history moves the range, or does not exist and says so;
 *   3. his wallet caps it, because he cannot bid money he does not have.
 */
function estimateFor(
  bidder: LikelyBidder,
  ctx: { tendency: BidderTendency; prices: PriceSummary | null; budgetTotal: number | null; bidding: boolean },
): { estimate: { low: number; high: number } | null; basis: EstimateBasis; caveat: string | null } {
  if (!ctx.bidding) {
    return { estimate: null, basis: 'none', caveat: 'this league does not use FAAB' };
  }
  const low = ctx.prices?.low ?? null;
  const high = ctx.prices?.high ?? null;
  if (low == null || high == null || (ctx.prices?.sample ?? 0) === 0) {
    return { estimate: null, basis: 'none', caveat: 'no winning bid is on record to price against' };
  }

  const relative = ctx.tendency.relative;
  const basis: EstimateBasis = relative != null ? 'manager_history' : 'league_price';

  let lo = low * (relative ?? 1);
  let hi = high * (relative ?? 1);

  /*
   * Thin evidence widens the range rather than shifting it.
   *
   * Being less sure about somebody is not the same as expecting him to bid
   * more, and a confident-looking narrow band is the specific way this feature
   * would mislead.
   */
  if (relative == null) {
    const width = (hi - lo) || hi * 0.2;
    lo -= width * THIN_SAMPLE_WIDENING;
    hi += width * THIN_SAMPLE_WIDENING;
  }

  let loDollars = Math.max(1, Math.round(lo));
  let hiDollars = Math.max(loDollars, Math.round(hi));

  let caveat: string | null =
    relative == null
      ? ctx.tendency.sample === 0
        ? 'no bids of his own on record — this is the league’s range'
        : `only ${ctx.tendency.sample} bid(s) of his own on record — this is the league’s range`
      : null;

  // He cannot bid money he does not have.
  if (bidder.remaining != null && hiDollars > bidder.remaining) {
    hiDollars = Math.max(1, bidder.remaining);
    loDollars = Math.min(loDollars, hiDollars);
    caveat = caveat ? `${caveat}; capped by his $${bidder.remaining}` : `capped by his $${bidder.remaining}`;
  }

  return { estimate: { low: loDollars, high: hiDollars }, basis, caveat };
}

/**
 * Most dangerous first.
 *
 * Urgency leads, because a manager who cannot field the position is the one who
 * bids past sense. Then the top of his range, then his wallet: between two
 * rivals who will pay the same, the one with more left is the one who can go
 * again.
 */
function compareBidders(a: NamedBidder, b: NamedBidder): number {
  return (
    Number(b.need === 'urgent') - Number(a.need === 'urgent') ||
    (b.estimate?.high ?? -1) - (a.estimate?.high ?? -1) ||
    (b.remaining ?? -1) - (a.remaining ?? -1) ||
    a.displayName.localeCompare(b.displayName)
  );
}

/**
 * The one line the card shows.
 *
 * Names when there are few enough to read, a count when there are not. The
 * count always agrees with the aggregate label, because both are taken from the
 * same bidder list — a card reading `High pressure · 1 likely bidder` is the
 * kind of self-contradiction that costs a feature its credibility.
 */
export function summarize(named: NamedBidder[], competition: CompetitionAssessment): string | null {
  const total = competition.bidders.length;
  if (total === 0) return null;

  const plural = total === 1 ? 'bidder' : 'bidders';
  if (named.length === 0) return `${total} likely ${plural}`;

  const shown = named.slice(0, 2).map((b) => b.displayName);
  const rest = total - shown.length;
  const names = rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
  return `${total} likely ${plural} · ${names}`;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
