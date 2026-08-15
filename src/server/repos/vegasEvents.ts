/**
 * The bit of the NFL schedule the app has paid to learn.
 *
 * The provider will not sell a schedule without odds — every event answer
 * carries its whole odds board, and the bill is one entity per event either
 * way. So the first fetch of the week is also the discovery, and what it
 * learned is kept here: which event a team is playing in, and when it starts.
 *
 * That is what lets the second and third refresh of the week go straight to the
 * roster's events instead of paying to find them again, and it is what tells
 * the planner which games have already kicked off and are therefore no longer
 * worth a penny.
 */

import { MAX_BOUND_PARAMS, chunk, nowIso, type Database } from '../db.ts';

export interface VegasEventRow {
  eventId: string;
  provider: string;
  kickoff: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  seenAt: string;
  /** The over/under, when the provider had quoted the game. */
  total?: number | null;
  /** The handicap, from `spreadTeam`'s point of view. Negative = favoured. */
  spread?: number | null;
  /** Whose handicap it is. Stored so the sign never has to be inferred. */
  spreadTeam?: string | null;
  /** When those two were last seen, which is not when the row was last touched. */
  linesSeenAt?: string | null;
}

export class VegasEventsRepo {
  constructor(private readonly db: Database) {}

  async upsertMany(rows: Omit<VegasEventRow, 'seenAt'>[]): Promise<void> {
    if (rows.length === 0) return;
    const at = nowIso();
    for (const batch of chunk(rows, 50)) {
      await this.db.batch(
        batch.map((r) =>
          this.db
            .prepare(
              /*
               * COALESCE on every column that can be absent, including the two
               * new ones. A refresh that comes back without game lines has
               * learned nothing about them, and writing NULL over a spread the
               * app already knew would make the game-script component blink out
               * every time the provider was quiet.
               *
               * `lines_seen_at` is only advanced when a line was actually
               * present, which is what keeps "we have a spread" and "the spread
               * is current" separable.
               */
              `INSERT INTO vegas_events
                 (event_id, provider, kickoff, home_team, away_team, seen_at, game_total, spread, spread_team, lines_seen_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(event_id) DO UPDATE SET
                 provider = excluded.provider,
                 kickoff = COALESCE(excluded.kickoff, vegas_events.kickoff),
                 home_team = COALESCE(excluded.home_team, vegas_events.home_team),
                 away_team = COALESCE(excluded.away_team, vegas_events.away_team),
                 game_total = COALESCE(excluded.game_total, vegas_events.game_total),
                 spread = COALESCE(excluded.spread, vegas_events.spread),
                 spread_team = COALESCE(excluded.spread_team, vegas_events.spread_team),
                 lines_seen_at = COALESCE(excluded.lines_seen_at, vegas_events.lines_seen_at),
                 seen_at = excluded.seen_at`,
            )
            .bind(
              r.eventId,
              r.provider,
              r.kickoff,
              r.homeTeam,
              r.awayTeam,
              at,
              r.total ?? null,
              r.spread ?? null,
              r.spreadTeam ?? null,
              r.total == null && r.spread == null ? null : at,
            ),
        ),
      );
    }
  }

  /** Games kicking off inside a window, oldest first. */
  async between(fromIso: string, toIso: string): Promise<VegasEventRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM vegas_events WHERE kickoff IS NOT NULL AND kickoff >= ? AND kickoff <= ? ORDER BY kickoff')
      .bind(fromIso, toIso)
      .all<Record<string, unknown>>();
    return rows.results.map(toRow);
  }

  /**
   * Team abbreviation -> the game they are in next, inside the window.
   *
   * Teams are keyed by whatever the provider calls them, uppercased. The caller
   * maps Sleeper's abbreviations onto that, and a team with no match is simply
   * absent — which the planner reports as "no game mapped" rather than
   * silently fetching something adjacent.
   */
  async teamIndex(fromIso: string, toIso: string): Promise<Map<string, VegasEventRow>> {
    const out = new Map<string, VegasEventRow>();
    for (const row of await this.between(fromIso, toIso)) {
      for (const team of [row.homeTeam, row.awayTeam]) {
        if (!team) continue;
        const key = team.toUpperCase();
        // Earliest kickoff wins: `between` is ordered, so the first write is
        // the next game, and a later one must not overwrite it.
        if (!out.has(key)) out.set(key, row);
      }
    }
    return out;
  }

  async forEvents(eventIds: string[]): Promise<Map<string, VegasEventRow>> {
    const out = new Map<string, VegasEventRow>();
    const unique = [...new Set(eventIds)].filter(Boolean);
    if (unique.length === 0) return out;
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM vegas_events WHERE event_id IN (${placeholders})`)
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        const row = toRow(r);
        out.set(row.eventId, row);
      }
    }
    return out;
  }

  /** When the schedule was last learned, so discovery is not repeated daily. */
  async lastSeenAt(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT MAX(seen_at) AS seen_at FROM vegas_events')
      .first<{ seen_at: string | null }>();
    return row?.seen_at ?? null;
  }
}

function toRow(r: Record<string, unknown>): VegasEventRow {
  return {
    eventId: String(r['event_id']),
    provider: String(r['provider']),
    kickoff: r['kickoff'] == null ? null : String(r['kickoff']),
    homeTeam: r['home_team'] == null ? null : String(r['home_team']),
    awayTeam: r['away_team'] == null ? null : String(r['away_team']),
    seenAt: String(r['seen_at']),
    total: numberOrNull(r['game_total']),
    spread: numberOrNull(r['spread']),
    spreadTeam: r['spread_team'] == null ? null : String(r['spread_team']),
    linesSeenAt: r['lines_seen_at'] == null ? null : String(r['lines_seen_at']),
  };
}

/** A stored NULL is unknown. It is never read as a zero-point game. */
function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
