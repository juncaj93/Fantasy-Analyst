/**
 * Trimming old rows, slowly, from the 4 AM job only (Alex, Round 15).
 *
 * ## What goes, and what never does
 *
 * - **Odds lines and odds copies older than three weeks** (`player_props`,
 *   `prop_snapshots`, weekly scope only). Each game's **final** copy is kept
 *   however old it is: the odds job asks "has this player ever had a line?"
 *   and the player card shows a player's last line, and both read only each
 *   game's newest copy (`PropsRepo.latestForPlayers`). Deleting an earlier
 *   copy of a game changes no answer anywhere; deleting the last one would
 *   change what the odds job buys, and that pipeline is not this round's to
 *   change. Season-long and preseason copies are not touched at all.
 * - **The injury feed's run log older than 30 days** (`injury_source_runs`).
 *   Only its newest row is ever read (`InjuryRepo.lastRun`), and that row is
 *   never deleted, however old it is.
 *
 * Nothing newer than a cutoff is ever deleted: every DELETE re-states its
 * cutoff, so a wrong id list still cannot reach a recent row.
 *
 * ## How much, and when
 *
 * At most {@link TRIM_DAILY_CAP} rows a day across all three tables, oldest
 * first in each, because a delete is a write and the account runs at 60,000
 * to 70,000 of its 100,000 writes on a weekday. Cloudflare also charges each
 * index a deleted row sits in: an odds line is about five writes (the table
 * and four indexes), so 2,000 rows is up to about 10,000 writes. That fits a
 * weekday; it does not fit a Saturday or Sunday (80,000 and 93,000 on 7 and 8
 * November), so on those two Eastern days nothing is deleted.
 *
 * The injury log gets the first {@link TRIM_INJURY_SHARE} rows of the cap
 * (two writes each), the odds the rest, and whichever runs out first leaves
 * its share to the other, so both backlogs shrink from the first morning.
 *
 * ## The kill switch
 *
 * One setting, `TRIM_OLD_ROWS` in `wrangler.toml`. `"off"` stops all of it
 * from the next deploy; anything else, or nothing, leaves it on.
 */

import type { Database } from '../db.ts';

export const TRIM_DAILY_CAP = 2_000;
export const TRIM_INJURY_SHARE = 500;
export const ODDS_KEEP_DAYS = 21;
export const INJURY_LOG_KEEP_DAYS = 30;

export interface TrimResult {
  outcome: 'succeeded' | 'skipped';
  /** Rows deleted, all tables. Never more than the cap. */
  deleted: number;
  oddsLines: number;
  oddsCopies: number;
  injuryLog: number;
  note: string;
}

/** `TRIM_OLD_ROWS` set to "off" (any case, spaces ignored) stops the trim; anything else leaves it on. */
export function trimEnabled(setting: string | undefined | null): boolean {
  return (setting ?? '').trim().toLowerCase() !== 'off';
}

/** Saturday or Sunday on the Eastern calendar, when the account's writes are already highest. */
export function isHeavyWriteDay(now: Date): boolean {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
  return day === 'Sat' || day === 'Sun';
}

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const changes = (r: { meta?: { changes?: number } } | null | undefined) => Number(r?.meta?.changes ?? 0);

/** The injury log: oldest first, older than the cutoff, never the newest row. */
async function trimInjuryLog(db: Database, cutoff: string, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const result = await db
    .prepare(
      `DELETE FROM injury_source_runs
        WHERE fetched_at < ?
          AND id IN (
            SELECT id FROM injury_source_runs
             WHERE fetched_at < ?
               AND id <> (SELECT id FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1)
             ORDER BY fetched_at ASC, id ASC
             LIMIT ?
          )`,
    )
    .bind(cutoff, cutoff, limit)
    .run();
  return changes(result);
}

/**
 * Odds: whole copies, oldest first, each with its lines, never a game's final
 * copy. A copy whose lines would overrun the budget has only as many lines
 * deleted as fit, and keeps the rest for tomorrow.
 */
