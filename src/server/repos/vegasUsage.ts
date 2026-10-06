/**
 * The Vegas spending ledger.
 *
 * Two things live here: the month's running total, which the budget gate reads
 * before every provider call, and a line per fetch saying what asked for it.
 * The second is what makes "where did the month go" answerable — a total alone
 * can only ever say that it went.
 *
 * Spending is recorded even when it was refused, because a refusal is the most
 * interesting row in the table: it is the moment the guard did its job.
 */

import { budgetView, emptyLedger, monthOf, type BudgetLedger, type BudgetView } from '../../core/vegas/budget.ts';
import { billingPeriodOf, type BillingPeriod } from '../../core/vegas/billingPeriod.ts';
import { nowIso, type Database } from '../db.ts';

export type UsageSource = 'weekly' | 'season' | 'manual' | 'schedule';
/**
 * `refused` is the provider (or this app's pacer) saying "not now": a `429`.
 * Logged, and not counted — the provider's own counter did not move across the
 * nine refusals of 24 September 2026, while this ledger booked each as spent
 * and drifted 54 ahead of it by the end of that morning.
 */
export type UsageOutcome = 'fetched' | 'blocked' | 'failed' | 'refused';

export interface UsageEntry {
  at: string;
  source: UsageSource;
  eventId: string | null;
  entities: number;
  requests: number;
  outcome: UsageOutcome;
  reason: string | null;
}

/**
 * The log's month labels a period can have rows under.
 *
 * A log row is filed under the calendar month it was written in, because that is
 * what the log's index is on, and a billing period starting on the 13th spans
 * two of them. Naming both lets the read use the index and then cut by instant.
 */
function logMonths(period: BillingPeriod): [string, string] {
  return [monthOf(period.startMs), monthOf(period.endMs - 1)];
}

/** What a row of the log counts toward the month: everything except a refusal. */
const COUNTED = "outcome NOT IN ('blocked', 'refused')";

export class VegasUsageRepo {
  constructor(private readonly db: Database) {}

  /**
   * What this app spent in the billing period `now` falls in, from the log.
   *
   * **Derived from the log by date and never stored per period**, which is what
   * makes the reset day a single setting: change `BILLING_RESET_DAY` and this is
   * a different number on the next read, with nothing to migrate. It is also what
   * the fallback is when the provider's own count cannot be read, so it counts
   * from the same day as the provider is assumed to, and does not drop to zero
   * on the 1st the way a calendar-month figure did (72 against the provider's
   * 352 on 6 October 2026).
   *
   * The provider's own reading is the newest one taken *inside* the period. One
   * taken before the period began described the last period and is not believed,
   * which is also what keeps a stale reading from carrying over a reset.
   */
  async ledger(now: Date | number = Date.now()): Promise<BudgetLedger> {
    const period = billingPeriodOf(now);
    const [first, second] = logMonths(period);
    const [sums, reading] = await Promise.all([
      this.db
        .prepare(
          `SELECT COALESCE(SUM(entities), 0) AS entities, COALESCE(SUM(requests), 0) AS requests
             FROM vegas_usage_log
            WHERE month IN (?, ?) AND at >= ? AND at < ? AND ${COUNTED}`,
        )
        .bind(first, second, period.start, period.end)
        .first<Record<string, unknown>>(),
      this.providerReading(period),
    ]);
    return {
      ...emptyLedger(period.key),
      entities: Number(sums?.['entities'] ?? 0),
      requests: Number(sums?.['requests'] ?? 0),
      providerEntities: reading?.entities ?? null,
      providerReadAt: reading?.readAt ?? null,
    };
  }

