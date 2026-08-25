/**
 * The waiver pool as a list of decisions rather than a list of comparisons.
 *
 * The engine answers a slot-shaped question — *is anybody available better than
 * the player currently in my RB2* — and produces one block per slot, each with
 * a current player, a bar, and up to three candidates. That is the right shape
 * for the arithmetic and the wrong shape for a person: the same receiver
 * appears under two slots, the interesting fact (should I claim him) is spread
 * over four lines, and the reader has to hold the roster in their head to read
 * it at all.
 *
 * This turns it the other way up. One row per *player*, carrying what a claim
 * decision is actually made of: how strongly he is recommended, where he fits,
 * what he is worth this week, what he is worth beyond it, what he will cost,
 * who else is likely to want him, and one line saying why.
 *
 * **Four of those seven are not knowable here, and that is the design.** Expected
 * cost, competition, multi-week value and league-specific ranking are all
 * facts about *your* league's managers — their bidding history, their roster
 * holes, their habits — and they belong to the league-intelligence pass, not to
 * a start/sit engine. So this module defines the shape they will arrive in,
 * reads them when they are present, and reports them as unknown when they are
 * not. It does not estimate a FAAB bid from a projection. There is no
 * arithmetic in this file that turns points into dollars, because there is no
 * honest arithmetic that does that, and a number the reader trusts and we
 * invented is worse than an empty field.
 *
 * Nothing here transacts. Every row is a sentence; the claim is made in
 * Sleeper, by hand.
 */

/**
 * What the league-intelligence pass owns.
 *
 * Every field is optional and nullable, and the two mean the same thing to a
 * reader: not known. Present-and-null is what a pass that ran and found nothing
 * looks like; absent is what a deployment without the pass looks like.
 */
import { weekRange, type DstDecision, type DstOption, type DstPlan } from '../dst/planner.ts';

export interface WaiverLeagueIntel {
  /**
   * What he is expected to cost, in this league's own currency.
   *
   * A range rather than a number, because a bid is a distribution and a single
   * figure would be pretending otherwise. `unit` says what the numbers are —
   * FAAB is a percentage of budget in some leagues and dollars in others, and
   * guessing wrong turns 30 into either a bargain or a disaster.
   */
  faab?: {
    low: number | null;
    high: number | null;
    unit?: 'percent' | 'dollar' | 'priority';
    detail?: string | null;
  } | null;
  /** How many other managers are likely to be in on him. */
  competition?: {
    level: 'high' | 'medium' | 'low' | 'unknown';
    label: string;
    detail?: string | null;
  } | null;
  /**
   * Which of them, by name, when the evidence supports saying so.
   *
   * Null is the ordinary answer: no bid history, no wallets, or a field of
   * rivals nothing can tell apart. The row shows the count either way, so an
   * absent list costs a name and never a fact.
   */
  bidders?: {
    rosterId: number;
    displayName: string;
    needReason: string;
    remaining: number | null;
    estimate: { low: number; high: number } | null;
    tendency: string | null;
    caveat: string | null;
    confidence: 'high' | 'medium' | 'low';
    display: string;
  }[] | null;
  /** What he is worth past this Sunday. */
  multiWeek?: {
    level: 'season_long' | 'multi_week' | 'streamer' | 'unknown';
    label: string;
    detail?: string | null;
  } | null;
  /** Where the league-specific ranking put him. Sorted on when present. */
  leagueRank?: number | null;
}

/** One candidate as the start/sit engine produces him, plus whatever Channel 4 added. */
export interface WaiverCandidateLike extends WaiverLeagueIntel {
  playerId: string;
  name: string;
  position: string;
  team: string;
  score: number | null;
  /** Points gained over whoever the optimiser currently has in the slot. */
  gain: number;
  reasons: string[];
  statusFlag?: string | null;
}

export interface WaiverUpgradeLike {
  slot: string;
  accepts: string[];
  need: 'unfilled' | 'upgrade';
  currentPlayerId: string | null;
  currentName: string | null;
  currentScore: number | null;
  /** The points gap the candidate had to clear, so the bar is never invisible. */
  bar: number;
  candidates: WaiverCandidateLike[];
}

/**
 * One player's price, as the league-intelligence pass works it out.
 *
 * Read here rather than reproduced: this module attaches the number to the row
 * that shows it and computes none of it. `withheld` is the case that matters —
 * a priority league, an unpublished budget, a spent wallet — and it is carried
 * as a reason rather than collapsed into a zero.
 */
