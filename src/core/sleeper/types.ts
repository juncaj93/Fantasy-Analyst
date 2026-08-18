/**
 * Raw Sleeper API shapes (only the fields we actually consume) plus the
 * normalized internal shapes we persist.
 *
 * Sleeper's public read API requires no key and no auth:
 *   GET https://api.sleeper.app/v1/user/<username>
 *   GET https://api.sleeper.app/v1/user/<user_id>/leagues/nfl/<season>
 *   GET https://api.sleeper.app/v1/league/<league_id>
 *   GET https://api.sleeper.app/v1/league/<league_id>/rosters
 *   GET https://api.sleeper.app/v1/league/<league_id>/users
 *   GET https://api.sleeper.app/v1/league/<league_id>/drafts
 *   GET https://api.sleeper.app/v1/draft/<draft_id>
 *   GET https://api.sleeper.app/v1/draft/<draft_id>/picks
 *   GET https://api.sleeper.app/v1/players/nfl   (large; cache, do not poll)
 *   GET https://api.sleeper.app/v1/state/nfl
 */

export interface SleeperUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  season_type?: string;
  status?: string;
  sport?: string;
  total_rosters?: number;
  scoring_settings?: Record<string, number>;
  roster_positions?: string[];
  settings?: Record<string, unknown>;
  previous_league_id?: string | null;
  draft_id?: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  settings?: Record<string, unknown>;
}

export interface SleeperDraft {
  draft_id: string;
  league_id: string;
  status: string;
  type: string;
  season: string;
  start_time?: number | null;
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SleeperDraftPick {
  draft_id: string;
  pick_no: number;
  round: number;
  draft_slot: number;
  player_id: string | null;
  picked_by?: string | null;
  roster_id?: number | string | null;
  metadata?: Record<string, unknown>;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  team?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  status?: string | null;
  injury_status?: string | null;
  active?: boolean | null;
  search_full_name?: string | null;
  /**
   * Sleeper's draft-order ranking. Unranked players carry a large sentinel
   * rather than being absent, so it is read defensively.
   */
  search_rank?: number | null;
  years_exp?: number | null;
  /** Either `"71"` or `"5'11\""` — both shapes appear in the live dictionary. */
  height?: string | number | null;
  weight?: string | number | null;
  age?: number | string | null;
  gsis_id?: string | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
}

export interface SleeperState {
  season: string;
  week: number;
  season_type: string;
  display_week?: number;
  /** Sleeper's own week counter across the whole season. */
  leg?: number;
}

/**
 * One completed or failed league transaction.
 *
 * The supported, documented shape only. `waiver_budget` is the FAAB *traded*
 * between rosters, which is a different thing from the FAAB *spent* on a waiver
 * claim — that lives in `settings.waiver_bid`, and only on a waiver row. The two
 * are conflated often enough in the wild that they are named apart here.
 *
 * A failed claim carries a bid too, which is the only supported way this app
 * ever learns what somebody else was willing to pay. Sleeper publishes the
 * user's own failed claims reliably and other managers' inconsistently, which
 * is why nothing downstream is allowed to assume the losing side is complete.
 */
export interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  /** Epoch milliseconds. */
  created?: number | null;
  status_updated?: number | null;
  leg?: number | null;
  roster_ids?: number[] | null;
  /** player id -> roster id receiving them. */
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: SleeperTradedPick[] | null;
  /** FAAB moved between rosters as part of a trade. */
  waiver_budget?: { sender: number; receiver: number; amount: number }[] | null;
  /** `waiver_bid` lives here on waiver rows. */
  settings?: Record<string, number> | null;
  creator?: string | null;
  consenter_ids?: number[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id?: number | null;
  owner_id: number;
}

/** One row of Sleeper's global trending adds/drops list. */
export interface SleeperTrendingPlayer {
  player_id: string;
  /** Adds (or drops) counted across all of Sleeper in the lookback window. */
  count: number;
}

/** Normalized league record persisted in D1. */
export interface LeagueRecord {
  id: string;
  sleeperLeagueId: string;
  name: string;
  season: string;
  totalRosters: number;
  scoringSettings: Record<string, number>;
  rosterPositions: string[];
  leagueSettings: Record<string, unknown>;
  draftId: string | null;
  /**
   * Sleeper's own `pre_draft` / `drafting` / `in_season` / `complete`.
   *
   * Optional because every league stored before this column existed has none,
   * and absent is read as "not known" rather than as "not in season".
   */
  status?: string | null;
  lastSyncedAt: string;
}

export interface RosterRecord {
  leagueId: string;
  rosterId: number;
  ownerId: string | null;
  ownerName: string | null;
  playerIds: string[];
  starterIds: string[];
  reserveIds: string[];
  isMine: boolean;
  /**
   * Sleeper's own roster settings blob, kept whole.
   *
   * `waiver_budget_used` lives here, and it is the authoritative FAAB spend —
   * it already accounts for budget that moved in a trade, which no
   * reconstruction from transactions does. Absent means the sync predates the
   * column, which is "not known" rather than "nothing spent".
   */
  settings?: Record<string, unknown> | null;
}

export interface DraftRecord {
  id: string;
  sleeperDraftId: string;
  leagueId: string;
  status: string;
  type: string;
  season: string;
  rounds: number;
  teams: number;
  /** draft slot (1-based) -> roster id */
  slotToRosterId: Record<string, number>;
  settings: Record<string, unknown>;
  lastSyncedAt: string;
}

export interface DraftPickRecord {
  draftId: string;
  pickNo: number;
  round: number;
  pickInRound: number;
  draftSlot: number;
  sleeperPlayerId: string | null;
  playerId: string | null;
  rosterId: number | null;
  pickedBy: string | null;
  raw: string;
}
