/** Canonical player identity types shared by every data source. */

export type MatchMethod =
  | 'external_id'
  | 'name_team'
  | 'name_position'
  | 'alias'
  | 'name_unique'
  | 'fuzzy'
  | 'anaphora';

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';

/** A canonical player row, as materialised from the Sleeper player sync. */
export interface CanonicalPlayer {
  id: string;
  sleeperPlayerId: string | null;
  fullName: string;
  firstName: string;
  lastName: string;
  team: string;
  position: string;
  status: string | null;
  active: boolean;
  normalizedName: string;
  aliases: string[];
  /** Non-Sleeper external ids, keyed by source (e.g. `gsis`, `odds:the-odds-api`). */
  externalIds?: Record<string, string>;
  /**
   * Sleeper's `search_rank`: how prominently it surfaces a player in search.
   *
   * NOT a draft position, and it must never be used as one. It puts Drake Maye
   * around 7 and ranks long-retired players highly, because it measures who
   * people look up rather than who gets picked. Kept only as a weak tie-break
   * for search results.
   */
  searchRank?: number | null;
  /**
   * Completed NFL seasons, from Sleeper's `years_exp`.
   *
   * Null means the dictionary did not say, which is not the same as zero — a
   * rookie and an unknown are different answers and only one of them belongs in
   * a "does this manager chase rookies" sample.
   */
  yearsExp?: number | null;
}

export interface PlayerAlias {
  playerId: string;
  alias: string;
  normalizedAlias: string;
  source: string;
  confidence: number;
}

/** A candidate produced during matching, ranked best-first. */
export interface MatchCandidate {
  playerId: string;
  player: CanonicalPlayer;
  method: MatchMethod;
  confidence: number;
  /** Short human-readable justification, surfaced in the review UI. */
  detail: string;
  /** Only set for fuzzy candidates. */
  editDistance?: number;
}

export interface MatchQuery {
  /** Raw display name as it appeared in the source. */
  name: string;
  team?: string | null;
  position?: string | null;
  /** External ids keyed by source name, e.g. `{ sleeper: '4046' }`. */
  externalIds?: Record<string, string | null | undefined>;
  /**
   * Players already resolved earlier in the same document, used to resolve
   * surname-only anaphora ("Achane ... he"). Best-first.
   */
  documentContext?: string[];
}

export interface MatchResult {
  status: MatchStatus;
  /** Only set when `status === 'matched'`. */
  playerId: string | null;
  method: MatchMethod | null;
  confidence: number;
  /** All candidates considered, ranked. Always populated for `ambiguous`. */
  candidates: MatchCandidate[];
  /** Machine-readable explanation, shown verbatim in the review queue. */
  reason: string;
}
