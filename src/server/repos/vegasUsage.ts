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
import { nowIso, type Database } from '../db.ts';

export type UsageSource = 'weekly' | 'season' | 'manual' | 'schedule';
export type UsageOutcome = 'fetched' | 'blocked' | 'failed';

export interface UsageEntry {
  at: string;
  source: UsageSource;
  eventId: string | null;
  entities: number;
  requests: number;
  outcome: UsageOutcome;
  reason: string | null;
}

export class VegasUsageRepo {
  constructor(private readonly db: Database) {}

  async ledger(month = monthOf()): Promise<BudgetLedger> {
    const row = await this.db
      .prepare('SELECT * FROM vegas_usage WHERE month = ?')
      .bind(month)
      .first<Record<string, unknown>>();
    if (!row) return emptyLedger(month);
    return {
      month,
      entities: Number(row['entities'] ?? 0),
      requests: Number(row['requests'] ?? 0),
      providerEntities: row['provider_entities'] == null ? null : Number(row['provider_entities']),
      providerReadAt: row['provider_read_at'] == null ? null : String(row['provider_read_at']),
    };
  }

  /** Where the month stands. The one call the fetch path makes before spending. */
  async view(month = monthOf()): Promise<BudgetView> {
    const stored = await this.db
      .prepare('SELECT provider_limit FROM vegas_usage WHERE month = ?')
      .bind(month)
      .first<{ provider_limit: number | null }>();
    const limit = stored?.provider_limit != null ? Number(stored.provider_limit) : undefined;
    return budgetView(await this.ledger(month), limit);
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
    const month = entry.month ?? monthOf();
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO vegas_usage_log (month, at, source, event_id, entities, requests, outcome, reason)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(month, at, entry.source, entry.eventId ?? null, entry.entities, entry.requests, entry.outcome, entry.reason ?? null)
      .run();

    // A blocked call spent nothing, so it is logged but not counted. Counting it
    // would make the guard tighten itself every time it fired.
    if (entry.outcome === 'blocked') return;

    await this.db
      .prepare(
        `INSERT INTO vegas_usage (month, entities, requests, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(month) DO UPDATE SET
           entities = entities + excluded.entities,
           requests = requests + excluded.requests,
           updated_at = excluded.updated_at`,
      )
      .bind(month, entry.entities, entry.requests, at)
      .run();
  }

  /**
   * Store the provider's own count.
   *
   * Free to read and authoritative — it sees spending this app never made, from
   * a probe or another deployment sharing the key — so it is kept beside our
   * own number rather than replacing it.
   */
  async recordProviderUsage(
    usage: { entities: number | null; limit: number | null },
    month = monthOf(),
  ): Promise<void> {
    if (usage.entities == null) return;
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
      .bind(month, usage.entities, usage.limit, nowIso(), nowIso())
      .run();
  }

  /** The month's most recent activity, newest first. For diagnostics. */
  async recent(limit = 20, month = monthOf()): Promise<UsageEntry[]> {
    const rows = await this.db
      .prepare('SELECT * FROM vegas_usage_log WHERE month = ? ORDER BY at DESC, id DESC LIMIT ?')
      .bind(month, limit)
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

  /** Entities by source this month, so the biggest spender is visible. */
  async bySource(month = monthOf()): Promise<Record<string, number>> {
    const rows = await this.db
      .prepare(
        "SELECT source, SUM(entities) AS entities FROM vegas_usage_log WHERE month = ? AND outcome = 'fetched' GROUP BY source",
      )
      .bind(month)
      .all<{ source: string; entities: number }>();
    const out: Record<string, number> = {};
    for (const r of rows.results) out[String(r.source)] = Number(r.entities ?? 0);
    return out;
  }
}
