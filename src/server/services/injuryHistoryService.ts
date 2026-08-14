/**
 * Reading a finished season, a little at a time.
 *
 * The 2025 injury file is 695KB, 6,068 rows and 22 weeks, and parsing all of it
 * measures ~10.6ms — the entire CPU allowance of a Workers invocation on the
 * free plan, before a single row is mapped or written. So this cannot be a job;
 * it has to be a walk. Each tick does one week, or one page of players, and
 * writes down where it got to.
 *
 * It also earns its keep twice. The history is the point, but a finished season
 * is the only published file this app can currently exercise end to end: 2026
 * does not exist yet, so `200 → validator → 304` has never actually run against
 * a real origin in production. Walking 2025 through the same fetch, the same
 * parser and the same identity layer proves the machinery on real bytes, and
 * the validator stored at the end makes the next check a real 304.
 *
 * What it must never do is leak. 2025 rows are written with `season = '2025'`
 * into a table keyed by `(player_id, season, week)`, and the current reader
 * asks for the current season, so a 2025 knee cannot reach a Sunday decision by
 * construction rather than by care.
 */

import { fetchInjuryReport, type FetchLike, type InjuryReportRow } from '../../core/injury/nflverse.ts';
import { summarizeSeason } from '../../core/injury/history.ts';
import { InjuryRepo, type StoredInjuryReport } from '../repos/injury.ts';
import { InjurySourceRepo } from '../repos/injury.ts';
import { InjuryHistoryRepo, type BackfillProgress, type StoredPlayerHistory } from '../repos/injuryHistory.ts';
import { PlayerRepo } from '../repos/players.ts';
import { normalizeName } from '../../core/identity/normalize.ts';
import { resolveToCanonical } from './injuryService.ts';
import { INJURY_SOURCE } from './injuryService.ts';
import type { Database } from '../db.ts';

/**
 * Weeks per tick.
 *
 * One, measured rather than guessed. A two-week chunk parses in ~2.2ms, which
 * looks affordable until the write side is counted: the busiest fortnight of
 * the real file is 777 rows, and mapping and upserting that many inside the
 * same 10ms as the parse leaves no margin. One week is at most 394 rows, the
 * whole walk is 22 ticks, and at five minutes a tick it finishes in under two
 * hours — once, invisibly, for a season that will never change again.
 */
export const WEEKS_PER_CHUNK = 1;

/** Players summarized per tick, once the weeks are in. */
export const PLAYERS_PER_CHUNK = 150;

/**
 * The backfill's own write budget.
 *
 * Kept apart from the five-minute pipeline's ceiling on purpose. That ceiling
 * exists to catch a diff that has started rewriting the board every tick, and
 * it is set at a few thousand because the live pipeline should spend dozens.
 * The backfill legitimately spends ~6,500 once, and pouring that through the
 * same counter would either trip the guard or force it so high it stops
 * guarding anything. Same mechanism, separate ledger, separate number.
 */
export const BACKFILL_WRITE_CEILING = 12_000;

/** The ledger key, so the walk cannot spend the live pipeline's allowance. */
export function backfillLedgerKey(day: string): string {
  return `${day}#backfill`;
}

export interface BackfillStep {
  season: string;
  phase: BackfillProgress['phase'];
  /** What this tick did, in one line, for the log and the panel. */
  note: string;
  weeksDone?: number;
  rowsSeen: number;
  playersWritten: number;
  significantPlayers: number;
  /** Set when the tick could not do its work. Absent is success. */
  error?: string;
}

export interface HistoryDeps {
  fetch?: FetchLike;
  now?: () => Date;
  log?: (message: string) => void;
}

export class InjuryHistoryService {
  private readonly reports: InjuryRepo;
  private readonly source: InjurySourceRepo;
  private readonly history: InjuryHistoryRepo;
  private readonly players: PlayerRepo;

