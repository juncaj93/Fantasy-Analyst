/**
 * Where to open, where to settle, and where to walk away.
 *
 * A trade valuation produces one number and one number is not a negotiation.
 * What a manager actually needs is three: the offer that starts the conversation
 * without insulting anybody, the band inside which the deal is fair to both
 * sides, and the point past which winning the argument means losing the trade.
 *
 * The ladder is expressed in the app's own value units — whatever the caller
 * hands in — rather than in a made-up "trade value" currency, because a second
 * currency is a second thing to keep calibrated and the first one is already
 * calibrated against fantasy points.
 *
 * Two constraints shape every number below:
 *
 *   - **the partner has to say yes.** An offer is not better for being cheaper;
 *     an offer nobody accepts is worth exactly nothing. So the opening offer is
 *     bounded by what the partner's own tendencies suggest he will entertain,
 *     not by how little you would like to pay;
 *   - **fair is a band, not a point.** Two rosters value the same player
 *     differently and both can be right. The fair zone is where the surplus is
 *     split rather than captured.
 *
 * Advisory only. Nothing here sends a trade, opens a chat, or names a price to
 * anybody but you.
 */

import type { ManagerTradeProfile } from '../managers/tradeProfile.ts';

export interface TradeSide {
  /** What this side gives up, in the caller's value units. */
  value: number;
  /** What those players are worth *to the receiving roster*, after fit. */
  valueToReceiver: number;
  playerIds: string[];
  names: string[];
}

export interface LadderInputs {
  targetPlayerId: string;
  targetName: string;
  /** Objective value of the player you want, before any roster fit. */
  targetValue: number;
  /** What he is worth to *your* roster once need and fit are applied. */
  targetValueToMe: number;
  /**
   * What the partner's roster loses by giving him up. Below `targetValue` when
   * he is surplus to their needs — which is the whole reason a trade exists.
   */
  targetCostToPartner: number;
  /** The assets you are willing to consider sending. */
  offering: TradeSide;
  partner: ManagerTradeProfile | null;
}

export interface TradeLadder {
  targetPlayerId: string;
  targetName: string;
  /** Where to start. Below fair, but inside the range this partner entertains. */
  opening: number;
  fair: { low: number; high: number };
  /** Past this, you have paid more than he is worth to you. */
  doNotExceed: number;
  /** Ordered, human, and in the units the caller supplied. */
  rungs: { label: string; value: number; note: string }[];
  reasons: string[];
  /** Null when the ladder stands; a sentence when it should not be shown at all. */
  blocked: string | null;
  advisory: 'never auto-sent';
}

/**
 * How far below fair an opening offer may sit.
 *
 * Ten per cent is an opening offer. Forty per cent is an insult, and an insult
 * is not a negotiating position — it is the end of the conversation, and every
 * subsequent offer you make is read through it.
 */
export const OPENING_DISCOUNT = 0.12;
/** How much further a manager known to counter everything can be lowballed. */
const HAGGLER_EXTRA_DISCOUNT = 0.08;
/** …and how much less room a manager who accepts or walks gets offered. */
const TAKE_IT_OR_LEAVE_IT_REDUCTION = 0.06;

/**
 * Build the three rungs.
 *
 * The fair zone is anchored between what the player costs his current owner and
 * what he is worth to you — the two honest ends of the bargain. Its width is the
 * surplus the trade creates, and a trade that creates none is reported as
 * blocked rather than dressed up with a band a millimetre wide.
 */
export function buildLadder(inputs: LadderInputs): TradeLadder {
  const reasons: string[] = [];

  const floor = Math.max(0, inputs.targetCostToPartner);
  const ceiling = Math.max(0, inputs.targetValueToMe);

  if (ceiling <= 0) {
    return blockedLadder(inputs, 'He is worth nothing to your roster as it stands, so there is no offer to make.');
  }
  if (ceiling <= floor) {
    return blockedLadder(
      inputs,
      'He is worth more to his current roster than to yours. Any price that works for them loses for you.',
    );
  }

  const surplus = ceiling - floor;
  /*
   * Fair is the middle half of the surplus.
   *
   * Splitting it exactly down the middle would produce a single number again and
   * pretend to a precision neither side has. The middle half is wide enough to
   * be an actual zone and narrow enough that both ends are defensible as fair.
   */
  const fairLow = round2(floor + surplus * 0.25);
  const fairHigh = round2(floor + surplus * 0.75);

  let discount = OPENING_DISCOUNT;
  const partner = inputs.partner;
  if (partner) {
    if (partner.negotiation === 'counters_often') {
      discount += HAGGLER_EXTRA_DISCOUNT;
      reasons.push('Opens lower than usual: this manager counters nearly every offer, so leave room.');
    } else if (partner.negotiation === 'accepts_or_declines') {
      discount = Math.max(0, discount - TAKE_IT_OR_LEAVE_IT_REDUCTION);
      reasons.push('Opens close to fair: this manager tends to accept or decline rather than counter.');
    }
  }

  /*
   * The opening never falls below what the player costs his owner.
   *
   * Below that line the offer is not aggressive, it is arithmetic the partner
   * can do in one second, and it spends the credibility the next offer needs.
   */
  const opening = round2(Math.max(floor, fairLow * (1 - discount)));
  const doNotExceed = round2(ceiling);

  if (inputs.targetValueToMe > inputs.targetValue) {
    reasons.push('Worth more to you than to the field, because of where your roster is thin.');
  }
  if (inputs.targetCostToPartner < inputs.targetValue) {
    reasons.push('Surplus to his roster’s needs, which is why there is a deal here at all.');
  }
  if (partner?.prefersConsolidation) {
    reasons.push('This manager has historically preferred two-for-one deals, so a package is likelier to land.');
  }
  if (partner && partner.sample < partner.minSample) {
    reasons.push(`Partner tendencies come from only ${partner.sample} trade(s) and are used lightly.`);
  }

  const offered = inputs.offering.valueToReceiver;
  if (offered > 0) {
    if (offered > doNotExceed) {
      reasons.push('What you have put on the table is already above your own ceiling for him.');
    } else if (offered < opening) {
      reasons.push('What you have put on the table is below a credible opening offer.');
    }
  }

  return {
    targetPlayerId: inputs.targetPlayerId,
    targetName: inputs.targetName,
    opening,
    fair: { low: fairLow, high: fairHigh },
    doNotExceed,
    rungs: [
      { label: 'Opening offer', value: opening, note: 'Leaves room to move without reading as an insult.' },
      { label: 'Fair zone', value: fairLow, note: `Both rosters gain between ${fairLow} and ${fairHigh}.` },
      { label: 'Do not exceed', value: doNotExceed, note: 'Above this you have paid more than he is worth to you.' },
    ],
    reasons,
    blocked: null,
    advisory: 'never auto-sent',
  };
}

function blockedLadder(inputs: LadderInputs, why: string): TradeLadder {
  return {
    targetPlayerId: inputs.targetPlayerId,
    targetName: inputs.targetName,
    opening: 0,
    fair: { low: 0, high: 0 },
    doNotExceed: 0,
    rungs: [],
    reasons: [],
    blocked: why,
    advisory: 'never auto-sent',
  };
}

/** The ladder holds its order by construction; this is what the tests pin. */
export function ladderIsOrdered(ladder: TradeLadder): boolean {
  if (ladder.blocked) return true;
  return (
    ladder.opening <= ladder.fair.low && ladder.fair.low <= ladder.fair.high && ladder.fair.high <= ladder.doNotExceed
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
