/**
 * Round 11 (database reads, part 2): the round's ONE combined production
 * probe. Read-only, and Sleeper is never called.
 *
 * It spans the round's deploy, so "before" and "after" are the same requests
 * against the same data minutes apart:
 *
 *   1. BEFORE, on the revision that is live when it starts: Alex's Team
 *      (`/lineup`), Waivers (`/waivers`), Trades ideas (`/api/trades/smart`),
 *      Build a trade, and Compare's two lists (`/compare-pool`, the same
 *      numbers the comparison draws), the trade screens and Team twice;
 *   2. it waits (reading only `/api/health`, which touches no database) until
 *      production reports a different revision, lets the deploy check finish,
 *      and asks the same requests again: AFTER;
 *   3. the two answers compared, screen by screen, path by path;
 *   4. rows read, from Cloudflare's own analytics (free, no database read):
 *      the before and after windows split into this round's four readers;
 *      the whole of 5 and 6 November for the same four; the position list's
 *      calls hour by hour on both days, and the 09:00 cron's invocations
 *      beside them, to name what ran it 234 times.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET,
 * shortly before the round's PR is merged. Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';
import { fetchInvocations } from './cron-health-watch.mjs';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES ?? 75);

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const easternHour = (d) =>
  new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, month: 'short', day: 'numeric', hour: 'numeric' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const n = (v) => (v == null ? '?' : Math.round(v).toLocaleString('en-US'));

function rowsToday() {
  if (!TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 11 probe'], {
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
    ['team', `/api/leagues/${id}/lineup`, 2],
    ['waivers', `/api/leagues/${id}/waivers`, 1],
    ['tradeIdeas', '/api/trades/smart?limit=5', 2],
    ['buildTrade', `/api/leagues/${id}/trades/build?team=all&unmarked=1&cost=1`, 2],
    ['compareMine', `/api/leagues/${id}/compare-pool?tab=mine&position=ALL&q=`, 1],
    ['compareWaivers', `/api/leagues/${id}/compare-pool?tab=waivers&position=ALL&q=`, 1],
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
    console.log(`${label} ${name.padEnd(14)} ${loads.map((l) => `HTTP ${l.status} ${l.ms} ms`).join(' | ')}${cost}`);
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

/** This round's four readers, old text and new, by the words in each query. */
const FAMILIES = {
  oddsCount: /COUNT\(DISTINCT event_id\) AS events FROM prop_snapshots WHERE scope = 'week'/,
  oddsStamp: /props_freshness/,
  positionsFull: /^SELECT id, position FROM players$/,
  positionsCopy: /players_positions/,
  evidenceOld: /FROM evidence_items WHERE player_id IN \([?,]+\) AND review_status IN/,
  evidenceNew: /FROM evidence_items WHERE player_id IN \([?,]+\) AND \+review_status IN/,
  usageWeeks: /FROM player_usage_weeks WHERE season = \? AND season_type = 'REG' AND week >= \?/,
};

let WITH_DB = true;

