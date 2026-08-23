/**
 * The forecast ledger, and the calibration it exists to make possible.
 *
 * Everything else in this app can be recomputed from stored sources. This
 * cannot: a live win probability is a function of a Sunday afternoon's state,
 * and that state stops being obtainable the moment the games end. If nobody
 * writes down what the model said at the time, the question "is 70% actually
 * 70%?" is unanswerable forever — not hard, unanswerable.
 *
 * So the write path is deliberately small and deliberately dumb. One row per
 * roster per week; the first forecast is written once and never touched again,
 * because it is the calibration sample and a sample that gets updated as the
 * afternoon goes on is a model marking its own homework.
 */

import type { Database } from '../db.ts';

export interface MatchupForecastRow {
  leagueId: string;
  season: string;
  week: number;
  rosterId: number;
  matchupId: number | null;
  opponentRosterId: number | null;
  modelVersion: string;
  phase: string;
  winProbability: number | null;
  projectedFinal: number | null;
  actual: number;
  confidence: string;
  fingerprint: string;
  at: string;
}

/** One calibration bucket: what was predicted, and what happened. */
export interface CalibrationBucket {
  /** `50-60` — the lower bound of the ten-point band. */
  band: string;
  low: number;
  high: number;
  /** How many settled forecasts landed in this band. */
  sample: number;
  /** How often those actually won, 0..1. Null below the minimum sample. */
  observed: number | null;
  /** The mean prediction inside the band, so the comparison is like for like. */
  predicted: number | null;
}

/**
 * How many settled weeks a band needs before an observed rate is reported.
 *
 * Twenty. Below that the confidence interval on a proportion is wider than the
 * band itself, and a screen printing "we said 70%, it happened 50% of the time"
 * off six samples would be reporting noise as a finding — which is exactly what
 * §9 means by not overclaiming calibration on small samples.
 */
export const MIN_CALIBRATION_SAMPLE = 20;

export class MatchupRepo {
  constructor(private readonly db: Database) {}

  /**
   * Record what the model currently believes.
   *
   * Two statements in one call, and they behave differently on purpose. The
   * insert carries the *first* forecast and only ever fires once — `ON CONFLICT
   * DO NOTHING` is what makes "written once" a property of the database rather
   * than of remembering to check. The update then moves the latest columns and
   * leaves the first ones exactly where they were.
   */
  async record(row: MatchupForecastRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO matchup_forecasts (
           league_id, season, week, roster_id, matchup_id, opponent_roster_id, model_version,
           first_forecast_at, first_phase, first_win_probability, first_projected_final, first_actual,
           latest_forecast_at, latest_phase, latest_win_probability, latest_projected_final, latest_actual,
           latest_confidence, latest_fingerprint
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (league_id, season, week, roster_id) DO NOTHING`,
      )
      .bind(
        row.leagueId,
        row.season,
        row.week,
        row.rosterId,
        row.matchupId,
        row.opponentRosterId,
        row.modelVersion,
        row.at,
        row.phase,
        row.winProbability,
        row.projectedFinal,
        row.actual,
        row.at,
        row.phase,
        row.winProbability,
        row.projectedFinal,
        row.actual,
        row.confidence,
        row.fingerprint,
      )
      .run();

    await this.db
      .prepare(
        `UPDATE matchup_forecasts
            SET latest_forecast_at = ?, latest_phase = ?, latest_win_probability = ?,
                latest_projected_final = ?, latest_actual = ?, latest_confidence = ?,
                latest_fingerprint = ?, model_version = ?
          WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ?`,
      )
      .bind(
        row.at,
        row.phase,
        row.winProbability,
        row.projectedFinal,
        row.actual,
        row.confidence,
        row.fingerprint,
        row.modelVersion,
        row.leagueId,
        row.season,
        row.week,
        row.rosterId,
      )
      .run();
  }

  /**
   * Close a week out with what actually happened.
   *
   * Only once, and only with both scores present: a half-settled row — one side
   * final, the other still playing — would be graded as a completed sample and
   * would be wrong in whichever direction the unfinished side was heading.
   */
  async settle(opts: {
    leagueId: string;
    season: string;
    week: number;
    rosterId: number;
    finalScore: number;
    opponentFinalScore: number;
    at: string;
  }): Promise<void> {
    const won = opts.finalScore === opts.opponentFinalScore ? null : opts.finalScore > opts.opponentFinalScore ? 1 : 0;
    await this.db
      .prepare(
        `UPDATE matchup_forecasts
            SET final_score = ?, opponent_final_score = ?, won = ?, settled_at = ?
          WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ? AND settled_at IS NULL`,
      )
      .bind(
        opts.finalScore,
        opts.opponentFinalScore,
        won,
        opts.at,
        opts.leagueId,
        opts.season,
        opts.week,
        opts.rosterId,
      )
      .run();
  }

  /**
   * Weeks this league has forecasts for and no outcome, oldest first.
   *
   * The question settlement starts from. It exists because closing a week out
   * used to be a side effect of somebody opening the Matchup screen during the
   * few hours between the last whistle and Sleeper rolling the week over — so a
   * week nobody happened to look at in that window kept its forecasts and never
   * got an outcome, which for a table whose entire purpose is grading means the
   * sample was collected and then thrown away.
   */
  async unsettledWeeks(leagueId: string): Promise<{ season: string; week: number }[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT season, week
           FROM matchup_forecasts
          WHERE league_id = ? AND settled_at IS NULL
          ORDER BY season, week`,
      )
      .bind(leagueId)
      .all<{ season: string; week: number }>();
    return rows.results.map((r) => ({ season: r.season, week: r.week }));
  }

