/**
 * How did every scheduled run end, hour by hour, and how much CPU did it use?
 *
 * Written for one question: the five-minute tick was reported killed for CPU
 * on every run from 27 September 09:00 UTC to 28 September 05:00 UTC. That was
 * a side note in another round, not a measurement. This measures it.
 *
 * Two sources, both Cloudflare's own and both read-only:
 *
 *   1. The GraphQL Analytics dataset `workersInvocationsScheduled`: one row
 *      per scheduled invocation, with its cron, its status and its CPU time.
 *      Printed as one line per hour per cron, so the start and end of a bad
 *      window are visible to the hour.
 *   2. Workers Observability: the failing invocations' own log lines, which say
 *      which step each one reached before it was cut off.
 *
 * Field names are found, never assumed (see probe-d1-usage-hours.mjs for why):
 * the dataset's fields are introspected and only the ones that exist are asked
 * for, and one raw Observability event is printed so its shape is on record.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID, HOURS (default 72), SCRIPT_NAME.
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const HOURS = Number(process.env.HOURS ?? 72);
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is required.');
  process.exit(1);
}
// The account the token can see, when the id was not handed in. The Probe
// workflow installs nothing, so `wrangler whoami` is not there to ask.
if (!ACCOUNT) {
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  ACCOUNT = (await res.json().catch(() => null))?.result?.[0]?.id;
  if (!ACCOUNT) {
    console.error(`Could not resolve the account id (HTTP ${res.status}).`);
    process.exit(1);
  }
}

const to = new Date();
const from = new Date(to.getTime() - HOURS * 3_600_000);

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
    /* reported by the caller */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// 1. Analytics: every scheduled invocation, by hour, cron and status.
// ---------------------------------------------------------------------------

const GQL = 'https://api.cloudflare.com/client/v4/graphql';

async function graphql(query, variables = {}) {
  const r = await post(GQL, { query, variables });
  if (!r.json) throw new Error(`HTTP ${r.status}, not JSON: ${r.text.slice(0, 600)}`);
  if (r.json.errors?.length) throw new Error(r.json.errors.map((e) => e.message).join(' | '));
  return r.json.data;
}

function unwrap(t) {
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
}

async function fieldsOf(name) {
  const d = await graphql(
    `query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } }`,
    { n: name },
  );
  return d?.__type?.fields ?? [];
}

async function analytics() {
  console.log(`=== Scheduled invocations, ${from.toISOString()} -> ${to.toISOString()} ===`);
  const root = await fieldsOf('Query');
  const viewerType = unwrap(root.find((f) => f.name === 'viewer')?.type);
  const viewer = await fieldsOf(viewerType);
  const accountType = unwrap(viewer.find((f) => f.name === 'accounts')?.type);
  const account = await fieldsOf(accountType);
  const ds = account.find((f) => f.name === 'workersInvocationsScheduled');
  if (!ds) {
    console.log('workersInvocationsScheduled is not on this account type. Scheduled datasets present:');
    console.log('  ' + account.map((f) => f.name).filter((n) => /work|sched|cron/i.test(n)).join(', '));
    return;
  }
  const rowFields = (await fieldsOf(unwrap(ds.type))).map((f) => f.name);
  console.log(`fields: ${rowFields.join(', ')}`);
  const want = ['cron', 'status', 'cpuTimeUs', 'datetime', 'scheduledDatetime', 'scriptName'];
  const pick = want.filter((w) => rowFields.includes(w));

  // Pages of 10,000 walked by datetime: 72h of a five-minute cron is ~900 rows,
  // so one page is expected, but a wider window must not truncate silently.
  const rows = [];
  let cursor = from.toISOString();
  for (let page = 0; page < 20; page += 1) {
    const d = await graphql(
      `query Q($a: String!, $from: Time!, $to: Time!, $s: String!) {
        viewer { accounts(filter: { accountTag: $a }) {
          workersInvocationsScheduled(limit: 10000, orderBy: [datetime_ASC],
            filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $s }) { ${pick.join(' ')} }
        } }
      }`,
      { a: ACCOUNT, from: cursor, to: to.toISOString(), s: SCRIPT },
    );
    const got = d?.viewer?.accounts?.[0]?.workersInvocationsScheduled ?? [];
    rows.push(...got);
    if (got.length < 10000) break;
    cursor = got[got.length - 1].datetime;
  }
  console.log(`${rows.length} scheduled invocation(s)`);

  const statuses = new Map();
  for (const r of rows) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  console.log('by status: ' + [...statuses].map(([s, n]) => `${s}=${n}`).join('  '));

  // hour | cron | ok/total | statuses | cpu p50 / max (ms)
  const buckets = new Map();
  for (const r of rows) {
    const key = `${String(r.datetime).slice(0, 13)}:00Z  ${String(r.cron).padEnd(12)}`;
    const b = buckets.get(key) ?? { n: 0, st: new Map(), cpu: [] };
    b.n += 1;
    b.st.set(r.status, (b.st.get(r.status) ?? 0) + 1);
    if (r.cpuTimeUs != null) b.cpu.push(Number(r.cpuTimeUs) / 1000);
    buckets.set(key, b);
  }
  console.log('');
  console.log('hour               cron          runs  statuses                      cpu ms p50 / max');
  for (const [k, b] of [...buckets].sort()) {
    const cpu = b.cpu.sort((x, y) => x - y);
    const p50 = cpu.length ? cpu[Math.floor(cpu.length / 2)].toFixed(1) : '-';
    const max = cpu.length ? cpu[cpu.length - 1].toFixed(1) : '-';
    const st = [...b.st].map(([s, n]) => `${s}=${n}`).join(' ');
    console.log(`${k}  ${String(b.n).padStart(4)}  ${st.padEnd(28)}  ${p50} / ${max}`);
  }

  // The bad window(s) for the five-minute cron, as runs of consecutive
  // non-success statuses with their first and last timestamps.
  const five = rows.filter((r) => String(r.cron).startsWith('*/5'));
  const windows = [];
  let cur = null;
  for (const r of five) {
    const bad = r.status !== 'success';
    if (bad && !cur) cur = { first: r.datetime, last: r.datetime, n: 1, st: new Set([r.status]) };
    else if (bad) { cur.last = r.datetime; cur.n += 1; cur.st.add(r.status); }
    else if (cur) { windows.push(cur); cur = null; }
  }
  if (cur) windows.push(cur);
  console.log('');
  console.log(`five-minute tick: ${five.length} runs; failing streaks:`);
  if (!windows.length) console.log('  none');
  for (const w of windows) {
    console.log(`  ${w.first} -> ${w.last}  ${w.n} consecutive  [${[...w.st].join(', ')}]`);
  }
}

