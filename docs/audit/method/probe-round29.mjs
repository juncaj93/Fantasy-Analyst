/**
 * Round 29 (full audit, report only): the round's ONE combined production read.
 *
 * Reads only. No odds are bought, nothing is logged in, nothing is written.
 * Lives on the audit branch only and is removed before the docs-only PR.
 *
 * Parts (STEPS is a comma list; empty runs them all):
 *
 *   sha         /api/health (reads no database rows).
 *   totals      Rows read and written per UTC day, last 10 days, app and account
 *               (Cloudflare analytics, reads no database rows).
 *   hours       App rows read and written per hour, last 80 hours, Eastern.
 *   statements  Rows by statement (sampled by Cloudflare), last 72 hours and
 *               since the Round 28 deploy, checked against the totals.
 *   crons       Every scheduled invocation, last 72 hours, by cron and status;
 *               fetch requests by status per day (analytics).
 *   tables      Small run-state tables: cron_run_state, newest injury runs.
 *   freshness   When each start/sit input was last fetched (indexed, few rows).
 *   forecasts   matchup_forecasts for this season (about 100 rows).
 *   screens     Each screen's own answer, as the phone reads it (GET only).
 *   snapshots   Support snapshots (lineup, matchup, waiver-plan; trade-offer is the old Smart Trades).
 *   gather      Saved data for the accuracy backtest (weeks 8 to 11).
 *
 * Everything gathered is printed once at the end as gzip + base64 between two
 * marker lines, with the league ids scrubbed out (the repository is public and
 * an encoded id would not be masked), so the analysis runs with no further read.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID, SLEEPER_LEAGUE_ID (Probe workflow).
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
let ACCOUNT = process.env.ACCOUNT_ID || null;
const STEPS = new Set(String(process.env.STEPS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const want = (s) => STEPS.size === 0 || STEPS.has(s);
/** The Round 28 deploy finished here (Deploy run 43747935053). */
const ROUND28_LIVE = '2026-11-15T18:43:42Z';

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const et = (iso) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const heading = (t) => console.log(`\n## ${t}`);
const bundle = { meta: { startedAt: new Date().toISOString() }, errors: {} };
const appRowsBefore = { at: null };

