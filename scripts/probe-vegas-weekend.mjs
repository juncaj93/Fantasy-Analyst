/**
 * Why did the two weekly Vegas refreshes fail, and since when?
 *
 * Worker cron watch's first real finding, on 29 September 2026, was that the
 * Saturday 23:00 and Sunday 15:00 UTC runs both ended `exceededResources`. The
 * watch can only see one week back, so "since when" was a claim rather than a
 * measurement. This measures it, and reads the app's own record of how far each
 * run got before it was cut off.
 *
 * Three sources, all read-only:
 *
 *   1. `workersInvocationsScheduled`, one week at a time (the widest range the
 *      API answers), for the two weekend crons only: every run since the start
 *      of September, its status and its CPU time.
 *   2. D1 `cron_run_state`: the last run of each weekend cron, with the steps
 *      it recorded. A step that says `started` and never finished is where the
 *      run died.
 *   3. D1: how fresh the stored lines actually are, and what the Vegas ledger
 *      says was bought, by whom, and when.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (optional), SINCE (default 2026-09-01).
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const SINCE = new Date(process.env.SINCE ?? '2026-09-01T00:00:00Z');
const SCRIPT = 'fantasy-analyst';
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported below */
  }
  return { status: res.status, json, text };
}

if (!ACCOUNT) ACCOUNT = (await call('/accounts')).json?.result?.[0]?.id;

// ---------------------------------------------------------------- 1. history

console.log(`=== Weekend crons since ${SINCE.toISOString()} (Cloudflare analytics) ===`);
const WEEK = 7 * 24 * 3_600_000 - 60_000;
const now = Date.now();
const runs = [];
for (let from = SINCE.getTime(); from < now; from += WEEK) {
  const to = Math.min(from + WEEK, now);
  const r = await call('/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: `query Q($a: String!, $from: Time!, $to: Time!, $s: String!) {
        viewer { accounts(filter: { accountTag: $a }) {
          workersInvocationsScheduled(limit: 10000, orderBy: [datetime_ASC],
            filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $s }) { cron status datetime cpuTimeUs }
        } }
      }`,
      variables: { a: ACCOUNT, from: new Date(from).toISOString(), to: new Date(to).toISOString(), s: SCRIPT },
    }),
  });
  const rows = r.json?.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled;
  if (!Array.isArray(rows)) {
    console.log(`  ${new Date(from).toISOString()} -> ${new Date(to).toISOString()}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
    continue;
  }
  runs.push(...rows.filter((row) => !String(row.cron).startsWith('*/5')));
}
for (const row of runs) {
  const cpu = row.cpuTimeUs == null ? '-' : (Number(row.cpuTimeUs) / 1000).toFixed(1);
  console.log(`  ${row.datetime}  ${String(row.cron).padEnd(13)} ${String(row.status).padEnd(18)} cpu ${cpu}ms`);
}

// ------------------------------------------------------------------ 2 and 3

const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs.json?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
if (!DB) {
  console.error(`Could not resolve the database (HTTP ${dbs.status}).`);
  process.exit(1);
}

const QUERIES = [
  ['cron run records (latest of each cron)', `SELECT cron, started_at, finished_at, outcome, last_success_at, release_sha, steps_json FROM cron_run_state`],
  ['Vegas ledger, last 60 entries', `SELECT at, source, event_id, entities, requests, outcome, reason FROM vegas_usage_log ORDER BY id DESC LIMIT 60`],
  ['Vegas ledger, by day and source', `SELECT substr(at, 1, 10) AS day, source, outcome, COUNT(*) AS n, SUM(entities) AS entities FROM vegas_usage_log WHERE at >= '2026-09-01' GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2`],
  ['Vegas usage by month', `SELECT * FROM vegas_usage ORDER BY month DESC LIMIT 3`],
  ['Vegas settings', `SELECT key, value_json, updated_at FROM settings WHERE key LIKE 'vegas.%'`],
  ['newest stored line per game', `SELECT event_id, game_start, MAX(fetched_at) AS newest, COUNT(*) AS snapshots FROM prop_snapshots WHERE game_start >= '2026-09-20' GROUP BY event_id ORDER BY game_start`],
  ['stored games (vegas_events), upcoming', `SELECT event_id, kickoff, home_team, away_team, seen_at FROM vegas_events WHERE kickoff >= '2026-09-24' ORDER BY kickoff`],
  ['size of what persist() indexes', `SELECT COUNT(*) AS players FROM players`],
  ['size of the snapshots persist() writes', `SELECT event_id, fetched_at, length(raw_json) AS bytes FROM prop_snapshots ORDER BY id DESC LIMIT 12`],
];

for (const [title, sql] of QUERIES) {
  // This probe may only ever read.
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
      .map(([k, v]) => `${k}=${String(v).slice(0, k === 'steps_json' ? 1200 : 160)}`)
      .join('  ');
    console.log(`  ${text}`);
  }
}
