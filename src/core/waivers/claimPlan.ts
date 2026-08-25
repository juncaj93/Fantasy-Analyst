/**
 * The waiver plan, gathered from what the screen already has and said in
 * English.
 *
 * `core/waivers/planner` answers the whole question — who to add, what to bid,
 * who to drop, and in what order to enter the claims — and deliberately answers
 * it in {@link WaiverReasonCode} values and numbers, with no prose anywhere. It
 * is also deliberately unwired: nothing calls it. This file is the seam, and it
 * is two functions with nothing between them.
 *
 * {@link planWaiversFor} is the adapter. It takes the objects the waivers
 * endpoint is already holding when it is about to reply — the roster inputs, the
 * candidate inputs, the advice with its priced bids, the league's shape and
 * scoring, the reserve slots and the wallet — and calls `planWaiverClaims`
 * once. It fetches nothing, scores nothing and computes no drop, no gain and no
 * bid. **Every number below came out of the planner or out of the pricing pass**,
 * and the day this file does arithmetic of its own is the day the plan and the
 * screen can start disagreeing.
 *
 * {@link describeWaiverPlan} is the wording. Reason codes are a closed list of
 * things the planner knows how to say; this turns each one into a sentence a
 * person reads, and it is the only place in the app that does. A reader never
 * sees `drop_covered_by_add`.
 *
 * ## What the reader is handed
 *
 * ```
 * Your waiver plan
 * 1  Add Breakout Back · $24 · Drop Depth Back
 * 2  Add Emerging Receiver · $14 · Drop Depth Back     Only if 1 loses
 * 3  Add Emerging Receiver · $14 · Drop Roster Filler
 * ```
 *
 * That list looks like a mistake — one player claimed twice, one drop spent
 * twice — and it is exactly right, because Sleeper runs claims in the order they
 * were entered and a claim whose drop is already gone does not execute. The
 * qualifier on the repeated lines is the whole of what stops it reading as a
 * duplicate, which is why it is on the plan itself rather than behind **See
 * Why**.
 *
 * ## Nothing here transacts
 *
 * The same rule as everywhere else, and this is the surface closest to breaking
 * it: the output is a list of instructions for somebody to type into Sleeper by
 * hand. There is no write path, no queue, and no control on the screen that
 * draws this that could submit anything.
 */

import { myBudget, type LeagueBudgetState } from '../faab/budget.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import { buildWaiverBoard, type WaiverAdviceLike, type WaiverBoardRow } from './board.ts';
import { planWaiverClaims } from './planner/index.ts';
import { plannerExcluded } from './planner/rosterState.ts';
import type {
  ClaimRelation,
  DropCost,
  TargetRelation,
  WaiverClaimRecommendation,
  WaiverPlan,
  WaiverReason,
  WaiverReasonCode,
} from './planner/types.ts';

/**
 * One line of the plan: the instruction, and the reason it is there.
 *
 * `headline` is the whole instruction in one string rather than three fields the
 * screen reassembles, because the three parts are one sentence and a layout that
 * can put them in a different order is a layout that eventually will.
 */
export interface WaiverClaimLine {
  /** 1-based, and the order to enter the claims in Sleeper. */
  rank: number;
  claimId: string;
  addPlayerId: string;
  addName: string;
  addPosition: string;
  dropPlayerId: string | null;
  dropName: string | null;
  /** What to bid, taken whole from the pricing pass. Null when it withheld one. */
  bid: number | null;
  /** `Add Breakout Back · $24 · Drop Depth Back` */
  headline: string;
  /**
   * Why this line is not the duplicate it looks like.
   *
   * Set only on the claims that repeat a target or a drop already spent above —
   * `Only if 1 loses`, `Only if 2 does not land him` — because a qualifier on
   * every line is noise and a qualifier on none of them is a plan that reads as
   * a mistake.
   */
  qualifier: string | null;
  relation: ClaimRelation;
  /** The **See Why** paragraph for this claim, one sentence per line. */
  why: string[];
}

/** Which honest ending this is. */
export type WaiverClaimPlanState =
  /** Claims to enter. */
  | 'plan'
  /** Targets and spare players, and nothing that gains enough to be worth it. */
  | 'no_move'
  /** Somebody worth adding, and nothing on the roster the plan will cut. */
  | 'no_safe_drop'
  /** Nothing on the wire to plan around. */
  | 'no_targets'
  /** Adds and bids, but a roster the engine cannot read well enough to cut from. */
  | 'drop_unknown';