async function part(name, run) {
  if (!want(name)) return;
  const t0 = Date.now();
  try {
    await run();
  } catch (err) {
    bundle.errors[name] = String(err?.stack ?? err).slice(0, 1500);
    console.log(`  ${name} failed: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  console.log(`  (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/* ------------------------------------------------------------ Cloudflare */
/* REHEARSE_DB=<sqlite file>: a local rehearsal. Cloudflare answers nothing, SQL runs on the file. */
const REHEARSE = process.env.REHEARSE_DB ?? '';
let rehearsalDb = null;
async function cf(path, init = {}) {
  if (REHEARSE) {
    if (!rehearsalDb) rehearsalDb = new (await import('node:sqlite')).DatabaseSync(REHEARSE);
    if (path === '/accounts') return { status: 200, body: { result: [{ id: 'rehearsal' }] } };
    if (path.includes('/d1/database?name=')) return { status: 200, body: { result: [{ name: 'fantasy_analyst', uuid: 'rehearsal' }] } };
    if (path.endsWith('/query')) {
      const { sql: text } = JSON.parse(init.body);
      const rows = rehearsalDb.prepare(text).all();
      return { status: 200, body: { result: [{ results: rows, meta: { rows_read: rows.length } }] } };
    }
    return { status: 200, body: { data: { viewer: { accounts: [{}] }, __type: { fields: [] } } } };
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function account() {
  if (ACCOUNT) return ACCOUNT;
  ACCOUNT = (await cf('/accounts')).body?.result?.[0]?.id ?? null;
  return ACCOUNT;
}
async function graphql(query, variables) {
  const res = await cf('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { a: await account(), ...variables } }) });
  if (res.body?.errors?.length) throw new Error(res.body.errors.map((e) => e.message).join(' | '));
  return res.body?.data?.viewer?.accounts?.[0] ?? {};
}
function unwrap(t) {
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
}
async function fieldsOf(name) {
  const res = await cf('/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: `query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } }`,
      variables: { n: name },
    }),
  });
  return res.body?.data?.__type?.fields ?? [];
}
let DB_ID = null;
let probeRows = 0;
const sqlLog = [];
async function sql(label, text) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error('read-only');
  const res = await cf(`/accounts/${await account()}/d1/database/${DB_ID}/query`, { method: 'POST', body: JSON.stringify({ sql: text }) });
  const result = res.body?.result?.[0];
  if (!result) throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(res.body?.errors ?? '').slice(0, 300)}`);
  const read = Number(result.meta?.rows_read ?? 0);
  probeRows += read;
  sqlLog.push({ label, read, rows: (result.results ?? []).length });
  return result.results ?? [];
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** One query that may fail on its own without stopping the part it belongs to. */
async function q(label, text) {
  try {
    return await sql(label, text);
  } catch (err) {
    bundle.errors[`sql ${label}`] = String(err?.message ?? err).slice(0, 300);
    console.log(`  (${label} failed: ${String(err?.message ?? err).slice(0, 160)})`);
    return [];
  }
}

/* ------------------------------------------------------------------- app */
async function getApp(path, init = {}) {
  const t0 = Date.now();
  const res = await fetch(`${APP}${path}`, {
    ...init,
    signal: AbortSignal.timeout(90_000),
    headers: { 'cache-control': 'no-cache', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, ms: Date.now() - t0, bytes: text.length, body, text: body ? null : text.slice(0, 400) };
}
async function sleeper(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://api.sleeper.app/v1${path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

console.log(`Round 29 full-audit probe, started ${et(new Date().toISOString())} ET`);
if (!TOKEN) {
  console.log('No CLOUDFLARE_API_TOKEN: nothing to do.');
  process.exit(0);
}
DB_ID = (await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`)).body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;
console.log(`database fantasy_analyst: ${DB_ID ? 'found' : 'not found'}`);

/* -------------------------------------------------------------------- sha */
await part('sha', async () => {
  heading('Production');
  const h = await getApp('/api/health');
  bundle.health = h.body;
  console.log(`  live revision ${h.body?.release?.gitSha ?? '?'} (HTTP ${h.status}, ${h.ms} ms)`);
});

/* ----------------------------------------------------------------- totals */
await part('totals', async () => {
  heading('Rows per UTC day (resets 7:00 PM ET). Caps: 5,000,000 read, 100,000 written');
  const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const acct = await graphql(
    `query Q($a: String!, $from: Date!) { viewer { accounts(filter: { accountTag: $a }) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $from }) {
        dimensions { date databaseId } sum { rowsRead rowsWritten readQueries writeQueries } } } } }`,
    { from },
  );
  const byDate = new Map();
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    const v = byDate.get(g.dimensions.date) ?? { read: 0, written: 0, appRead: 0, appWritten: 0, appReadQ: 0, appWriteQ: 0, dbs: 0 };
    v.read += Number(g.sum.rowsRead);
    v.written += Number(g.sum.rowsWritten);
    v.dbs += 1;
    if (g.dimensions.databaseId === DB_ID) {
      v.appRead += Number(g.sum.rowsRead);
      v.appWritten += Number(g.sum.rowsWritten);
      v.appReadQ += Number(g.sum.readQueries ?? 0);
      v.appWriteQ += Number(g.sum.writeQueries ?? 0);
    }
    byDate.set(g.dimensions.date, v);
  }
  bundle.totals = Object.fromEntries(byDate);
  console.log('  date        account read  (%)   account written (%)   app read    app written  app queries r/w   databases');
  for (const [d, v] of [...byDate].sort()) {
    console.log(
      `  ${d} ${n(v.read).padStart(12)} ${(v.read / 50_000).toFixed(1).padStart(5)} ${n(v.written).padStart(13)} ${(v.written / 1_000).toFixed(1).padStart(5)} ${n(v.appRead).padStart(11)} ${n(v.appWritten).padStart(11)}  ${n(v.appReadQ).padStart(7)}/${n(v.appWriteQ).padEnd(6)} ${v.dbs}`,
    );
  }
});

