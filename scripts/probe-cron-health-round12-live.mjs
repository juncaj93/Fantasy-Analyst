/**
 * Round 12 (cron health): the round's ONE combined production probe.
 * Read-only, and Sleeper is never called. Run after 7:05 PM ET, then merge.
 *
 *   1. The 09:00 tick's own record of its last run, step by step: one row of
 *      `cron_run_state`, read by its key.
 *   2. BEFORE, on the revision live when it starts: Alex's Team, Waivers,
 *      Trades ideas, Build a trade, and Compare's two lists.
 *   3. It waits (reading only `/api/health`, which touches no database) for
 *      the new revision, lets the deploy check finish, and asks again: AFTER.
 *   4. The two answers compared, path by path.
 *   5. The cron watch as merged, run against Cloudflare.
 *   6. Rows read: today's total at start and end, and the database's own
 *      minute counts for the before and after requests.
 *
 * The Probe workflow runs the D1 budget guard first. Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';
import { CRONS, LOOKBACK_HOURS, judgeAll, readInvocations } from './cron-health-watch.mjs';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID || null;
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES ?? 75);

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const n = (v) => (v == null ? '?' : Math.round(v).toLocaleString('en-US'));

function rowsToday() {
  if (!TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 12 probe'], {
    encoding: 'utf8',
    env: process.env,
  });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

async function getText(path) {
  const started = Date.now();
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    return { status: res.status, ms: Date.now() - started, text };
  } catch (err) {
    return { status: `network error: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started, text: '' };
  }
}

async function sha() {
  const r = await getText('/api/health');
  try {
    return JSON.parse(r.text)?.release?.gitSha ?? null;
  } catch {
    return null;
  }
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function account() {
  if (ACCOUNT) return ACCOUNT;
  ACCOUNT = (await cf('/accounts')).body?.result?.[0]?.id ?? null;
  return ACCOUNT;
}

/* ------------------------------------------------------------ the screens */

async function capture(label, leagueId) {
  const id = encodeURIComponent(leagueId);
  const plan = [
    ['team', `/api/leagues/${id}/lineup`],
    ['waivers', `/api/leagues/${id}/waivers`],
    ['tradeIdeas', '/api/trades/smart?limit=5'],
    ['buildTrade', `/api/leagues/${id}/trades/build?team=all&unmarked=1&cost=1`],
    ['compareMine', `/api/leagues/${id}/compare-pool?tab=mine&position=ALL&q=`],
    ['compareWaivers', `/api/leagues/${id}/compare-pool?tab=waivers&position=ALL&q=`],
  ];
  const from = new Date();
  const out = {};
  for (const [name, path] of plan) {
    const r = await getText(path);
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {
      body = null;
    }
    out[name] = { load: r, body };
    console.log(`${label} ${name.padEnd(14)} HTTP ${r.status} ${r.ms} ms`);
  }
  return { from, to: new Date(), screens: out };
}

function diff(a, b, path = '', out = []) {
  if (out.length > 200) return out;
  if (path === '.cost') return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path || '.'}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

