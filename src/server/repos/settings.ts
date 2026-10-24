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

  /** Several keys in one read; a key with no row is absent from the result. */
  async getMany<T>(keys: readonly string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      if (chunk.length === 0) continue;
      const rows = await this.db
        .prepare(`SELECT key, value_json FROM settings WHERE key IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk)
        .all<{ key: string; value_json: string }>();
      for (const r of rows.results) {
        const value = parseJson<T | null>(r.value_json, null);
        if (value != null) out.set(r.key, value);
      }
    }
    return out;
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

  /**
   * When the full Sleeper player list last downloaded successfully, or null.
   *
   * One settings row, written by `syncPlayers` on success. Before the first
   * success that writes it, the sync log's newest `ok` row answers instead.
   */
  async playersLastSuccessAt(): Promise<string | null> {
    const cached = playersStampCache.get(this.db);
    if (cached && Date.now() - cached.readAt < PLAYERS_STAMP_TTL_MS) return cached.at;
    // One statement, one round trip: the stamp, or the log when there is no stamp yet.
    const row = await this.db
      .prepare(
        `SELECT COALESCE(
           (SELECT value_json FROM settings WHERE key = ?),
           (SELECT json_quote(MAX(finished_at)) FROM sync_log WHERE kind = 'players' AND status = 'ok')
         ) AS at`,
      )
      .bind(SETTING_KEYS.playersLastSuccess)
      .first<Record<string, unknown>>();
    const parsed = row?.['at'] == null ? null : parseJson<unknown>(String(row['at']), null);
    const at = typeof parsed === 'string' && parsed ? parsed : null;
    playersStampCache.set(this.db, { at, readAt: Date.now() });
    return at;
  }

  /** Record a successful player-list download. */
  async markPlayersSynced(at: string): Promise<void> {
    await this.set(SETTING_KEYS.playersLastSuccess, at);
    playersStampCache.delete(this.db);
  }
}

/*
 * The stamp changes once a day and every injury read wants it, so a minute's
 * memory per database handle keeps it to one row read however many screens a
 * request assembles. The download itself clears it.
 */
const PLAYERS_STAMP_TTL_MS = 60_000;
const playersStampCache = new WeakMap<Database, { at: string | null; readAt: number }>();

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
  /**
   * Roster teams discovery asked about and found no game for, with when.
   *
   * `{ "NYJ": "2026-09-30T12:00:00.000Z" }`. Each of those asks is billed an
   * entity for an empty answer, so a team on this list is not asked again
   * until its entry is a few hours old — otherwise every tap on a refresh
   * button re-buys the same nothing. See `VegasRefreshService.discoverIfNeeded`.
   */
  vegasDiscoveryEmpty: 'vegas.discoveryEmpty',
  /**
   * The kickoff clock's gate: `{ processedThrough, next, retries, last }`.
   *
   * What lets the five-minute tick read one row and go home on the 99% of ticks
   * where no game has a new checkpoint. A missing or unreadable value means
   * "look now", never "do nothing". See `VegasKickoffClock`.
   */
  vegasClock: 'vegas.clock',
  /**
   * The Detroit date the weekly manager-tendencies refresh last finished on,
   * as `YYYY-MM-DD`, so a Wednesday window that spans several ticks stops once
   * the work is done. See `core/league/managerIntelCadence.ts`.
   */
  managerIntelWeekly: 'managerIntel.weekly',
  /**
   * When the full player list last downloaded successfully, as an ISO instant.
   *
   * Sleeper asks for that download at most once a day, and this is what holds
   * the scheduled ones to one per Eastern date (`core/sleeper/playerListClock.ts`).
   * It is also how old Sleeper's injury statuses are, which is what lets a
   * newer injury report outrank them (`core/injury/model.ts`).
   */
  playersLastSuccess: 'sleeper.players.lastSuccessAt',
} as const;