async function trimOdds(db: Database, cutoff: string, limit: number): Promise<{ lines: number; copies: number }> {
  let lines = 0;
  let copies = 0;
  if (limit <= 0) return { lines, copies };
  const { results } = await db
    .prepare(
      `SELECT ps.id AS id, (SELECT COUNT(*) FROM player_props pp WHERE pp.snapshot_id = ps.id) AS lines
         FROM prop_snapshots ps
        WHERE ps.scope = 'week'
          AND ps.fetched_at < ?
          AND EXISTS (
            SELECT 1 FROM prop_snapshots later
             WHERE later.event_id = ps.event_id AND +later.scope = 'week' AND later.fetched_at > ps.fetched_at
          )
        ORDER BY ps.fetched_at ASC, ps.id ASC
        LIMIT 200`,
    )
    .bind(cutoff)
    .all<{ id: number; lines: number }>();
  for (const copy of results ?? []) {
    const room = limit - lines - copies;
    if (room <= 0) break;
    const id = Number(copy.id);
    const count = Number(copy.lines ?? 0);
    /* Lines first, so the copy is never deleted out from under a line (and no cascade does uncounted work). */
    const take = Math.min(count, room);
    if (take > 0) {
      lines += changes(
        await db
          .prepare(
            `DELETE FROM player_props
              WHERE id IN (
                SELECT pp.id FROM player_props pp
                  JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
                 WHERE pp.snapshot_id = ? AND ps.scope = 'week' AND ps.fetched_at < ?
                 ORDER BY pp.id
                 LIMIT ?
              )`,
          )
          .bind(id, cutoff, take)
          .run(),
      );
    }
    if (take < count || limit - lines - copies <= 0) break;
    copies += changes(
      await db
        .prepare(
          `DELETE FROM prop_snapshots
            WHERE id = ? AND scope = 'week' AND fetched_at < ?
              AND NOT EXISTS (SELECT 1 FROM player_props WHERE snapshot_id = ?)
              AND EXISTS (
                SELECT 1 FROM prop_snapshots later
                 WHERE later.event_id = prop_snapshots.event_id AND +later.scope = 'week'
                   AND later.fetched_at > prop_snapshots.fetched_at
              )`,
        )
        .bind(id, cutoff, id)
        .run(),
    );
  }
  return { lines, copies };
}

export async function trimOldRows(
  db: Database,
  opts: { now: Date; enabled: boolean; cap?: number; skipHeavyDays?: boolean },
): Promise<TrimResult> {
  const none = { deleted: 0, oddsLines: 0, oddsCopies: 0, injuryLog: 0 };
  if (!opts.enabled) return { outcome: 'skipped', ...none, note: 'off (TRIM_OLD_ROWS = "off")' };
  if ((opts.skipHeavyDays ?? true) && isHeavyWriteDay(opts.now)) {
    return { outcome: 'skipped', ...none, note: 'weekend: the account writes most on Saturday and Sunday' };
  }
  const cap = Math.max(0, Math.floor(opts.cap ?? TRIM_DAILY_CAP));
  const oddsCutoff = daysBefore(opts.now, ODDS_KEEP_DAYS);
  const injuryCutoff = daysBefore(opts.now, INJURY_LOG_KEEP_DAYS);

  let injuryLog = await trimInjuryLog(db, injuryCutoff, Math.min(TRIM_INJURY_SHARE, cap));
  const odds = await trimOdds(db, oddsCutoff, cap - injuryLog);
  /* Whatever the odds did not need goes back to the injury log. */
  injuryLog += await trimInjuryLog(db, injuryCutoff, cap - injuryLog - odds.lines - odds.copies);
  const deleted = injuryLog + odds.lines + odds.copies;
  return {
    outcome: 'succeeded',
    deleted,
    oddsLines: odds.lines,
    oddsCopies: odds.copies,
    injuryLog,
    note: `odds lines ${odds.lines}, odds copies ${odds.copies}, injury log ${injuryLog} (cap ${cap}; odds before ${oddsCutoff.slice(0, 10)}, injury log before ${injuryCutoff.slice(0, 10)})`,
  };
}
