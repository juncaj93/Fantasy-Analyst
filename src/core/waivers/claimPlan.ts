/**
 * The waiver plan, said in English.
 *
 * ## Where the decisions are made
 *
 * Not here. Who is worth a claim, which yardstick he was measured on, and who a
 * claim for him would drop are all decided once, by `planMoves` in
 * `core/waivers/yardstick.ts`, and carried on the advice as `moveGroups` and on
 * each board row as `cut`. This file reads those groups and writes the
 * sentences. It computes no cut, no gain and no bid, which is what makes "the
 * name after `Better than` on a card is the name after `Drop` on the plan" a
 * fact about the data rather than a thing to keep true by hand.
 *
 * On 30 September 2026 it was not: the cards measured free agents against
 * Jaylen Wright and a separate utility planner cut Emmett Johnson three times.
 * That planner is gone.
 *
 * ## The shape
 *
 * ```
 * Your waiver plan
 * Drop Jaylen Wright for the first one you win
 *   1  Add Keenan Allen · bid $3–7
 *   2  Add KC Concepcion · bid $2–5          Only if 1 loses
 *   3  Add Tyler Allgeier · bid $1–3         Only if 1 and 2 lose
 * Keeping Emmett Johnson: he backs up Kenneth Walker, your starting RB.
 * ```
 *
 * Up to three claims hang off one drop, because Sleeper runs claims top to
 * bottom and a claim whose drop is already gone does not run. A second drop is
 * spent in the same week only when a claim clears the bar against that drop on
 * its own; its claims are numbered after the first group's.
 *
 * ## Nothing here transacts
 *
 * The output is a list of instructions for somebody to type into Sleeper by
 * hand. There is no write path and no control on the screen that could submit
 * anything.
 */

import { myBudget, type LeagueBudgetState } from '../faab/budget.ts';
import { buildWaiverBoard, type WaiverAdviceLike, type WaiverBoardRow } from './board.ts';
import { basisLabel } from './yardstick.ts';
import { mostAddedLine } from './signals.ts';
import type { PickupState } from './clearWindow.ts';

/** How a claim stands to the claims above it. */
export type ClaimRelation = 'primary' | 'fallback' | 'compatible';

/** One line of the plan: the instruction, and the case for it. */
export interface WaiverClaimLine {
  /** 1-based, and the order to enter the claims in Sleeper. */
  rank: number;
  claimId: string;
  /** Which drop group this claim belongs to, 1-based. */
  group: number;
  addPlayerId: string;
  addName: string;
  addPosition: string;
  addTeam: string;
  dropPlayerId: string | null;
  dropName: string | null;
  /** The pricing pass's recommended maximum. Null when it withheld one. */
  bid: number | null;
  /** `$3–7`: what winning him is likely to cost. Null when nothing is priced. */
  bidRange: string | null;
  /** `Add Keenan Allen · bid $3–7` */
  headline: string;
  /** `Proj. 7.0 vs 3.5 (Sleeper projection for both) · #11 most-added on Sleeper today · practised fully` */
  detail: string | null;
  /** `Only if 1 loses`, on every claim that is a fallback. */
  qualifier: string | null;
  relation: ClaimRelation;
  /** The **See why** paragraph for this claim, one sentence per line. */
  why: string[];
  /** Still on waivers, or free to add now. Null when the window could not be read. */
  pickup: PickupState | null;
}

/** One drop, and the claims that would spend it. */
export interface WaiverClaimGroup {
  index: number;
  drop: { playerId: string; name: string } | null;
  /** `Drop Jaylen Wright for the first one you win` */
  headline: string;
  /**
   * Every protected player the drop was chosen over, with why. Data only: the
   * card no longer prints it (see {@link keepNote}).
   */
  keep: string[];
  /**
   * `Emmett Johnson stays: he backs up Kenneth Walker`, printed on the drop
   * line. Only the handcuff case: a bench player who was not cut needs no
   * defending, but a backup to your own starter looks like an obvious cut the
   * plan skipped, and this is why. Null when no handcuff was passed over.
   */
  keepNote: string | null;
  firstRank: number;
  lastRank: number;
}