  /** The newest provider reading taken inside the period, with the ceiling it reported. */
  private async providerReading(
    period: BillingPeriod,
  ): Promise<{ entities: number; readAt: string; limit: number | null } | null> {
    const row = await this.db
      .prepare(
        `SELECT provider_entities, provider_limit, provider_read_at
           FROM vegas_usage
          WHERE provider_entities IS NOT NULL AND provider_read_at >= ? AND provider_read_at < ?
          ORDER BY provider_read_at DESC LIMIT 1`,
      )
      .bind(period.start, period.end)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      entities: Number(row['provider_entities']),
      readAt: String(row['provider_read_at']),
      limit: row['provider_limit'] == null ? null : Number(row['provider_limit']),
    };
  }

  /** Where the period stands. The one call the fetch path makes before spending. */
  async view(now: Date | number = Date.now()): Promise<BudgetView> {
    const period = billingPeriodOf(now);
    const [ledger, reading] = await Promise.all([this.ledger(now), this.providerReading(period)]);
    return budgetView(ledger, reading?.limit ?? undefined);
  }

  /** Add what a fetch cost, and say what it was for. */
  async record(entry: {
    source: UsageSource;
    eventId?: string | null;
    entities: number;
    requests: number;
    outcome: UsageOutcome;
    reason?: string | null;
    month?: string;
  }): Promise<void> {
    // The log's own label is the calendar month the row is written in.
    const month = entry.month ?? monthOf();
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO vegas_usage_log (month, at, source, event_id, entities, requests, outcome, reason)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(month, at, entry.source, entry.eventId ?? null, entry.entities, entry.requests, entry.outcome, entry.reason ?? null)
      .run();

    // A blocked or refused call spent nothing, so it is logged but not counted.
    // Counting it would make the guard tighten itself every time it fired.
    if (entry.outcome === 'blocked' || entry.outcome === 'refused') return;

    /*
     * The running total, kept for the probes that print it and under the period's
     * key. Nothing reads it back: the gate reads the log, so this cannot drift
     * the budget, and a changed reset day cannot strand it.
     */
    await this.db
      .prepare(
        `INSERT INTO vegas_usage (month, entities, requests, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(month) DO UPDATE SET
           entities = entities + excluded.entities,
           requests = requests + excluded.requests,
           updated_at = excluded.updated_at`,
      )
      .bind(billingPeriodOf().key, entry.entities, entry.requests, at)
      .run();
  }

  /**
   * Store the provider's own count.
   *
   * Free to read and authoritative — it sees spending this app never made, from
   * a probe or another deployment sharing the key — so it is kept beside our
   * own number rather than replacing it. Filed under the period it was read in,
   * and only believed while that period lasts.
   */
  async recordProviderUsage(
    usage: { entities: number | null; limit: number | null },
    now: Date | number = Date.now(),
  ): Promise<void> {
    if (usage.entities == null) return;
    const key = billingPeriodOf(now).key;
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO vegas_usage (month, entities, requests, provider_entities, provider_limit, provider_read_at, updated_at)
         VALUES (?,0,0,?,?,?,?)
         ON CONFLICT(month) DO UPDATE SET
           provider_entities = excluded.provider_entities,
           provider_limit = COALESCE(excluded.provider_limit, vegas_usage.provider_limit),
           provider_read_at = excluded.provider_read_at,
           updated_at = excluded.updated_at`,
      )
      .bind(key, usage.entities, usage.limit, at, at)
      .run();
  }

  /** The period's most recent activity, newest first. For diagnostics. */
  async recent(limit = 20, now: Date | number = Date.now()): Promise<UsageEntry[]> {
    const period = billingPeriodOf(now);
    const [first, second] = logMonths(period);
    const rows = await this.db
      .prepare(
        'SELECT * FROM vegas_usage_log WHERE month IN (?, ?) AND at >= ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?',
      )
      .bind(first, second, period.start, period.end, limit)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      at: String(r['at']),
      source: String(r['source']) as UsageSource,
      eventId: r['event_id'] == null ? null : String(r['event_id']),
      entities: Number(r['entities'] ?? 0),
      requests: Number(r['requests'] ?? 0),
      outcome: String(r['outcome']) as UsageOutcome,
      reason: r['reason'] == null ? null : String(r['reason']),
    }));
  }

  /** Entities by source this period, so the biggest spender is visible. */
  async bySource(now: Date | number = Date.now()): Promise<Record<string, number>> {
    const period = billingPeriodOf(now);
    const [first, second] = logMonths(period);
    const rows = await this.db
      .prepare(
        "SELECT source, SUM(entities) AS entities FROM vegas_usage_log WHERE month IN (?, ?) AND at >= ? AND at < ? AND outcome = 'fetched' GROUP BY source",
      )
      .bind(first, second, period.start, period.end)
      .all<{ source: string; entities: number }>();
    const out: Record<string, number> = {};
    for (const r of rows.results) out[String(r.source)] = Number(r.entities ?? 0);
    return out;
  }
}