/* ------------------------------------------------------------------ hours */
await part('hours', async () => {
  heading('App rows per hour, last 80 hours (Eastern)');
  const now = new Date();
  const from = new Date(Math.floor((now.getTime() - 80 * 3_600_000) / 3_600_000) * 3_600_000).toISOString();
  const acct = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      d1AnalyticsAdaptiveGroups(limit: 5000, filter: { datetimeHour_geq: $from, datetimeHour_leq: $to }) {
        dimensions { databaseId datetimeHour } sum { rowsRead rowsWritten readQueries writeQueries } } } } }`,
    { from, to: now.toISOString() },
  );
  const mine = (acct.d1AnalyticsAdaptiveGroups ?? []).filter((g) => g.dimensions.databaseId === DB_ID);
  const others = new Map();
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    if (g.dimensions.databaseId === DB_ID) continue;
    others.set(g.dimensions.datetimeHour, (others.get(g.dimensions.datetimeHour) ?? 0) + Number(g.sum.rowsRead));
  }
  bundle.hours = mine
    .map((g) => ({ hour: g.dimensions.datetimeHour, read: Number(g.sum.rowsRead), written: Number(g.sum.rowsWritten), readQ: Number(g.sum.readQueries ?? 0), writeQ: Number(g.sum.writeQueries ?? 0), othersRead: others.get(g.dimensions.datetimeHour) ?? 0 }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  for (const h of bundle.hours) {
    console.log(`  ${et(h.hour).padEnd(20)} read ${n(h.read).padStart(10)}  written ${n(h.written).padStart(7)}  queries ${n(h.readQ).padStart(6)}  other sites read ${n(h.othersRead).padStart(9)}`);
  }
});

/* ------------------------------------------------------------- statements */
await part('statements', async () => {
  const qFields = (await fieldsOf('AccountD1QueriesAdaptiveGroupsSum')).map((f) => f.name);
  const sumFields = ['rowsRead', 'rowsWritten', 'rowsReturned', 'queryDurationMs'].filter((f) => qFields.length === 0 || qFields.includes(f));
  const windows = [
    ['last 72 hours', new Date(Date.now() - 72 * 3_600_000).toISOString(), new Date().toISOString()],
    ['since the Round 28 deploy', ROUND28_LIVE, new Date().toISOString()],
  ];
  bundle.statements = {};
  for (const [label, from, to] of windows) {
    heading(`Statements, ${label} (sampled by Cloudflare; compared with the hourly totals)`);
    const rows = [];
    for (const order of ['sum_rowsRead_DESC', 'sum_rowsWritten_DESC']) {
      const acct = await graphql(
        `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
          d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [${order}]) {
            count dimensions { query databaseId } sum { ${sumFields.join(' ')} } } } } }`,
        { from, to },
      );
      for (const r of acct.d1QueriesAdaptiveGroups ?? []) {
        if (r.dimensions?.databaseId && r.dimensions.databaseId !== DB_ID) continue;
        rows.push({ q: String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim(), calls: Number(r.count ?? 0), read: Number(r.sum?.rowsRead ?? 0), written: Number(r.sum?.rowsWritten ?? 0), returned: Number(r.sum?.rowsReturned ?? 0), ms: Number(r.sum?.queryDurationMs ?? 0) });
      }
      if (order === 'sum_rowsRead_DESC') {
        /* The same statement can come back in both orders: keep one copy of each. */
      }
    }
    const byQ = new Map();
    for (const r of rows) if (!byQ.has(r.q)) byQ.set(r.q, r);
    const list = [...byQ.values()];
    const read = list.reduce((s, r) => s + r.read, 0);
    const written = list.reduce((s, r) => s + r.written, 0);
    const hourly = (bundle.hours ?? []).filter((h) => h.hour >= from.slice(0, 13) && h.hour <= to);
    const hRead = hourly.reduce((s, h) => s + h.read, 0);
    const hWritten = hourly.reduce((s, h) => s + h.written, 0);
    console.log(`  ${list.length} statements; sampled sum read ${n(read)}, written ${n(written)}; hourly totals for the same hours read ${n(hRead)}, written ${n(hWritten)}`);
    console.log('  top readers:');
    for (const r of [...list].sort((a, b) => b.read - a.read).slice(0, 45)) {
      console.log(`   ${n(r.read).padStart(11)} rows ${String(r.calls).padStart(6)} calls ${n(Math.round(r.read / Math.max(1, r.calls))).padStart(8)}/call  ${r.q.slice(0, 200)}`);
    }
    console.log('  top writers:');
    for (const r of [...list].sort((a, b) => b.written - a.written).slice(0, 25)) {
      if (r.written === 0) break;
      console.log(`   ${n(r.written).padStart(9)} written ${String(r.calls).padStart(6)} calls  ${r.q.slice(0, 200)}`);
    }
    bundle.statements[label] = { from, to, sampledRead: read, sampledWritten: written, hourlyRead: hRead, hourlyWritten: hWritten, list: list.filter((r) => r.read > 0 || r.written > 0).slice(0, 2000) };
  }
});

/* ------------------------------------------------------------------ crons */
await part('crons', async () => {
  heading('Scheduled runs, last 72 hours, by cron and status');
  const to = new Date();
  const from = new Date(to.getTime() - 72 * 3_600_000);
  const root = await fieldsOf('Query');
  const viewer = await fieldsOf(unwrap(root.find((f) => f.name === 'viewer')?.type));
  const acctFields = await fieldsOf(unwrap(viewer.find((f) => f.name === 'accounts')?.type));
  const ds = acctFields.find((f) => f.name === 'workersInvocationsScheduled');
  const rows = [];
  if (ds) {
    const rowFields = (await fieldsOf(unwrap(ds.type))).map((f) => f.name);
    const pick = ['cron', 'status', 'cpuTimeUs', 'datetime', 'scheduledDatetime'].filter((w) => rowFields.includes(w));
    let cursor = from.toISOString();
    for (let page = 0; page < 10; page += 1) {
      const d = await graphql(
        `query Q($a: String!, $from: Time!, $to: Time!, $s: String!) { viewer { accounts(filter: { accountTag: $a }) {
          workersInvocationsScheduled(limit: 10000, orderBy: [datetime_ASC], filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $s }) { ${pick.join(' ')} } } } }`,
        { from: cursor, to: to.toISOString(), s: 'fantasy-analyst' },
      );
      const got = d.workersInvocationsScheduled ?? [];
      rows.push(...got);
      if (got.length < 10000) break;
      cursor = got[got.length - 1].datetime;
    }
  }
  const by = new Map();
  for (const r of rows) {
    const k = `${r.cron}|${r.status}`;
    const v = by.get(k) ?? { n: 0, cpu: [] };
    v.n += 1;
    if (r.cpuTimeUs != null) v.cpu.push(Number(r.cpuTimeUs) / 1000);
    by.set(k, v);
  }
  for (const [k, v] of [...by].sort()) {
    const cpu = v.cpu.sort((a, b) => a - b);
    console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(5)} runs  cpu ms p50 ${cpu.length ? cpu[Math.floor(cpu.length / 2)].toFixed(0) : '-'} max ${cpu.length ? cpu[cpu.length - 1].toFixed(0) : '-'}`);
  }
  const bad = rows.filter((r) => r.status !== 'success');
  console.log(`  ${rows.length} scheduled runs, ${bad.length} not "success"`);
  for (const r of bad.slice(0, 40)) console.log(`   ${et(r.datetime)} ${r.cron} ${r.status} cpu ${r.cpuTimeUs ?? '?'}`);
  bundle.crons = { runs: rows.length, byCronStatus: Object.fromEntries([...by].map(([k, v]) => [k, v.n])), bad };

  heading('Fetch requests by day and status, last 4 days');
  const inv = acctFields.find((f) => f.name === 'workersInvocationsAdaptive');
  if (inv) {
    const d = await graphql(
      `query Q($a: String!, $from: Time!, $to: Time!, $s: String!) { viewer { accounts(filter: { accountTag: $a }) {
        workersInvocationsAdaptive(limit: 2000, filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $s }) {
          dimensions { date status } sum { requests errors subrequests } } } } }`,
      { from: new Date(to.getTime() - 4 * 86_400_000).toISOString(), to: to.toISOString(), s: 'fantasy-analyst' },
    );
    const list = (d.workersInvocationsAdaptive ?? []).map((g) => ({ date: g.dimensions.date, status: g.dimensions.status, requests: Number(g.sum.requests), errors: Number(g.sum.errors), subrequests: Number(g.sum.subrequests) }));
    list.sort((a, b) => a.date.localeCompare(b.date) || b.requests - a.requests);
    for (const g of list) console.log(`  ${g.date} ${String(g.status).padEnd(22)} requests ${n(g.requests).padStart(7)} errors ${n(g.errors).padStart(5)} subrequests ${n(g.subrequests).padStart(7)}`);
    bundle.requests = list;
  }
});