/** Which honest ending this is. */
export type WaiverClaimPlanState =
  /** Claims to enter. */
  | 'plan'
  /** Targets on the board, and none that clears the bar for a claim. */
  | 'no_move'
  /** Somebody worth adding, and nothing on the roster a claim may cut. */
  | 'no_safe_drop'
  /** Nothing on the wire to plan around. */
  | 'no_targets';

export interface WaiverClaimPlan {
  /** Whether the screen should draw the card at all. */
  surface: boolean;
  state: WaiverClaimPlanState;
  /** `Your waiver plan`, or the honest sentence for an empty one. */
  headline: string;
  /** `Enter in this order`, above a list of more than one claim. */
  instruction: string | null;
  groups: WaiverClaimGroup[];
  claims: WaiverClaimLine[];
  /** One line under the list, when there is something to qualify. */
  note: string | null;
  /** **See why**: why the order is the order. Set exactly when `instruction` is. */
  mechanics: string | null;
  /** **See why**: the branches, as reachable worlds and never as odds. */
  outcomes: string[];
  /** **See why**: whether two adds are worth two drops. */
  relationships: string[];
  /** **See why**: who the plan refuses to cut, and why. */
  protectedPlayers: string[];
  /** **See why**: what the wallet allowed. */
  budget: string | null;
  /** The drop for every player on the board, for his detail sheet. From the same cut the plan reads. */
  dropHints: { addPlayerId: string; dropName: string; label: string }[];
  generatedAt: string;
}

export interface WaiverClaimPlanInput {
  /** Exactly the object the endpoint is about to send: board, groups and bids. */
  advice: WaiverAdviceLike;
  budget?: LeagueBudgetState | null;
  generatedAt?: string;
}

const ORDER_INSTRUCTION = 'Enter in this order';
/** On a claim for a player outside the waiver window. */
export const FREE_AGENT_PHRASE = 'free agent, no bid needed';
const ORDER_NOTE =
  'Sleeper runs claims top to bottom, and a claim whose drop is already gone does not run. So the first claim you win under a drop spends it, and the claims below it under the same drop do not run.';
const NO_SAFE_DROP_NOTE =
  'Every player a claim could cut is starting, on injured reserve, or protected. A trade or a bye week frees a spot; a claim does not.';

const EMPTY_HEADLINE: Record<WaiverClaimPlanState, string> = {
  plan: 'Your waiver plan',
  no_move: 'No waiver move recommended',
  no_safe_drop: 'No safe drop for this upgrade',
  no_targets: 'No waiver move recommended',
};

