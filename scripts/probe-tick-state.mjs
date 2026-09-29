/**
 * What the five-minute tick's own bookkeeping says, read straight from D1.
 *
 * Companion to probe-cron-outcomes.mjs. That one says *that* the tick was cut
 * off for CPU from 27 September 09:15 UTC to 28 September 05:40 UTC, and that
 * the killed runs had already logged the injury check's 304. This reads the
 * state rows each later step keeps -- the injury gap watermark, the schedule's
 * last check, the backfill's progress, the nflverse feeds -- so the step that
 * kept being retried can be named from its own record rather than inferred.
 *
 * Read-only: SELECTs only, through D1's HTTP query endpoint (the Probe
 * workflow installs nothing, so wrangler is not there).
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (optional; discovered from the token).
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is required.');
  process.exit(1);
}

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

if (!ACCOUNT) ACCOUNT = (await call('/accounts')).json?.result?.[0]?.id;
const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs.json?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
if (!DB) {
  console.error(`Could not resolve the database (HTTP ${dbs.status}).`);
  process.exit(1);
}

const QUERIES = [
  ['injury source state', `SELECT * FROM injury_source_state`],
  ['nflverse/schedule source state', `SELECT * FROM nflverse_source_state`],
  ['injury backfill progress', `SELECT * FROM injury_backfill_progress`],
  ['cron run records', `SELECT * FROM cron_run_state`],
  ['injury rows by week (2026)', `SELECT week, COUNT(*) AS n, MIN(fetched_at) AS first, MAX(fetched_at) AS last FROM player_injury_reports WHERE season = '2026' GROUP BY week ORDER BY week`],
  ['recent injury runs', `SELECT fetched_at, latest_week, rows_returned, outcome, note FROM injury_source_runs ORDER BY fetched_at DESC LIMIT 12`],
  ['recent nflverse runs', `SELECT * FROM nflverse_source_runs ORDER BY rowid DESC LIMIT 12`],
  ['nflverse write ledger, by day', `SELECT * FROM nflverse_write_budget ORDER BY 1 DESC LIMIT 12`],
];

for (const [title, sql] of QUERIES) {
  // Belt and braces: this probe may only ever read.
  if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
  const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  console.log('');
  console.log(`=== ${title} ===`);
  if (!r.json?.success) {
    console.log(`  HTTP ${r.status}: ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`);
    continue;
  }
  const rows = r.json.result?.[0]?.results ?? [];
  if (!rows.length) console.log('  (no rows)');
  for (const row of rows) {
    const text = Object.entries(row)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${String(v).slice(0, 160)}`)
      .join('  ');
    console.log(`  ${text}`);
  }
}