/* ----------------------------------------------------------------- tables */
let LEAGUE_APP_ID = null;
await part('tables', async () => {
  heading('Run state and sync times (small tables)');
  const leagues = await sql('leagues', `SELECT id, season, is_selected, last_synced_at FROM leagues`);
  const sel = leagues.find((l) => Number(l.is_selected) === 1) ?? leagues[0] ?? null;
  LEAGUE_APP_ID = sel?.id ?? null;
  bundle.leagues = leagues.map((l) => ({ selected: Number(l.is_selected) === 1, season: l.season, lastSyncedAt: l.last_synced_at, isThis: l.id === LEAGUE_APP_ID }));
  console.log(`  leagues stored: ${leagues.length}; selected league last synced ${sel?.last_synced_at ?? '?'}`);
  const rosters = await q('rosters', `SELECT roster_id, is_mine, updated_at, json_array_length(players_json) AS n FROM rosters WHERE league_id = ${lit(LEAGUE_APP_ID)}`);
  bundle.rosterSync = rosters;
  console.log(`  rosters: ${rosters.length}, updated ${[...new Set(rosters.map((r) => r.updated_at))].sort().slice(-3).join(', ')}`);
  const crons = await q('cron_run_state', `SELECT cron, label, trigger, started_at, finished_at, outcome, last_success_at, budget_limit, budget_used, budget_remaining, steps_json, release_sha FROM cron_run_state`);
  bundle.cronRunState = crons;
  for (const c of crons) console.log(`  ${String(c.cron).padEnd(14)} ${String(c.label).padEnd(34)} ${c.outcome.padEnd(10)} started ${et(c.started_at)} last success ${c.last_success_at ? et(c.last_success_at) : '-'}`);
  const inj = await q('injury_source_runs', `SELECT id, source, latest_week, fetched_at, published_at, rows_returned, outcome FROM injury_source_runs ORDER BY id DESC LIMIT 60`);
  bundle.injuryRuns = inj;
  const outcomes = new Map();
  for (const r of inj) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
  console.log(`  injury runs (newest 60): ${[...outcomes].map(([k, v]) => `${k}=${v}`).join(' ')}; newest ${inj[0] ? et(inj[0].fetched_at) : '-'} published ${inj[0]?.published_at ?? '-'}`);
  const state = await q('injury_source_state', `SELECT * FROM injury_source_state`);
  bundle.injuryState = state;
  const sync = await q('sync_log', `SELECT kind, status, started_at, finished_at, substr(detail, 1, 200) AS detail FROM sync_log WHERE id > (SELECT MAX(id) - 400 FROM sync_log)`);
  const byKind = new Map();
  for (const r of sync) {
    const v = byKind.get(r.kind) ?? { n: 0, bad: 0, last: null, lastOk: null };
    v.n += 1;
    if (!/ok|success|done|complete/i.test(String(r.status))) v.bad += 1;
    if (!v.last || r.started_at > v.last) v.last = r.started_at;
    if (/ok|success|done|complete/i.test(String(r.status)) && (!v.lastOk || r.started_at > v.lastOk)) v.lastOk = r.started_at;
    byKind.set(r.kind, v);
  }
  bundle.syncLog = sync;
  for (const [k, v] of byKind) console.log(`  sync ${String(k).padEnd(28)} ${String(v.n).padStart(4)} runs, ${v.bad} not ok, newest ${v.last ? et(v.last) : '-'}`);
});

