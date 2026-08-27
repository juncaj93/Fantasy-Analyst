/**
 * The health view, reduced to what a support snapshot should carry.
 *
 * One function, and it exists so that "what goes in the file" is a decision
 * made once rather than by six capture adapters. §11 asks for decision-relevant
 * health facts and explicitly not for bloat, so this is a projection down —
 * never a second measurement, and never anything the full view does not already
 * say.
 *
 * ## What is dropped, and why
 *
 * The cadence sentences, the impact sentences and the technical block. All
 * three are for a person standing in front of the Data Health screen deciding
 * what to do next; none of them is a fact about the decision in the file. An
 * agent reading a snapshot wants six words per source and the run's deferrals,
 * and everything past that is a couple of kilobytes it has to skim.
 *
 * The run's steps are dropped for the same reason, except for the two lists
 * that answer questions: what deferred, and what failed.
 */

import type { DataHealthView } from './model.ts';
import type { SnapshotDataHealth } from '../support/schema.ts';

export function toSnapshotHealth(view: DataHealthView): SnapshotDataHealth {
  return {
    state: view.overall.state,
    refreshedAt: view.overall.refreshedAt,
    sources: view.sources.map((source) => ({
      id: source.id,
      label: source.label,
      state: source.state,
      severity: source.severity,
      ageMinutes: source.ageMinutes,
    })),
    lastRun:
      view.lastRun == null
        ? null
        : {
            label: view.lastRun.label,
            startedAt: view.lastRun.startedAt,
            outcome: view.lastRun.outcome,
            deferred: view.lastRun.steps.filter((s) => s.outcome === 'deferred').map((s) => s.label),
            failed: view.lastRun.steps.filter((s) => s.outcome === 'failed').map((s) => s.label),
          },
  };
}
