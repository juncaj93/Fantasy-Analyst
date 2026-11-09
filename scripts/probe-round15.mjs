/**
 * Round 15 (cleanup): one combined probe, in parts, all read-only.
 *
 *   STEPS=logs     The Worker's own logs for every support-snapshot request
 *                  over the last 7 days: outcome (ok, exceededCpu,
 *                  exceededMemory, exception), CPU and wall time, status, and
 *                  any error line logged on the same request. Cloudflare's
 *                  telemetry API only: zero D1 rows.
 *   STEPS=d1       Rows written per day, the top writers (nflverse among
 *                  them), the trim step in the 4 AM run record, and the sizes
 *                  of the tables the trim works on.
 *   STEPS=fetch    The two snapshot downloads that failed (defense plan,
 *                  trade offer), once each, with status, time and size.
 *   STEPS=replay   Alex's real Team, Waivers and Trades rebuilt from
 *                  production's database on the code before this round and on
 *                  this checkout, and every difference printed.
 *
 * No STEPS: all of them, in that order. Times are Eastern.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';
const BEFORE_SHA = process.env.BEFORE_SHA || 'c83febf68cf42a5f7c585d28f3f680a52c1bdf71';
const REPORT = 'scripts/round15-report.ts';
const steps = new Set(
  (process.env.STEPS || 'logs,d1,fetch,replay')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);
let probeRows = 0;

console.log(`Round 15 probe, started ${eastern()} ET; steps: ${[...steps].join(', ')}`);

// ------------------------------------------------------------------ logs ---

async function telemetry(body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

async function logsStep() {
  heading('Support snapshot requests in the Worker logs, last 7 days');
  if (!TOKEN || !ACCOUNT) {
    console.log('CLOUDFLARE_API_TOKEN and ACCOUNT_ID are needed for this part; skipped.');
    return;
  }
  const to = Date.now();
  const from = to - 7 * 24 * 3_600_000;
  /* The URL key differs between event kinds; try each until one answers. */
  const urlKeys = ['$workers.event.request.url', '$metadata.url', '$workers.event.request.path'];
  let events = [];
  let usedKey = null;
  for (const key of urlKeys) {
    const all = [];
    const ask = async (a, b, depth) => {
      const r = await telemetry({
        queryId: `round15-${a}-${b}`,
        timeframe: { from: a, to: b },
        view: 'events',
        limit: 100,
        parameters: {
          datasets: ['cloudflare-workers'],
          filters: [
            { key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT },
            { key, operation: 'includes', type: 'string', value: 'support-snapshot' },
          ],
          filterCombination: 'and',
        },
      });
      if (!r.json?.success) {
        console.log(`  ${key}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
        return;
      }
      const list = r.json.result?.events?.events ?? [];
      if (list.length >= 100 && depth < 6) {
        const mid = Math.floor((a + b) / 2);
        await ask(a, mid, depth + 1);
        await ask(mid, b, depth + 1);
        return;
      }
      all.push(...list);
    };
    await ask(from, to, 0);
    console.log(`  filter ${key}: ${all.length} event(s)`);
    if (all.length > 0) {
      events = all;
      usedKey = key;
      break;
    }
  }
  if (events.length === 0) {
    console.log('No support-snapshot request found in the logs for 7 days (logs may keep fewer days).');
    return;
  }
  /* One row per request: the invocation event carries the outcome; log lines carry messages. */
  const byRequest = new Map();
  for (const e of events) {
    const m = e.$metadata ?? {};
    const w = e.$workers ?? {};
    const id = m.requestId ?? w.requestId ?? `${e.timestamp}`;
    const row = byRequest.get(id) ?? { at: Number(e.timestamp ?? m.timestamp ?? 0), url: null, outcome: null, cpu: null, wall: null, status: null, messages: [] };
    row.url ??= w.event?.request?.url ?? m.url ?? null;
    row.outcome ??= w.outcome ?? null;
    row.cpu ??= w.cpuTimeMs ?? w.diagnosticsChannelEvents?.cpuTime ?? null;
    row.wall ??= w.wallTimeMs ?? null;
    row.status ??= w.event?.response?.status ?? m.statusCode ?? null;
    if (m.message && !/^GET |^POST /.test(String(m.message))) row.messages.push(String(m.message).slice(0, 240));
    if (m.error) row.messages.push(`error: ${String(m.error).slice(0, 240)}`);
    byRequest.set(id, row);
  }
  console.log(`  ${byRequest.size} request(s), by ${usedKey}`);
  const rows = [...byRequest.values()].sort((a, b) => a.at - b.at);
  for (const r of rows) {
    const context = String(r.url ?? '').match(/context=([a-z-]+)/)?.[1] ?? '?';
    console.log(
      `  ${eastern(r.at).padEnd(24)} ${context.padEnd(12)} status ${String(r.status ?? '?').padEnd(4)} outcome ${String(r.outcome ?? '?').padEnd(14)} cpu ${r.cpu ?? '?'} ms  wall ${r.wall ?? '?'} ms`,
    );
    for (const msg of r.messages.slice(0, 3)) console.log(`      ${msg}`);
  }
  const sample = events.find((e) => e.$workers?.outcome) ?? events[0];
  console.log(`  keys on one event: $workers.{${Object.keys(sample?.$workers ?? {}).join(', ')}}; $metadata.{${Object.keys(sample?.$metadata ?? {}).join(', ')}}`);
}

// -------------------------------------------------------------------- d1 ---

let dbUuid = null;
async function cfSql(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error('read-only: SELECT only');
  const cf = async (path, init = {}) =>
    (
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      })
    ).json();
  dbUuid ??= ((await cf('/d1/database?name=fantasy_analyst')).result ?? []).find((d) => d.name === 'fantasy_analyst')?.uuid;
  if (!dbUuid) throw new Error('no D1 database called fantasy_analyst');
  const body = await cf(`/d1/database/${dbUuid}/query`, { method: 'POST', body: JSON.stringify({ sql, params: [] }) });
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 300)}`);
  probeRows += Number(body.result?.[0]?.meta?.rows_read ?? 0);
  return body.result?.[0]?.results ?? [];
}

async function graphql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function d1Step() {
  heading('Rows written per day (UTC day, resets 7 PM ET). Cap: 100,000 written, 5,000,000 read');
  const since = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const days = await graphql(
    `query($a: String!, $since: Date!, $until: Date!) { viewer { accounts(filter: { accountTag: $a }) {
       d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $since, date_leq: $until }) {
         sum { readQueries writeQueries rowsRead rowsWritten } dimensions { date databaseId } } } } }`,
    { a: ACCOUNT, since, until },
  );
  const groups = days?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const byDate = new Map();
  for (const g of groups) {
    const d = byDate.get(g.dimensions.date) ?? { read: 0, written: 0 };
    d.read += g.sum.rowsRead;
    d.written += g.sum.rowsWritten;
    byDate.set(g.dimensions.date, d);
  }
  for (const [date, d] of [...byDate].sort()) {
    console.log(`  ${date}  account read ${d.read.toLocaleString('en-US').padStart(10)}   written ${d.written.toLocaleString('en-US').padStart(8)}`);
  }
  if (groups.length === 0) console.log(`  (no analytics: ${JSON.stringify(days?.errors ?? days).slice(0, 300)})`);

  heading('nflverse writes, last 24 hours (sampled statements)');
  const top = await graphql(
    `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
       d1QueriesAdaptiveGroups(limit: 40, orderBy: [sum_rowsWritten_DESC], filter: { datetime_geq: $from, datetime_leq: $to }) {
         count sum { rowsWritten rowsRead } dimensions { query } } } } }`,
    { a: ACCOUNT, from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() },
  );
  for (const g of top?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
    const q = String(g.dimensions.query).replace(/\s+/g, ' ');
    if (!/nflverse|depth_chart|player_props|prop_snapshots|injury_source_runs/i.test(q)) continue;
    console.log(`  ${String(g.count).padStart(6)} calls ${g.sum.rowsWritten.toLocaleString('en-US').padStart(8)} written  ${q.slice(0, 120)}`);
  }

  heading('The 4 AM run record: the trim step');
  const runs = await cfSql("SELECT started_at, outcome, steps_json, release_sha FROM cron_run_state WHERE cron = '0 9 * * *'");
  for (const run of runs) {
    console.log(`  started ${eastern(run.started_at)} ET, outcome ${run.outcome}, release ${String(run.release_sha ?? '').slice(0, 7)}`);
    let parsed = [];
    try {
      parsed = JSON.parse(String(run.steps_json ?? '[]'));
    } catch {
      /* printed as missing */
    }
    const trim = parsed.find((s) => s.id === 'trim-old-rows');
    console.log(trim ? `  trim: ${trim.outcome}, ${trim.items ?? 0} row(s) deleted${trim.note ? ` (${trim.note})` : ''}` : '  trim: not in this run (runs from the first 4 AM job after the deploy)');
  }

  heading('Tables the trim works on');
  const cutoffOdds = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const cutoffInjury = new Date(Date.now() - 30 * 86_400_000).toISOString();
  for (const [label, sql] of [
    ['odds copies (prop_snapshots), oldest', 'SELECT MIN(id) AS lo, MAX(id) AS hi, MIN(fetched_at) AS oldest FROM prop_snapshots'],
    ['odds lines (player_props), id range', 'SELECT MIN(id) AS lo, MAX(id) AS hi FROM player_props'],
    ['injury feed log (injury_source_runs), oldest', 'SELECT MIN(id) AS lo, MAX(id) AS hi, MIN(fetched_at) AS oldest FROM injury_source_runs'],
  ]) {
    const [row] = await cfSql(sql);
    console.log(`  ${label}: ${JSON.stringify(row)}`);
  }
  console.log(`  cutoffs now: odds before ${cutoffOdds.slice(0, 10)}, injury log before ${cutoffInjury.slice(0, 10)}`);
}

// ----------------------------------------------------------------- fetch ---

async function call(path) {
  const started = Date.now();
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    const page = /<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? '';
    console.log(`  ${res.status} ${path} (${text.length.toLocaleString('en-US')} bytes, ${Date.now() - started} ms)${page ? ` page: ${page}` : ''}`);
    return { status: res.status, text };
  } catch (err) {
    console.log(`  network error ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 0, text: '' };
  }
}

async function fetchStep() {
  heading('The two snapshot downloads that failed');
  const health = await call('/api/health');
  try {
    console.log(`  production revision ${JSON.parse(health.text)?.release?.gitSha ?? '?'}`);
  } catch {
    /* printed above */
  }
  const leagues = await call('/api/leagues');
  let league = null;
  try {
    league = (JSON.parse(leagues.text).leagues ?? []).find((l) => l.isSelected) ?? null;
  } catch {
    /* none */
  }
  if (!league) {
    console.log('  no selected league; skipped');
    return;
  }
  const id = encodeURIComponent(process.env.LEAGUE_ID || league.id);
  for (const context of ['dst-plan', 'trade-offer']) await call(`/api/leagues/${id}/support-snapshot?context=${context}`);
}

// ---------------------------------------------------------------- replay ---

let leagueIdForReplay = null;
async function selectedLeague() {
  try {
    const res = await fetch(`${APP}/api/leagues`);
    return ((await res.json()).leagues ?? []).find((l) => l.isSelected)?.id ?? null;
  } catch {
    return null;
  }
}

function replayStep() {
  heading(`Alex's real Team, Waivers and Trades: before (${BEFORE_SHA.slice(0, 7)}) and after (this checkout)`);
  if (!existsSync(REPORT)) {
    console.log(`  ${REPORT} is missing; skipped`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'round15-'));
  const env = { ...process.env, REPORT_NOW: new Date().toISOString(), LEAGUE_ID: process.env.LEAGUE_ID || leagueIdForReplay || '' };
  const run = (cwd, label) => {
    try {
      const out = execFileSync('node', ['--experimental-transform-types', '--no-warnings', REPORT], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env,
      });
      writeFileSync(join(dir, `${label}.txt`), out);
      return out;
    } catch (err) {
      return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 3000)})`;
    }
  };
  let before = '(unavailable)';
  try {
    execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
    const tree = join(dir, 'before');
    execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: tree, stdio: 'ignore' });
    mkdirSync(dirname(join(tree, REPORT)), { recursive: true });
    copyFileSync(REPORT, join(tree, REPORT));
    mkdirSync(join(tree, 'scripts/lib'), { recursive: true });
    copyFileSync('scripts/lib/d1Http.ts', join(tree, 'scripts/lib/d1Http.ts'));
    before = run(tree, 'before');
  } catch (err) {
    before = `(could not build the before tree: ${err instanceof Error ? err.message : String(err)})`;
  }
  const after = run('.', 'after');
  const lines = (t) => t.split('\n');
  const a = lines(before);
  const b = lines(after);
  console.log('\n### after (this checkout)');
  console.log(after);
  console.log('\n### lines that differ (- before, + after)');
  const setA = new Set(a);
  const setB = new Set(b);
  let n = 0;
  for (const l of a) if (!setB.has(l) && !/rows read/.test(l)) (console.log(`- ${l}`), n++);
  for (const l of b) if (!setA.has(l) && !/rows read/.test(l)) (console.log(`+ ${l}`), n++);
  if (n === 0) console.log('  (none)');
  const readLine = (t) => Number(/report rows read: (\d+)/.exec(t)?.[1] ?? 0);
  probeRows += readLine(before) + readLine(after);
}

// ------------------------------------------------------------------ main ---

if (steps.has('logs')) await logsStep();
if (steps.has('d1')) await d1Step();
if (steps.has('fetch')) await fetchStep();
if (steps.has('replay')) {
  leagueIdForReplay = await selectedLeague();
  replayStep();
}

heading('This probe');
console.log(`rows read by this probe's own SQL and the replays: ${probeRows.toLocaleString('en-US')} (the two downloads are counted by Cloudflare, not here)`);
console.log(`finished ${eastern()} ET`);