async function queryRows(from, to, extraDims = '') {
  const ask = () =>
    graphql(
      `query Q($a: String!, $from: Time!, $to: Time!) {
         viewer { accounts(filter: { accountTag: $a }) {
           d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
             dimensions { query${WITH_DB ? ' databaseId' : ''}${extraDims} }
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
    WITH_DB = false;
    data = await ask();
  }
  const rows = (data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []).map((r) => ({
    q: String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim(),
    db: r.dimensions?.databaseId ?? null,
    hour: r.dimensions?.datetimeHour ?? null,
    read: Number(r.sum?.rowsRead ?? 0),
    calls: Number(r.count ?? 0),
  }));
  // This app's database is the one that holds the player list and the odds snapshots.
  if (!DB_ID) DB_ID = rows.find((r) => /player_aliases|prop_snapshots|players\.snapshot|player_list_stamp/.test(r.q))?.db ?? null;
  return DB_ID ? rows.filter((r) => r.db === DB_ID) : rows;
}

async function rowsIn(from, to) {
  const mine = await queryRows(from, to);
  const total = mine.reduce((a, r) => a + r.read, 0);
  const families = {};
  for (const [name, re] of Object.entries(FAMILIES)) {
    families[name] = mine.filter((r) => re.test(r.q)).reduce((a, r) => ({ read: a.read + r.read, calls: a.calls + r.calls }), { read: 0, calls: 0 });
  }
  return { total, families, top: mine.sort((a, b) => b.read - a.read).slice(0, 6) };
}

function printWindow(label, w) {
  console.log(`${label}: ${n(w.total)} rows read (this app's database)`);
  for (const [name, f] of Object.entries(w.families)) console.log(`   ${name.padEnd(14)} ${n(f.read).padStart(9)} rows in ${String(f.calls).padStart(4)} calls`);
  for (const t of w.top) console.log(`   top ${String(t.calls).padStart(5)}x ${n(t.read).padStart(9)}  ${t.q.slice(0, 100)}`);
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

/* What the position list was doing on 5 and 6 November, before anything else moves. */
if (TOKEN) {
  heading('The position list (SELECT id, position FROM players), hour by hour, Eastern');
  try {
    for (const [label, from, to] of [
      ['5 Nov (UTC day)', '2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z'],
      ['6 Nov (UTC day)', '2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z'],
    ]) {
      const byHour = new Map();
      const add = (hour, r) => {
        const h = byHour.get(hour) ?? { read: 0, calls: 0 };
        h.read += r.read;
        h.calls += r.calls;
        byHour.set(hour, h);
      };
      try {
        for (const r of (await queryRows(from, to, ' datetimeHour')).filter((x) => FAMILIES.positionsFull.test(x.q))) add(r.hour, r);
      } catch {
        // No hour dimension on this dataset: ask one hour at a time instead (free, no database read).
        for (let t = Date.parse(from); t < Math.min(Date.parse(to), Date.now()); t += 3_600_000) {
          const hour = new Date(t).toISOString();
          for (const r of (await queryRows(t, t + 3_600_000)).filter((x) => FAMILIES.positionsFull.test(x.q))) add(hour, r);
        }
      }
      const total = [...byHour.values()].reduce((a, h) => ({ read: a.read + h.read, calls: a.calls + h.calls }), { read: 0, calls: 0 });
      console.log(`${label}: ${n(total.read)} rows in ${total.calls} calls`);
      for (const [hour, h] of [...byHour.entries()].sort()) console.log(`   ${easternHour(hour).padEnd(18)} ${String(h.calls).padStart(4)} calls ${n(h.read).padStart(9)} rows`);
    }
  } catch (err) {
    console.log(`hourly breakdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const runs = await fetchInvocations({ token: TOKEN, account: await account(), from: '2026-11-05T00:00:00Z', to: new Date().toISOString() });
    const daily = runs.filter((r) => r.cron === '0 9 * * *');
    console.log(`\n09:00 cron invocations since 5 Nov (Cloudflare's record): ${daily.length}`);
    const byStatus = new Map();
    for (const r of daily) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    console.log(`   by outcome: ${[...byStatus.entries()].map(([s, c]) => `${s} ${c}`).join(', ') || 'none recorded'}`);
    for (const r of daily.slice(0, 12)) console.log(`   ${eastern(new Date(r.datetime))}  ${r.status}`);
    const five = runs.filter((r) => r.cron === '*/5 * * * *');
    console.log(`five-minute tick invocations since 5 Nov: ${five.length} (all crons: ${runs.length})`);
  } catch (err) {
    console.log(`cron invocations failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    printWindow('\nWhole UTC day 5 Nov', await rowsIn('2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z'));
    printWindow('Whole UTC day 6 Nov', await rowsIn('2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z'));
  } catch (err) {
    console.log(`day totals failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
for (const name of Object.keys(before.screens)) {
  const b = before.screens[name].loads.map((l) => l.ms).join(' / ');
  const a = after.screens[name].loads.map((l) => l.ms).join(' / ');
  console.log(`${name.padEnd(14)} ${b} -> ${a}`);
}

if (!TOKEN) {
  console.log('\nno Cloudflare token; skipping the row counts');
  process.exit(0);
}

heading("Rows read, from Cloudflare's count (it lags; waiting 5 minutes first)");
await sleep(5 * 60_000);
try {
  const b = await rowsIn(before.from, new Date(before.to.getTime() + 5_000));
  const a = await rowsIn(after.from, new Date(after.to.getTime() + 5_000));
  printWindow(`BEFORE requests ${eastern(before.from)} to ${eastern(before.to)}`, b);
  printWindow(`AFTER requests  ${eastern(after.from)} to ${eastern(after.to)}`, a);
  console.log(`\nsame requests: ${n(b.total)} rows before, ${n(a.total)} rows after`);

  console.log("\nThis round's deploy check, minute by minute (new revision first answered in the minute marked *):");
  const start = new Date(Math.floor(shaSeenAt.getTime() / 60_000) * 60_000 - 3 * 60_000);
  let sum = 0;
  for (let m = 0; m < 9; m++) {
    const from = new Date(start.getTime() + m * 60_000);
    const w = await rowsIn(from, new Date(from.getTime() + 60_000));
    sum += w.total;
    const mark = shaSeenAt >= from && shaSeenAt < new Date(from.getTime() + 60_000) ? '*' : ' ';
    console.log(` ${mark} ${eastern(from)}  ${n(w.total).padStart(8)} rows`);
  }
  console.log(`   nine minutes in all: ${n(sum)} rows`);
  console.log(`\n(database told apart: ${DB_ID ? 'yes' : 'no, these are account totals'})`);
} catch (err) {
  console.log(`Cloudflare analytics failed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nD1 rows read today at end: ${n(rowsToday())}`);
console.log(`Finished ${eastern()} ET`);
