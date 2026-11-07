/**
 * Round 12 (cron health): what did the 4 AM job (the 09:00 UTC cron) actually
 * do on 5, 6 and 7 November, step by step, and why can the cron watch not see
 * any scheduled run?
 *
 * Reads Cloudflare's own records only. No database read, no Sleeper call, no
 * odds call:
 *
 *   1. The account: whether ACCOUNT_ID reached the script (never printed), and
 *      how many accounts the token can see.
 *   2. `workersInvocationsScheduled`, asked several ways (with and without the
 *      script filter, short and long windows), so the reason the watch sees
 *      nothing is measured rather than guessed.
 *   3. D1's own per-query log for 09:00 to 10:00 UTC each day, minute by
 *      minute. Each step of the job runs queries nobody else runs, so the
 *      queries say which steps ran, how often, and where the run ended.
 *   4. Workers Observability for the same windows: every scheduled invocation
 *      with its cron, outcome, CPU and wall time, and the lines it logged.
 *
 * Times printed in Eastern and UTC.
 */

import { CRONS, judgeAll, readInvocations, LOOKBACK_HOURS } from './cron-health-watch.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID || null;
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';
const GQL = 'https://api.cloudflare.com/client/v4/graphql';

if (!TOKEN) {
  console.log('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}

const eastern = (d) =>
  new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* printed by the caller */
  }
  return { status: res.status, json, text };
}

async function graphql(query, variables = {}) {
  const r = await post(GQL, { query, variables });
  if (!r.json) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  if (r.json.errors?.length) throw new Error(r.json.errors.map((e) => e.message).join(' | '));
  return r.json.data;
}

/* ------------------------------------------------------------ 1. account */

heading('1. The account');
console.log(`ACCOUNT_ID handed to this run: ${ACCOUNT ? 'yes (CLOUDFLARE_ACCOUNT_ID secret is set)' : 'no (the secret is empty or missing)'}`);
{
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => null);
  const list = body?.result ?? [];
  console.log(`accounts the token can see: ${list.length} (HTTP ${res.status})`);
  if (ACCOUNT) console.log(`the secret matches one of them: ${list.some((a) => a.id === ACCOUNT) ? 'yes' : 'no'}`);
  if (!ACCOUNT) ACCOUNT = list[0]?.id ?? null;
}
if (!ACCOUNT) {
  console.log('no account to ask about; stopping');
  process.exit(0);
}

/* -------------------------------------------- 2. scheduled invocations */

heading('2. workersInvocationsScheduled, asked several ways');
const now = new Date();
const SCHED_FIELDS = 'cron status datetime scriptName';
async function scheduled(fromIso, toIso, withScript) {
  const filter = withScript
    ? '{ datetime_geq: $from, datetime_leq: $to, scriptName: $s }'
    : '{ datetime_geq: $from, datetime_leq: $to }';
  const vars = withScript ? '$a: String!, $from: Time!, $to: Time!, $s: String!' : '$a: String!, $from: Time!, $to: Time!';
  const d = await graphql(
    `query Q(${vars}) { viewer { accounts(filter: { accountTag: $a }) {
       workersInvocationsScheduled(limit: 10000, orderBy: [datetime_ASC], filter: ${filter}) { ${SCHED_FIELDS} }
     } } }`,
    withScript ? { a: ACCOUNT, from: fromIso, to: toIso, s: SCRIPT } : { a: ACCOUNT, from: fromIso, to: toIso },
  );
  return d?.viewer?.accounts?.[0]?.workersInvocationsScheduled ?? null;
}
for (const [label, hours] of [['last 24 hours', 24], ['last 72 hours', 72], ['last 167 hours (the watch)', 167]]) {
  const from = new Date(now.getTime() - hours * 3_600_000).toISOString();
  for (const withScript of [true, false]) {
    try {
      const rows = await scheduled(from, now.toISOString(), withScript);
      const by = new Map();
      for (const r of rows ?? []) by.set(`${r.scriptName} ${r.cron} ${r.status}`, (by.get(`${r.scriptName} ${r.cron} ${r.status}`) ?? 0) + 1);
      console.log(`${label}, ${withScript ? `scriptName=${SCRIPT}` : 'any script'}: ${rows == null ? 'no list' : `${rows.length} rows`}`);
      for (const [k, n] of [...by].sort()) console.log(`   ${String(n).padStart(5)}  ${k}`);
      if (rows?.length) console.log(`   newest: ${rows.at(-1).datetime}  oldest: ${rows[0].datetime}`);
    } catch (err) {
      console.log(`${label}, ${withScript ? 'with' : 'without'} script filter: ERROR ${err.message}`);
    }
  }
}
// The watch builds its window with `toISOString()` (milliseconds); Cloudflare's
// Time type may want whole seconds. Ask both ways for the same window.
{
  const from = new Date(now.getTime() - 24 * 3_600_000);
  const secs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const [label, f, t] of [
    ['milliseconds (as the watch sends)', from.toISOString(), now.toISOString()],
    ['whole seconds', secs(from), secs(now)],
  ]) {
    try {
      const rows = await scheduled(f, t, true);
      console.log(`24h window in ${label}: ${rows?.length ?? 'no list'} rows`);
    } catch (err) {
      console.log(`24h window in ${label}: ERROR ${err.message}`);
    }
  }
}

