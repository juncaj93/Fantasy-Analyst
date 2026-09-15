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

/**
 * How the projected totals themselves have landed, against what was scored.
 *
 * A different question from the win probability above, and a cheaper one. A
 * model can be perfectly calibrated on win probability while every projection
 * it makes is four points high, because the bias cancels on both sides of one
 * subtraction — and a projection that is four points high is wrong everywhere
 * *else* it is used: the lineup optimiser, the waiver comparison, the trade
 * value, all of which read one side only.
 */
export interface ProjectionAccuracy {
  /** Settled weeks with both a pregame projection and a final score. */
  sample: number;
  /** Mean signed error, projected minus actual. Positive means over-projecting. */
  bias: number | null;
  /** Mean absolute error, in fantasy points. */
  absoluteError: number | null;
  /** Median absolute error — the typical week rather than the worst one. */
  medianAbsoluteError: number | null;
  /** The sentence a diagnostics screen prints, or null below the minimum sample. */
  detail: string | null;
}

/**
 * How many settled team-weeks before a bias figure is worth printing.
 *
 * Lower than {@link MIN_CALIBRATION_SAMPLE} and deliberately so: that one is
 * estimating a *proportion* inside a ten-point band, which needs a band's worth
 * of samples before the interval is narrower than the band. This is a mean over
 * a continuous quantity with a standard deviation of roughly twenty points, so
 * a dozen team-weeks already pin the bias to about ±6 — coarse, and coarse is
 * enough to notice a systematic four-point lean, which is all this is for.
 *
 * Twelve is also reachable inside one week of one twelve-team league, which is
 * the point: this is meant to say something by the end of the first Sunday it
 * has data for, not by December.
 */
export const MIN_ACCURACY_SAMPLE = 12;

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
  }): Promise<{
    fingerprint: string | null;
    winProbability: number | null;
    at: string | null;
    /**
     * Who this roster is playing this week, as of the last forecast.
     *
     * Read by the lineup route, which needs to know whose roster to weigh the
     * reader's against and has no other cheap way to find out — the pairing
     * otherwise costs a Sleeper request per Team load. It is already a column
     * on the row this query reads, so carrying it is free.
     *
     * Null for a roster on a bye, and null for a week whose matchup screen
     * nobody has opened yet. Both mean the same thing to the caller: no
     * opponent to read, so no opinion about the matchup.
     */
    opponentRosterId: number | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT latest_fingerprint AS fingerprint, latest_win_probability AS win, latest_forecast_at AS at,
                opponent_roster_id AS opponent
           FROM matchup_forecasts
          WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ?`,
      )
      .bind(opts.leagueId, opts.season, opts.week, opts.rosterId)
      .first<{ fingerprint: string | null; win: number | null; at: string | null; opponent: number | null }>();
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      winProbability: row.win,
      at: row.at,
      opponentRosterId: row.opponent ?? null,
    };
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

  /**
   * Whether this app's projected totals have been running high or low.
   *
   * The cheapest calibration available, and it costs nothing to collect: both
   * halves are already on the row. `first_projected_final` was written before
   * anything was known and is never updated, and `final_score` is filled in
   * when the week settles — so the comparison is pregame projection against
   * result, with no lookahead available to flatter it.
   *
   * Pregame-first rows only, for the same reason `calibration` takes them:
   * a forecast first seen at half-time already contains half the answer, and
   * grading it would report that the model is excellent at predicting games it
   * has watched.
   *
   * One indexed read over settled rows. Nothing is stored, nothing is written,
   * and no new column exists for this — the table has carried both numbers
   * since migration 0023 and nothing had asked them this question.
   */
  async projectionAccuracy(modelVersion?: string): Promise<ProjectionAccuracy> {
    const rows = await this.db
      .prepare(
        `SELECT first_projected_final AS projected, final_score AS actual
           FROM matchup_forecasts
          WHERE won IS NOT NULL
            AND first_phase = 'pregame'
            AND first_projected_final IS NOT NULL
            AND final_score IS NOT NULL
            AND (? IS NULL OR model_version = ?)`,
      )
      .bind(modelVersion ?? null, modelVersion ?? null)
      .all<{ projected: number; actual: number }>();

    const errors = rows.results.map((r) => r.projected - r.actual).filter((e) => Number.isFinite(e));
    const sample = errors.length;
    if (sample < MIN_ACCURACY_SAMPLE) {
      return { sample, bias: null, absoluteError: null, medianAbsoluteError: null, detail: null };
    }

    const bias = round2(errors.reduce((a, e) => a + e, 0) / sample);
    const absolute = errors.map(Math.abs);
    const absoluteError = round2(absolute.reduce((a, e) => a + e, 0) / sample);
    const sorted = [...absolute].sort((a, b) => a - b);
    const middle = sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

    /*
     * The sentence, and the threshold it turns on.
     *
     * Two points is about a tenth of a team's week and well inside the noise of
     * a dozen samples; saying "running 1.4 high" off that would be inventing a
     * finding. Past two points it is worth a look, and the wording says which
     * way rather than making the reader do the subtraction.
     */
    const direction = bias > 0 ? 'high' : 'low';
    const detail =
      Math.abs(bias) < 2
        ? `Projected totals are landing within ${absoluteError} pts on average over ${sample} settled team-weeks, with no systematic lean.`
        : `Projected totals are running ${Math.abs(bias)} pts ${direction} on average over ${sample} settled team-weeks (typical miss ${round2(middle)} pts).`;

    return { sample, bias, absoluteError, medianAbsoluteError: round2(middle), detail };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
