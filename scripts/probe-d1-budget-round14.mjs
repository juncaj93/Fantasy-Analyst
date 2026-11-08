/**
 * Round 14, the D1 budget: one combined probe.
 *
 *   node scripts/probe-d1-budget-round14.mjs
 *   STEPS=digest node scripts/probe-d1-budget-round14.mjs   (only the output digest)
 *
 * Parts (STEPS is a comma list of these; empty runs them all):
 *
 *   totals   Rows read and written per day, last 8 days, for this database and
 *            for every database on the account (the caps are shared). From
 *            Cloudflare's analytics, which reads no rows.
 *   writers  The last 24 hours by statement, top writers and top readers.
 *            Sampled by Cloudflare: a single big number is checked against the
 *            totals before it is believed.
 *   hours    Rows written per hour over the last 24 hours, Eastern time.
 *   piles    The tables that only grow (odds snapshots, logs, run records):
 *            how many rows and how old the oldest is, from the first and last
 *            id (a few rows read each, never a full COUNT). Nothing is deleted.
 *   matchup  What one Matchup refresh costs: five reads of the live endpoint
 *            inside one quiet minute, against the same minute of the five-
 *            minute cycle before it.
 *   digest   A fingerprint of Team, Waivers, Trades and Matchup as the app
 *            answers them now, for a before/after comparison around a deploy.
 *
 * Reads only. No odds are bought, nothing is logged in, nothing is written.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (or the token's own account list).
 */

import { createHash } from 'node:crypto';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const STEPS = new Set(
  String(process.env.STEPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const want = (step) => STEPS.size === 0 || STEPS.has(step);

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const eastern = (d = new Date()) =>
  new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
const heading = (t) => console.log(`\n## ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let ACCOUNT = process.env.ACCOUNT_ID || null;
async function account() {
  if (ACCOUNT) return ACCOUNT;
  const res = await cf('/accounts');
  ACCOUNT = res.body?.result?.[0]?.id ?? null;
  return ACCOUNT;
}

async function graphql(query, variables) {
  const res = await cf('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { a: await account(), ...variables } }) });
  if (res.body?.errors?.length) throw new Error(res.body.errors.map((e) => e.message).join(' | '));
  return res.body?.data?.viewer?.accounts?.[0] ?? {};
}

let DB_ID = null;
let probeRowsRead = 0;
async function sql(text) {
  const res = await cf(`/accounts/${await account()}/d1/database/${DB_ID}/query`, { method: 'POST', body: JSON.stringify({ sql: text }) });
  const result = res.body?.result?.[0];
  if (!result) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body?.errors ?? '').slice(0, 200)}`);
  probeRowsRead += Number(result.meta?.rows_read ?? 0);
  return { rows: result.results ?? [], read: Number(result.meta?.rows_read ?? 0) };
}

async function getJson(path) {
  const res = await fetch(`${APP}${path}`, { headers: { 'cache-control': 'no-cache' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body };
}

console.log(`Round 14 D1 budget probe, started ${eastern()} ET`);

if (TOKEN) {
  const list = await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`);
  DB_ID = list.body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;
  console.log(`database fantasy_analyst: ${DB_ID ?? 'not found'}`);
} else {
  console.log('No CLOUDFLARE_API_TOKEN: only the app-side parts (matchup reads, digest) can run.');
}

/* ------------------------------------------------------------------ totals */

async function dailyTotals(days) {
  const today = new Date();
  const from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const acct = await graphql(
    `query Q($a: String!, $from: Date!) { viewer { accounts(filter: { accountTag: $a }) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $from }) {
        dimensions { date databaseId } sum { rowsRead rowsWritten readQueries writeQueries } } } } }`,
    { from },
  );
  return acct.d1AnalyticsAdaptiveGroups ?? [];
}

if (TOKEN && want('totals')) {
  heading('Rows per day (UTC day; Cloudflare resets at 00:00 UTC = 7:00 PM ET). Caps: 5,000,000 read, 100,000 written');
  try {
    const groups = await dailyTotals(8);
    const byDate = new Map();
    for (const g of groups) {
      const d = g.dimensions.date;
      const hit = byDate.get(d) ?? { read: 0, written: 0, mineRead: 0, mineWritten: 0 };
      hit.read += Number(g.sum.rowsRead);
      hit.written += Number(g.sum.rowsWritten);
      if (g.dimensions.databaseId === DB_ID) {
        hit.mineRead += Number(g.sum.rowsRead);
        hit.mineWritten += Number(g.sum.rowsWritten);
      }
      byDate.set(d, hit);
    }
    console.log('  date         account read   (%)   account written  (%)   fantasy_analyst read  written');
    for (const [d, v] of [...byDate].sort()) {
      console.log(
        `  ${d}  ${n(v.read).padStart(13)} ${(v.read / 50_000).toFixed(1).padStart(5)}  ${n(v.written).padStart(15)} ${(v.written / 1_000).toFixed(1).padStart(5)}   ${n(v.mineRead).padStart(18)} ${n(v.mineWritten).padStart(8)}`,
      );
    }
  } catch (err) {
    console.log(`totals failed: ${err.message}`);
  }
}

/* ----------------------------------------------------------------- writers */

async function byStatement(from, to, order) {
  const acct = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [${order}]) {
        count dimensions { query databaseId } sum { rowsRead rowsWritten } } } } }`,
    { from, to },
  );
  const agg = new Map();
  for (const r of acct.d1QueriesAdaptiveGroups ?? []) {
    if (DB_ID && r.dimensions?.databaseId && r.dimensions.databaseId !== DB_ID) continue;
    const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
    const hit = agg.get(q) ?? { calls: 0, read: 0, written: 0 };
    hit.calls += Number(r.count ?? 0);
    hit.read += Number(r.sum?.rowsRead ?? 0);
    hit.written += Number(r.sum?.rowsWritten ?? 0);
    agg.set(q, hit);
  }
  return [...agg];
}

