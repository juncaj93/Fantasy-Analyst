/**
 * Roster fit on both sides of a trade: does the partner want what is offered,
 * and can the reader afford to lose what is sent.
 *
 * Opened by the live board of 29 September 2026, which suggested two trades
 * that priced every player on his own market number and never asked about the
 * rosters around him:
 *
 *   - **Give Sam LaPorta, get Malik Nabers.** The manager holding Nabers
 *     already started a tight end, in a league that starts one. LaPorta went
 *     into his flex in Nabers' place for a lineup change of zero, and the card
 *     still said "gives him a starting TE". Nothing asked whether he wanted a
 *     second tight end at all.
 *   - **Give Kenneth Walker, get CeeDee Lamb.** Walker was one of two startable
 *     backs on a roster deep at receiver. The optimiser measured this week (a
 *     receiver slid into the flex and the lineup moved by 0.2) and nothing
 *     measured what losing him does to the position once that stops working.
 *
 * The same class of bug Waivers fixed when it stopped offering a fourth tight
 * end, and the fix reuses that round's policy rather than restating it.
 *
 * ## The partner's side: `core/waivers/depthPolicy.ts`, applied to his roster
 *
 * That policy was written against the league's shape and a calendar, never
 * against Alex's roster in particular, so it applies to any roster as it
 * stands. QB, TE, K and DEF are *slot* positions: a manager wants as many as
 * he has slots for, and a second one has to be a real upgrade over the one he
 * starts. RB and WR are *depth* positions with no cap. The bar for "a real
 * upgrade" is {@link MEANINGFUL_UPGRADE_GAIN}, the one number the app already
 * uses for "worth changing a starter for".
 *
 * The calendar half of the policy only ever moves the defence cap, and a
 * defence is never in a trade (`TRADE_EXCLUDED_POSITIONS`), so the check reads
 * the cap without a date.
 *
 * ## Alex's side: value over replacement
 *
 * A player's worth to his own roster is not his projection, it is how much
 * worse the position gets without him: the points his position's starters lose
 * when the next man at the position steps in. A back with a startable back
 * behind him is cheap to move; a back whose replacement is a bench body is
 * not, whatever the two are priced at. Only priced players count as a
 * replacement. A man the market has not priced may be fine, and nothing shows
 * it, so he protects nothing here — this only ever makes a give harder.
 *
 * Pure, like the rest of this directory. It reads views and returns facts.
 */

import { depthCap } from '../waivers/depthPolicy.ts';
import { MEANINGFUL_UPGRADE_GAIN } from '../startsit/waivers.ts';
import { tradeExcluded, type RosterView } from './rosterUtility.ts';

export const SCARCITY = {
  /**
   * Points of positional loss that cost nothing extra.
   *
   * The same 1.5 that `WEAK_SHORTFALL` treats as noise in a weekly projection.
   * Below it the man behind him is as good as interchangeable, which is what
   * depth is for.
   */
  freeLoss: 1.5,
  /**
   * The share of the rest of the loss charged against the trade, in lineup points.
   *
   * Half. The optimiser has already counted whatever the loss costs *this*
   * week, and in a flex league that is often nothing, because another position
   * covers the slot. What it cannot see is every later week that cover fails:
   * a bye, an injury, a receiver who is not there. Half the uncovered gap is a
   * standing charge for that exposure, large enough that a scarce starter
   * needs a clearly better return and small enough that a genuine upgrade can
   * still pay it.
   */
  weight: 0.5,
} as const;

// ------------------------------------------------------- the partner's need --

export interface CounterpartNeed {
  /** False when the partner is already full at a slot position and this is no clear upgrade. */
  wanted: boolean;
  /** The incoming player the answer is about, when refused. */
  playerId: string | null;
  /** One sentence for the rejection record, when refused. */
  detail: string | null;
}

/**
 * Would the partner actually want what he is being sent?
 *
 * Checked per incoming player at a capped position. He counts the players he
 * already holds there, minus the ones he sends in this deal and anybody ruled
 * out (injured reserve is a real gap; a bye is not). Under the cap he has room
 * and the answer is yes. At the cap the newcomer has to beat the best one he
 * already starts by {@link MEANINGFUL_UPGRADE_GAIN}, or the trade hands him a
 * position he has already filled.
 *
 * A partner whose only holder at the position has no market price is not
 * shown to want another: the waiver board skips the same case for the same
 * reason, when nothing priced is there to compare against.
 */