export interface WaiverBidLike {
  playerId: string;
  expected: { low: number; high: number } | null;
  recommended: number | null;
  doNotExceed: number | null;
  headline: string;
  reasons?: string[];
  confidence?: 'none' | 'low' | 'medium' | 'high';
  withheld?: string | null;
  opportunity?: { line: string } | null;
  trending?: string | null;
  disagreement?: { line: string | null } | null;
}

export interface WaiverAdviceLike {
  upgrades: WaiverUpgradeLike[];
  headline?: string | null;
  notes?: string[];
  considered?: number;
  /**
   * What each upgrade would cost. Optional, because the pass that prices them
   * is a separate one and a deployment may not have it — in which case every
   * row's cost reads as unknown, which is the honest answer and not a bug.
   */
  faab?: { bids?: WaiverBidLike[] } | null;
  /**
   * The defence decision, decided elsewhere and drawn here.
   *
   * A DST does not arrive through `upgrades` and deliberately does not: the
   * generic scan compares one player against the man in the slot, and the
   * question at defence is whether the slot is worth holding at all, over how
   * many weeks, against what the bench spot was earning. That is
   * `core/dst/planner.ts`, and this is where its answer joins the board so
   * there is one surface rather than a defence dashboard.
   */
  dst?: DstPlan | null;
}

export type WaiverStrength = 'strong' | 'solid' | 'speculative';

/** What a defence row is: the plan's decision, and which half of it this is. */
export interface WaiverDstRole {
  decision: DstDecision;
  /** `stream` and `add` fill the slot; `stash` is carried for the playoffs. */
  role: 'slot' | 'stash';
  /** The compact sentence the plan wrote. */
  headline: string;
  /** What the roster spot costs, always in words. */
  cost: string;
  /** One week only — a bye fill rather than a replacement. */
  temporary: boolean;
}

export interface WaiverBoardRow {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** How strongly he is recommended, and the sentence for it. */
  strength: { level: WaiverStrength; label: string };
  /** Where he fits: the slot, and whether that slot is empty or merely beatable. */
  fit: {
    slot: string;
    need: 'unfilled' | 'upgrade';
    label: string;
    /** Every slot he would improve, when it is more than one. */
    alsoFits: string[];
  };
  /** This week, in points, against the man he would replace. */
  shortTerm: { gain: number; label: string; over: string | null };
  /** Past this week. Null until the league-intelligence pass provides it. */
  multiWeek: NonNullable<WaiverLeagueIntel['multiWeek']> | null;
  /** What he will cost. Null until then, and never estimated here. */
  faab: NonNullable<WaiverLeagueIntel['faab']> | null;
  /** Who else wants him. Null until then. */
  competition: NonNullable<WaiverLeagueIntel['competition']> | null;
  /** The named rivals behind that count, when they can be supported. */
  bidders: NonNullable<WaiverLeagueIntel['bidders']> | null;
  /** One short phrase. The rest of the reasons open on tap. */
  why: string;
  /** Everything the engine said about him, for the detail view. */
  reasons: string[];
  statusFlag: string | null;
  score: number | null;
  leagueRank: number | null;
  /**
   * The priced bid behind `faab`, when one exists: the headline, the ceiling,
   * what spending it costs, and whether the market is already on him.
   *
   * Carried whole so the detail sheet can say what the row has no room for, and
   * carried *unchanged* — every string here was written by the pass that priced
   * the bid.
   */
  bid: WaiverBidLike | null;
  /** Present only on a defence row. Absent everywhere else, not null-filled. */
  dst?: WaiverDstRole;
}

export interface WaiverBoard {
  rows: WaiverBoardRow[];
  /** Position filters worth offering, given who is actually on the board. */
  positions: string[];
  headline: string | null;
  notes: string[];
  considered: number;
  /**
   * The columns the league-intelligence pass will fill, named once.
   *
   * Shown as a single quiet line rather than as four empty fields per row: the
   * reader should know what is missing without being reminded of it eleven
   * times down a list.
   */
  pending: string[];
  /**
   * The whole defence answer, including the ones with nobody to add.
   *
   * `wait`, `hold` and `unknown` have no player attached and therefore no row,
   * but they are still the answer to "which defence should I add" — the answer
   * being *none, and here is why*. Carried beside the rows so the screen can
   * say it in one line without inventing a player to hang it on.
   */
  dst: DstPlan | null;
}

/** How far past the bar a gain has to be before it is called strong. */
export const STRONG_MULTIPLE = 2;
/** …and merely solid. Below this, he cleared the bar and not much else. */
export const SOLID_MULTIPLE = 1.35;