if (TOKEN && want('writers')) {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  try {
    const rows = await byStatement(from, now.toISOString(), 'sum_rowsWritten_DESC');
    const totalW = rows.reduce((s, [, v]) => s + v.written, 0);
    const totalR = rows.reduce((s, [, v]) => s + v.read, 0);
    heading(`Last 24 hours by statement (sampled): ${n(totalW)} written, ${n(totalR)} read`);
    console.log('  top writers:  calls   written     read  query');
    for (const [q, v] of rows.filter(([, v]) => v.written > 0).sort((a, b) => b[1].written - a[1].written).slice(0, 25)) {
      console.log(`  ${String(v.calls).padStart(12)} ${n(v.written).padStart(9)} ${n(v.read).padStart(8)}  ${q.slice(0, 160)}`);
    }
    console.log('  top readers:  calls      read  written  query');
    for (const [q, v] of rows.sort((a, b) => b[1].read - a[1].read).slice(0, 20)) {
      console.log(`  ${String(v.calls).padStart(12)} ${n(v.read).padStart(9)} ${n(v.written).padStart(8)}  ${q.slice(0, 160)}`);
    }
  } catch (err) {
    console.log(`writers failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------- hours */

if (TOKEN && DB_ID && want('hours')) {
  heading('Rows per hour, last 24 hours (Eastern)');
  try {
    const now = new Date();
    const from = new Date(Math.floor((now.getTime() - 24 * 3_600_000) / 3_600_000) * 3_600_000).toISOString();
    const acct = await graphql(
      `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 2000, filter: { datetimeHour_geq: $from, datetimeHour_leq: $to }) {
          dimensions { databaseId datetimeHour } sum { rowsRead rowsWritten } } } } }`,
      { from, to: now.toISOString() },
    );
    const mine = (acct.d1AnalyticsAdaptiveGroups ?? []).filter((g) => g.dimensions.databaseId === DB_ID);
    for (const g of mine.sort((a, b) => a.dimensions.datetimeHour.localeCompare(b.dimensions.datetimeHour))) {
      console.log(`  ${eastern(g.dimensions.datetimeHour).padEnd(22)} read ${n(g.sum.rowsRead).padStart(9)}  written ${n(g.sum.rowsWritten).padStart(7)}`);
    }
  } catch (err) {
    console.log(`hours failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------- piles */