export interface WaiverClaimPlan {
  /** Whether the screen should draw anything at all. */
  surface: boolean;
  state: WaiverClaimPlanState;
  /** `Your waiver plan`, or the honest sentence for an empty one. */
  headline: string;
  /**
   * Four words above the list, when the order is the instruction.
   *
   * `Enter in this order`, and nothing else. The card used to carry the whole
   * mechanic here — why Sleeper runs claims top to bottom and what happens to a
   * claim whose drop is already gone — which is two wrapped lines of theory on
   * a card whose job is to be typed into another app. What a reader has to *do*
   * is enter them in that order; why the order matters is `mechanics`, one tap
   * in. Null for a single claim, which has no order to be in.
   */
  instruction: string | null;
  claims: WaiverClaimLine[];
  /** One line under the list, when there is something to qualify. */
  note: string | null;
  /**
   * **See Why**: why the order is the order.
   *
   * The sentence `instruction` is the short form of. It is here rather than on
   * the card because it explains a rule of Sleeper's rather than naming a
   * claim, and because a reader who has understood it once does not need it
   * again every week. Set exactly when `instruction` is.
   */
  mechanics: string | null;
  /** **See Why**: the branches, as reachable worlds and never as odds. */
  outcomes: string[];
  /** **See Why**: whether two adds are worth two drops. */
  relationships: string[];
  /** **See Why**: who the plan refuses to cut, grouped by why. */
  protectedPlayers: string[];
  /** **See Why**: what the wallet allowed. Null in a league that does not bid. */
  budget: string | null;
  /**
   * The add-specific drop for every target that was weighed, plan or no plan.
   *
   * Drawn on a player's own detail sheet rather than on the compact row: the
   * board is longer than the plan, so a target no claim was made for still gets
   * to answer *who would I cut for him*, and a sheet is where somebody asks that
   * about one player. See {@link hintsFrom} for why a planned target is named by
   * its claim and never by the ranking.
   */
  dropHints: { addPlayerId: string; dropName: string; label: string }[];
  generatedAt: string;
}

/** Everything the seam needs, and all of it already in the caller's hands. */
export interface WaiverClaimPlanInput {
  /** The user's own players, as the Team screen builds them. */
  roster: StartSitInput[];
  /** The bounded free-agent scan, already scored. */
  candidates: StartSitInput[];
  /** Exactly the object the endpoint is about to send, bids and all. */
  advice: WaiverAdviceLike;
  shape: RosterShape;
  profile: ScoringProfile;
  reserveIds?: string[];
  budget?: LeagueBudgetState | null;
  now?: string | Date;
  generatedAt?: string;
}

/**
 * The whole seam, in one call.
 *
 * What a caller wants is the finished thing, and splitting the gather from the
 * wording at the call site would mean every caller rebuilding the board to hand
 * the second half its names. Both halves are exported below for the tests that
 * need to pin one without the other.
 */
export function buildWaiverClaimPlan(opts: WaiverClaimPlanInput): WaiverClaimPlan {
  const { plan, rows } = planWaiversFor(opts);
  return describeWaiverPlan(plan, {
    board: rows,
    remaining: opts.budget ? (myBudget(opts.budget)?.remaining ?? null) : null,
    usesFaab: opts.budget?.rule.usesFaab,
  });
}

/**
 * Run the planner against what the endpoint already has.
 *
 * The board is rebuilt here rather than passed in, and it is the same pure
 * function the screen calls — so the targets the planner ranks are, in order,
 * the rows the reader is looking at. A second ordering would be a second opinion
 * about who is worth chasing.
 *
 * The plan is null when there is nothing to plan around at all: a league with no
 * roster, or a scan that produced no wire. The rows come back either way,
 * because the wording half needs them for names.
 */
