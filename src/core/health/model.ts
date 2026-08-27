/**
 * Whether what Junculator knew was healthy and current.
 *
 * Support Snapshot answers *what the app knew* when it made a decision. This
 * answers the question directly beside it: **was what it knew any good?** A
 * recommendation built on a Vegas line from Wednesday, an injury report that
 * has not published for this week, or a manager ledger that yielded its
 * subrequests to the injury check is not a wrong recommendation — it is a
 * correct recommendation about degraded inputs, and the first fork of every
 * diagnosis is telling those two apart.
 *
 * ## Three refusals this model is built on
 *
 * **`not_published` is never a failure.** The NFL publishes a week's injury
 * report when it publishes it; nflverse publishes a season's snap file when the
 * games have been played. A source that has correctly nothing to say is
 * `waiting`, and calling that a fault would train a reader to ignore the one
 * word that means somebody has to do something.
 *
 * **Last attempt is not last success.** The pair is the whole reason a
 * five-minute injury check can look perfectly healthy while four consecutive
 * ingests have died — `checkedAt` moves every tick and `ingestedAt` has not
 * moved since Tuesday. Every source here carries both, and the state is derived
 * from whichever one the source's own policy says is the real question.
 *
 * **Unknown stays unknown.** A source nothing has ever recorded a timestamp for
 * is `unknown`, not `current` and not `missing`. Turning an absence of
 * measurement into a measurement is exactly the flattening that makes a health
 * screen worth less than no health screen.
 *
 * ## What is *not* here
 *
 * No history, no charts, no alerting, no counters this app cannot honestly
 * measure. A current view, a last attempt, a last success and the most recent
 * scheduled run is the whole surface — see the brief's §14. Everything below is
 * derived from state the shipped pipelines already record.
 */

/**
 * What one recommendation-driving source is currently worth.
 *
 * Six words, and the distinctions between them are the point:
 *
 *   - `current` — inside this source's own freshness window;
 *   - `stale` — past it, still usable, and the age is worth knowing;
 *   - `waiting` — the source has legitimately not published. Not a fault;
 *   - `degraded` — present but reduced: a fallback is standing in, or coverage
 *     came back thin;
 *   - `missing` — the pipeline should have something and has nothing;
 *   - `deferred` — work that was intentionally yielded, not work that failed;
 *   - `unknown` — nothing has ever been recorded. Never inferred to anything.
 */
export type SourceState = 'current' | 'stale' | 'waiting' | 'degraded' | 'missing' | 'deferred' | 'unknown';

/**
 * The one word at the top of the screen, in the user's language.
 *
 * Deliberately the five §3 concepts and not a severity number: `Healthy`,
 * `Waiting on source`, `Some data stale`, `Degraded`, `Refresh problem`, plus
 * `unknown` for a deployment nothing has run on yet.
 */
export type OverallState = 'healthy' | 'waiting' | 'stale' | 'degraded' | 'problem' | 'unknown';

/**
 * How much a source being wrong actually costs a recommendation.
 *
 * Severity is about *decision impact*, not about how loudly a pipeline failed.
 * A missing injury report on Sunday morning changes who starts; a manager
 * ledger three days behind changes a `Next%` by a point or two. Collapsing the
 * two into one "unhealthy" is what makes a status screen ignorable.
 */
export type Severity = 'critical' | 'important' | 'background';

/**
 * How a scheduled invocation ended.
 *
 * `partial` is the honest common case and the reason this is not a boolean: the
 * daily tick runs eleven separately-caught feeds, and one of them failing while
 * ten succeeded is neither a success nor a failure.
 */
export type RunOutcome = 'succeeded' | 'partial' | 'deferred' | 'failed' | 'running' | 'unknown';

/**
 * How one step of a scheduled run ended.
 *
 * `not_published` and `deferred` are separate from `failed` for the reason the
 * whole model exists: one is a source with nothing to say, one is this app
 * choosing to spend its budget elsewhere, and neither is a fault.
 */
export type StepOutcome = 'succeeded' | 'not_published' | 'deferred' | 'skipped' | 'failed';