  constructor(db: Database, private readonly deps: HistoryDeps = {}) {
    this.reports = new InjuryRepo(db);
    this.source = new InjurySourceRepo(db);
    this.history = new InjuryHistoryRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.log)(message);
  }

  /**
   * Is there anything left to do for this season?
   *
   * Cheap on purpose — one indexed read — because the five-minute tick asks it
   * every time and the answer is "no" for the rest of the deployment's life.
   */
  async isComplete(season: string): Promise<boolean> {
    const progress = await this.history.progress(INJURY_SOURCE, season).catch(() => null);
    return progress?.phase === 'done';
  }

  /** One tick of the walk. Does nothing and says so when the season is done. */
  async step(season: string): Promise<BackfillStep> {
    const now = this.now();
    const progress = (await this.history.progress(INJURY_SOURCE, season)) ?? {
      source: INJURY_SOURCE,
      season,
      phase: 'weeks' as const,
      nextWeek: 1,
      lastWeek: null,
      afterPlayerId: null,
      rowsSeen: 0,
      playersWritten: 0,
      significantPlayers: 0,
      startedAt: now.toISOString(),
      completedAt: null,
      updatedAt: now.toISOString(),
      note: null,
    };

    if (progress.phase === 'done') {
      return {
        season,
        phase: 'done',
        note: 'nothing to do',
        rowsSeen: progress.rowsSeen,
        playersWritten: progress.playersWritten,
        significantPlayers: progress.significantPlayers,
      };
    }

    const spent = await this.source.writesToday(backfillLedgerKey(now.toISOString().slice(0, 10))).catch(() => 0);
    if (spent >= BACKFILL_WRITE_CEILING) {
      const note = `paused: ${spent} backfill writes today has reached the ${BACKFILL_WRITE_CEILING} ceiling`;
      await this.history.saveProgress({ ...progress, updatedAt: now.toISOString(), note });
      return { season, phase: progress.phase, note, rowsSeen: progress.rowsSeen, playersWritten: progress.playersWritten, significantPlayers: progress.significantPlayers, error: note };
    }

    return progress.phase === 'weeks' ? this.stepWeeks(progress, now) : this.stepPlayers(progress, now);
  }

  /**
   * Read one week of the file.
   *
   * No validator is sent while the walk is unfinished: a 304 would be correct
   * and useless, because what is wanted is the body, again, for a different
   * week. The validator is stored only once the last week is in — which is also
   * what makes the first check after completion a genuine 304 rather than a
   * fingerprint nobody earned.
   */
  private async stepWeeks(progress: BackfillProgress, now: Date): Promise<BackfillStep> {
    const season = progress.season;
    const from = progress.nextWeek;
    const to = from + WEEKS_PER_CHUNK - 1;

    const fetched = await fetchInjuryReport(season, {
      fetch: this.deps.fetch,
      fingerprint: null,
      weeks: { from, to },
    });

    if (fetched.outcome !== 'ok' || !fetched.report) {
      const note = `week ${from}: ${fetched.outcome}${fetched.note ? ` — ${fetched.note}` : ''}`;
      await this.history.saveProgress({ ...progress, updatedAt: now.toISOString(), note });
      return { season, phase: 'weeks', note, rowsSeen: progress.rowsSeen, playersWritten: progress.playersWritten, significantPlayers: progress.significantPlayers, error: note };
    }

    const report = fetched.report;
    const lastWeek = progress.lastWeek ?? report.latestWeek;
    const rows = await this.toStoredRows(report.rows, season, fetched.fingerprint.lastModified, now);
    await this.reports.saveReports(rows);
    await this.source.addWrites(backfillLedgerKey(now.toISOString().slice(0, 10)), rows.length, now.toISOString());

    const nextWeek = to + 1;
    const finishedWeeks = lastWeek != null && nextWeek > lastWeek;
    const rowsSeen = progress.rowsSeen + rows.length;

    /*
     * The validator lands here, at the moment the last week is stored, together
     * with the ingest timestamp. Storing it earlier would make a half-read
     * season look ingested; storing it later would mean a tick in between asked
     * the origin for a file it already had.
     */
    if (finishedWeeks) {
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: now.toISOString(),
        etag: fetched.fingerprint.etag,
        lastModified: fetched.fingerprint.lastModified,
        sourceModifiedAt: fetched.fingerprint.lastModified ? new Date(fetched.fingerprint.lastModified).toISOString() : null,
        ingestedAt: now.toISOString(),
        outcome: 'ok',
        note: `backfilled ${season} through week ${lastWeek}`,
      });
    }

    await this.history.saveProgress({
      ...progress,
      phase: finishedWeeks ? 'players' : 'weeks',
      nextWeek,
      lastWeek,
      rowsSeen,
      startedAt: progress.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      note: `week ${from} stored ${rows.length} rows`,
    });

    this.log(`injury-backfill season=${season} week=${from} rows=${rows.length} phase=${finishedWeeks ? 'players' : 'weeks'}`);
    return {
      season,
      phase: finishedWeeks ? 'players' : 'weeks',
      note: `week ${from}: ${rows.length} rows`,
      weeksDone: from,
      rowsSeen,
      playersWritten: progress.playersWritten,
      significantPlayers: progress.significantPlayers,
    };
  }

  /** Map a chunk's rows onto canonical players. Unresolved rows are dropped. */
  private async toStoredRows(
    rows: InjuryReportRow[],
    season: string,
    publishedAt: string | null,
    now: Date,
  ): Promise<StoredInjuryReport[]> {
    const keys = rows.map((r) => normalizeName(r.fullName));
    const candidates = await this.players.findByNormalizedNames(keys);
    const byName = new Map<string, typeof candidates>();
    for (const player of candidates) {
      const list = byName.get(player.normalizedName);
      if (list) list.push(player);
      else byName.set(player.normalizedName, [player]);
    }

    const fetchedAt = now.toISOString();
    const out: StoredInjuryReport[] = [];
    for (const row of rows) {
      const match = resolveToCanonical(row, { byName });
      if (!match) continue;
      out.push({
        playerId: match.playerId,
        season: row.season || season,
        week: row.week,
        team: row.team || null,
        reportStatus: row.reportStatus,
        primaryInjury: row.primaryInjury,
        secondaryInjury: row.secondaryInjury,
        practiceStatus: row.practiceStatus,
        practiceRaw: row.practiceRaw,
        gsisId: row.gsisId,
        source: INJURY_SOURCE,
        publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
        fetchedAt,
      });
    }
    return out;
  }

  /**
   * Summarize one page of players.
   *
   * A player who no longer clears the bar is forgotten rather than left behind:
   * re-deriving is not additive, and a stale row would keep a note on a card
   * that nothing generates any more.
   */
  private async stepPlayers(progress: BackfillProgress, now: Date): Promise<BackfillStep> {
    const season = progress.season;
    const page = await this.history.playersWithReports(season, progress.afterPlayerId, PLAYERS_PER_CHUNK);

    if (page.length === 0) {
      await this.history.saveProgress({
        ...progress,
        phase: 'done',
        afterPlayerId: null,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        note: `complete: ${progress.significantPlayers} players with significant ${season} history`,
      });
      this.log(`injury-backfill season=${season} phase=done significant=${progress.significantPlayers}`);
      return {
        season,
        phase: 'done',
        note: `complete — ${progress.significantPlayers} players with significant history`,
        rowsSeen: progress.rowsSeen,
        playersWritten: progress.playersWritten,
        significantPlayers: progress.significantPlayers,
      };
    }

    const rowsByPlayer = await this.history.reportsFor(page, season);
    const derivedAt = now.toISOString();
    const keep: StoredPlayerHistory[] = [];
    const drop: string[] = [];

    for (const playerId of page) {
      const rows = rowsByPlayer.get(playerId) ?? [];
      const summary = summarizeSeason(season, rows);
      if (summary.significance === 'none' || !summary.note) {
        drop.push(playerId);
        continue;
      }
      keep.push({
        playerId,
        season,
        significance: summary.significance,
        gamesMissed: summary.gamesMissed,
        note: summary.note,
        episodes: summary.episodes,
        source: INJURY_SOURCE,
        derivedAt,
      });
    }

    await this.history.save(keep);
    await this.history.forget(drop, season);
    await this.source.addWrites(backfillLedgerKey(derivedAt.slice(0, 10)), keep.length, derivedAt);

    const playersWritten = progress.playersWritten + page.length;
    const significantPlayers = progress.significantPlayers + keep.length;

    await this.history.saveProgress({
      ...progress,
      phase: 'players',
      afterPlayerId: page[page.length - 1]!,
      playersWritten,
      significantPlayers,
      updatedAt: derivedAt,
      note: `summarized ${page.length} players, ${keep.length} with something to say`,
    });

    this.log(`injury-backfill season=${season} players=${page.length} significant=${keep.length}`);
    return {
      season,
      phase: 'players',
      note: `${page.length} players summarized, ${keep.length} significant`,
      rowsSeen: progress.rowsSeen,
      playersWritten,
      significantPlayers,
    };
  }

  /**
   * Ask the origin whether the finished season has changed.
   *
   * This is the proof, not the maintenance: the file is a completed season and
   * will not move again, so the interesting part is that the request carries the
   * stored validator and comes back 304 with no body — the same exchange that
   * will keep 2026 cheap 288 times a day.
   */
  async verifyUnchanged(season: string): Promise<{ outcome: string; sentValidator: boolean; note: string | null }> {
    const known = await this.source.get(INJURY_SOURCE, season).catch(() => null);
    const fingerprint = known?.etag || known?.lastModified ? { etag: known!.etag, lastModified: known!.lastModified } : null;
    const fetched = await fetchInjuryReport(season, {
      fetch: this.deps.fetch,
      fingerprint,
      // One week, so a stale validator costs a small parse rather than a season.
      weeks: { from: 1, to: 1 },
    });
    const now = this.now().toISOString();
    await this.source.recordCheck(INJURY_SOURCE, season, {
      checkedAt: now,
      outcome: fetched.outcome === 'not_modified' ? 'not_modified' : fetched.outcome,
      note: fetched.outcome === 'not_modified' ? null : (fetched.note ?? null),
    });
    return { outcome: fetched.outcome, sentValidator: fingerprint != null, note: fetched.note ?? null };
  }
}