/* -------------------------------------------------------------- freshness */
await part('freshness', async () => {
  heading('When each start/sit input was last fetched (indexed or small reads)');
  const f = {};
  f.schedule = await q('nfl_schedule', `SELECT week, COUNT(*) AS teams, MIN(fetched_at) AS first, MAX(fetched_at) AS last, MIN(kickoff) AS firstKick, MAX(kickoff) AS lastKick FROM nfl_schedule WHERE season = '2026' AND week >= 9 AND week <= 12 GROUP BY week`);
  f.events = await q('vegas_events', `SELECT event_id, kickoff, home_team, away_team, seen_at FROM vegas_events WHERE kickoff >= '2026-11-10'`);
  f.injuryWeeks = await q('player_injury_reports', `SELECT week, COUNT(*) AS n, MAX(fetched_at) AS fetched, MAX(published_at) AS published, SUM(CASE WHEN report_status IN ('Out','Doubtful') THEN 1 ELSE 0 END) AS outs FROM player_injury_reports WHERE season = '2026' AND week >= 8 GROUP BY week`);
  f.injuryEvents = await q('injury_events', `SELECT player_id, week, kind, from_value, to_value, source, source_modified_at, detected_at FROM injury_events ORDER BY detected_at DESC LIMIT 300`);
  const depth = await q('depth_chart_entries', `SELECT MAX(captured_at) AS captured FROM depth_chart_entries WHERE season = '2026'`);
  f.depthChart = depth[0]?.captured ? (await q('depth_chart_entries one', `SELECT captured_at, fetched_at, source FROM depth_chart_entries WHERE season = '2026' AND captured_at = ${lit(depth[0].captured)} LIMIT 1`))[0] : null;
  f.usageRuns = await q('usage_source_runs', `SELECT source, week, latest_week, fetched_at, published_at, rows_returned, rows_written, outcome, substr(note, 1, 160) AS note FROM usage_source_runs ORDER BY id DESC LIMIT 15`);
  f.nflverseRuns = await q('nflverse_source_runs', `SELECT source, week, fetched_at, published_at, rows_returned, rows_written, outcome, substr(note, 1, 160) AS note FROM nflverse_source_runs ORDER BY id DESC LIMIT 15`);
  f.seasonStatsRuns = await q('player_season_stats_runs', `SELECT fetched_at, source, rows_returned, rows_matched FROM player_season_stats_runs ORDER BY id DESC LIMIT 5`);
  f.settings = await q('settings (keys and times only)', `SELECT key, updated_at, length(value_json) AS bytes FROM settings`);
  /* The freshness map's cheap reads (settings PK, small state tables, indexed logs). */
  f.settingsValues = await sql(
    'settings (clock and job values)',
    `SELECT key, updated_at, value_json FROM settings WHERE key IN ('vegas.clock','vegas.lastRefresh','vegas.lastSchedule','vegas.extraSources','props.week.stamp','props.week.freshness','refresh.job.startsit','refresh.job.waivers','sleeper.nflState','sleeper.players.lastSuccessAt')`,
  );
  f.vegasUsage = await q('vegas_usage', `SELECT month, entities, provider_entities, provider_limit, provider_read_at, updated_at FROM vegas_usage WHERE month IN ('2026-10','2026-11')`);
  f.vegasUsageOutcomes = await q('vegas_usage_log by outcome', `SELECT outcome, source, COUNT(*) AS n, SUM(entities) AS entities, MIN(at) AS first, MAX(at) AS last FROM vegas_usage_log WHERE month = '2026-11' GROUP BY outcome, source`);
  f.vegasUsageRecent = await q('vegas_usage_log newest', `SELECT at, source, event_id, entities, requests, outcome, reason FROM vegas_usage_log WHERE month = '2026-11' ORDER BY at DESC LIMIT 80`);
  f.nflverseState = await q('nflverse_source_state', `SELECT source, checked_at, source_modified_at, ingested_at, last_outcome, consecutive_failures FROM nflverse_source_state WHERE season = '2026'`);
  f.usageState = await q('usage_source_state', `SELECT * FROM usage_source_state WHERE season = '2026'`);
  f.injuryBudget = await q('injury_write_budget', `SELECT * FROM injury_write_budget WHERE day >= '2026-11-12'`);
  f.trending = await q('trending_snapshots newest', `SELECT captured_at, trend_type FROM trending_snapshots WHERE trend_type = 'add' ORDER BY captured_at DESC LIMIT 1`);
  bundle.freshness = f;
  for (const u of f.vegasUsage) console.log(`  odds budget ${u.month}: ${u.entities} used of ${u.provider_limit ?? '?'} (provider count ${u.provider_entities ?? '?'}, read ${u.provider_read_at ?? '-'})`);
  console.log(`  odds log this month: ${f.vegasUsageOutcomes.map((o) => `${o.outcome}/${o.source}=${o.n}`).join(', ') || 'none'}`);
  for (const w of f.schedule) console.log(`  schedule week ${w.week}: ${w.teams} teams, fetched ${et(w.last)}, kickoffs ${w.firstKick ? et(w.firstKick) : '-'} to ${w.lastKick ? et(w.lastKick) : '-'}`);
  for (const w of f.injuryWeeks) console.log(`  injury report week ${w.week}: ${w.n} players (${w.outs} Out or Doubtful), fetched ${et(w.fetched)}, published ${w.published ?? '-'}`);
  console.log(`  injury changes detected (newest 300): newest ${f.injuryEvents[0] ? et(f.injuryEvents[0].detected_at) : '-'}, oldest ${f.injuryEvents.at(-1) ? et(f.injuryEvents.at(-1).detected_at) : '-'}`);
  console.log(`  depth chart captured ${f.depthChart?.captured_at ?? '-'} (fetched ${f.depthChart?.fetched_at ?? '-'})`);
  console.log(`  usage runs newest ${f.usageRuns[0] ? `${et(f.usageRuns[0].fetched_at)} ${f.usageRuns[0].outcome}` : '-'}; nflverse newest ${f.nflverseRuns[0] ? `${et(f.nflverseRuns[0].fetched_at)} ${f.nflverseRuns[0].outcome}` : '-'}`);
  console.log(`  settings rows: ${f.settings.length}`);
});