/**
 * Which timestamp actually answers "is this current?" for a given source.
 *
 * The distinction is not cosmetic. A finished week's snap counts never change
 * again, so ageing them against the clock would report every October Tuesday as
 * five days stale for ever; what matters there is whether the pipeline still
 * *asks*. A betting line is the opposite: nobody cares that we asked eleven
 * minutes ago if the answer we are holding is from Thursday.
 */
export type FreshnessMeasure =
  /** Age of the data itself, from the last time something was actually stored. */
  | 'data'
  /** Age of the last attempt, because the data legitimately does not move. */
  | 'attempt';

/** Bounded technical facts, shown only behind Technical details. */
export interface SourceTechnical {
  /** The pipeline's own canonical outcome word, verbatim. Never invented here. */
  lastOutcome: string | null;
  /** Ingests that started and did not finish, in a row. */
  consecutiveFailures: number;
  failingSince: string | null;
  /**
   * One short bounded phrase from the pipeline, already written for a person.
   *
   * Truncated on the way in — see {@link boundedNote}. Never a raw exception, a
   * stack, a URL, a payload or anything from `env`.
   */
  note: string | null;
}

/** One recommendation-driving input, and what it is currently worth. */
export interface SourceHealth {
  id: string;
  /** What the user calls it: `Injuries`, `Vegas lines`, `Manager tendencies`. */
  label: string;
  severity: Severity;
  state: SourceState;
  /**
   * The two timestamps, kept apart, for every source alike.
   *
   * `lastSuccessAt` is the last time this app actually learned something.
   * `lastAttemptAt` is the last time it asked. A source where the first is days
   * behind the second is the exact state a single "updated N ago" would hide.
   */
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** Age of whichever timestamp this source's policy measures, in minutes. */
  ageMinutes: number | null;
  measure: FreshnessMeasure;
  /** How often this source is expected to move, in the user's words. */
  cadence: string;
  /** The window this source is `current` inside, in minutes. Null where none applies. */
  freshWithinMinutes: number | null;
  /** One plain sentence, shown only when the state is not `current`. */
  note: string | null;
  technical: SourceTechnical;
}

/** One step of a scheduled run, as the run ledger recorded it. */
export interface RunStep {
  id: string;
  label: string;
  outcome: StepOutcome;
  /** Rows, weeks or items this step actually stored, where the step counts them. */
  items: number | null;
  note: string | null;
}

/**
 * What the last scheduled invocation did.
 *
 * Every field here is measured rather than inferred. The budget numbers come
 * from `RequestBudget.snapshot()`, which counts at the transport and therefore
 * counts retries and redirect hops — so `used/limit` is what actually went out,
 * not what somebody expected to go out. A tick with no budget to report (the
 * five-minute injury check, which has no ceiling to defend) reports `null`
 * rather than a zero that would read as "spent nothing".
 */
export interface RunHealth {
  /** The cron expression Cloudflare fired, verbatim. */
  cron: string;
  /** Which of the three clocks this was, in the user's words. */
  label: string;
  /** `schedule` today. The field exists so a manual run could never be mistaken for one. */
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome;
  /** One plain sentence about the whole run. */
  summary: string;
  budget: { limit: number; used: number; remaining: number } | null;
  steps: RunStep[];
  /** The revision the run executed on, when the deployment injected one. */
  releaseSha: string | null;
}

/** The whole read-only view, as `GET /api/data-health` returns it. */
export interface DataHealthView {
  /** When this view was assembled. Not a refresh — nothing was fetched. */
  generatedAt: string;
  overall: {
    state: OverallState;
    /** `Healthy`, `2 inputs need attention` — the Setup row's own words. */
    headline: string;
    /** The most recent successful update across every source. */
    refreshedAt: string | null;
    /** How many sources are in a state somebody should look at. */
    needsAttention: number;
  };
  sources: SourceHealth[];
  /** The most recent scheduled run, or null where none has been recorded yet. */
  lastRun: RunHealth | null;
  /** Which revision is answering. The same string `/api/health` reports. */
  release: { gitSha: string };
}

// --------------------------------------------------------------- derivation

