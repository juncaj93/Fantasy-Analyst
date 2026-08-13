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