export function buildWaiverClaimPlan(opts: WaiverClaimPlanInput): WaiverClaimPlan {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const board = buildWaiverBoard(opts.advice);
  const rows = new Map(board.rows.map((row) => [row.playerId, row]));
  const usesFaab = opts.budget?.rule.usesFaab ?? true;
  const remaining = opts.budget ? (myBudget(opts.budget)?.remaining ?? null) : null;

  const dropHints = board.rows
    .filter((row) => row.cut != null)
    .map((row) => ({ addPlayerId: row.playerId, dropName: row.cut!.name, label: `Drop ${row.cut!.name}` }));

  /*
   * A free agent outside the waiver window is an instant add, so a claim under
   * the same drop below him can never run: adding him spends the drop. The
   * list stops at the first one. Claims into open spots each run on their own
   * and are left alone. See `waivers/clearWindow.ts`.
   */
  const isFree = (id: string) => rows.get(id)?.pickup?.state === 'free';
  let groups = (opts.advice.moveGroups ?? [])
    .map((g) => {
      const present = g.addIds.filter((id) => rows.has(id));
      const firstFree = g.drop == null ? -1 : present.findIndex(isFree);
      return { ...g, addIds: firstFree < 0 ? present : present.slice(0, firstFree + 1) };
    })
    .filter((g) => g.addIds.length > 0);

  /*
   * The wallet, held to the one condition that is safe whatever Sleeper does
   * with pending claims: the claims that could all land together — one per
   * drop — may not total more than what is left. Claims under one drop never
   * land together, so they are free to stack. Bids are never lowered to fit;
   * a whole drop is given up instead, and the sheet says so.
   */
  let budgetLine: string | null = null;
  if (!usesFaab) {
    budgetLine = 'This league does not bid for waivers, so the plan carries no prices, only the order.';
  } else if (remaining != null) {
    /* Claims under one drop never land together; claims into open spots all can. */
    const worst = (g: (typeof groups)[number]) => {
      const bids = g.addIds.map((id) => (isFree(id) ? 0 : (rows.get(id)?.bid?.recommended ?? 0)));
      return g.drop == null ? bids.reduce((a, b) => a + b, 0) : Math.max(0, ...bids);
    };
    while (groups.length > 1 && groups.reduce((t, g) => t + worst(g), 0) > remaining) {
      const gone = groups.pop()!;
      budgetLine = `Your remaining $${remaining} would not cover a claim landing under both drops at once, so the plan gave up the second drop${gone.drop ? ` (${gone.drop.name})` : ''}. No bid was lowered to make it fit.`;
    }
    if (budgetLine == null) {
      const most = groups.reduce((t, g) => t + worst(g), 0);
      if (most > 0) {
        budgetLine = `The most this plan can spend is $${most} of the $${remaining} you have left: one claim per drop. Claims under the same drop never both land.`;
      } else if (groups.some((g) => g.addIds.some(isFree))) {
        budgetLine = `Every add in this plan is a free agent, so it spends none of the $${remaining} you have left.`;
      }
    }
  }

  if (groups.length === 0) {
    const state: WaiverClaimPlanState = board.rows.some((r) => r.dst == null && r.strength.level !== 'unknown')
      ? board.rows.some((r) => r.cut == null && r.dst == null && r.strength.level !== 'unknown' && r.strength.level !== 'value')
        ? 'no_safe_drop'
        : 'no_move'
      : 'no_targets';
    return {
      surface: state === 'no_safe_drop',
      state,
      headline: EMPTY_HEADLINE[state],
      instruction: null,
      groups: [],
      claims: [],
      note: state === 'no_safe_drop' ? NO_SAFE_DROP_NOTE : null,
      mechanics: null,
      outcomes: [],
      relationships: [],
      protectedPlayers: [],
      budget: null,
      dropHints,
      generatedAt,
    };
  }

  const claims: WaiverClaimLine[] = [];
  const outGroups: WaiverClaimGroup[] = [];
  groups.forEach((group, gi) => {
    const firstRank = claims.length + 1;
    const groupRanks: number[] = [];
    group.addIds.forEach((addId, i) => {
      const row = rows.get(addId)!;
      const rank = claims.length + 1;
      const free = row.pickup?.state === 'free';
      const bidRange =
        !free && usesFaab && row.faab && row.faab.low != null && row.faab.high != null ? rangeOf(row.faab.low, row.faab.high) : null;
      const drop = group.drop;
      /* Claims into open spots each run on their own; claims under a drop are fallbacks. */
      const qualifier =
        i === 0 || drop == null ? null : `Only if ${joinRanks(groupRanks)} ${groupRanks.length === 1 ? 'loses' : 'lose'}`;
      claims.push({
        rank,
        claimId: `${addId}>${drop?.playerId ?? 'none'}`,
        group: gi + 1,
        addPlayerId: addId,
        addName: row.name,
        addPosition: row.position,
        addTeam: row.team,
        dropPlayerId: drop?.playerId ?? null,
        dropName: drop?.name ?? null,
        bid: usesFaab && !free ? (row.bid?.recommended ?? null) : null,
        bidRange,
        headline: [`Add ${row.name}`, free ? FREE_AGENT_PHRASE : bidRange ? `bid ${bidRange}` : null].filter(Boolean).join(' · '),
        pickup: row.pickup ?? null,
        detail: detailFor(row),
        qualifier,
        relation: gi === 0 && i === 0 ? 'primary' : i === 0 || drop == null ? 'compatible' : 'fallback',
        why: whyFor(row, drop, drop == null ? [] : groupRanks, usesFaab),
      });
      groupRanks.push(rank);
    });
    outGroups.push({
      index: gi + 1,
      drop: group.drop ? { playerId: group.drop.playerId, name: group.drop.name } : null,
      headline: group.drop
        ? group.addIds.length > 1
          ? `Drop ${group.drop.name} for the first one you win`
          : `Drop ${group.drop.name}`
        : group.addIds.length > 1
          ? `${group.addIds.length} open roster spots: these need no drop`
          : 'Open roster spot: this one needs no drop',
      keep: group.kept.map((k) => `Keeping ${k.name}: ${k.why}.`),
      keepNote: keepNoteFor(group.kept),
      firstRank,
      lastRank: claims.length,
    });
  });

  return {
    surface: true,
    state: 'plan',
    headline: 'Your waiver plan',
    instruction: claims.length > 1 ? ORDER_INSTRUCTION : null,
    groups: outGroups,
    claims,
    note: null,
    mechanics: claims.length > 1 ? ORDER_NOTE : null,
    outcomes: outcomeLines(outGroups, claims),
    relationships:
      outGroups.length > 1
        ? [
            `Two drops this week, because ${claims.find((c) => c.group === 2)?.addName ?? 'the second group'} clears the bar against ${outGroups[1]!.drop?.name ?? 'an open spot'} on his own. Both groups can land.`,
          ]
        : [],
    protectedPlayers: outGroups.flatMap((g) => g.keep),
    budget: budgetLine,
    dropHints,
    generatedAt,
  };
}