/*
 * How strongly it is recommended — said as a recommendation, never as an
 * action.
 *
 * "Strong add" is the phrase the rest of fantasy football uses and it is the
 * wrong one here: every row on this board is a button, and a button reading
 * *add* is a button that looks like it adds him. Nothing in this app transacts,
 * and the labels are held to the same rule as the controls.
 */
/*
 * The verdict, in words that fit the badge it is printed in.
 *
 * `Strongly recommended` was nineteen characters on the widest element of a
 * card that has to work at 360px, and it took its room from the player's name.
 * These say the same thing in twelve.
 *
 * Not `Strong claim`, which was the first attempt and is a word this screen may
 * not use: the whole card is a button, and `offers nothing that would make a
 * claim` reads every control on the page for `add`, `drop`, `claim`, `bid` and
 * `submit`. A badge inside a tappable row saying `claim` reads as an offer to
 * make one, which is exactly the promise this app does not make.
 *
 * Nothing about the threshold behind them changed — see `strengthOf`.
 */
const STRENGTH_LABEL: Record<WaiverStrength, string> = {
  strong: 'Highly rated',
  solid: 'Recommended',
  speculative: 'Worth a look',
};

/**
 * Positions the filter row offers, in the order the rest of the app uses.
 *
 * `DEF` is last and is not flex-eligible, which is the whole of what makes it
 * behave: it earns a chip when the planner has named a defence and gets none
 * when it has not, exactly like every other position on this board.
 */
export const BOARD_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DEF'];
export const FLEX_POSITIONS = ['RB', 'WR', 'TE'];

export function buildWaiverBoard(advice: WaiverAdviceLike): WaiverBoard {
  /*
   * One row per player, not per slot-and-player.
   *
   * A flex-eligible receiver legitimately clears the bar at WR2 and at FLEX,
   * and the engine reports both because both are true. To a reader they are one
   * decision — claim him or do not — so the better of the two leads and the
   * other becomes "also fits", which is a genuinely useful thing to know and
   * costs four words.
   */
  const byPlayer = new Map<string, WaiverBoardRow>();

  for (const upgrade of advice.upgrades ?? []) {
    for (const candidate of upgrade.candidates ?? []) {
      const row = rowFor(candidate, upgrade);
      const existing = byPlayer.get(candidate.playerId);
      if (!existing) {
        byPlayer.set(candidate.playerId, row);
        continue;
      }
      // Keep the slot where he is worth the most, and remember the other.
      if (row.shortTerm.gain > existing.shortTerm.gain) {
        row.fit.alsoFits = dedupe([...existing.fit.alsoFits, existing.fit.slot]);
        byPlayer.set(candidate.playerId, row);
      } else {
        existing.fit.alsoFits = dedupe([...existing.fit.alsoFits, upgrade.slot]);
      }
    }
  }

  /*
   * The prices, attached to the players they are prices for.
   *
   * The pass that works them out answers per player, and this board is per
   * player, so the join is a lookup. A bid that deliberately quotes no number —
   * `withheld` — leaves the cost unknown and contributes its reason instead: a
   * blank field would read as "free", which is the opposite of what it means.
   */
  const bids = new Map((advice.faab?.bids ?? []).map((b) => [b.playerId, b]));
  for (const row of byPlayer.values()) {
    const bid = bids.get(row.playerId);
    if (!bid) continue;
    row.bid = bid;
    if (bid.expected) {
      row.faab = {
        low: bid.expected.low,
        high: bid.expected.high,
        unit: 'dollar',
        detail: bid.recommended == null ? null : `Recommended max $${bid.recommended}`,
      };
    } else if (bid.withheld) {
      row.reasons = [...row.reasons, bid.withheld];
    }
  }

  /*
   * The defence rows, if the plan named anybody.
   *
   * At most two — the defence to start this week and the defence to carry into
   * the playoffs — and only when the planner actually chose one. A `hold` or a
   * `wait` produces no row on purpose: there is nobody to add, and a board row
   * for a player you are not being told to add is the context-free DST ranking
   * this lane exists to avoid.
   */
  for (const row of dstRows(advice.dst ?? null)) byPlayer.set(row.playerId, row);

  const rows = [...byPlayer.values()].sort(compareRows);

  /*
   * What the league-intelligence pass has still to fill — for the rows it fills.
   *
   * A defence row is excluded from this count rather than counted as missing,
   * because nothing is coming for it: the price model runs over waiver upgrades
   * and a DST does not arrive as one, and this lane deliberately did not build a
   * second auction model for a two-dollar add. Counting it would have the page
   * promise a column that will never arrive.
   */
  const priced = rows.filter((r) => r.dst == null);
  const pending: string[] = [];
  if (priced.length > 0) {
    if (priced.every((r) => r.faab == null)) pending.push('expected cost');
    if (priced.every((r) => r.competition == null)) pending.push('likely competition');
    if (priced.every((r) => r.multiWeek == null)) pending.push('multi-week value');
  }

  return {
    rows,
    positions: offeredPositions(rows),
    headline: advice.headline ?? null,
    notes: advice.notes ?? [],
    considered: advice.considered ?? 0,
    pending,
    dst: advice.dst ?? null,
  };
}

