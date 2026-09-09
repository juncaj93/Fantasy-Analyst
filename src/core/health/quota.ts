/**
 * How much of today's D1 allowance is gone, and whether today is going to run
 * out of it.
 *
 * ## Why this is in the app at all
 *
 * The free plan allows 5,000,000 rows read a day, and the moment that is gone
 * every query in the app answers with an error until midnight UTC. That has
 * happened three times. Each time the first anybody knew of it was the app
 * failing, and each diagnosis started by asking a question — "how much have we
 * used?" — that nothing in the app could answer. `wrangler d1 insights` can say
 * which query spent the allowance, and `.github/workflows/d1-insights.yml`
 * asks it, but only from a laptop or an Actions run, and only about the past.
 *
 * A number on a screen Alex already opens turns that into something he can see
 * before it matters rather than after.
 *
 * ## What this module is, and is not
 *
 * Pure arithmetic over a reading somebody else obtained. It does not fetch, it
 * does not know what a token is, and it never invents a number: a reading that
 * could not be taken produces a view that says so, in words, rather than a
 * zero that reads as "plenty left". §14's rule — no counters this app cannot
 * honestly measure — is kept by making "cannot measure" one of the states
 * rather than by leaving the counter out.
 */

/** Rows read a day, free plan. The number the whole app is bounded by. */
export const D1_DAILY_ROWS_READ = 5_000_000;

/** Rows written a day, free plan. Never the binding constraint here, but real. */
export const D1_DAILY_ROWS_WRITTEN = 100_000;

/**
 * What a reading of the platform's own analytics contains.
 *
 * Rows *and* queries, because the pair is what tells the two failure shapes
 * apart: a hundred thousand rows across four calls is one bad query, and a
 * hundred thousand across forty thousand calls is a loop nobody meant to write.
 * That distinction is what every incident here has turned on.
 */
export interface D1QuotaReading {
  /** The UTC day these totals cover, `YYYY-MM-DD`. The allowance resets on it. */
  day: string;
  rowsRead: number;
  rowsWritten: number;
  readQueries: number;
  writeQueries: number;
  /** What the previous UTC day finished on, for a sense of normal. Null if not asked for. */
  previousDayRowsRead: number | null;
  /** When the reading was taken, not when the platform computed it. */
  readAt: string;
}

/**
 * Why there is no reading.
 *
 * Two states rather than one, because they ask different things of the reader:
 * `unconfigured` is a five-minute setup task, and `unavailable` is either
 * Cloudflare being unreachable or the response having changed shape.
 */
export type QuotaAvailability = 'reading' | 'unconfigured' | 'unavailable';

/** How worried to be. `unknown` when there is nothing to be worried about with. */
export type QuotaState = 'unknown' | 'ok' | 'watch' | 'critical';

export interface D1QuotaView {
  availability: QuotaAvailability;
  state: QuotaState;
  /** The row's own words: `38% of today's rows`, or why there is no number. */
  headline: string;
  /** The sentence under it. Always says something a reader can act on or dismiss. */
  detail: string;
  /** 0-100+, or null when there is no reading. Not clamped: over is a real state. */
  percentUsed: number | null;
  /**
   * Where today ends at this rate, as a percentage.
   *
   * Null until enough of the day has passed for the extrapolation to mean
   * anything — see {@link MIN_HOURS_BEFORE_PACE}. A projection from four
   * minutes of a day is a number with the precision of a measurement and the
   * content of a guess, which is exactly the mistake #243 was written about.
   */
  projectedPercent: number | null;
  reading: D1QuotaReading | null;
}

/**
 * How much of the UTC day must have passed before a pace is worth showing.
 *
 * Two hours. Traffic here is not uniform — the 09:00 cron is a spike, and so is
 * a Sunday afternoon — so this extrapolation is a straight line through data
 * that is not one, and it is offered as an early warning rather than a
 * forecast. Before two hours the divisor is small enough that a single cron
 * tick projects to several times the allowance, which would cry wolf every
 * morning and teach the one useful row on this screen to be ignored.
 */
export const MIN_HOURS_BEFORE_PACE = 2;

/** Past this share of the allowance, somebody should look today. */
export const WATCH_AT_PERCENT = 70;

/** Past this, or on pace past 100, it is going to fail before midnight. */
export const CRITICAL_AT_PERCENT = 90;

/** On pace to finish the day above this, say so while there is time to act. */
export const PACE_WATCH_PERCENT = 85;

/** How far into the UTC day a given instant is, as a fraction. */
export function fractionOfUtcDay(at: Date): number {
  const ms = at.getTime() - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return Math.min(1, Math.max(0, ms / 86_400_000));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The row, from a reading or from the reason there isn't one.
 *
 * `now` is passed rather than read, because the pace is the whole early-warning
 * half of this and a test that cannot move the clock cannot check it.
 */
export function describeQuota(
  input: { availability: QuotaAvailability; reading?: D1QuotaReading | null; reason?: string | null },
  now: Date,
): D1QuotaView {
  if (input.availability !== 'reading' || !input.reading) {
    const unconfigured = input.availability === 'unconfigured';
    return {
      availability: unconfigured ? 'unconfigured' : 'unavailable',
      state: 'unknown',
      headline: unconfigured ? 'Not connected' : 'Could not be read',
      detail: unconfigured
        ? 'Cloudflare can report how much of the daily database allowance today has used, but this deployment has no analytics token to ask with. See docs/DATA_HEALTH.md.'
        : (input.reason ?? 'Cloudflare did not answer, or answered in a shape this app does not recognise.'),
      percentUsed: null,
      projectedPercent: null,
      reading: null,
    };
  }

  const reading = input.reading;
  const percentUsed = round((100 * reading.rowsRead) / D1_DAILY_ROWS_READ);

  const elapsed = fractionOfUtcDay(now);
  const projectedPercent =
    elapsed * 24 >= MIN_HOURS_BEFORE_PACE ? round(percentUsed / elapsed) : null;

  /*
   * The state, from whichever of the two numbers is worse.
   *
   * A day that is already at 92% does not need a projection to be a problem,
   * and a day at 30% by 09:00 UTC does not look like one without a projection.
   * Both are the same warning at different hours.
   */
  let state: QuotaState = 'ok';
  if (percentUsed >= CRITICAL_AT_PERCENT || (projectedPercent ?? 0) >= 100) state = 'critical';
  else if (percentUsed >= WATCH_AT_PERCENT || (projectedPercent ?? 0) >= PACE_WATCH_PERCENT) state = 'watch';

  const paceSentence =
    projectedPercent == null
      ? 'Too early in the UTC day to say where it lands.'
      : projectedPercent >= 100
        ? `At this rate today runs out before midnight UTC (on pace for ${projectedPercent}%).`
        : `On pace for ${projectedPercent}% by midnight UTC.`;

  const yesterday =
    reading.previousDayRowsRead == null
      ? ''
      : ` Yesterday finished on ${round((100 * reading.previousDayRowsRead) / D1_DAILY_ROWS_READ)}%.`;

  return {
    availability: 'reading',
    state,
    headline: `${percentUsed}% of today's rows`,
    detail:
      `${reading.rowsRead.toLocaleString('en-GB')} of ${D1_DAILY_ROWS_READ.toLocaleString('en-GB')} rows read ` +
      `across ${reading.readQueries.toLocaleString('en-GB')} queries. ${paceSentence}${yesterday}`,
    percentUsed,
    projectedPercent,
    reading,
  };
}
