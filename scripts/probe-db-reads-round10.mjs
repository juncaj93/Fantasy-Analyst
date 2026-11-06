/**
 * Round 10 (database reads and the deploy check): the round's ONE combined
 * production probe. Read-only, and Sleeper is never called.
 *
 * It spans the round's deploy, so "before" and "after" are the same requests
 * against the same data minutes apart:
 *
 *   1. BEFORE, on the revision that is live when it starts: Alex's Team
 *      (`/lineup`), Waivers (`/waivers`), Trades ideas (`/api/trades/smart`)
 *      and Build a trade (`/trades/build?team=all&unmarked=1&cost=1`), each
 *      timed, the two trade screens twice (first and second load);
 *   2. it then waits (reading only `/api/health`, which touches no database)
 *      until production reports a different revision, lets the deploy check
 *      finish, and asks the same requests again: AFTER;
 *   3. the two answers compared, screen by screen, path by path;
 *   4. rows read, from Cloudflare's own analytics (free, no database read):
 *      the before and after windows, the player-list reads in each, this
 *      round's deploy check minute by minute, and Round 8's deploy check
 *      (5 November, 11:26 AM ET) for comparison.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET,
 * shortly before the round's PR is merged. Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES ?? 75);
/* Round 8's deploy check: release checks then the iPhone gate, attempt 2 (attempt 1 died at 16:18:49 on curl 56). */
const ROUND8_CHECK = [
  ['2026-11-05T16:18:40Z', '2026-11-05T16:18:55Z'],
  ['2026-11-05T16:26:10Z', '2026-11-05T16:27:45Z'],
];

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const n = (v) => (v == null ? '?' : Math.round(v).toLocaleString('en-US'));