/**
 * The plan's chosen defences, as board rows.
 *
 * Everything a defence row shows is the plan's own: the strength is the
 * decision rather than a ratio against a waiver bar, the fit is the DEF slot or
 * the playoff carry, and `shortTerm.gain` is the gain the plan measured against
 * the defence already rostered. Nothing here re-decides anything.
 */
function dstRows(plan: DstPlan | null): WaiverBoardRow[] {
  if (!plan || !plan.surface) return [];
  const rows: WaiverBoardRow[] = [];

  if (plan.target) {
    rows.push(
      dstRow(plan.target, plan, {
        decision: plan.decision,
        role: 'slot',
        headline: plan.headline,
        cost: plan.cost.label,
        temporary: plan.temporary,
      }),
    );
  }
  if (plan.stash) {
    /* The stash's own gain is a playoff figure, not this week's — see `dstRow`. */
    rows.push(
      dstRow(plan.stash, plan, {
        decision: plan.decision,
        role: 'stash',
        headline: `Playoff stash · ${plan.stash.team}`,
        cost: plan.cost.label,
        temporary: false,
      }),
    );
  }
  return rows;
}

function dstRow(option: DstOption, plan: DstPlan, role: WaiverDstRole): WaiverBoardRow {
  const stash = role.role === 'stash';
  const gain = stash ? (option.playoff?.perWeek ?? 0) : (plan.gain ?? option.thisWeek ?? 0);
  /*
   * A defence's strength is its decision, not a multiple of a bar.
   *
   * `strengthOf` prices a claim against the points threshold a waiver upgrade
   * had to clear, and the defence bar already has the roster-spot cost folded
   * into it — running the ratio again would report the same restraint twice and
   * call a cleared decision speculative.
   */
  const level: WaiverStrength =
    role.decision === 'add' || role.decision === 'stream' || role.decision === 'stream_and_stash'
      ? stash
        ? 'solid'
        : 'strong'
      : 'solid';

  return {
    playerId: option.playerId,
    name: option.name,
    position: 'DEF',
    team: option.team,
    strength: { level, label: stash ? 'Playoff stash' : DST_DECISION_LABEL[role.decision] },
    fit: {
      slot: 'DEF',
      need: plan.current == null && !stash ? 'unfilled' : 'upgrade',
      label: stash ? `Carry for ${weekRange(plan.playoffWeeks)}` : plan.current ? `Streams over ${plan.current.team}` : 'Fills DEF',
      alsoFits: [],
    },
    shortTerm: {
      gain,
      label: `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} pts`,
      over: stash ? null : (plan.current?.name ?? null),
    },
    multiWeek: dstMultiWeek(option, stash),
    faab: null,
    competition: null,
    bidders: null,
    why: role.headline,
    reasons: [...plan.why, ...plan.evidence.map((e) => `${e.label}: ${e.value}`)],
    statusFlag: option.unavailable ? (option.unavailableReason ?? 'unavailable') : null,
    score: option.thisWeek,
    leagueRank: null,
    bid: null,
    dst: role,
  };
}

/**
 * The forward view, in the column the board already has for one.
 *
 * Reported as an outlook rather than as a projection — `medium` at its very
 * best — because no book has priced these weeks; see `core/dst/outlook.ts`.
 */
function dstMultiWeek(option: DstOption, stash: boolean): WaiverBoardRow['multiWeek'] {
  const outlook = stash ? option.playoff : option.forward;
  if (!outlook || outlook.perWeek == null) return null;
  return {
    /*
     * `streamer` rather than a level of its own.
     *
     * The column's vocabulary already has a word for "worth a week or a few
     * rather than a season", and a defence is the position it was coined for.
     * Adding a fifth level to describe the same thing would put two words for
     * one idea in front of a reader.
     */
    level: 'streamer',
    label: `${outlook.perWeek.toFixed(1)} pts a week`,
    detail:
      outlook.confidence === 'medium'
        ? `${stash ? 'the playoff weeks' : 'the next few weeks'}, on the lines the market has published`
        : `${stash ? 'the playoff weeks' : 'the next few weeks'} — an outlook rather than a projection, because nobody has priced them yet`,
  };
}

