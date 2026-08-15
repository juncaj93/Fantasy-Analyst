/**
 * What was recommended, under which version of the model, on what information.
 *
 * A tool that grades itself needs three things a tool that only recommends does
 * not: a record written **before** the games, a version number attached to it,
 * and a rule that the record can never be edited afterwards. This file is those
 * three things and nothing else — no scoring, no judgement, no report.
 *
 * ## Why the version is on every row
 *
 * "The model went 6–4 this month" means nothing if the model changed in week
 * three. Every recommendation carries the version that produced it, so a grade
 * is always a grade *of something specific*, and a change to the weights
 * partitions the history rather than quietly rewriting it. That is also the
 * mechanism behind the brief's hardest instruction — do not silently rewrite
 * core weights from one week — because a weight change that does not bump the
 * version is visibly a bug in this scheme, not a judgement call.
 *
 * ## No lookahead, enforced rather than promised
 *
 * A record's whole value is that it contains only what was knowable when the
 * decision was made. `decidedAt` is the moment, every source carries its own
 * `observedAt`, and {@link lookaheadViolations} checks that none of them is
 * later. A grading pipeline that has ever read a post-kickoff number is a
 * pipeline that says the model is excellent, and this is the cheapest possible
 * way to keep that from happening by accident.
 */

import type { StartSitMode } from '../startsit/mode.ts';

/**
 * The version of the decision model.
 *
 * Bumped whenever a weight, threshold or component that can change a
 * recommendation changes. The minor number is a retune; the major is a change
 * in what the components *are*. `notes` is what a person reads on the grading
 * screen when two versions appear in one season.
 */
export const MODEL_VERSION = '1.0.0';

export const MODEL_VERSION_NOTES: Record<string, string> = {
  '1.0.0':
    'Market expectation, news, availability, opportunity, role trend, touchdown dependency, game script, weather and role matchup, with Floor/Balanced/Ceiling reweighting.',
};

/** Recommendation kinds the ledger can hold. */
export type RecommendationKind = 'start_sit' | 'lineup' | 'waiver' | 'trade';

/** One component's contribution, as it stood at decision time. */
export interface RecordedComponent {
  key: string;
  value: number;
  unknown: boolean;
}

export interface RecordedPlayer {
  playerId: string;
  name: string;
  position: string;
  /** The model's score at decision time. */
  score: number | null;
  /** The market's own number, kept separately so the two can be graded apart. */
  marketPoints: number | null;
  components: RecordedComponent[];
}

/** Where a number came from, and how old it was when it was used. */
export interface RecordedSource {
  key: string;
  state: 'fresh' | 'stale' | 'missing';
  /** When the source itself was observed. Null for a source that was missing. */
  observedAt: string | null;
  ageMinutes: number | null;
}

export interface RecommendationRecord {
  id: string;
  season: string;
  week: number;
  kind: RecommendationKind;
  /** The version of the model that produced it. Never rewritten. */
  modelVersion: string;
  /** When the recommendation was made. Everything in the row predates this. */
  decidedAt: string;
  mode: StartSitMode;
  chosen: RecordedPlayer;
  /** Everyone else who was considered for the same slot. */
  alternatives: RecordedPlayer[];
  margin: number | null;
  confidence: 'high' | 'medium' | 'low';
  drivers: string[];
  sources: RecordedSource[];
}

/** What actually happened, written after the games. */
export interface PlayerOutcome {
  playerId: string;
  /** Fantasy points scored, under the league's own scoring. */
  actualPoints: number | null;
  /**
   * Expected points from the opportunity he actually got.
   *
   * The most important field here, and the reason the grading is not a box
   * score: it separates "he got the ball a lot" from "he scored a lot", which
   * is the whole of the difference between a good decision and a good result.
   */
  xfp: number | null;
  touchdowns: number | null;
  /** True when he did not play at all. */
  inactive: boolean;
}

export interface RecordOutcome {
  recordId: string;
  /** Keyed by player id, covering the chosen player and every alternative. */
  players: PlayerOutcome[];
  /** When the last of the relevant games finished. */
  settledAt: string;
}

/**
 * Every place a record contains information from after the decision.
 *
 * Returns descriptions rather than throwing: a violation is a data-quality
 * finding for the grading screen, and a grading run that crashed would simply
 * hide it. An empty array is the only acceptable steady state, and the test
 * suite asserts it for the fixtures the app builds itself.
 */
export function lookaheadViolations(record: RecommendationRecord): string[] {
  const decided = Date.parse(record.decidedAt);
  const out: string[] = [];
  if (!Number.isFinite(decided)) return [`decidedAt is not a usable timestamp: ${record.decidedAt}`];

  for (const source of record.sources) {
    if (!source.observedAt) continue;
    const observed = Date.parse(source.observedAt);
    if (!Number.isFinite(observed)) {
      out.push(`source ${source.key} has an unusable observedAt`);
      continue;
    }
    if (observed > decided) {
      out.push(`source ${source.key} was observed after the decision was recorded`);
    }
  }
  return out;
}

/** True when this record was produced by the model as it stands today. */
export function isCurrentVersion(record: RecommendationRecord): boolean {
  return record.modelVersion === MODEL_VERSION;
}