const PILES = [
  ['prop_snapshots', 'id', 'fetched_at', 'odds snapshots, one per game per fetch'],
  ['player_props', 'id', null, 'odds lines, many per snapshot'],
  ['vegas_usage_log', 'id', 'at', 'odds request log'],
  ['sync_log', 'id', 'started_at', 'sync log'],
  ['injury_source_runs', 'id', 'fetched_at', 'injury feed run log'],
  ['nflverse_source_runs', 'id', 'fetched_at', 'nflverse feed run log'],
  ['usage_source_runs', 'id', 'fetched_at', 'usage feed run log'],
  ['player_season_stats_runs', 'id', 'fetched_at', 'season stats run log'],
  ['decision_feed_events', 'id', 'occurred_at', 'decision feed'],
  ['adp_snapshots', 'id', 'imported_at', 'ADP imports'],
  ['adp_rows', 'id', null, 'ADP rows, many per import'],
];

if (TOKEN && DB_ID && want('piles')) {
  heading('Tables that only grow (rows from first and last id; nothing deleted)');
  for (const [table, id, at, label] of PILES) {
    try {
      const oldest = at ? `, (SELECT ${at} FROM ${table} ORDER BY ${id} LIMIT 1) AS oldest, (SELECT ${at} FROM ${table} ORDER BY ${id} DESC LIMIT 1) AS newest` : '';
      const { rows, read } = await sql(`SELECT (SELECT MIN(${id}) FROM ${table}) AS lo, (SELECT MAX(${id}) FROM ${table}) AS hi${oldest}`);
      const r = rows[0] ?? {};
      const span = r.hi == null ? 0 : Number(r.hi) - Number(r.lo) + 1;
      const age = r.oldest ? `${Math.round((Date.now() - Date.parse(r.oldest)) / 86_400_000)} days` : '';
      console.log(
        `  ${table.padEnd(26)} up to ${n(span).padStart(9)} rows (ids ${r.lo ?? '-'}..${r.hi ?? '-'})${r.oldest ? `  oldest ${String(r.oldest).slice(0, 10)} (${age})  newest ${String(r.newest).slice(0, 10)}` : ''}  [${label}; probe read ${read}]`,
      );
    } catch (err) {
      console.log(`  ${table}: ${err.message}`);
    }
  }
  try {
    const { rows, read } = await sql(`SELECT MIN(captured_at) AS oldest, MAX(captured_at) AS newest FROM trending_snapshots`);
    console.log(`  trending_snapshots         oldest ${String(rows[0]?.oldest ?? '-').slice(0, 10)}  newest ${String(rows[0]?.newest ?? '-').slice(0, 10)}  [probe read ${read}]`);
  } catch (err) {
    console.log(`  trending_snapshots: ${err.message}`);
  }
  try {
    const { rows, read } = await sql(`SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl`);
    if (rows.length) {
      console.log(`  sqlite_stat1 row estimates (from the last ANALYZE; probe read ${read}):`);
      const seen = new Set();
      for (const r of rows) {
        if (seen.has(r.tbl)) continue;
        seen.add(r.tbl);
        console.log(`    ${String(r.tbl).padEnd(32)} ~${n(String(r.stat).split(' ')[0])}`);
      }
    }
  } catch (err) {
    console.log(`  sqlite_stat1: ${err.message}`);
  }
}

/* ----------------------------------------------------------------- matchup */

