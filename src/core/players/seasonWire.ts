/**
 * What the in-season Players tab is sent (Round 24, behind `PLAYERS_INSEASON`).
 *
 * Types only, so the screen can read them without loading an engine.
 */

/** How likely the owner is to deal him: trades often and needs one of yours. */
export type Willingness = 'Likely' | 'Maybe' | 'Unlikely';

export interface SeasonTradeRead {
  /** Points a week Alex's best lineup gains with him in it. */
  gain: number;
  /** The lineup spot he would take: `RB`, `WR`, `FLEX`... */
  slot: string;
  willingness: Willingness;
  /** The starter he would push out of Alex's lineup, for the direct comparison. Null when he fills an empty spot. */
  overId: string | null;
  over: string | null;
  /** That starter's rest-of-season value. */
  overValue: number | null;
  /** One short line. */
  reason: string;
}

export interface SeasonInjuryRead {
  /** Not playing this week: Out, IR, PUP, suspended, Doubtful, or in an IR slot. */
  out: true;
  /** The first later week he is expected to play, or null when not inside the season. */
  backWeek: number | null;
}

export interface SeasonRow {
  id: string;
  name: string;
  position: string;
  team: string;
  /** Sleeper's injury word, as the draft list sends it. */
  status: string | null;
  /** The roster holding him, or null for a free agent. */
  ownerRosterId: number | null;
  /** Rest-of-season value: expected points in an average remaining week, playoff weeks at their weight. */
  value: number | null;
  /**
   * What the list ranks by (Alex, Round 24 review): rest-of-season points over
   * the free agent at his position, the number Trades values a player on
   * (`seasonValueOver`). Null with no free-agent level at his position.
   */
  overFreeAgent: number | null;
  injury: SeasonInjuryRead | null;
  /** Set only on a player another team holds who would start for Alex. */
  trade: SeasonTradeRead | null;
  /** The draft list's numbers, kept (Alex): draft order, the pick, the 7-day and 30-day moves. */
  draftRank: number | null;
  adjustedRank: number | null;
  draftPick: string | null;
  last7: number;
  last30: number;
  lifetime: number;
}

export interface SeasonBoard {
  league: { id: string; name: string } | null;
  /** The week the values start from. */
  week: number | null;
  /** False once the trade deadline has passed: no trade targets. */
  tradeOpen: boolean;
  teams: { rosterId: number; ownerName: string | null; isMine: boolean }[];
  rows: SeasonRow[];
  /** One plain line when there is nothing to show. */
  reason?: string;
}

export interface SeasonWeekCell {
  week: number;
  bye: boolean;
  /** Points, or null for a dash. */
  points: number | null;
  /** Built on Sleeper's projection rather than a full Vegas week (italic, dotted underline). */
  sleeper: boolean;
  out: boolean;
}

export interface SeasonCard {
  playerId: string;
  week: number | null;
  /** This week's number, the one Team and Compare show. */
  thisWeek: { points: number | null; sleeper: boolean; out: boolean };
  /** This week and the three after it, byes marked. */
  next: SeasonWeekCell[];
  /** His last five games played, oldest first, in this league's scoring. */
  last: { week: number; points: number }[];
}
