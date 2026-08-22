/** Evidence ledger types. The ledger is the source of truth; tallies are derived. */

import type { Confidence } from '../newsletter/classify.ts';
import type { EvidenceCategory, Polarity } from '../newsletter/rules.ts';

export type ReviewStatus =
  | 'auto_applied'
  | 'pending'
  | 'accepted'
  | 'corrected'
  | 'rejected'
  | 'ignored';

export interface EvidenceItem {
  id: string;
  playerId: string;
  sourceType: string;
  sourceName: string;
  sourceMessageId: string | null;
  /** ISO date of the source material, NOT of ingestion. */
  sourceDate: string;
  excerpt: string;
  contextSummary: string | null;
  category: EvidenceCategory | string | null;
  polarity: Polarity;
  magnitude: number;
  confidence: Confidence | string;
  confidenceScore: number;
  ruleId: string | null;
  reviewStatus: ReviewStatus;
  /**
   * User-authored correction. When present it wins over the classifier for
   * every field it specifies, and reprocessing must never overwrite it.
   */
  userOverride: EvidenceOverride | null;
  dedupeKey: string;
  createdAt: string;
}

export interface EvidenceOverride {
  polarity?: Polarity;
  magnitude?: number;
  category?: string;
  playerId?: string;
  note?: string;
}

/** The values that actually count, after applying any user override. */
export interface EffectiveEvidence {
  playerId: string;
  polarity: Polarity;
  magnitude: number;
  category: string | null;
  sourceDate: string;
  /** Signed contribution to the tally. */
  delta: number;
  counted: boolean;
  /**
   * Does this row describe a *period* rather than a moment?
   *
   * A backfilled running tally covers several earlier issues and is carried
   * across as one item, so its `sourceDate` is when the summary was imported,
   * not when the news happened. The distinction matters only to windows short
   * enough that the difference is provable — see `aggregate.ts`.
   */
  spansPriorIssues: boolean;
}

export interface SignalWindow {
  positive: number;
  negative: number;
  net: number;
  /** Count of evidence items, independent of magnitude. */
  items: number;
}

export interface PlayerSignal {
  playerId: string;
  raw: SignalWindow;
  last7: SignalWindow;
  last30: SignalWindow;
  seasonToDate: SignalWindow;
  categoryBreakdown: Record<string, { positive: number; negative: number; items: number }>;
  /** Items awaiting review; excluded from every window above. */
  pendingCount: number;
  /**
   * Counted items that carry a period rather than a moment.
   *
   * Lets a reader tell "no news this week" from "his whole record is a carried
   * tally, so this week has nothing to say about him" — two very different
   * statements that a bare `last7.net` of zero would otherwise collapse.
   */
  carriedOverItems: number;
  mixedCount: number;
  lastEvidenceAt: string | null;
  updatedAt: string;
}