/**
 * The line under a claim: the comparison, then at most one signal.
 *
 * The yardstick is always named, so a reader can see that both numbers are
 * the same kind of number.
 */
export function detailFor(row: WaiverBoardRow): string | null {
  const parts: string[] = [];
  const basis = row.basis;
  if (basis?.yardstick && basis.projection != null && basis.overProjection != null) {
    parts.push(`Proj. ${basis.projection.toFixed(1)} vs ${basis.overProjection.toFixed(1)} (${basisLabel(basis.yardstick)})`);
  }
  /*
   * Then one reason, never a stack: the card's most important note (they
   * arrive most important first), or else where he sits on Sleeper's adds.
   * The rest stays on his detail sheet.
   */
  const reason = row.notes[0] ?? (basis?.attention?.rank != null ? mostAddedLine(basis.attention.rank) : null);
  if (reason) parts.push(reason);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The factors behind an add, for **See why**. Read off the row's basis, which
 * the scan wrote beside the arithmetic.
 */
export function caseLines(name: string, row: WaiverBoardRow | null): string[] {
  const basis = row?.basis;
  if (!row || !basis) return [];
  const lines: string[] = [];
  const over = row.cut?.name ?? row.shortTerm.over;

  if (basis.yardstick && basis.projection != null && basis.overProjection != null && over) {
    lines.push(
      basis.yardstick === 'market'
        ? `Both are fully priced by Vegas, so they are compared on the betting lines: ${name} ${basis.projection.toFixed(1)} pts, ${over} ${basis.overProjection.toFixed(1)}.`
        : `At least one of them is not fully priced by Vegas, so both are compared on Sleeper's projection: ${name} ${basis.projection.toFixed(1)} pts, ${over} ${basis.overProjection.toFixed(1)}.`,
    );
  }
  if (basis.projectionGap != null && Math.abs(row.shortTerm.gain - basis.projectionGap) >= 0.25) {
    lines.push(
      `Injury status moves the call to a ${row.shortTerm.gain.toFixed(1)}-point edge: half a point off for a Questionable player, a point for Doubtful or an injured player who did not practise.`,
    );
  }
  lines.push(`He had to clear a ${basis.bar.toFixed(1)}-pt bar${basis.yardstick === 'sleeper' ? ', wider on a borrowed projection than on betting lines' : ''}.`);

  const { position, held, cap } = basis.depth;
  if (basis.comparedTo === 'position') {
    lines.push(`You already hold ${held} ${position}${held === 1 ? '' : 's'}, as many as your lineup uses, so he was measured against ${over ?? 'the weaker one'} rather than a spare bench spot.`);
  } else if (cap != null) {
    lines.push(`You hold ${held} ${position}${held === 1 ? '' : 's'} and your lineup uses ${cap}, so there is room for him without doubling up.`);
  }

  if (basis.attention) {
    const rank = basis.attention.rank == null ? 'On Sleeper\'s adds list today' : mostAddedLine(basis.attention.rank);
    lines.push(
      basis.attention.nudge > 0
        ? `${rank}, which moved him up ${basis.attention.nudge.toFixed(2)} pts in the order. It does not change his projection.`
        : `${rank}.`,
    );
  }
  if (basis.dropped) {
    lines.push(
      basis.dropped.nudge < 0
        ? `#${basis.dropped.rank} most-dropped on Sleeper today, which moved him down ${Math.abs(basis.dropped.nudge).toFixed(2)} pts in the order.`
        : `#${basis.dropped.rank} most-dropped on Sleeper today, so he is kept out of the plan until the news is clear.`,
    );
  }
  if (basis.props) {
    lines.push(
      basis.props.verdict === 'ahead'
        ? `${basis.props.line}. That moved him up ${basis.props.nudge.toFixed(1)} pts in the order and nothing more.`
        : `${basis.props.line}.`,
    );
  }
  if (basis.lean > 0) lines.push(`Running backs get a ${basis.lean.toFixed(2)}-pt lean when adds are close. It breaks ties and never overrides a real gap.`);
  return lines;
}

function whyFor(
  row: WaiverBoardRow,
  drop: { playerId: string; name: string } | null,
  earlier: readonly number[],
  usesFaab: boolean,
): string[] {
  const lines: string[] = [...(row.basis ? caseLines(row.name, row) : row.reasons.slice(0, 3))];
  if (drop) lines.push(`${drop.name} is the player this claim would cut: the weakest you hold who plays the same slots and is not protected.`);
  else lines.push('A spare roster spot means this claim costs you nobody.');
  for (const note of row.notes) if (!lines.some((l) => l.startsWith(note))) lines.push(`${note}.`);
  if (usesFaab && row.bid?.headline) lines.push(row.bid.headline);
  if (usesFaab && row.bid?.doNotExceed != null && row.bid.recommended != null && row.bid.doNotExceed !== row.bid.recommended) {
    lines.push(`Winning him above $${row.bid.doNotExceed} costs more than he is worth to this roster.`);
  }
  if (row.competition) lines.push(`${row.competition.label}${row.competition.detail ? ` (${row.competition.detail})` : ''}.`);
  if (earlier.length > 0 && drop) {
    lines.push(`If claim ${joinRanks(earlier)} ${earlier.length === 1 ? 'lands' : 'land'} first, ${drop.name} is already gone and this one does not run. That is what makes it safe to enter underneath.`);
  }
  return lines.filter((l) => l.length > 0);
}

function outcomeLines(groups: readonly WaiverClaimGroup[], claims: readonly WaiverClaimLine[]): string[] {
  const firsts = groups.map((g) => claims.find((c) => c.rank === g.firstRank)!).filter(Boolean);
  const lines: string[] = [];
  const cut = firsts.map((c) => c.dropName).filter((n): n is string => n != null);
  lines.push(`Best case: you land ${joinNames(firsts.map((c) => c.addName))}${cut.length > 0 ? `, cutting ${joinNames(cut)}` : ''}.`);
  if (claims.length > firsts.length) lines.push('If a first choice goes to somebody else, the next claim under the same drop runs instead.');
  lines.push('If the room outbids you on all of them, nothing on your roster changes and you spend nothing.');
  return lines;
}

/** The handcuffs a drop was chosen over, as one clause for the drop line. */
export function keepNoteFor(kept: readonly { name: string; backs?: string }[]): string | null {
  const cuffs = kept.filter((k) => k.backs != null);
  if (cuffs.length === 0) return null;
  if (cuffs.length === 1) return `${cuffs[0]!.name} stays: he backs up ${cuffs[0]!.backs}`;
  return `${joinNames(cuffs.map((k) => k.name))} stay: they back up your starters`;
}

function rangeOf(low: number, high: number): string {
  return low === high ? `$${low}` : `$${low}–${high}`;
}

function joinRanks(ranks: readonly number[]): string {
  if (ranks.length === 1) return String(ranks[0]);
  return `${ranks.slice(0, -1).join(', ')} and ${ranks[ranks.length - 1]}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