/**
 * The states a reader is being asked to do something about.
 *
 * `waiting` is not one of them, which is the §3 rule stated as code: a source
 * that has legitimately not published is a fact, not a task. `deferred` is not
 * one either — deferring background work to protect a lineup feed is the budget
 * strategy working, not failing.
 */
export function needsAttention(source: SourceHealth): boolean {
  if (source.state === 'missing' || source.state === 'degraded') return true;
  /*
   * Stale counts only where staleness can actually move a recommendation.
   *
   * A background source past its window is exactly what `background` means:
   * manager tendencies from four days ago nudge a `Next%` and nothing else, and
   * putting that on the same row as a missing injury report is how a screen
   * teaches people to ignore it.
   */
  if (source.state === 'stale') return source.severity !== 'background';
  return false;
}

/**
 * The one word at the top, from the sources below it.
 *
 * Order matters and is the severity order, not the alphabet: a refresh problem
 * outranks degradation, degradation outranks staleness, and waiting is only
 * ever the headline when nothing worse is true.
 */
export function overallState(sources: readonly SourceHealth[], lastRun: RunHealth | null): OverallState {
  if (sources.length === 0) return 'unknown';

  /*
   * A failed run is a refresh problem even when every source still reads
   * current, and that is the case worth catching: the data is fine *today*
   * because it was fetched yesterday, and nobody would know the pipeline had
   * stopped until it was old enough to matter.
   */
  if (lastRun?.outcome === 'failed') return 'problem';
  /*
   * A critical source that is missing or degraded is a refresh problem, not a
   * degradation, and the difference is what the reader is being asked to do.
   * `Degraded` says the app is working with less; `Refresh problem` says
   * something has stopped and somebody should look. An injury feed whose
   * ingests are dying is the second, whatever the rest of the screen says.
   */
  if (sources.some((s) => s.severity === 'critical' && (s.state === 'missing' || s.state === 'degraded'))) {
    return 'problem';
  }
  if (sources.some((s) => s.state === 'degraded' || s.state === 'missing')) return 'degraded';
  if (sources.some((s) => needsAttention(s))) return 'stale';
  if (sources.some((s) => s.state === 'waiting')) return 'waiting';
  if (sources.every((s) => s.state === 'unknown')) return 'unknown';
  return 'healthy';
}

/** The five §3 concepts, spelled the way the screen says them. */
export const OVERALL_LABELS: Record<OverallState, string> = {
  healthy: 'Healthy',
  waiting: 'Waiting on source',
  stale: 'Some data stale',
  degraded: 'Degraded',
  problem: 'Refresh problem',
  unknown: 'Not known yet',
};

/** What each source state is called on a row. */
export const SOURCE_LABELS: Record<SourceState, string> = {
  current: 'Current',
  stale: 'Stale',
  waiting: 'Waiting on source',
  degraded: 'Degraded',
  missing: 'Missing',
  deferred: 'Deferred',
  unknown: 'Not known',
};

/**
 * The sentence on the Setup row.
 *
 * `Healthy · refreshed 18 min ago` when there is nothing to do, and the count
 * when there is — because a row that reads `2 inputs need attention` is already
 * the whole announcement, and a badge beside it would be the same fact twice.
 */
export function headline(state: OverallState, attention: number, refreshedAt: string | null, now: Date): string {
  if (attention > 0) {
    return `${attention} input${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention`;
  }
  const age = refreshedAt == null ? null : describeAge(minutesSince(refreshedAt, now));
  return age == null ? OVERALL_LABELS[state] : `${OVERALL_LABELS[state]} · refreshed ${age}`;
}

/** Whole minutes between an ISO instant and now, or null when it is not one. */
export function minutesSince(at: string | null, now: Date): number | null {
  if (at == null) return null;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 60_000));
}

/**
 * An age a person can read, at the resolution they care about.
 *
 * Minutes under an hour because "refreshed 18 min ago" is the whole point of
 * the Setup row; hours to a day; days beyond that. No `about`, no `~`, and no
 * seconds — a health screen that says `refreshed 41 seconds ago` is reporting
 * on itself rather than on the data.
 */