/* ---------------------------------------------- 3. D1, minute by minute */

heading('3. Database queries 09:00 to 10:00 UTC (4 to 5 AM ET), minute by minute');

let DB_ID = null;
let MINUTE_DIM = null;
async function d1Rows(fromIso, toIso, dims) {
  const d = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
       d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
         dimensions { query databaseId ${dims} } sum { rowsRead } count
       } } } }`,
    { a: ACCOUNT, from: fromIso, to: toIso },
  );
  const rows = (d?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []).map((r) => ({
    q: String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim(),
    db: r.dimensions?.databaseId ?? null,
    minute: r.dimensions?.[MINUTE_DIM ?? 'x'] ?? null,
    read: Number(r.sum?.rowsRead ?? 0),
    calls: Number(r.count ?? 0),
  }));
  if (!DB_ID) DB_ID = rows.find((r) => /player_aliases|prop_snapshots|players_snapshot|player_list_stamp|cron_run_state/.test(r.q))?.db ?? null;
  return DB_ID ? rows.filter((r) => r.db === DB_ID) : rows;
}
for (const candidate of ['datetimeMinute', 'datetimeFiveMinutes']) {
  try {
    MINUTE_DIM = candidate;
    await d1Rows('2026-11-07T09:00:00Z', '2026-11-07T09:01:00Z', candidate);
    break;
  } catch {
    MINUTE_DIM = null;
  }
}
console.log(`time bucket: ${MINUTE_DIM ?? 'none available, asking one minute at a time'}`);

/* The step each query belongs to, by words only that step's code uses. */
const STEP_MARKS = [
  ['claim (round 11)', /season_stats\.nightlyAttempt|seasonStats\.attempt/i],
  ['positions (season stats)', /^SELECT id, position FROM players$/],
  ['season stats write', /player_season_stats|season_stat/i],
  ['stats run record', /stats_runs|player_stats_runs/i],
  ['player list', /sleeper\.players\.lastSuccessAt|INSERT INTO players|player_aliases/i],
  ['roster', /INSERT INTO rosters|FROM rosters|league_users/i],
  ['injuries', /injury/i],
  ['usage', /player_usage_weeks|usage_/i],
  ['season markets', /season_market|market_lines/i],
  ['schedule', /nfl_schedule/i],
  ['trending', /trending/i],
  ['calibration', /calibration/i],
  ['published projections', /published_projection|projection_snapshots/i],
  ['run record', /cron_run_state|cron_runs/i],
  ['sync log', /sync_log/i],
];
const stepOf = (q) => STEP_MARKS.find(([, re]) => re.test(q))?.[0] ?? 'other';

async function minuteWindow(dayLabel, fromIso, minutes) {
  console.log(`\n=== ${dayLabel}: ${eastern(fromIso)} ET for ${minutes} minutes ===`);
  const byMinute = new Map();
  if (MINUTE_DIM) {
    const to = new Date(Date.parse(fromIso) + minutes * 60_000).toISOString();
    for (const r of await d1Rows(fromIso, to, MINUTE_DIM)) {
      const k = r.minute ?? '?';
      byMinute.set(k, [...(byMinute.get(k) ?? []), r]);
    }
  } else {
    for (let m = 0; m < minutes; m += 1) {
      const f = new Date(Date.parse(fromIso) + m * 60_000);
      if (f > now) break;
      const rows = await d1Rows(f.toISOString(), new Date(f.getTime() + 60_000).toISOString(), '');
      if (rows.length) byMinute.set(f.toISOString(), rows);
    }
  }
  let positionsCalls = 0;
  for (const [minute, rows] of [...byMinute].sort()) {
    const steps = new Map();
    for (const r of rows) {
      const s = stepOf(r.q);
      const cur = steps.get(s) ?? { calls: 0, read: 0 };
      cur.calls += r.calls;
      cur.read += r.read;
      steps.set(s, cur);
      if (s === 'positions (season stats)') positionsCalls += r.calls;
    }
    const total = rows.reduce((a, r) => ({ calls: a.calls + r.calls, read: a.read + r.read }), { calls: 0, read: 0 });
    console.log(`${String(minute).slice(11, 16)} UTC (${eastern(minute).split(', ').at(-1)} ET): ${total.calls} queries, ${total.read.toLocaleString('en-US')} rows`);
    for (const [s, v] of [...steps].sort((a, b) => b[1].read - a[1].read)) {
      console.log(`     ${s.padEnd(26)} ${String(v.calls).padStart(5)} calls ${v.read.toLocaleString('en-US').padStart(10)} rows`);
    }
  }
  console.log(`position list calls in this window: ${positionsCalls}`);
  return byMinute;
}

const days = [
  ['5 Nov', '2026-11-05T08:59:00Z', 61],
  ['6 Nov', '2026-11-06T08:59:00Z', 61],
  ['7 Nov', '2026-11-07T08:59:00Z', 61],
];
const firstMinutes = {};
for (const [label, from, minutes] of days) {
  try {
    firstMinutes[label] = await minuteWindow(label, from, minutes);
  } catch (err) {
    console.log(`${label}: ERROR ${err.message}`);
  }
}

/* Every distinct query in the first five minutes of each run, so steps the marks above miss are still named. */
heading('3b. Every distinct query in each run\'s first five minutes');
for (const [label, from] of days) {
  try {
    const rows = await d1Rows(from, new Date(Date.parse(from) + 6 * 60_000).toISOString(), '');
    console.log(`\n=== ${label} ===`);
    for (const r of rows.sort((a, b) => b.calls - a.calls)) {
      console.log(`  ${String(r.calls).padStart(5)}x ${r.read.toLocaleString('en-US').padStart(9)}  [${stepOf(r.q)}] ${r.q.slice(0, 120)}`);
    }
  } catch (err) {
    console.log(`${label}: ERROR ${err.message}`);
  }
}

/* --------------------------------------------- 4. Workers Observability */

heading('4. Workers Observability: scheduled invocations in each window');
const OBS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`;
for (const [label, from] of days) {
  const f = Date.parse(from);
  const t = Math.min(f + 61 * 60_000, now.getTime());
  const r = await post(OBS, {
    queryId: `round12-${label}-${now.getTime()}`,
    timeframe: { from: f, to: t },
    view: 'events',
    limit: 1000,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT }],
      filterCombination: 'and',
    },
  });
  const evs = r.json?.result?.events?.events ?? [];
  console.log(`\n=== ${label}: HTTP ${r.status}, ${evs.length} event(s) ===`);
  if (!r.json?.success) {
    console.log(r.text.slice(0, 600));
    continue;
  }
  const groups = new Map();
  for (const e of evs) {
    const id = e.$metadata?.requestId ?? e.$workers?.requestId ?? '?';
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  let shown = 0;
  const counts = new Map();
  for (const [id, g] of groups) {
    const cronEv = g.find((e) => e.$workers?.event?.cron);
    if (!cronEv) continue;
    const cron = cronEv.$workers.event.cron;
    const end = g.find((e) => e.$workers?.outcome) ?? cronEv;
    const w = end.$workers ?? {};
    counts.set(`${cron} ${w.outcome}`, (counts.get(`${cron} ${w.outcome}`) ?? 0) + 1);
    if (cron !== '0 9 * * *') continue;
    shown += 1;
    g.sort((x, y) => Number(x.timestamp) - Number(y.timestamp));
    console.log(
      `invocation ${String(id).slice(0, 12)} cron=${cron} scheduled=${w.event?.scheduledTime ? eastern(Number(w.event.scheduledTime)) : '?'} ` +
        `outcome=${w.outcome} cpu=${w.cpuTimeMs}ms wall=${w.wallTimeMs}ms`,
    );
    for (const e of g) {
      const m = e.$metadata ?? {};
      const msg = m.message ?? e.source?.message ?? '';
      if (!msg) continue;
      console.log(`   ${eastern(Number(e.timestamp)).split(', ').at(-1)} ${m.level ?? ''} ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}`);
    }
  }
  for (const [k, n] of [...counts].sort()) console.log(`   scheduled ${k}: ${n}`);
  if (!shown) console.log('   no 0 9 * * * invocation in this window (logs kept 3 days on this plan)');
}