// ---------------------------------------------------------------------------
// 2. Observability: what the failing runs said before they were cut off.
// ---------------------------------------------------------------------------

const OBS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry`;

async function observability() {
  console.log('');
  console.log('=== Observability: cron events ===');
  const keys = await post(`${OBS}/keys`, { timeframe: { from: from.getTime(), to: to.getTime() }, limit: 1000 });
  const names = (keys.json?.result ?? []).map((k) => k.key ?? k);
  console.log(`keys HTTP ${keys.status}: ${names.filter((k) => /outcome|cron|cpu|trigger|event|wall|request/i.test(k)).join(', ') || keys.text.slice(0, 400)}`);

  const base = [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT }];
  const outcomeKey = names.find((k) => k === '$workers.outcome') ?? '$workers.outcome';
  const failing = await post(`${OBS}/query`, {
    queryId: `cron-outcomes-${to.getTime()}`,
    timeframe: { from: from.getTime(), to: to.getTime() },
    view: 'events',
    limit: 100,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [...base, { key: outcomeKey, operation: 'neq', type: 'string', value: 'ok' }],
      filterCombination: 'and',
    },
  });
  console.log(`non-ok events HTTP ${failing.status}`);
  if (!failing.json?.success) {
    console.log(failing.text.slice(0, 1500));
    return;
  }
  const list = failing.json.result?.events?.events ?? [];
  console.log(`${list.length} non-ok event(s) returned (capped at 100)`);
  const byHour = new Map();
  for (const e of list) {
    const w = e.$workers ?? {};
    const at = new Date(Number(e.timestamp ?? e.$metadata?.timestamp ?? 0)).toISOString().slice(0, 13);
    const k = `${at}:00Z  ${w.event?.cron ?? e.$metadata?.trigger ?? '?'}  ${w.outcome ?? '?'}`;
    byHour.set(k, (byHour.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byHour].sort()) console.log(`  ${k}  ${n}`);

}

/*
 * Every event in a few short windows, grouped by invocation, printed for the
 * scheduled ones: the log lines a tick wrote, then how it ended. WINDOWS is a
 * comma-separated list of ISO start/end pairs joined by "/".
 */
async function windows() {
  // Defaults: the last good ticks and the first kill of 27 September, one
  // mid-outage hour, and the recovery on 28 September.
  const spec =
    process.env.WINDOWS ??
    '2026-09-27T08:48:00Z/2026-09-27T09:22:00Z,2026-09-27T15:03:00Z/2026-09-27T15:12:00Z,2026-09-28T05:33:00Z/2026-09-28T06:02:00Z';
  if (!spec) return;
  const base = [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT }];
  for (const pair of spec.split(',')) {
    const [a, b] = pair.split('/');
    const r = await post(`${OBS}/query`, {
      queryId: `cron-window-${a}`,
      timeframe: { from: Date.parse(a), to: Date.parse(b) },
      view: 'events',
      limit: 1000,
      parameters: { datasets: ['cloudflare-workers'], filters: base, filterCombination: 'and' },
    });
    const evs = r.json?.result?.events?.events ?? [];
    console.log('');
    console.log(`=== window ${a} -> ${b}: HTTP ${r.status}, ${evs.length} event(s) ===`);
    if (!r.json?.success) console.log(r.text.slice(0, 800));
    const groups = new Map();
    for (const e of evs) {
      const id = e.$metadata?.requestId ?? e.$workers?.requestId ?? '?';
      const g = groups.get(id) ?? [];
      g.push(e);
      groups.set(id, g);
    }
    for (const [id, g] of groups) {
      const scheduled = g.some((e) => e.$workers?.event?.cron || e.$workers?.eventType === 'cron' || e.$workers?.eventType === 'scheduled');
      if (!scheduled) continue;
      g.sort((x, y) => Number(x.timestamp) - Number(y.timestamp));
      const end = g.find((e) => e.$workers?.outcome) ?? {};
      const w = end.$workers ?? {};
      console.log('');
      console.log(`invocation ${id}  cron=${w.event?.cron ?? '?'}  outcome=${w.outcome ?? '?'}  cpu=${w.cpuTimeMs}ms  wall=${w.wallTimeMs}ms`);
      for (const e of g) {
        const m = e.$metadata ?? {};
        const msg = m.message ?? e.source?.message ?? '';
        console.log(`  ${new Date(Number(e.timestamp)).toISOString()} ${m.level ?? e.source?.level ?? ''}  ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 400)}`);
      }
    }
  }
}

try {
  await analytics();
} catch (err) {
  console.log(`analytics failed: ${err.message}`);
}
try {
  await observability();
} catch (err) {
  console.log(`observability failed: ${err.message}`);
}
try {
  await windows();
} catch (err) {
  console.log(`windows failed: ${err.message}`);
}