/** The decision, in the words the badge has room for. */
export const DST_DECISION_LABEL: Record<DstDecision, string> = {
  add: 'Add',
  stream: 'Stream',
  stream_and_stash: 'Stream',
  stash: 'Playoff stash',
  hold: 'Hold',
  wait: 'Wait',
  unknown: 'Unknown',
};

function rowFor(candidate: WaiverCandidateLike, upgrade: WaiverUpgradeLike): WaiverBoardRow {
  const level = strengthOf(candidate.gain, upgrade.bar, upgrade.need);
  return {
    playerId: candidate.playerId,
    name: candidate.name,
    position: candidate.position,
    team: candidate.team,
    strength: { level, label: STRENGTH_LABEL[level] },
    fit: {
      slot: upgrade.slot,
      need: upgrade.need,
      label: upgrade.need === 'unfilled' ? `Fills ${upgrade.slot}` : `Upgrades ${upgrade.slot}`,
      alsoFits: [],
    },
    shortTerm: {
      gain: candidate.gain,
      /*
       * One decimal, everywhere this number is printed.
       *
       * The engine's gain carries whatever precision the subtraction produced,
       * so the board was showing `+6.46 pts` on one card and `+5.7 pts` on the
       * next — two different claims about how precisely this is known, from the
       * same calculation. It is a projection of a projection; the second
       * decimal is noise wearing the clothes of a measurement.
       */
      label: `+${candidate.gain.toFixed(1)} pts`,
      over: upgrade.currentName,
    },
    multiWeek: candidate.multiWeek ?? null,
    faab: candidate.faab ?? null,
    competition: candidate.competition ?? null,
    bidders: candidate.bidders ?? null,
    why: candidate.reasons[0] ?? `Projects ${candidate.gain} points above your ${upgrade.slot}.`,
    reasons: candidate.reasons ?? [],
    statusFlag: candidate.statusFlag ?? null,
    score: candidate.score,
    leagueRank: candidate.leagueRank ?? null,
    bid: null,
  };
}

/**
 * How strongly to put it, from how far past the bar he is.
 *
 * The bar is the engine's own — the points a claim has to be worth before it is
 * worth a roster spot — so this is a ratio against a threshold that already
 * exists rather than a new opinion about what "good" means. An empty starting
 * slot is strong by definition: anybody legal beats nobody.
 */
export function strengthOf(gain: number, bar: number, need: 'unfilled' | 'upgrade'): WaiverStrength {
  if (need === 'unfilled') return 'strong';
  if (bar <= 0) return gain > 0 ? 'solid' : 'speculative';
  if (gain >= bar * STRONG_MULTIPLE) return 'strong';
  if (gain >= bar * SOLID_MULTIPLE) return 'solid';
  return 'speculative';
}

/**
 * Best first, and "best" is the league's own ranking when there is one.
 *
 * Until the league-intelligence pass lands, the ordering is what this branch can
 * honestly compute: the size of the improvement, then the name so the list is
 * stable between renders.
 */
function compareRows(a: WaiverBoardRow, b: WaiverBoardRow): number {
  if (a.leagueRank != null && b.leagueRank != null && a.leagueRank !== b.leagueRank) {
    return a.leagueRank - b.leagueRank;
  }
  if (a.leagueRank != null && b.leagueRank == null) return -1;
  if (a.leagueRank == null && b.leagueRank != null) return 1;
  if (b.shortTerm.gain !== a.shortTerm.gain) return b.shortTerm.gain - a.shortTerm.gain;
  return a.name.localeCompare(b.name);
}

/**
 * Which filters to offer.
 *
 * Only positions that are actually on the board: a QB chip over a board with no
 * quarterbacks on it is a control whose only possible outcome is an empty list.
 * FLEX earns its place only when more than one flex-eligible position is
 * present, otherwise it is a duplicate of the position chip beside it.
 */
export function offeredPositions(rows: WaiverBoardRow[]): string[] {
  const present = new Set(rows.map((r) => (r.position ?? '').toUpperCase()));
  const positions = BOARD_POSITIONS.filter((p) => present.has(p));
  const flexy = FLEX_POSITIONS.filter((p) => present.has(p));
  return flexy.length > 1 ? [...positions, 'FLEX'] : positions;
}

/** Whether a row belongs under a filter chip. `ALL` and `FLEX` are views. */
export function rowMatches(row: WaiverBoardRow, filter: string): boolean {
  const position = (row.position ?? '').toUpperCase();
  if (filter === 'ALL') return true;
  if (filter === 'FLEX') return FLEX_POSITIONS.includes(position);
  return position === filter;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
