/**
 * The waiver bid: the one function every bid on the Waivers screen comes from
 * (Round 20, 11 November 2026).
 *
 * ## Why
 *
 * Alex: the app often told him to spend more than he should. It priced a claim
 * off who might bid and a guess at what they bid, never off what this league
 * has actually paid. Three seasons of the league's own claims (2024 to 2026,
 * `leagueBidHistory.ts`) say a starter-level player somebody else also wanted
 * was usually won for a few dollars, while the winners paid about $11.
 *
 * ## The rule
 *
 * The chance a bid of $b wins him is
 *
 *     chance nobody else bids + chance somebody does × share of contested
 *                                                    starters $b would have won
 *
 * The first part is the rival read (`waivers/bidModel.ts`); the second is this
 * league's history for a starter at his position, or every starter's when the
 * position has too few contested claims on record. The bid is the lowest whole
 * dollar that wins him three times in four for a "Do this" move and half the
 * time for "Worth considering". Then:
 *
 * - **$0** when that is already likely: nobody else is expected to bid.
 * - **Never more than he is worth to you:** his gain over the player he
 *   replaces (season-weighted points) times the league's price per point.
 * - **Never into the playoff reserve:** at most FAAB left less $20 until the
 *   playoffs (`faab/budget.ts`).
 *
 * A stash is $0, or $1 when somebody else may want him. A block of this
 * week's opponent stays at most $3 (Alex, 5 November 2026) and at least $1,
 * so it beats a $0 claim.
 *
 * One number and one short reason. Nothing here places a claim.
 */

import { LEAGUE_BID_HISTORY, type BidHistorySummary, type PriceRow } from './leagueBidHistory.ts';

export type SmartBidKind = 'do_this' | 'consider' | 'stash' | 'block';

export const SMART_BID = {
  /** Fewer expected rival bidders than this is "nobody else": $0. */
  nobody: 0.3,
  /** How often the bid should win him. */
  target: { do_this: 0.75, consider: 0.5 },
  /** The most a block bids (Alex, 5 November 2026). */
  blockMax: 3,
  /** The most a stash bids. */
  stashMax: 1,
} as const;

export interface SmartBidInput {
  kind: SmartBidKind;
  position: string;
  /** Season-weighted points of lineup gain over the player he replaces. Null: not known, no value cap. */
  gain: number | null;
  /** Expected number of other managers bidding. Null: not known. */
  expectedRivals: number | null;
  /** The chance nobody else bids, 0 to 1. Null: not known, read as contested. */
  noRival?: number | null;
  /** What a bid may spend now: FAAB left less the playoff reserve. Null: not known. */
  spendable: number | null;
  /** Dollars held for the playoffs, for the reason. */
  reserveHeld?: number;
  /** The league's record; the stored summary when absent. */
  history?: BidHistorySummary;
}

export interface SmartBid {
  bid: number;
  /** One short reason, no closing period. */
  reason: string;
  /** Which rule set the number. */
  basis: 'nobody' | 'history' | 'value' | 'reserve' | 'stash' | 'block';
  /** The lowest bid that likely wins, from the league's prices. Null on a stash. */
  clearing: number | null;
  /** What he is worth to Alex, dollars. Null without a gain. */
  valueCap: number | null;
  /** The position had too few contested claims, so every starter's prices stood in. */
  thin: boolean;
}

/** `starting WR`, `starting defense`. */
function starterWords(position: string): string {
  const pos = position.toUpperCase();
  return pos === 'DEF' ? 'starting defense' : `starting ${pos}`;
}

/** The league's price row for a tier and position, or every position's when this one is thin. */
export function priceRowFor(
  tier: 'starter' | 'depth',
  position: string,
  history: BidHistorySummary = LEAGUE_BID_HISTORY,
): { row: PriceRow; thin: boolean } {
  const table = history[tier];
  const own = table[position.toUpperCase()];
  if (own && own.contested >= history.minContested) return { row: own, thin: false };
  return { row: table.ALL!, thin: true };
}

/** The share of contested players a bid of `dollars` would have won. */
export function shareWonAt(row: PriceRow, dollars: number): number {
  let share = 0;
  for (const [d, s] of row.won) if (d <= dollars) share = s;
  return share;
}

/** The lowest whole dollar that wins him `target` of the time, given the chance nobody else bids. */
export function clearingBid(row: PriceRow, target: number, noRival: number): number {
  const none = Math.min(1, Math.max(0, noRival));
  if (none >= target) return 0;
  const top = row.won.length > 0 ? row.won[row.won.length - 1]![0] : 1;
  for (let b = 1; b <= top; b++) if (none + (1 - none) * shareWonAt(row, b) >= target - 1e-9) return b;
  return top;
}

export function smartBid(input: SmartBidInput): SmartBid {
  const history = input.history ?? LEAGUE_BID_HISTORY;
  const spendable = input.spendable == null ? null : Math.max(0, Math.floor(input.spendable));
  const unlikely = input.expectedRivals != null && input.expectedRivals < SMART_BID.nobody;

  if (input.kind === 'stash') {
    const want = unlikely ? 0 : SMART_BID.stashMax;
    const bid = spendable == null ? want : Math.min(want, spendable);
    return {
      bid,
      reason: bid === 0 ? 'A stash nobody else is chasing' : 'A stash, so $1 at most',
      basis: 'stash',
      clearing: null,
      valueCap: null,
      thin: false,
    };
  }

  if (input.kind === 'block') {
    const { row } = priceRowFor('depth', input.position, history);
    const bid = Math.max(1, Math.min(SMART_BID.blockMax, row.p75, spendable ?? SMART_BID.blockMax));
    return { bid, reason: `A block: $${SMART_BID.blockMax} at most`, basis: 'block', clearing: row.p75, valueCap: null, thin: false };
  }

  const { row, thin } = priceRowFor('starter', input.position, history);
  const target = SMART_BID.target[input.kind];
  const clearing = unlikely ? 0 : clearingBid(row, target, input.noRival ?? 0);
  const valueCap = input.gain == null ? null : Math.max(1, Math.round(Math.max(0, input.gain) * history.pricePerPoint));
  const often = input.kind === 'do_this' ? 'about 3 times in 4' : 'about half the time';

  let bid: number;
  let basis: SmartBid['basis'];
  let reason: string;
  if (clearing === 0) {
    bid = 0;
    basis = 'nobody';
    reason = 'Nobody else is likely to bid';
  } else if (valueCap != null && valueCap < clearing) {
    bid = valueCap;
    basis = 'value';
    reason = `Worth about $${valueCap} to you; a ${starterWords(input.position)} usually takes $${clearing}`;
  } else {
    bid = clearing;
    basis = 'history';
    /* The number sits beside the reason (`Bid $6: ...`), so the reason does not repeat it. */
    reason = thin
      ? `Few ${input.position.toUpperCase()} bids on record; wins a starter here ${often}`
      : `Wins a ${starterWords(input.position)} in this league ${often}`;
  }
  if (spendable != null && bid > spendable) {
    bid = spendable;
    basis = 'reserve';
    reason = `Keeps $${input.reserveHeld ?? 20} for the playoffs`;
  }
  return { bid, reason, basis, clearing, valueCap, thin };
}