export function planWaiversFor(opts: WaiverClaimPlanInput): { plan: WaiverPlan | null; rows: WaiverBoardRow[] } {
  const board = buildWaiverBoard(opts.advice);
  if (opts.roster.length === 0) return { plan: null, rows: board.rows };

  const byId = new Map(opts.candidates.map((input) => [input.player.id, input]));

  /*
   * The board's own order, carried through as `boardRank`.
   *
   * That ranking already contains the league-intelligence pass's work — who
   * else needs the position, what the room has paid — which the planner has no
   * access to and explicitly defers to when it decides which targets to look at
   * at all. A defence row is passed through with everything else and excluded
   * inside the planner, so the boundary lives in one place rather than two.
   */
  const targets = board.rows
    .map((row, index) => ({ row, input: byId.get(row.playerId), boardRank: index + 1 }))
    .filter((t): t is { row: WaiverBoardRow; input: StartSitInput; boardRank: number } => t.input != null)
    .map(({ row, input, boardRank }) => ({
      input,
      boardRank,
      /*
       * The priced bid, handed over whole.
       *
       * `PlannerBid` is a structural subset of the bid the pricing pass
       * produced, so this is a reference and not a copy with fields chosen —
       * which is what makes "the displayed bid is the recommended bid" a fact
       * about the types rather than a thing to keep true by hand.
       */
      bid: row.bid ?? null,
    }));

  if (targets.length === 0) return { plan: null, rows: board.rows };

  return {
    rows: board.rows,
    plan: planWaiverClaims({
      roster: opts.roster,
      targets,
      shape: opts.shape,
      profile: opts.profile,
      reserveIds: opts.reserveIds,
      budget: opts.budget
        ? { remaining: myBudget(opts.budget)?.remaining ?? null, usesFaab: opts.budget.rule.usesFaab }
        : null,
      now: opts.now,
      generatedAt: opts.generatedAt,
    }),
  };
}

/**
 * Say the plan in English.
 *
 * One sentence per thing the planner knows, and the planner's closed list of
 * reason codes is what bounds the vocabulary — a code with no wording here is a
 * code that says nothing, which is a compile-time-visible omission rather than a
 * silent one.
 *
 * The word `optimal` appears nowhere. The plan is the best structure this model
 * can see over a bounded search of a wire it did not choose, which is a useful
 * thing and not an optimum, and calling it one would be the single easiest way
 * to overstate what the app knows.
 */