export function describeAge(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The right-hand side of a source row: `Current · 2h ago`, `Waiting on source`.
 *
 * The age is appended only where there is one and where it means something. A
 * source that is waiting has no age worth printing — the whole statement is
 * that nothing has been published — and appending one would invite a reader to
 * treat an absence as an old value.
 */
export function describeSource(source: SourceHealth): string {
  const word = SOURCE_LABELS[source.state];
  if (source.state === 'waiting' || source.state === 'unknown') return word;
  if (source.state === 'deferred') return `${word} · background`;
  const age = describeAge(source.ageMinutes);
  return age == null ? word : `${word} · ${age}`;
}

/**
 * The pipelines' own outcome word, in this model's vocabulary.
 *
 * `ok | not_published | failed` is the canonical triple the injury, usage,
 * schedule and nflverse ingests have recorded since long before this lane
 * existed, and §3 asks that it be preserved rather than replaced. This is the
 * one place the translation happens, so a fourth pipeline adopting the same
 * triple gets the same reading for free — and so that `not_published` can never
 * be quietly rounded to a failure on the way to a screen.
 */
export function stepOutcomeFrom(pipelineOutcome: string | null | undefined): StepOutcome {
  switch (pipelineOutcome) {
    case 'ok':
    case 'not_modified':
      return 'succeeded';
    case 'not_published':
      return 'not_published';
    case 'skipped':
    case 'blocked':
      return 'skipped';
    case 'failed':
    case 'ingest_failed':
      return 'failed';
    default:
      return 'succeeded';
  }
}

/**
 * Truncate a pipeline's own note to something a screen can carry.
 *
 * Notes come from shipped services and are already written for a person, but
 * "already written for a person" is a convention rather than a guarantee — and
 * this document is handed to support. A hard ceiling here is what stops a
 * future note carrying a URL, a query or a paragraph of provider prose into a
 * snapshot. Nothing is *interpreted*: it is the pipeline's sentence, shortened.
 */
export const MAX_NOTE_CHARS = 160;

export function boundedNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  return trimmed.length <= MAX_NOTE_CHARS ? trimmed : `${trimmed.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

/**
 * How a run ended, from the steps it recorded.
 *
 * Derived rather than declared, so a run cannot report success while carrying a
 * failed step. `deferred` outranks `succeeded` and is outranked by everything
 * else: a tick that did all its work and then yielded the manager backfill is
 * not a partial success, it is the budget strategy working, and saying
 * `succeeded` about it would hide the one thing somebody looking at a thin
 * `Next%` needs to see.
 */
export function runOutcome(steps: readonly RunStep[]): RunOutcome {
  if (steps.length === 0) return 'unknown';
  const failed = steps.filter((s) => s.outcome === 'failed').length;
  if (failed === steps.length) return 'failed';
  if (failed > 0) return 'partial';
  if (steps.some((s) => s.outcome === 'deferred')) return 'deferred';
  return 'succeeded';
}

/**
 * One sentence about a whole run, in plain language.
 *
 * The §7 rule lives here: a deferred step is described as a deliberate
 * reservation of budget, never as a generic failure. `Manager intelligence
 * deferred — refresh budget reserved for higher-priority data` is the sentence
 * that stops somebody diagnosing a working system.
 */
export function describeRun(run: Omit<RunHealth, 'summary' | 'outcome'> & { outcome: RunOutcome }): string {
  const failed = run.steps.filter((s) => s.outcome === 'failed');
  const deferred = run.steps.filter((s) => s.outcome === 'deferred');
  const waiting = run.steps.filter((s) => s.outcome === 'not_published');

  const parts: string[] = [];
  if (run.outcome === 'failed') parts.push('Nothing on this run completed.');
  else if (failed.length > 0) {
    parts.push(`${failed.length} of ${run.steps.length} did not complete: ${failed.map((s) => s.label).join(', ')}.`);
  } else {
    parts.push(`All ${run.steps.length} completed.`);
  }
  if (deferred.length > 0) {
    parts.push(
      `${deferred.map((s) => s.label).join(', ')} deferred — refresh budget reserved for higher-priority data.`,
    );
  }
  if (waiting.length > 0) {
    parts.push(`${waiting.map((s) => s.label).join(', ')} waiting on the source to publish.`);
  }
  return parts.join(' ');
}
