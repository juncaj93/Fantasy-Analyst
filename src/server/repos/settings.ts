/** Key/value settings + sync log. */

import { nowIso, parseJson, toJson, type Database } from '../db.ts';

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value_json: string }>();
    if (!row) return fallback;
    return parseJson<T>(row.value_json, fallback);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(key, toJson(value), nowIso())
      .run();
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.prepare('SELECT key, value_json FROM settings').all<{ key: string; value_json: string }>();
    const out: Record<string, unknown> = {};
    for (const r of rows.results) out[r.key] = parseJson<unknown>(r.value_json, null);
    return out;
  }

  async logSync(kind: string, status: 'ok' | 'error', detail: string, startedAt: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO sync_log (kind, status, detail, started_at, finished_at) VALUES (?,?,?,?,?)')
      .bind(kind, status, detail, startedAt, nowIso())
      .run();
  }

  async lastSync(kind: string): Promise<{ status: string; detail: string; finishedAt: string } | null> {
    const row = await this.db
      .prepare('SELECT status, detail, finished_at FROM sync_log WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .bind(kind)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      status: String(row['status']),
      detail: String(row['detail'] ?? ''),
      finishedAt: String(row['finished_at'] ?? ''),
    };
  }
}

/** Setting keys used across the app. */
export const SETTING_KEYS = {
  sleeperUser: 'sleeper.user',
  newsletterSources: 'newsletter.sources',
  /** In-app override for the dedicated inbound email address. */
  inboundAddress: 'newsletter.inboundAddress',
  seasonStart: 'season.start',
  /**
   * Sleeper's own `/state/nfl`, as last read.
   *
   * Cached rather than fetched per request: it changes once a week, and the
   * one thing it decides — whether the regular season has started — must not
   * put a network call in front of every render of the toolbar.
   */
  nflState: 'sleeper.nflState',
  /**
   * How loudly the owner's own research argues with the market on the draft
   * board — one of the five positions in `core/draft/signalBalance.ts`.
   *
   * Kept on the account rather than on the phone, unlike Appearance, because
   * the board it changes is built on the server: a preference in `localStorage`
   * could only reach the ranking by riding on every board request, so a
   * rehearsal and a second phone would each have to remember to carry it — and
   * whoever forgot would be silently ranking on the default.
   */
  draftSignalBalance: 'draft.signalBalance',
  vegasProvider: 'vegas.provider',
  lastVegasRefresh: 'vegas.lastRefresh',
  /**
   * When the week's schedule was last bought from the provider.
   *
   * Separate from the refresh stamp because it answers a different question:
   * not "when did we last look at the lines" but "when did we last pay to find
   * out which games the roster is in", which is the thing that must not happen
   * on every pass.
   */
  lastVegasSchedule: 'vegas.lastSchedule',
} as const;