/** The database's own rows-read count over a window, by minute (no database read). */
async function databaseRows(from, to) {
  const minute = (d) => new Date(Math.floor(new Date(d).getTime() / 60_000) * 60_000).toISOString();
  const res = await cf('/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 100, filter: { datetimeMinute_geq: $from, datetimeMinute_leq: $to }) {
          dimensions { databaseId datetimeMinute } sum { rowsRead readQueries }
        } } } }`,
      variables: { a: await account(), from: minute(from), to: minute(to) },
    }),
  });
  const rows = res.body?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const mine = DB_ID ? rows.filter((r) => r.dimensions.databaseId === DB_ID) : rows;
  return mine.reduce((a, r) => ({ rows: a.rows + Number(r.sum.rowsRead), reads: a.reads + Number(r.sum.readQueries) }), { rows: 0, reads: 0 });
}

/* ----------------------------------------------------------------- the run */

console.log(`Started ${eastern()} ET`);
const startRows = rowsToday();
console.log(`D1 rows read today at start: ${n(startRows)}`);

let DB_ID = null;
if (TOKEN) {
  heading("The 4 AM job's own record of its last run (one row, read by its key)");
  try {
    const list = await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`);
    DB_ID = list.body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;
    if (!DB_ID) throw new Error(`database not found (HTTP ${list.status})`);
    const q = await cf(`/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        sql: "SELECT started_at, finished_at, outcome, budget_used, budget_limit, steps_json, release_sha FROM cron_run_state WHERE cron = '0 9 * * *'",
      }),
    });
    const result = q.body?.result?.[0];
    const row = result?.results?.[0];
    if (!row) throw new Error(`no record (HTTP ${q.status} ${JSON.stringify(q.body?.errors ?? '').slice(0, 200)})`);
    console.log(`started ${eastern(row.started_at)} ET, finished ${eastern(row.finished_at)} ET, outcome ${row.outcome}`);
    console.log(`subrequests ${row.budget_used}/${row.budget_limit}, release ${String(row.release_sha).slice(0, 7)}, rows read for this: ${result?.meta?.rows_read ?? '?'}`);
    for (const s of JSON.parse(row.steps_json)) {
      console.log(`   ${s.id.padEnd(24)} ${String(s.outcome).padEnd(14)} ${s.items == null ? '' : `items ${s.items}`}${s.note ? `  (${s.note})` : ''}`);
    }
  } catch (err) {
    console.log(`run record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const startSha = await sha();
heading('Production SHA');
console.log(`live at start: ${startSha ?? '?'}`);

const leagues = await getText('/api/leagues');
let leagueId = process.env.LEAGUE_ID || null;
try {
  leagueId ||= JSON.parse(leagues.text).leagues.find((l) => l.isSelected)?.id ?? null;
} catch {}
if (!leagueId) {
  console.log('no selected league; nothing to compare');
  process.exit(0);
}

heading(`BEFORE (${startSha?.slice(0, 7) ?? '?'})`);
const before = await capture('before', leagueId);

heading('Waiting for the new revision (health only, no database)');
let afterSha = startSha;
let shaSeenAt = null;
const deadline = Date.now() + WAIT_MINUTES * 60_000;
while (Date.now() < deadline) {
  await sleep(20_000);
  const now = await sha();
  if (now && now !== startSha) {
    afterSha = now;
    shaSeenAt = new Date();
    break;
  }
}
if (!shaSeenAt) {
  console.log(`production did not change within ${WAIT_MINUTES} minutes; no AFTER to compare`);
  process.exit(0);
}
console.log(`new revision ${afterSha} seen at ${eastern(shaSeenAt)} ET; letting the deploy check finish`);
await sleep(Number(process.env.SETTLE_SECONDS ?? 420) * 1_000);

heading(`AFTER (${afterSha.slice(0, 7)})`);
const after = await capture('after ', leagueId);

heading("Alex's real output, before and after");
for (const name of Object.keys(before.screens)) {
  const a = before.screens[name].body;
  const b = after.screens[name].body;
  if (a == null || b == null) {
    console.log(`${name}: could not compare (${a == null ? 'before' : 'after'} was not JSON)`);
    continue;
  }
  const changes = diff(a, b);
  const isTime = (c) => /: "\d{4}-\d\d-\d\dT[\d:.]+Z" -> "\d{4}-\d\d-\d\dT[\d:.]+Z"$/.test(c);
  const real = changes.filter((c) => !isTime(c));
  const times = changes.length - real.length;
  console.log(`${name}: ${real.length === 0 ? 'IDENTICAL' : `${real.length} values differ`}${times ? ` (${times} timestamps of when it was read or built moved)` : ''}`);
  for (const c of real.slice(0, 25)) console.log(`   ${c}`);
}

if (TOKEN) {
  heading('The cron watch as merged, against Cloudflare');
  try {
    const now = new Date();
    const read = await readInvocations({ token: TOKEN, account: await account(), from: new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000), to: now });
    const daily = read.rows.filter((r) => r.cron === '0 9 * * *');
    console.log(`source: ${read.source}; 09:00 runs seen: ${daily.map((r) => `${eastern(r.datetime)} ${r.status}`).join(', ') || 'none'}`);
    for (const v of judgeAll(read.rows, now, CRONS, read.lookbackHours)) console.log(`${v.result === 'success' ? 'ok  ' : 'FAIL'}  ${v.name}: ${v.message}`);
  } catch (err) {
    console.log(`watch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  heading("Rows read (the database's own count; it lags, so waiting 5 minutes)");
  await sleep(5 * 60_000);
  try {
    const b = await databaseRows(before.from, before.to);
    const a = await databaseRows(after.from, after.to);
    console.log(`BEFORE requests ${eastern(before.from)}: ${n(b.rows)} rows in ${b.reads} reads (minutes touched, includes anything else running)`);
    console.log(`AFTER requests  ${eastern(after.from)}: ${n(a.rows)} rows in ${a.reads} reads`);
  } catch (err) {
    console.log(`row counts failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const endRows = rowsToday();
console.log(`\nD1 rows read today at end: ${n(endRows)}${startRows != null && endRows != null ? ` (+${n(endRows - startRows)} during this probe, deploy check included)` : ''}`);
console.log(`Finished ${eastern()} ET`);