/* ---------------------------------- 5. is the per-query count sampled? */

heading("5. The position list's count: sampled or real?");
async function fieldsOf(name) {
  const d = await graphql(`query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } }`, { n: name });
  return d?.__type?.fields ?? [];
}
try {
  const unwrap = (t) => {
    while (t && !t.name) t = t.ofType;
    return t?.name ?? null;
  };
  const viewerType = unwrap((await fieldsOf('Query')).find((f) => f.name === 'viewer')?.type);
  const accountType = unwrap((await fieldsOf(viewerType)).find((f) => f.name === 'accounts')?.type);
  const acct = await fieldsOf(accountType);
  const groupType = (acct.find((f) => f.name === 'd1QueriesAdaptiveGroups')?.type);
  let t = groupType;
  while (t && !t.name) t = t.ofType;
  const groupFields = await fieldsOf(t?.name);
  console.log(`d1QueriesAdaptiveGroups parts: ${groupFields.map((f) => f.name).join(', ')}`);
  const avgType = groupFields.find((f) => f.name === 'avg')?.type;
  let at = avgType;
  while (at && !at.name) at = at.ofType;
  const avgFields = at?.name ? (await fieldsOf(at.name)).map((f) => f.name) : [];
  console.log(`avg fields: ${avgFields.join(', ') || 'none'}`);
  if (avgFields.includes('sampleInterval')) {
    for (const [label, from] of days) {
      const f = from.replace('08:59', '09:00');
      const d = await graphql(
        `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
           d1QueriesAdaptiveGroups(limit: 50, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [count_DESC]) {
             dimensions { query databaseId } count sum { rowsRead } avg { sampleInterval }
           } } } }`,
        { a: ACCOUNT, from: f, to: new Date(Date.parse(f) + 3 * 60_000).toISOString() },
      );
      console.log(`\n${label}, 09:00 to 09:03 UTC: query, reported calls, average sample interval`);
      for (const r of d?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
        if (DB_ID && r.dimensions.databaseId !== DB_ID) continue;
        const q = String(r.dimensions.query).replace(/\s+/g, ' ').slice(0, 70);
        console.log(`   ${String(r.count).padStart(5)} calls, sample interval ${Number(r.avg?.sampleInterval ?? NaN).toFixed(1).padStart(6)}  ${q}`);
      }
    }
  }
  // The database-level count for the same minutes, which is what the allowance is charged on.
  const dbGroup = acct.find((f) => f.name === 'd1AnalyticsAdaptiveGroups');
  if (dbGroup) {
    for (const [label, from] of days) {
      const f = from.replace('08:59', '09:00');
      const d = await graphql(
        `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
           d1AnalyticsAdaptiveGroups(limit: 50, filter: { datetimeMinute_geq: $from, datetimeMinute_lt: $to }) {
             dimensions { databaseId datetimeMinute } sum { rowsRead readQueries writeQueries }
           } } } }`,
        { a: ACCOUNT, from: f, to: new Date(Date.parse(f) + 3 * 60_000).toISOString() },
      );
      for (const r of (d?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []).sort((a, b) => String(a.dimensions.datetimeMinute).localeCompare(String(b.dimensions.datetimeMinute)))) {
        if (DB_ID && r.dimensions.databaseId !== DB_ID) continue;
        console.log(`   ${label} ${String(r.dimensions.datetimeMinute).slice(11, 16)} UTC database total: ${Number(r.sum.rowsRead).toLocaleString('en-US')} rows read, ${r.sum.readQueries} reads, ${r.sum.writeQueries} writes`);
      }
    }
  }
} catch (err) {
  console.log(`sampling check failed: ${err.message}`);
}