  /** The rosters still awaiting an outcome in one week, and who each played. */
  async unsettledRosters(opts: {
    leagueId: string;
    season: string;
    week: number;
  }): Promise<{ rosterId: number; opponentRosterId: number | null }[]> {
    const rows = await this.db
      .prepare(
        `SELECT roster_id AS rosterId, opponent_roster_id AS opponentRosterId
           FROM matchup_forecasts
          WHERE league_id = ? AND season = ? AND week = ? AND settled_at IS NULL
          ORDER BY roster_id`,
      )
      .bind(opts.leagueId, opts.season, opts.week)
      .all<{ rosterId: number; opponentRosterId: number | null }>();
    return rows.results;
  }

  /** The latest stored forecast for one roster's week, or null. */
  async latest(opts: {
    leagueId: string;
    season: string;
    week: number;
    rosterId: number;
  }): Promise<{ fingerprint: string | null; winProbability: number | null; at: string | null } | null> {
    const row = await this.db
      .prepare(
        `SELECT latest_fingerprint AS fingerprint, latest_win_probability AS win, latest_forecast_at AS at
           FROM matchup_forecasts
          WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ?`,
      )
      .bind(opts.leagueId, opts.season, opts.week, opts.rosterId)
      .first<{ fingerprint: string | null; win: number | null; at: string | null }>();
    if (!row) return null;
    return { fingerprint: row.fingerprint, winProbability: row.win, at: row.at };
  }

  /**
   * How well the pregame forecasts have held up, in ten-point bands.
   *
   * Pregame only, and settled only. A forecast first seen at half-time is not a
   * pregame prediction and grading it as one would flatter the model with
   * information it did not have.
   */
  async calibration(modelVersion?: string): Promise<{ buckets: CalibrationBucket[]; sample: number }> {
    const rows = await this.db
      .prepare(
        `SELECT first_win_probability AS p, won
           FROM matchup_forecasts
          WHERE won IS NOT NULL
            AND first_phase = 'pregame'
            AND first_win_probability IS NOT NULL
            AND (? IS NULL OR model_version = ?)`,
      )
      .bind(modelVersion ?? null, modelVersion ?? null)
      .all<{ p: number; won: number }>();

    const buckets: CalibrationBucket[] = [];
    for (let low = 0; low < 100; low += 10) {
      const high = low + 10;
      const inBand = rows.results.filter((r) => r.p * 100 >= low && (r.p * 100 < high || (high === 100 && r.p === 1)));
      const sample = inBand.length;
      buckets.push({
        band: `${low}-${high}`,
        low: low / 100,
        high: high / 100,
        sample,
        observed:
          sample >= MIN_CALIBRATION_SAMPLE
            ? round3(inBand.reduce((a, r) => a + r.won, 0) / sample)
            : null,
        predicted: sample > 0 ? round3(inBand.reduce((a, r) => a + r.p, 0) / sample) : null,
      });
    }

    return { buckets, sample: rows.results.length };
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