async function minuteRows(fromIso, toIso) {
  const acct = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      d1AnalyticsAdaptiveGroups(limit: 200, filter: { datetimeMinute_geq: $from, datetimeMinute_leq: $to }) {
        dimensions { databaseId datetimeMinute } sum { rowsRead rowsWritten readQueries } } } } }`,
    { from: fromIso, to: toIso },
  );
  const out = new Map();
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    if (g.dimensions.databaseId !== DB_ID) continue;
    out.set(new Date(g.dimensions.datetimeMinute).toISOString(), { read: Number(g.sum.rowsRead), written: Number(g.sum.rowsWritten), queries: Number(g.sum.readQueries) });
  }
  return out;
}

let leagueId = process.env.LEAGUE_ID || null;
async function selectedLeague() {
  if (leagueId) return leagueId;
  const res = await getJson('/api/leagues');
  leagueId = (res.body?.leagues ?? []).find((l) => l.isSelected)?.id ?? null;
  return leagueId;
}

if (want('matchup')) {
  heading('What one Matchup refresh costs');
  const id = await selectedLeague();
  if (!id) {
    console.log('no selected league');
  } else {
    const path = `/api/leagues/${encodeURIComponent(id)}/matchup`;
    const first = await getJson(path);
    console.log(`matchup: HTTP ${first.status}, phase ${first.body?.forecast?.phase ?? '?'}, week ${first.body?.forecast?.week ?? first.body?.week ?? '?'}`);
    // A quiet minute: not one the five-minute cron runs in (minute % 5 == 0), nor the one after.
    for (;;) {
      const d = new Date();
      if (d.getUTCMinutes() % 5 === 2 && d.getUTCSeconds() < 15) break;
      await sleep(5_000);
    }
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const K = 5;
    const started = Date.now();
    for (let i = 0; i < K; i++) {
      await getJson(path);
      await sleep(2_000);
    }
    console.log(`${K} refreshes in the minute starting ${eastern(minute)} ET (${Math.round((Date.now() - started) / 1000)}s)`);
    if (TOKEN && DB_ID) {
      console.log('waiting four minutes for Cloudflare analytics to catch up...');
      await sleep(4 * 60_000 + 20_000);
      const baseMinute = new Date(minute.getTime() - 5 * 60_000);
      const rows = await minuteRows(new Date(baseMinute.getTime() - 5 * 60_000).toISOString(), minute.toISOString());
      const at = rows.get(minute.toISOString()) ?? { read: 0, written: 0, queries: 0 };
      const base = rows.get(baseMinute.toISOString()) ?? { read: 0, written: 0, queries: 0 };
      const base2 = rows.get(new Date(baseMinute.getTime() - 5 * 60_000).toISOString()) ?? { read: 0, written: 0, queries: 0 };
      const baseline = Math.min(base.read, base2.read);
      const per = Math.max(0, Math.round((at.read - baseline) / K));
      console.log(`  that minute: ${n(at.read)} rows read, ${n(at.written)} written, ${n(at.queries)} queries`);
      console.log(`  same minute 5 and 10 min earlier (no probe): ${n(base.read)} and ${n(base2.read)} rows read`);
      console.log(`  => about ${n(per)} rows read per Matchup refresh (writes per refresh: ${Math.max(0, Math.round((at.written - Math.min(base.written, base2.written)) / K))})`);
      console.log(`  one open, visible tab polling every 30 s: ${n(per * 120)} rows an hour; a full Sunday (1 PM to 11:30 PM, 10.5 h live) ${n(per * 120 * 10.5)}`);
      try {
        const stmts = await byStatement(minute.toISOString(), new Date(minute.getTime() + 60_000).toISOString(), 'sum_rowsRead_DESC');
        console.log('  statements in that minute (sampled):');
        for (const [q, v] of stmts.sort((a, b) => b[1].read - a[1].read).slice(0, 12)) {
          console.log(`  ${String(v.calls).padStart(6)} ${n(v.read).padStart(8)}  ${q.slice(0, 150)}`);
        }
      } catch (err) {
        console.log(`  statements failed: ${err.message}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ digest */

/** Drop fields that move on their own (clocks, ages), so the digest is about decisions. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (/(^|_)(at|now|ts|ms)$|At$|Ms$|^(generated|fetched|captured|checked|updated|asOf|age|stale|freshness|served|cache|elapsed|took)/i.test(key)) continue;
      out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}
const digestOf = (body) => createHash('sha256').update(JSON.stringify(stable(body))).digest('hex').slice(0, 16);

if (want('digest')) {
  heading('Output digest: Team, Waivers, Trades, Matchup (compare before and after a deploy)');
  const id = await selectedLeague();
  if (!id) {
    console.log('no selected league');
  } else {
    const e = encodeURIComponent(id);
    const health = await getJson('/api/health');
    console.log(`live revision ${health.body?.release?.gitSha ?? '?'}`);
    for (const [label, path] of [
      ['Team (lineup)', `/api/leagues/${e}/lineup`],
      ['Team (roster)', `/api/leagues/${e}/roster`],
      ['Waivers', `/api/leagues/${e}/waivers`],
      ['Trades', '/api/trades/smart'],
      ['Matchup', `/api/leagues/${e}/matchup`],
    ]) {
      const res = await getJson(path);
      console.log(`  ${label.padEnd(16)} HTTP ${res.status}  ${res.body ? digestOf(res.body) : '(not JSON)'}  ${n(res.text.length)} bytes`);
    }
  }
}

heading('This probe');
console.log(`rows read by this probe's own SQL: ${n(probeRowsRead)}`);
console.log(`finished ${eastern()} ET`);
