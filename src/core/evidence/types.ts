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
  last21: SignalWindow;
  seasonToDate: SignalWindow;
  categoryBreakdown: Record<string, { positive: number; negative: number; items: number }>;
  /** Items awaiting review; excluded from every window above. */
  pendingCount: number;
  mixedCount: number;
  lastEvidenceAt: string | null;
  updatedAt: string;
}