function rowsToday() {
  if (!TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 10 probe'], {
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

/* ------------------------------------------------------------ the screens */

async function capture(label, leagueId) {
  const id = encodeURIComponent(leagueId);
  const plan = [
    ['team', `/api/leagues/${id}/lineup`, 1],
    ['waivers', `/api/leagues/${id}/waivers`, 1],
    ['tradeIdeas', '/api/trades/smart?limit=5', 2],
    ['buildTrade', `/api/leagues/${id}/trades/build?team=all&unmarked=1&cost=1`, 2],
  ];
  const from = new Date();
  const out = {};
  for (const [name, path, times] of plan) {
    const loads = [];
    let body = null;
    for (let i = 0; i < times; i++) {
      const r = await getText(path);
      loads.push(r);
      try {
        body = JSON.parse(r.text);
      } catch {
        body = null;
      }
    }
    out[name] = { loads, body };
    const cost = body?.cost ? `, rows returned ${n(body.cost.rowsReturned)} in ${body.cost.statements} statements` : '';
    console.log(`${label} ${name.padEnd(10)} ${loads.map((l) => `HTTP ${l.status} ${l.ms} ms`).join(' | ')}${cost}`);
    if (name === 'buildTrade' && body?.cost?.top) {
      for (const t of body.cost.top.slice(0, 4)) console.log(`      ${String(t.rows).padStart(6)} rows ${t.calls}x  ${t.sql.slice(0, 90)}`);
    }
  }
  return { from, to: new Date(), screens: out };
}

/** Every path where two answers differ (the build's own `cost` line aside). */
function diff(a, b, path = '', out = []) {
  if (out.length > 200) return out;
  if (path === '.cost') return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path || '.'}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

/* ------------------------------------------------------ Cloudflare's count */

let ACCOUNT = process.env.ACCOUNT_ID || null;
let DB_ID = null;

async function graphql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

async function account() {
  if (ACCOUNT) return ACCOUNT;
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${TOKEN}` } });
  ACCOUNT = (await res.json().catch(() => null))?.result?.[0]?.id ?? null;
  return ACCOUNT;
}

/** Rows read per query in a window, this app's database only when it can be told apart. */
let WITH_DB = true;

async function rowsIn(from, to) {
  const ask = () =>
    graphql(
      `query Q($a: String!, $from: Time!, $to: Time!) {
         viewer { accounts(filter: { accountTag: $a }) {
           d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
             dimensions { query${WITH_DB ? ' databaseId' : ''} }
             sum { rowsRead }
             count
           }
         } }
       }`,
      { a: ACCOUNT, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    );
  await account();
  let data;
  try {
    data = await ask();
  } catch (err) {
    if (!WITH_DB) throw err;
    // No per-database dimension on this dataset: fall back to account totals, and say so.
    WITH_DB = false;
    data = await ask();
  }
  const rows = (data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []).map((r) => ({
    q: String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim(),
    db: r.dimensions?.databaseId ?? null,
    read: Number(r.sum?.rowsRead ?? 0),
    calls: Number(r.count ?? 0),
  }));
  // This app's database is the one that holds the player list and the odds snapshots.
  if (!DB_ID) DB_ID = rows.find((r) => /player_aliases|prop_snapshots|players\.snapshot|player_list_stamp/.test(r.q))?.db ?? null;
  const mine = DB_ID ? rows.filter((r) => r.db === DB_ID) : rows;
  const total = mine.reduce((a, r) => a + r.read, 0);
  const list = (re) => mine.filter((r) => re.test(r.q)).reduce((a, r) => ({ read: a.read + r.read, calls: a.calls + r.calls }), { read: 0, calls: 0 });
  return {
    total,
    fullList: list(/FROM players\s+WHERE active = 1 AND position NOT IN/),
    storedCopy: list(/key >= \? AND key < \?/),
    stamp: list(/player_list_stamp/),
    top: mine.sort((a, b) => b.read - a.read).slice(0, 6),
  };
}

function printWindow(label, w) {
  console.log(`${label}: ${n(w.total)} rows read (this app's database)`);
  console.log(`   full player list: ${n(w.fullList.read)} rows in ${w.fullList.calls} calls; stored copy: ${n(w.storedCopy.read)} rows in ${w.storedCopy.calls} calls; stamp checks: ${n(w.stamp.read)} rows in ${w.stamp.calls} calls`);
  for (const t of w.top) console.log(`   ${String(t.calls).padStart(5)}x ${n(t.read).padStart(9)}  ${t.q.slice(0, 110)}`);
}

/* ----------------------------------------------------------------- the run */

console.log(`Started ${eastern()} ET`);
console.log(`D1 rows read today at start: ${n(rowsToday())}`);

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
// The release checks and the iPhone gate run in the next few minutes; stay out of their window.
await sleep(Number(process.env.SETTLE_SECONDS ?? 360) * 1_000);

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
  // A stamp of when something was read or built moves on its own; a value moving is a real change.
  const isTime = (c) => /: "\d{4}-\d\d-\d\dT[\d:.]+Z" -> "\d{4}-\d\d-\d\dT[\d:.]+Z"$/.test(c);
  const real = changes.filter((c) => !isTime(c));
  const times = changes.length - real.length;
  console.log(
    `${name}: ${real.length === 0 ? 'IDENTICAL' : `${real.length} values differ`}${times ? ` (${times} timestamps of when it was read or built moved)` : ''}`,
  );
  for (const c of real.slice(0, 25)) console.log(`   ${c}`);
  for (const c of changes.filter(isTime).slice(0, 5)) console.log(`   time only: ${c}`);
}

heading('Load times (ms), before -> after');
for (const name of ['tradeIdeas', 'buildTrade', 'team', 'waivers']) {
  const b = before.screens[name].loads.map((l) => l.ms).join(' / ');
  const a = after.screens[name].loads.map((l) => l.ms).join(' / ');
  console.log(`${name.padEnd(10)} ${b} -> ${a}  (first load / second load)`);
}

if (!TOKEN) {
  console.log('\nno Cloudflare token; skipping the row counts');
  process.exit(0);
}

heading("Rows read, from Cloudflare's count (it lags; waiting 5 minutes first)");
await sleep(5 * 60_000);
try {
  printWindow(`BEFORE requests ${eastern(before.from)} to ${eastern(before.to)}`, await rowsIn(before.from, new Date(before.to.getTime() + 5_000)));
  printWindow(`AFTER requests  ${eastern(after.from)} to ${eastern(after.to)}`, await rowsIn(after.from, new Date(after.to.getTime() + 5_000)));

  console.log("\nThis round's deploy check, minute by minute (new revision first answered in the minute marked *):");
  const start = new Date(Math.floor(shaSeenAt.getTime() / 60_000) * 60_000 - 3 * 60_000);
  let sum = 0;
  for (let m = 0; m < 9; m++) {
    const from = new Date(start.getTime() + m * 60_000);
    const w = await rowsIn(from, new Date(from.getTime() + 60_000));
    sum += w.total;
    const mark = shaSeenAt >= from && shaSeenAt < new Date(from.getTime() + 60_000) ? '*' : ' ';
    console.log(` ${mark} ${eastern(from)}  ${n(w.total).padStart(8)} rows  (full list ${w.fullList.calls}x, stored copy ${w.storedCopy.calls}x)`);
  }
  console.log(`   nine minutes in all: ${n(sum)} rows`);

  console.log("\nRound 8's deploy check (5 Nov), for comparison:");
  let r8 = 0;
  for (const [from, to] of ROUND8_CHECK) {
    const w = await rowsIn(from, to);
    r8 += w.total;
    printWindow(`  ${eastern(new Date(from))} to ${eastern(new Date(to))}`, w);
  }
  console.log(`   Round 8 deploy check in all: ${n(r8)} rows`);
  console.log(`\n(database told apart: ${DB_ID ? 'yes' : 'no, these are account totals'})`);
} catch (err) {
  console.log(`Cloudflare analytics failed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nD1 rows read today at end: ${n(rowsToday())}`);
console.log(`Finished ${eastern()} ET`);
