/**
 * The D1 free-plan caps, shared by every one of Alex's sites. Each day resets
 * at 00:00 UTC (7 PM Eastern in winter).
 *
 * This module used to also describe a live reading for an in-app meter on
 * Data health. The meter was never connected (no analytics token was ever
 * set), so Round 34 removed it; the round checks read Cloudflare's own totals
 * from the Probe workflow instead (`.github/workflows/d1-insights.yml`).
 */

/** Rows read a day, free plan. The number the whole app is bounded by. */
export const D1_DAILY_ROWS_READ = 5_000_000;

/** Rows written a day, free plan. Never the binding constraint here, but real. */
export const D1_DAILY_ROWS_WRITTEN = 100_000;
