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
}

export type WaiverStrength = 'strong' | 'solid' | 'speculative';

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
const STRENGTH_LABEL: Record<WaiverStrength, string> = {
  strong: 'Strongly recommended',
  solid: 'Recommended',
  speculative: 'Worth a look',
};

/** Positions the filter row offers, in the order the rest of the app uses. */
export const BOARD_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
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

  const rows = [...byPlayer.values()].sort(compareRows);

  const pending: string[] = [];
  if (rows.length > 0) {
    if (rows.every((r) => r.faab == null)) pending.push('expected cost');
    if (rows.every((r) => r.competition == null)) pending.push('likely competition');
    if (rows.every((r) => r.multiWeek == null)) pending.push('multi-week value');
  }

  return {
    rows,
    positions: offeredPositions(rows),
    headline: advice.headline ?? null,
    notes: advice.notes ?? [],
    considered: advice.considered ?? 0,
    pending,
  };
}

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
      label: `+${candidate.gain} pts`,
      over: upgrade.currentName,
    },
    multiWeek: candidate.multiWeek ?? null,
    faab: candidate.faab ?? null,
    competition: candidate.competition ?? null,
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