/* ------------------------------------------- 6. the fixed watch, for real */

heading('6. The cron watch as fixed in this round, run against Cloudflare');
try {
  const read = await readInvocations({
    token: TOKEN,
    account: ACCOUNT,
    from: new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString(),
    to: now.toISOString(),
  });
  console.log(`source: ${read.source}, ${read.rows.length} scheduled runs, windows ${JSON.stringify(read.lookbackHours)}`);
  const fiveRuns = read.rows.filter((x) => x.cron === '*/5 * * * *');
  if (fiveRuns.length) console.log(`   five-minute runs: ${fiveRuns.length}, first ${eastern(fiveRuns[0].datetime)} ET, last ${eastern(fiveRuns.at(-1).datetime)} ET`);
  const by = new Map();
  for (const r of read.rows) by.set(`${r.cron} ${r.status}`, (by.get(`${r.cron} ${r.status}`) ?? 0) + 1);
  for (const [k, n] of [...by].sort()) console.log(`   ${String(n).padStart(5)}  ${k}`);
  for (const r of read.rows.filter((x) => x.cron === '0 9 * * *')) console.log(`   09:00 run: ${eastern(r.datetime)} ET  ${r.status}`);
  for (const v of judgeAll(read.rows, now, CRONS, read.lookbackHours)) console.log(`${v.result === 'success' ? 'ok  ' : 'FAIL'}  ${v.name}: ${v.message}`);
} catch (err) {
  console.log(`watch failed: ${err.message}`);
}

console.log(`\nFinished ${eastern(Date.now())} ET`);
