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
  gsis_id?: string | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
}

export interface SleeperState {
  season: string;
  week: number;
  season_type: string;
  display_week?: number;
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
