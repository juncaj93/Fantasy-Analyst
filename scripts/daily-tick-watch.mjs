/**
 * Did the 09:00 tick finish today?
 *
 *   npx wrangler d1 execute fantasy_analyst --remote --json --command "<SQL>" \
 *     | node scripts/daily-tick-watch.mjs
 *
 * The daily tick writes its run record to `cron_run_state` as its very last act,
 * so a tick that dies part-way through leaves yesterday's row standing and says
 * nothing. That is not hypothetical: from 19 to 23 September 2026 Cloudflare
 * ended every 09:00 invocation `exceededCpu`, the feeds above the point it died
 * kept landing, and nothing anywhere reported that the tick itself had stopped
 * finishing. It was found by somebody asking why Data Health's last run read
 * 18 September.
 *
 * So this reads that one row and fails — loudly, as a red job that
 * `alert-on-failure.yml` turns into the "Scheduled job failures" issue — when
 * the tick has not finished recently. It runs at 10:15 UTC, an hour after the
 * tick, so a morning that did not finish is reported the same morning.
 *
 * Reads one row and writes nothing. Depends on nothing, like the alert script
 * beside it, so it still answers on a day when an install is what is broken.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DAILY_CRON = '0 9 * * *';

/**
 * How old the last finished run may be before it is a missed morning.
 *
 * Read at 10:15, a healthy record is today's and a little over an hour old; a
 * morning that did not finish leaves yesterday's standing, about 25 hours old.
 * Anything between the two tells them apart on the same morning. 20 sits well
 * inside that gap, so a scheduled run GitHub starts hours late still reads a
 * healthy morning as healthy, and a missed one is never mistaken for yesterday.
 */
export const MAX_AGE_HOURS = 20;

export const SQL =
  `SELECT cron, started_at, finished_at, outcome FROM cron_run_state WHERE cron = '${DAILY_CRON}'`;

/**
 * The verdict on one row, or on its absence.
 *
 * A pure function of what the database said and what time it is, so the whole
 * decision is tested without a database or a clock.
 */
export function judgeDailyTick(row, now, maxAgeHours = MAX_AGE_HOURS) {
  if (!row) {
    return { ok: false, message: 'The 09:00 tick has never recorded a finished run.' };
  }
  if (!row.finished_at) {
    return { ok: false, message: `The 09:00 tick's last record, started ${row.started_at}, has no finish time.` };
  }
  const finished = Date.parse(row.finished_at);
  if (!Number.isFinite(finished)) {
    return { ok: false, message: `The 09:00 tick's finish time could not be read: ${JSON.stringify(row.finished_at)}.` };
  }
  const ageHours = (now.getTime() - finished) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return {
      ok: false,
      message:
        `The 09:00 tick last finished at ${row.finished_at}, ${ageHours.toFixed(1)} hours ago ` +
        `(limit ${maxAgeHours}). It has started since then and not finished: the feeds above the point ` +
        `it stops keep landing, so nothing else will say so. Run "Who is calling production" across ` +
        `09:00 UTC to see how it ends.`,
    };
  }
  if (row.outcome === 'failed') {
    return { ok: false, message: `The 09:00 tick finished at ${row.finished_at} with every step failed.` };
  }
  return { ok: true, message: `The 09:00 tick finished at ${row.finished_at} (${ageHours.toFixed(1)}h ago), outcome ${row.outcome}.` };
}

/**
 * The row out of `wrangler d1 execute --json`, which prints an array of result
 * sets, sometimes after a line or two of its own. A reply that is not that shape
 * is reported as unreadable rather than as "no row", because the difference is
 * the difference between a dead tick and a dead query.
 */
export function rowFromWranglerJson(text) {
  // The first line that *opens* with a bracket: a warning wrangler prints first
  // (`▲ [WARNING] ...`) carries a bracket mid-line and must not be taken for it.
  const start = text.search(/^\[/m);
  if (start === -1) throw new Error('wrangler printed no JSON result');
  const sets = JSON.parse(text.slice(start));
  const set = Array.isArray(sets) ? sets[0] : null;
  if (!set || set.success === false || !Array.isArray(set.results)) {
    throw new Error('wrangler did not return a result set');
  }
  return set.results[0] ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const text = readFileSync(0, 'utf8');
  let row;
  try {
    row = rowFromWranglerJson(text);
  } catch (err) {
    console.log(`::error::Could not read the 09:00 tick's record: ${err.message}`);
    console.log(text.slice(0, 1000));
    process.exit(1);
  }
  const verdict = judgeDailyTick(row, new Date());
  console.log(verdict.ok ? verdict.message : `::error::${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}