/* -------------------------------------------------------------- forecasts */
await part('forecasts', async () => {
  heading('Matchup forecasts this season (win probability, projected and final)');
  const rows = await sql(
    'matchup_forecasts',
    `SELECT season, week, roster_id, matchup_id, opponent_roster_id, model_version, first_forecast_at, first_phase, first_win_probability,
            first_projected_final, first_actual, latest_forecast_at, latest_phase, latest_win_probability, latest_projected_final,
            latest_actual, latest_confidence, final_score, opponent_final_score, won, settled_at
       FROM matchup_forecasts WHERE league_id = ${lit(LEAGUE_APP_ID)} AND season = '2026'`,
  );
  bundle.forecasts = rows;
  const settled = rows.filter((r) => r.won != null);
  console.log(`  ${rows.length} rows, ${settled.length} settled; weeks ${[...new Set(rows.map((r) => r.week))].sort((a, b) => a - b).join(',')}`);
});

/* ----------------------------------------------------------------- gather */
await part('gather', async () => {
  heading('Saved data for the accuracy backtest (scripts/probe-round29-gather.ts)');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'round29-')), 'gather.json');
  const out = execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/probe-round29-gather.ts', file], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  console.log(out.split('\n').map((l) => `  ${l}`).join('\n'));
  bundle.gather = JSON.parse(readFileSync(file, 'utf8'));
  probeRows += Number(bundle.gather?.meta?.d1RowsTotal ?? 0);
});