export function describeWaiverPlan(
  plan: WaiverPlan | null,
  context: {
    /** For the competition sentence, which the board already worked out. */
    board?: WaiverBoardRow[];
    /** What is left in the wallet, for the budget line. */
    remaining?: number | null;
    usesFaab?: boolean;
  } = {},
): WaiverClaimPlan {
  const empty: WaiverClaimPlan = {
    surface: false,
    state: 'no_targets',
    headline: NO_TARGETS,
    instruction: null,
    claims: [],
    note: null,
    mechanics: null,
    outcomes: [],
    relationships: [],
    protectedPlayers: [],
    budget: null,
    dropHints: [],
    generatedAt: plan?.generatedAt ?? '',
  };
  if (plan == null) return empty;

  const rows = new Map((context.board ?? []).map((row) => [row.playerId, row]));
  const dropHints = hintsFrom(plan);

  if (plan.claims.length === 0) {
    const state = stateOfEmpty(plan.reasons);
    return {
      ...empty,
      state,
      headline: EMPTY_HEADLINE[state],
      /*
       * The empty plan surfaces only when it says something the board does not.
       *
       * `No waiver move recommended` beside a board reading `Nothing available
       * beats what you already have` is the same claim twice, and this app has
       * just finished taking those out. A roster with nothing spare to cut is a
       * different fact and earns its line.
       */
      surface: state === 'no_safe_drop',
      note: state === 'no_safe_drop' ? NO_SAFE_DROP_NOTE : null,
      protectedPlayers: protectedLines(plan),
      dropHints,
      generatedAt: plan.generatedAt,
    };
  }

  const unknownDrop = plan.dropAdvice === 'unavailable';
  const claims = plan.claims.map((claim) => lineFor(claim, plan, rows, unknownDrop));

  return {
    surface: true,
    state: unknownDrop ? 'drop_unknown' : 'plan',
    headline: 'Your waiver plan',
    /*
     * The order, said as an instruction rather than as an explanation.
     *
     * Same condition the full sentence used to appear under — more than one
     * claim — because one claim has no order to enter it in. The note below
     * keeps only what qualifies the *claims*: a roster the engine could not
     * score is a fact about the lines themselves and stays on the card.
     */
    instruction: claims.length > 1 ? ORDER_INSTRUCTION : null,
    mechanics: claims.length > 1 ? ORDER_NOTE : null,
    claims,
    note: unknownDrop ? ROSTER_UNSCORABLE_NOTE : null,
    outcomes: outcomeLines(plan),
    relationships: relationshipLines(plan, rows),
    protectedPlayers: protectedLines(plan),
    budget: budgetLine(plan, rows, context),
    dropHints,
    generatedAt: plan.generatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * The lines
 * ------------------------------------------------------------------ */

/**
 * The instruction, and the mechanic behind it.
 *
 * Two strings for one idea, and the split is the point. `ORDER_INSTRUCTION` is
 * what the reader does; `ORDER_NOTE` is why it works, which is a fact about how
 * Sleeper processes a waiver run and is the same fact every week. The first is
 * on the card above the claims, the second is behind **See why** with the rest
 * of the argument.
 */
const ORDER_INSTRUCTION = 'Enter in this order';
const ORDER_NOTE = 'Sleeper runs claims top to bottom, and a claim whose drop is already gone does not run — so enter them in the order above.';
const ROSTER_UNSCORABLE_NOTE =
  'Your roster cannot be scored this week, so the plan names who to add and leaves the cut to you.';
const NO_SAFE_DROP_NOTE =
  'Everybody on your roster is either starting, on injured reserve, or worth more than the upgrade would gain. A trade or a bye week frees a spot; a claim does not.';
const NO_TARGETS = 'No waiver move recommended';

const EMPTY_HEADLINE: Record<WaiverClaimPlanState, string> = {
  plan: 'Your waiver plan',
  no_move: 'No waiver move recommended',
  no_safe_drop: 'No safe drop for this upgrade',
  no_targets: NO_TARGETS,
  drop_unknown: 'Your waiver plan',
};

function lineFor(
  claim: WaiverClaimRecommendation,
  plan: WaiverPlan,
  rows: ReadonlyMap<string, WaiverBoardRow>,
  unknownDrop: boolean,
): WaiverClaimLine {
  const row = rows.get(claim.addPlayerId) ?? null;
  const parts = [`Add ${claim.addName}`];
  if (claim.bid != null) parts.push(`$${claim.bid}`);
  /*
   * The drop, said exactly one of three ways.
   *
   * A named cut, an honest "none needed" when the roster has room, and silence
   * when the engine could not read the roster well enough to name one. A blank
   * where a name should be would read as the second of those, which is the one
   * case it must never be mistaken for.
   */
  if (claim.dropName != null) parts.push(`Drop ${claim.dropName}`);
  else if (!unknownDrop) parts.push('No drop needed');

  return {
    rank: claim.rank,
    claimId: claim.id,
    addPlayerId: claim.addPlayerId,
    addName: claim.addName,
    addPosition: claim.addPosition,
    dropPlayerId: claim.dropPlayerId,
    dropName: claim.dropName,
    bid: claim.bid,
    headline: parts.join(' · '),
    qualifier: qualifierFor(claim, plan.claims),
    relation: claim.relation,
    why: whyFor(claim, plan, row, unknownDrop),
  };
}

/**
 * Why a repeated line is deliberate.
 *
 * Two shapes, both derived from the planner's own declared dependencies rather
 * than from reading the list: a claim whose drop an earlier claim would spend,
 * and a second attempt at a target an earlier claim might already have landed.
 * Everything else gets nothing, because a plan where every line carries a
 * qualifier is a plan where none of them is read.
 */
function qualifierFor(
  claim: WaiverClaimRecommendation,
  all: readonly WaiverClaimRecommendation[],
): string | null {
  const rankOf = new Map(all.map((c) => [c.id, c.rank]));
  const earlier = (ids: readonly string[]) =>
    ids
      .map((id) => rankOf.get(id))
      .filter((rank): rank is number => rank != null && rank < claim.rank)
      .sort((a, b) => a - b);

  const blockers = earlier(claim.blockedBy);
  if (blockers.length > 0) {
    return `Only if ${joinRanks(blockers)} ${blockers.length === 1 ? 'loses' : 'lose'}`;
  }
  const exclusive = earlier(claim.mutuallyExclusiveWith);
  if (exclusive.length > 0) {
    return `Only if ${joinRanks(exclusive)} ${exclusive.length === 1 ? 'does' : 'do'} not land him`;
  }
  return null;
}

function joinRanks(ranks: readonly number[]): string {
  if (ranks.length === 1) return String(ranks[0]);
  return `${ranks.slice(0, -1).join(', ')} or ${ranks[ranks.length - 1]}`;
}

/**
 * The **See Why** paragraph for one claim, in the order somebody argues.
 *
 * Why him, why that cut, what it is worth, what it costs, and how it stands to
 * the claims above it. The bid rationale is the pricing pass's own headline
 * quoted verbatim — this file has no opinion about money and writing one would
 * be a second FAAB model in a comment.
 */
function whyFor(
  claim: WaiverClaimRecommendation,
  plan: WaiverPlan,
  row: WaiverBoardRow | null,
  unknownDrop: boolean,
): string[] {
  const lines: string[] = [];
  const codes = codesOf(claim.reasons);

  /* Why him. */
  const position = claim.addPosition || 'the slot';
  if (codes.has('add_fills_empty_slot')) lines.push(`${claim.addName} fills your empty ${position} slot.`);
  else if (codes.has('add_enters_lineup')) lines.push(`${claim.addName} starts for you this week.`);
  else if (codes.has('add_bench_depth')) lines.push(`${claim.addName} is depth rather than a starter — he covers a position you are thin at.`);
  else if (codes.has('add_no_lineup_effect')) lines.push(`${claim.addName} does not change this week's lineup; he is a hold for later.`);

  /*
   * Why that cut — and nothing at all about it when the roster cannot be read.
   *
   * The plan's own note already says why there is no cut named, once, and
   * repeating it under every claim would be the same sentence four times on one
   * sheet.
   */
  if (!unknownDrop) {
    if (claim.dropName == null) lines.push('You have a spare roster spot, so this claim costs you nobody.');
    else lines.push(...dropLines(claim));
  }

  /* What it is worth, and what it does to Sunday. */
  if (claim.netGain != null && !unknownDrop) {
    const paid = claim.dropName == null ? '' : ', after paying for the cut';
    lines.push(`Your roster is ${claim.netGain.toFixed(1)} pts better for the swap${paid}.`);
    lines.push(lineupLine(claim));
  }

  /* What it costs. */
  if (claim.bidHeadline) lines.push(claim.bidHeadline);
  if (claim.doNotExceed != null && claim.bid != null && claim.doNotExceed !== claim.bid) {
    lines.push(`Winning him above $${claim.doNotExceed} costs more than he is worth to this roster.`);
  }

  /*
   * Who else wants him — the league-intelligence pass's own sentence.
   *
   * Read off the board row rather than recomputed, and it is context about
   * price and not about the player: manager pressure is allowed to say a claim
   * will be contested and is never allowed to change what the claim is worth.
   */
  if (row?.competition) {
    lines.push(`${row.competition.label}${row.competition.detail ? ` — ${row.competition.detail}` : ''}.`);
  }

  /* And how it stands to the claims above it. */
  lines.push(...relationLines(claim, plan.claims));

  return lines.filter((line) => line.length > 0);
}

/** Why that cut, from the codes the drop ranking attached to it. */
function dropLines(claim: WaiverClaimRecommendation): string[] {
  const codes = codesOf(claim.pair.reasons);
  const name = claim.dropName ?? 'he';
  const lines: string[] = [];

  if (codes.has('drop_covered_by_add')) {
    lines.push(`${name} is not in your lineup, and ${claim.addName} covers what he was covering.`);
  } else if (codes.has('drop_at_or_below_replacement')) {
    lines.push(`${name} is not in your lineup, and the wire would replace him for nothing.`);
  } else if (codes.has('drop_outside_lineup')) {
    lines.push(`${name} is not in your lineup.`);
  }

  const lineupCost = valueOf(claim.pair.reasons, 'drop_costs_lineup_points');
  if (lineupCost != null && lineupCost > 0) {
    lines.push(`Cutting him does cost the lineup ${lineupCost.toFixed(1)} pts, which is already paid for in the figure below.`);
  }
  const bare = claim.pair.reasons.find((r) => r.code === 'drop_leaves_position_bare');
  if (bare) {
    lines.push(`It leaves ${bare.position ?? 'a position'} with no spare body — one absence and the slot is a problem.`);
  }
  return lines;
}

/** What Sunday and the bench actually gain. */
function lineupLine(claim: WaiverClaimRecommendation): string {
  const { lineupGain, depthChange } = claim.pair;
  const lineup =
    lineupGain > 0
      ? `Your starting lineup gains ${lineupGain.toFixed(1)} pts`
      : lineupGain < 0
        ? `Your starting lineup loses ${Math.abs(lineupGain).toFixed(1)} pts`
        : 'Your starting lineup is unchanged';
  const depth =
    depthChange > 0
      ? `${depthChange} more startable player on the bench`
      : depthChange < 0
        ? `${Math.abs(depthChange)} fewer startable ${Math.abs(depthChange) === 1 ? 'player' : 'players'} on the bench`
        : 'the same bench cover';
  return `${lineup}, and you carry ${depth}.`;
}

/**
 * How this claim stands to the ones above it, and what happens if they land.
 *
 * The three relations are three genuinely different instructions, and the last
 * of them is the question §9 of the brief names: *which claims still execute
 * after an earlier success*.
 */
function relationLines(
  claim: WaiverClaimRecommendation,
  all: readonly WaiverClaimRecommendation[],
): string[] {
  const nameOf = new Map(all.map((c) => [c.id, c]));
  const lines: string[] = [];

  for (const id of claim.blockedBy) {
    const blocker = nameOf.get(id);
    if (!blocker || blocker.rank >= claim.rank) continue;
    lines.push(
      `Claim ${blocker.rank} spends ${blocker.dropName ?? 'the same cut'}. If it lands, this one cannot run at all — which is what makes it safe to enter underneath it.`,
    );
  }
  for (const id of claim.mutuallyExclusiveWith) {
    const twin = nameOf.get(id);
    if (!twin || twin.rank >= claim.rank) continue;
    /*
     * "Better", not "cheaper".
     *
     * Two claims for one target carry one bid — two prices on one player would
     * be two opinions about what he is worth — so what separates them is the
     * cut, and the planner ranked the one above on net gain rather than on
     * money. Saying `cheaper` would be a claim about dollars that is not true.
     */
    lines.push(`Claim ${twin.rank} is the better way to land ${claim.addName}. This one only comes up if that claim does not run.`);
  }
  if (claim.relation === 'compatible' && claim.blockedBy.length === 0 && claim.mutuallyExclusiveWith.length === 0 && claim.rank > 1) {
    lines.push('This one runs whether or not the claims above it land, and it was measured against both worlds.');
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * The sheet's other sections
 * ------------------------------------------------------------------ */

/**
 * The branches, as worlds that are reachable rather than likely.
 *
 * There is no probability anywhere in this app's waiver work — it has an
 * observed distribution of what past bids cost, which is a fact about prices and
 * not about outcomes — so none of these lines carries a percentage, and the
 * do-nothing branch is always the last of them.
 */
function outcomeLines(plan: WaiverPlan): string[] {
  const nameOf = new Map(plan.claims.map((c) => [c.addPlayerId, c.addName]));
  const dropNameOf = new Map(plan.claims.map((c) => [c.dropPlayerId ?? '', c.dropName ?? '']));
  const lines: string[] = [];

  const best = plan.outcomes.find((o) => o.kind === 'best');
  if (best) lines.push(`Best case — ${describeOutcome(best, nameOf, dropNameOf)}.`);

  for (const outcome of plan.outcomes.filter((o) => o.kind === 'partial').slice(0, 3)) {
    lines.push(`Or — ${describeOutcome(outcome, nameOf, dropNameOf)}.`);
  }

  if (plan.outcomes.some((o) => o.kind === 'none')) {
    lines.push('If the room outbids you on all of them, nothing on your roster changes and you spend nothing.');
  }
  return lines;
}

function describeOutcome(
  outcome: WaiverPlan['outcomes'][number],
  nameOf: ReadonlyMap<string, string>,
  dropNameOf: ReadonlyMap<string, string>,
): string {
  const adds = outcome.addedPlayerIds.map((id) => nameOf.get(id) ?? id);
  const drops = outcome.droppedPlayerIds.map((id) => dropNameOf.get(id) ?? id).filter(Boolean);
  const cut = drops.length > 0 ? `, cutting ${joinNames(drops)}` : '';
  const spend = outcome.spend == null ? '' : ` for $${outcome.spend}`;
  return `you land ${joinNames(adds)}${cut}${spend}`;
}

/**
 * Whether two adds are worth two cuts.
 *
 * The four relations are one ratio in the planner — what the second target is
 * still worth once the first has landed — and they are four quite different
 * instructions here. `redundant` and `substitute` are the ones that save
 * somebody a cut they were about to make for nothing.
 */
function relationshipLines(plan: WaiverPlan, rows: ReadonlyMap<string, WaiverBoardRow>): string[] {
  /*
   * Names for targets that never made a claim, which is most of the useful
   * ones.
   *
   * A substitute is interesting *because* the plan declined to chase him, and a
   * sentence naming him needs a name from somewhere the plan does not carry —
   * the board row the reader is looking at. A target with no row is skipped
   * rather than referred to by id.
   */
  const nameOf = new Map<string, string>();
  for (const [playerId, row] of rows) nameOf.set(playerId, row.name);
  for (const claim of plan.claims) nameOf.set(claim.addPlayerId, claim.addName);

  /*
   * Grouped by relation, because every relationship shares a first player.
   *
   * The planner measures each target against the same spine claim, so a roster
   * with one spare cut produces the same sentence five times with a different
   * name in it. One sentence naming all five says the identical thing and is the
   * one somebody reads.
   */
  const grouped = new Map<TargetRelation, string[]>();
  let first: string | null = null;
  for (const relation of plan.relationships) {
    const one = nameOf.get(relation.firstPlayerId);
    const second = nameOf.get(relation.secondPlayerId);
    if (!one || !second) continue;
    first = one;
    grouped.set(relation.relation, [...(grouped.get(relation.relation) ?? []), second]);
  }
  if (first == null) return [];

  const lines: string[] = [];
  const redundant = grouped.get('redundant');
  if (redundant) {
    lines.push(
      `Once ${first} lands, ${joinNames(redundant)} ${redundant.length === 1 ? 'adds' : 'add'} almost nothing. ${redundant.length === 1 ? 'He is' : 'None of them is'} worth a second cut.`,
    );
  }
  const substitutes = grouped.get('substitute');
  if (substitutes) {
    lines.push(
      `${first} and ${joinNames(substitutes)} do the same job on this roster. Landing one makes ${substitutes.length === 1 ? 'the other' : 'the others'} much less worth chasing.`,
    );
  }
  const conditional = grouped.get('conditional_complement');
  if (conditional) {
    lines.push(
      `${joinNames(conditional)} ${conditional.length === 1 ? 'is' : 'are'} still worth having after ${first}, but only by spending a different and more expensive cut.`,
    );
  }
  const complements = grouped.get('complement');
  if (complements) {
    lines.push(
      `${first} and ${joinNames(complements)} improve different things. Both are worth having, and a second cut is the right price for ${complements.length === 1 ? 'the second' : 'them'}.`,
    );
  }
  return lines;
}

/**
 * Who the plan refuses to cut, grouped by why rather than listed by name.
 *
 * A settled roster protects its whole starting seven, and seven lines saying
 * `starts for you` is a list nobody reads. The grouping is the same four reasons
 * the planner emits, in the order they are categorical: two facts about the
 * roster, one judgement, and one admission of not knowing.
 */
function protectedLines(plan: WaiverPlan): string[] {
  /*
   * A defence is protected for a reason of its own, said in its own words.
   *
   * The planner reports one as `core_value`, and the comment in `dropCost.ts`
   * explains why: from a generic waiver claim's point of view "not yours to cut"
   * and "worth too much to cut" are the same instruction, and a fifth reason
   * code would have been a distinction the model does not make. The *reader*
   * needs the distinction, because a defence in a `worth too much` list beside
   * the DST line's own recommendation reads as the two disagreeing. Recovered
   * from the position on the drop ranking, which is where the planner does carry
   * it.
   */
  const positionOf = new Map<string, string>();
  for (const ranking of plan.dropRanking) {
    for (const drop of ranking.drops) positionOf.set(drop.playerId, drop.position);
  }
  const isDefence = (playerId: string) => plannerExcluded(positionOf.get(playerId));

  const groups: { lead: string; take: (p: WaiverPlan['protectedPlayers'][number]) => boolean }[] = [
    { lead: 'Starting for you', take: (p) => p.reason === 'in_lineup' },
    { lead: 'On an injured-reserve slot, which is not a bench spot', take: (p) => p.reason === 'reserve_slot' },
    {
      lead: 'Worth more than a waiver claim should be allowed to spend',
      take: (p) => p.reason === 'core_value' && !isDefence(p.playerId),
    },
    {
      lead: 'A defence, which belongs to the defence plan rather than to a generic claim',
      take: (p) => p.reason === 'core_value' && isDefence(p.playerId),
    },
    { lead: 'Not scorable yet, so never named as a cut', take: (p) => p.reason === 'unscorable' },
  ];

  const lines: string[] = [];
  for (const group of groups) {
    const names = plan.protectedPlayers.filter(group.take).map((p) => p.name);
    if (names.length === 0) continue;
    lines.push(`${group.lead}: ${joinNames(names)}.`);
  }
  return lines;
}

/**
 * What the wallet allowed, and what it cost.
 *
 * The constraint the planner holds itself to is deliberately conservative — no
 * set of claims that could *all* succeed may total more than the budget —
 * because nothing in this repository establishes what Sleeper does with pending
 * claims that together exceed it. That restraint is worth saying out loud when
 * it bites, because a reader who cannot see why a target was left out will add
 * it back by hand.
 */
function budgetLine(
  plan: WaiverPlan,
  rows: ReadonlyMap<string, WaiverBoardRow>,
  context: { remaining?: number | null; usesFaab?: boolean },
): string | null {
  if (context.usesFaab === false) {
    return 'This league does not bid for waivers, so the plan carries no prices — only the order.';
  }

  const capped = plan.reasons.filter((r) => r.code === 'budget_caps_simultaneous_claims');
  if (capped.length > 0) {
    const given = capped.map((r) => {
      const name = r.playerId ? (rows.get(r.playerId)?.name ?? r.playerId) : 'a claim';
      return r.value != null ? `${name}, at $${r.value}` : name;
    });
    return `Your remaining budget would not cover every claim landing at once, so the plan gave up ${joinNames(given)}. No bid was lowered to make it fit — a bid is the pricing pass's answer, not this plan's.`;
  }

  if (plan.maxSimultaneousSpend != null) {
    const of = context.remaining != null ? ` of the $${context.remaining} you have left` : '';
    return `Landing every claim above would cost $${plan.maxSimultaneousSpend}${of}. Fallback claims cost nothing extra, because they only run in the world where the claim above them lost.`;
  }
  return null;
}

/**
 * The add-specific cut for each target the planner weighed, plan or no plan.
 *
 * This is the whole insight of the folder reduced to three words — *the drop
 * moves with the incoming player* — and it is the one thing a waiver detail
 * sheet has never been able to say. It is drawn on the sheet rather than on the
 * compact row, because a row sitting four lines under the plan card would be
 * repeating it and a sheet is where somebody asks the question about one player.
 *
 * Two sources, and the order between them is the point. **A target the plan
 * claims is named by the claim**, not by the ranking: the claim was chosen on
 * net gain over the pair and the ranking is ordered on the cost of the cut
 * alone, and the two legitimately disagree — the same receiver's cheapest cut
 * and his best cut are different men when the dearer one frees more. Reading the
 * ranking for a player the plan has already spoken about is how a sheet and a
 * plan end up naming two different cuts for one add. Everything else falls back
 * to the cheapest eligible drop in that target's ranking, which is the honest
 * answer for a target no claim was made for.
 */
function hintsFrom(plan: WaiverPlan): WaiverClaimPlan['dropHints'] {
  const hints = new Map<string, WaiverClaimPlan['dropHints'][number]>();
  for (const ranking of plan.dropRanking) {
    const best = ranking.drops.find((drop: DropCost) => drop.protection == null && drop.cost != null);
    if (!best) continue;
    hints.set(ranking.addPlayerId, { addPlayerId: ranking.addPlayerId, dropName: best.name, label: `Drop ${best.name}` });
  }
  for (const claim of plan.claims) {
    if (claim.dropName == null) continue;
    /* The first claim for a target is its preferred one; later ones are contingencies. */
    if (hints.get(claim.addPlayerId)?.dropName === claim.dropName) continue;
    if (plan.claims.find((c) => c.addPlayerId === claim.addPlayerId) !== claim) continue;
    hints.set(claim.addPlayerId, {
      addPlayerId: claim.addPlayerId,
      dropName: claim.dropName,
      label: `Drop ${claim.dropName}`,
    });
  }
  return [...hints.values()];
}

/* ------------------------------------------------------------------ *
 * Small shared readings
 * ------------------------------------------------------------------ */

/** Which of the two empty plans this is — a quiet week, or a full roster. */
function stateOfEmpty(reasons: readonly WaiverReason[]): WaiverClaimPlanState {
  const codes = codesOf(reasons);
  if (codes.has('no_eligible_drop')) return 'no_safe_drop';
  if (codes.has('net_gain_below_bar')) return 'no_move';
  return 'no_targets';
}

function codesOf(reasons: readonly WaiverReason[]): Set<WaiverReasonCode> {
  return new Set(reasons.map((r) => r.code));
}

function valueOf(reasons: readonly WaiverReason[], code: WaiverReasonCode): number | null {
  const found = reasons.find((r) => r.code === code);
  return found?.value ?? null;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
