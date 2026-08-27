/**
 * The scheduler's own state: what each clock last did.
 *
 * One row per cron expression, overwritten in place — see
 * `migrations/0033_cron_runs.sql` for why this is a current view rather than a
 * ledger, and for why the five-minute injury tick is deliberately not written
 * here at all.
 *
 * Nothing that comes off a wire reaches this table. A step contributes an id, a
 * label, an outcome word from a closed vocabulary, an optional count and a note
 * that has already been through `boundedNote`. That is the entire surface, and
 * it is why this can be read straight into a support snapshot.
 */

import { parseJson, toJson, type Database } from '../db.ts';
import {
  boundedNote,
  runOutcome,
  type RunHealth,
  type RunOutcome,
  type RunStep,
  type StepOutcome,
} from '../../core/health/model.ts';

export interface CronRunRecord {
  cron: string;
  label: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome;
  /** The last run of this clock that was not a total failure. */
  lastSuccessAt: string | null;
  budget: { limit: number; used: number; remaining: number } | null;
  steps: RunStep[];
  releaseSha: string | null;
}

export class CronRunRepo {
  constructor(private readonly db: Database) {}

  /**
   * Write what this invocation did, replacing what the same clock did last time.
   *
   * `last_success_at` is carried forward by the statement rather than by the
   * caller: a failing run must not be able to erase when the clock last worked,
   * and making that the database's job rather than a read-modify-write removes
   * the window where two invocations could race it away.
   */
  async record(run: Omit<CronRunRecord, 'lastSuccessAt'>): Promise<void> {
    const succeeded = run.outcome !== 'failed';
    await this.db
      .prepare(
        `INSERT INTO cron_run_state
           (cron, label, trigger, started_at, finished_at, outcome, last_success_at,
            budget_limit, budget_used, budget_remaining, steps_json, release_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cron) DO UPDATE SET
           label = excluded.label,
           trigger = excluded.trigger,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           outcome = excluded.outcome,
           -- COALESCE so a failed run keeps saying when this clock last worked.
           last_success_at = COALESCE(excluded.last_success_at, cron_run_state.last_success_at),
           budget_limit = excluded.budget_limit,
           budget_used = excluded.budget_used,
           budget_remaining = excluded.budget_remaining,
           steps_json = excluded.steps_json,
           release_sha = excluded.release_sha`,
      )
      .bind(
        run.cron,
        run.label,
        run.trigger,
        run.startedAt,
        run.finishedAt,
        run.outcome,
        succeeded ? (run.finishedAt ?? run.startedAt) : null,
        run.budget?.limit ?? null,
        run.budget?.used ?? null,
        run.budget?.remaining ?? null,
        toJson(run.steps),
        run.releaseSha,
      )
      .run();
  }

  /** Every clock's last run, newest first. A read; never a write. */
  async all(): Promise<CronRunRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM cron_run_state ORDER BY started_at DESC')
      .all<Record<string, unknown>>();
    return rows.results.map(toRecord);
  }

  /** The most recent run of any clock, or null before the first one. */
  async latest(): Promise<CronRunRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM cron_run_state ORDER BY started_at DESC LIMIT 1')
      .first<Record<string, unknown>>();
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: Record<string, unknown>): CronRunRecord {
  const text = (key: string) => (row[key] == null ? null : String(row[key]));
  const number = (key: string) => (row[key] == null ? null : Number(row[key]));
  const limit = number('budget_limit');
  const used = number('budget_used');
  const remaining = number('budget_remaining');
  return {
    cron: String(row['cron']),
    label: String(row['label']),
    trigger: String(row['trigger']) === 'manual' ? 'manual' : 'schedule',
    startedAt: String(row['started_at']),
    finishedAt: text('finished_at'),
    outcome: String(row['outcome'] ?? 'unknown') as RunOutcome,
    lastSuccessAt: text('last_success_at'),
    budget: limit == null || used == null ? null : { limit, used, remaining: remaining ?? Math.max(0, limit - used) },
    steps: parseJson<RunStep[]>(row['steps_json'], []),
    releaseSha: text('release_sha'),
  };
}