/* ---------------------------------------------------------------- screens */
const keep = (r) => ({ status: r.status, ms: r.ms, bytes: r.bytes, body: r.body, text: r.text });
await part('screens', async () => {
  heading('Each screen as the phone reads it (GET only; reads are public)');
  bundle.screens = {};
  const lg = await getApp('/api/leagues');
  const leagueId = process.env.LEAGUE_ID || lg.body?.leagues?.find((l) => l.isSelected)?.id;
  if (!leagueId) throw new Error('no selected league');
  LEAGUE_APP_ID ??= leagueId;
  const L = encodeURIComponent(leagueId);
  const call = async (key, path) => {
    const r = await getApp(path);
    bundle.screens[key] = keep(r);
    console.log(`  ${key.padEnd(18)} HTTP ${r.status} ${String(r.ms).padStart(6)} ms ${n(r.bytes).padStart(9)} bytes${r.body?.cost ? `  cost ${JSON.stringify(r.body.cost).slice(0, 110)}` : ''}`);
    return r;
  };
  /* The Vegas clock before and after the burst: a refresh inside it would make two screens read two slates. */
  await call('vegas.before', '/api/vegas/status');
  for (const [key, path] of [
    ['overview', '/api/overview'],
    ['authStatus', '/api/auth/status'],
    ['team.roster', `/api/leagues/${L}/roster`],
    ['team.lineup', `/api/leagues/${L}/lineup`],
    ['waivers', `/api/leagues/${L}/waivers?cost=1`],
    ['matchup', `/api/leagues/${L}/matchup`],
  ])
    await call(key, path);
  const mode = encodeURIComponent(bundle.screens['team.lineup']?.body?.mode ?? 'balanced');
  await call('compare.poolMine', `/api/leagues/${L}/compare-pool?tab=mine&position=ALL&q=&mode=${mode}`);
  await call('compare.poolWaivers', `/api/leagues/${L}/compare-pool?tab=waivers&position=ALL&q=&mode=${mode}`);
  await call('players.board', `/api/players/season?leagueId=${L}&cost=1`);
  await call('trades.offers', '/api/trades/screens/offers');
  await call('trades.teams', '/api/trades/screens/teams');
  /* Each offer opened in Check a trade (the verdict line) and metered through the same engine (per-player rates). */
  const offers = bundle.screens['trades.offers']?.body?.offers ?? [];
  const myRosterId =
    (bundle.screens['trades.teams']?.body?.teams ?? []).find((t) => t.isMine)?.rosterId ??
    (bundle.screens['players.board']?.body?.teams ?? []).find((t) => t.isMine)?.rosterId ??
    null;
  bundle.screens.verdicts = [];
  bundle.screens.checks = [];
  for (const o of offers.slice(0, 3)) {
    const give = (o.give ?? []).map((p) => p.playerId).join(',');
    const getIds = (o.get ?? []).map((p) => p.playerId).join(',');
    const partner = o.partner?.rosterId;
    if (partner == null || !give || !getIds) continue;
    const v = await getApp(`/api/trades/screens/verdict?b=${partner}&give=${encodeURIComponent(give)}&get=${encodeURIComponent(getIds)}`);
    bundle.screens.verdicts.push({ offerId: o.id ?? null, partner, give, get: getIds, ...keep(v) });
    if (myRosterId != null) {
      const c = await getApp(`/api/leagues/${L}/trades/check?a=${myRosterId}&b=${partner}&give=${encodeURIComponent(give)}&get=${encodeURIComponent(getIds)}&cost=1`);
      bundle.screens.checks.push({ offerId: o.id ?? null, partner, give, get: getIds, ...keep(c) });
    }
    console.log(`  offer ${o.id ?? '?'}: verdict HTTP ${v.status}; check ${myRosterId == null ? 'skipped (no roster id)' : 'read'}`);
  }
  /* The 20 audited: Alex's skill players (starters, bench, IR), then the free agents the screens put forward. */
  const lineupBody = bundle.screens['team.lineup']?.body;
  const evals = [...(lineupBody?.starters ?? []), ...(lineupBody?.bench ?? []), ...(lineupBody?.undecidable ?? [])];
  const mineIds = evals.filter((e) => ['QB', 'RB', 'WR', 'TE'].includes(e.position)).map((e) => e.playerId).filter(Boolean);
  const w = bundle.screens.waivers?.body ?? {};
  const t = w.tiers ?? {};
  const faFromWaivers = [
    w.pickupStart?.start?.playerId,
    ...(w.pickupStart?.consider ?? []).map((m) => m.playerId),
    ...[...(t.doThese ?? []), ...(t.doThis ? [t.doThis] : []), ...(t.consider ?? []), ...(t.watch ?? [])].map((m) => m.playerId),
    ...(bundle.screens['compare.poolWaivers']?.body?.rows ?? []).map((r) => r.id ?? r.playerId),
  ].filter(Boolean);
  const faIds = [...new Set(faFromWaivers)].filter((id) => !mineIds.includes(id));
  const pick = [...new Set([...mineIds, ...faIds.slice(0, Math.max(6, 20 - mineIds.length))])];
  bundle.screens.picked = { mine: mineIds, freeAgents: faIds.slice(0, Math.max(6, 20 - mineIds.length)) };
  bundle.screens.cards = {};
  for (const id of pick) bundle.screens.cards[id] = keep(await getApp(`/api/players/${encodeURIComponent(id)}/season?leagueId=${L}&cost=1`));
  console.log(`  Players cards read: ${Object.keys(bundle.screens.cards).length} (Alex ${mineIds.length}, free agents ${pick.length - mineIds.length})`);
  for (const [key, path] of [
    ['refresh.status', '/api/refresh/status?kind=startsit'],
    ['dataHealth', '/api/data-health'],
    ['vegas.after', '/api/vegas/status'],
  ])
    await call(key, path);
  const before = JSON.stringify(bundle.screens['vegas.before']?.body ?? null);
  const after = JSON.stringify(bundle.screens['vegas.after']?.body ?? null);
  console.log(`  Vegas status ${before === after ? 'unchanged during the burst' : 'CHANGED during the burst (screens may have read two slates)'}`);
});