export function counterpartNeed(args: {
  receiver: RosterView;
  sender: RosterView;
  /** What the receiver gets, as ids on `sender`. */
  incoming: readonly string[];
  /** What the receiver sends away in the same deal. */
  outgoing: readonly string[];
}): CounterpartNeed {
  const { receiver, sender } = args;
  const leaving = new Set(args.outgoing);
  const arriving: { position: string; value: number }[] = [];

  for (const id of [...args.incoming].sort()) {
    const position = sender.positionOf.get(id);
    const value = sender.valueOf.get(id);
    if (!position || value == null || tradeExcluded(position)) continue;
    const cap = depthCap(position, { shape: receiver.shape, week: 1, playoffWeeks: [] });
    if (cap == null) continue;

    const held = receiver.playerIds.filter(
      (other) => receiver.positionOf.get(other) === position && !leaving.has(other) && !receiver.ruledOut.has(other),
    );
    const already = arriving.filter((a) => a.position === position);
    if (held.length + already.length < cap) {
      arriving.push({ position, value });
      continue;
    }

    const priced = [
      ...held
        .map((other) => ({ name: receiver.nameOf.get(other) ?? other, value: receiver.valueOf.get(other) }))
        .filter((p): p is { name: string; value: number } => p.value != null),
      ...already.map((a) => ({ name: 'the other one in this deal', value: a.value })),
    ].sort((a, b) => b.value - a.value);
    const name = sender.nameOf.get(id) ?? id;
    const slots = cap === 1 ? `one ${position}` : `${cap} ${position}s`;

    if (priced.length === 0) {
      return {
        wanted: false,
        playerId: id,
        detail: `they already hold ${slots} with no market price this week, so nothing shows they want ${name} as well`,
      };
    }
    const best = priced[0]!;
    const margin = round2(value - best.value);
    if (margin < MEANINGFUL_UPGRADE_GAIN) {
      return {
        wanted: false,
        playerId: id,
        detail:
          `they already start ${best.name} at ${position} (${best.value.toFixed(1)}) and this league starts ${slots}; ` +
          `${name} (${value.toFixed(1)}) is not a clear enough upgrade for them to want a second`,
      };
    }
    arriving.push({ position, value });
  }

  return { wanted: true, playerId: null, detail: null };
}

// ---------------------------------------------------- the reader's scarcity --

export interface ScarcityCost {
  position: string;
  /** The players sent at this position. */
  sent: string[];
  /** Points the position's starters lose when the next man steps in. */
  loss: number;
  /** Who would step in, or null when nobody priced is there. */
  replacement: { name: string; value: number } | null;
  /** What that loss adds to the bar this trade has to clear, in lineup points. */
  charge: number;
}

export interface Scarcity {
  /** Total lineup points charged against the package. Zero for surplus. */
  charge: number;
  /** Per position, only where something was charged. */
  costs: ScarcityCost[];
}

/**
 * What sending these players costs the roster at their positions, beyond this week.
 *
 * For each position a player is sent from, the position's starters are summed
 * before and after the deal: the best `k` priced players there, where `k` is
 * the league's dedicated slots at the position (at least one). Players arriving
 * at the same position count toward "after", so a back-for-back swap costs
 * nothing here. The difference is the loss; past {@link SCARCITY.freeLoss},
 * {@link SCARCITY.weight} of it is the charge.
 */
export function scarcityOf(args: {
  view: RosterView;
  give: readonly string[];
  /** What arrives, as position and value on the other roster. */
  incoming: readonly { position: string; value: number }[];
}): Scarcity {
  const { view } = args;
  const leaving = new Set(args.give);
  const positions = [...new Set(args.give.map((id) => view.positionOf.get(id)).filter((p): p is string => p != null))]
    .filter((p) => !tradeExcluded(p))
    .sort();

  const costs: ScarcityCost[] = [];
  for (const position of positions) {
    const slots = Math.max(1, view.shape.starters[position] ?? 0);
    const here = view.playerIds
      .filter((id) => view.positionOf.get(id) === position && !view.ruledOut.has(id))
      .map((id) => ({ id, name: view.nameOf.get(id) ?? id, value: view.valueOf.get(id) }))
      .filter((p): p is { id: string; name: string; value: number } => p.value != null)
      .sort((a, b) => b.value - a.value);

    const after = [
      ...here.filter((p) => !leaving.has(p.id)),
      ...args.incoming.filter((p) => p.position === position).map((p) => ({ id: '', name: 'the player you get', value: p.value })),
    ].sort((a, b) => b.value - a.value);

    const loss = round2(Math.max(0, topSum(here, slots) - topSum(after, slots)));
    const charge = round2(SCARCITY.weight * Math.max(0, loss - SCARCITY.freeLoss));
    if (charge <= 0) continue;

    const stepsIn = after[slots - 1] ?? null;
    costs.push({
      position,
      sent: args.give.filter((id) => view.positionOf.get(id) === position),
      loss,
      replacement: stepsIn ? { name: stepsIn.name, value: round2(stepsIn.value) } : null,
      charge,
    });
  }

  return { charge: round2(costs.reduce((sum, c) => sum + c.charge, 0)), costs };
}

/** The caveat a card prints for a scarce give. One per position. */
export function scarcityLine(view: RosterView, cost: ScarcityCost): string {
  const names = cost.sent.map((id) => view.nameOf.get(id) ?? id).join(' and ');
  const behind = cost.replacement
    ? `${cost.replacement.name} (${cost.replacement.value.toFixed(1)}) would start in his place`
    : `nobody priced is behind him at ${cost.position}`;
  return `${names} is hard to replace: ${behind}, ${cost.loss.toFixed(1)} pts a week worse.`;
}

function topSum(players: readonly { value: number }[], k: number): number {
  let total = 0;
  for (let i = 0; i < k; i++) total += players[i]?.value ?? 0;
  return total;
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