/**
 * One invocation, assembling itself as it goes.
 *
 * The shape this takes is the reason `scheduled()` did not have to be
 * rearranged to get a run record. Every feed on the daily tick was already
 * `try`/`catch`-ed on its own — the invariant being that one dead provider must
 * never take down the ten below it — so a step here *is* that try/catch, with
 * the outcome written down instead of discarded. Ordering, priority and the
 * separate-catch rule are all exactly as they were; §8 asks this lane to
 * observe the schedule rather than redesign it.
 *
 * Nothing is written to the database until {@link finish}. A recorder is a few
 * strings in memory, so a run that dies half way through costs one missing
 * update rather than a half-written row claiming eleven steps ran.
 */
export class CronRunRecorder {
  private readonly steps: RunStep[] = [];
  readonly startedAt: string;

  constructor(
    private readonly db: Database,
    private readonly meta: {
      cron: string;
      /** What this clock is called on the screen. */
      label: string;
      releaseSha: string | null;
      now?: () => Date;
    },
  ) {
    this.startedAt = this.now().toISOString();
  }

  private now(): Date {
    return this.meta.now?.() ?? new Date();
  }

  /**
   * Run one feed, and record how it went.
   *
   * The callback returns the step's own outcome so the *feed* decides whether
   * "nothing was written" means it succeeded, is waiting on a source that has
   * not published, or deferred — the three states §3 refuses to collapse. A
   * callback that throws is a failure, is logged exactly as it was before, and
   * does not stop the steps after it.
   */
  async step(
    id: string,
    label: string,
    body: () => Promise<{ outcome: StepOutcome; items?: number | null; note?: string | null } | void>,
  ): Promise<void> {
    try {
      const result = (await body()) ?? { outcome: 'succeeded' as const };
      this.add({
        id,
        label,
        outcome: result.outcome,
        items: result.items ?? null,
        note: boundedNote(result.note ?? null),
      });
    } catch (err) {
      /*
       * The category, not the exception.
       *
       * A message from a failed fetch can carry a URL with a key in it, and this
       * row is read by a support screen and copied into a snapshot. What a
       * reader needs is which step failed and roughly why; what they must never
       * be handed is a provider's own words about a request this app made.
       */
      console.error(`${id} failed`, err);
      this.add({ id, label, outcome: 'failed', items: null, note: errorCategory(err) });
    }
  }

  /** Record a step whose outcome was decided outside a callback. */
  add(step: RunStep): void {
    this.steps.push({ ...step, note: boundedNote(step.note) });
  }

  /** Everything recorded so far, for a caller that wants to log it. */
  get recorded(): readonly RunStep[] {
    return this.steps;
  }

  /**
   * Write the run down.
   *
   * Separately caught by the caller, and it must be: a health record that
   * failed to save is worth a log line and is never worth taking down the tick
   * it was describing.
   */
  async finish(budget: { limit: number; used: number; remaining: number } | null): Promise<CronRunRecord> {
    const outcome = runOutcome(this.steps);
    const record: Omit<CronRunRecord, 'lastSuccessAt'> = {
      cron: this.meta.cron,
      label: this.meta.label,
      trigger: 'schedule',
      startedAt: this.startedAt,
      finishedAt: this.now().toISOString(),
      outcome,
      budget,
      steps: this.steps,
      releaseSha: this.meta.releaseSha,
    };
    await new CronRunRepo(this.db).record(record);
    return { ...record, lastSuccessAt: outcome === 'failed' ? null : record.finishedAt };
  }
}

/**
 * A bounded category for a thrown error, and nothing from its message.
 *
 * Five words, chosen because they are the five distinctions a reader can act
 * on: the source was not there, it refused, it was too slow, we ran out of
 * budget, or something else went wrong. The exception's own text is logged —
 * where the operator can see it and a user cannot — and never stored.
 */
export function errorCategory(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'BudgetExhaustedError') return 'stopped early: refresh budget spent';
  if (/abort|timeout|timed out/i.test(message)) return 'the source did not answer in time';
  if (/\b(404|not found)\b/i.test(message)) return 'the source had nothing published';
  if (/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(message)) return 'the source refused the request';
  if (/\b(5\d\d)\b/.test(message)) return 'the source returned an error';
  return 'the step did not complete';
}

/** Turn a stored record into the health-model shape the API and UI read. */
export function toRunHealth(record: CronRunRecord, describe: (r: CronRunRecord) => string): RunHealth {
  return {
    cron: record.cron,
    label: record.label,
    trigger: record.trigger,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    outcome: record.outcome,
    summary: describe(record),
    budget: record.budget,
    steps: record.steps,
    releaseSha: record.releaseSha,
  };
}