/* -------------------------------------------------------------- snapshots */
await part('snapshots', async () => {
  heading('Support snapshots (the inputs each decision was drawn from)');
  bundle.snapshots = {};
  const L = encodeURIComponent(LEAGUE_APP_ID);
  for (const context of ['lineup', 'matchup', 'waiver-plan']) {
    const r = await getApp(`/api/leagues/${L}/support-snapshot?context=${context}`);
    bundle.snapshots[context] = keep(r);
    console.log(`  ${context.padEnd(12)} HTTP ${r.status} ${String(r.ms).padStart(6)} ms ${n(r.bytes).padStart(9)} bytes`);
  }
});

/* ------------------------------------------------------------------- pack */
heading('This probe');
bundle.meta.finishedAt = new Date().toISOString();
bundle.meta.probeRows = probeRows;
bundle.meta.sqlLog = sqlLog;
console.log(`  rows read by this probe's own SQL and the gather: ${n(probeRows)} (screen loads are counted by the app and show in the totals)`);
for (const s of sqlLog) console.log(`   ${String(s.label).padEnd(26)} ${n(s.read).padStart(8)} rows read, ${n(s.rows)} back`);
const scrub = (text) => {
  let out = text;
  for (const secret of [SLEEPER_LEAGUE, LEAGUE_APP_ID].filter((s) => s && String(s).length >= 6)) out = out.split(String(secret)).join('LEAGUE');
  return out;
};
const json = scrub(JSON.stringify(bundle));
const packed = gzipSync(Buffer.from(json), { level: 9 }).toString('base64');
console.log(`  bundle: ${n(json.length)} bytes, gzip+base64 ${n(packed.length)}, sha256 ${createHash('sha256').update(json).digest('hex')}`);
console.log('-----BEGIN ROUND29 BUNDLE-----');
for (let i = 0; i < packed.length; i += 4000) console.log(packed.slice(i, i + 4000));
console.log('-----END ROUND29 BUNDLE-----');
console.log(`  finished ${et(new Date().toISOString())} ET`);
