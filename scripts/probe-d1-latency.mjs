/**
 * Which queries are slow, and when? — the timing half of `d1 insights`.
 *
 * The D1-quota rounds ranked queries by rows read, which is the right lens for
 * the allowance and the wrong one for a 30-45 second wait: a cheap query stuck
 * behind a long one is slow without reading a row more. So this asks the
 * GraphQL Analytics API for D1 *time*, three ways:
 *
 *   1. per hour, the database's own batch-time percentiles, so a bad hour
 *      stands out against a normal one;
 *   2. per query, over the window, total and per-call duration, so the query
 *      that owns the time is named rather than inferred;
 *   3. the Worker's wall time per hour, so a slow request can be told apart
 *      from a slow database.
 *
 * Read-only. A metrics API, no user data, no SQL.
 *
 * Field names are introspected and printed, never assumed, for the same
 * reason as `probe-d1-usage-hours.mjs`: a guessed name reports zeroes.
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const HOURS = Number(process.env.HOURS ?? 72);
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';

if (!TOKEN || !ACCOUNT) {
  console.error('CLOUDFLARE_API_TOKEN and ACCOUNT_ID are both required.');
  process.exit(1);
}

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`HTTP ${res.status}, body not JSON`);
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

function unwrap(type) {
  let t = type;
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
}

async function fieldsOf(typeName) {
  if (!typeName) return [];
  const data = await graphql(
    `query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } }`,
    { n: typeName },
  );
  return data?.__type?.fields ?? [];
}

const rootName = (await graphql('{ __schema { queryType { name } } }'))?.__schema?.queryType?.name;
const viewerType = unwrap((await fieldsOf(rootName)).find((f) => f.name === 'viewer')?.type ?? {});
const accountType = unwrap((await fieldsOf(viewerType)).find((f) => f.name === 'accounts')?.type ?? {});
const accountFields = await fieldsOf(accountType);

/** The sub-selections a dataset offers, by name, for printing and choosing. */
async function shapeOf(dataset) {
  const field = accountFields.find((f) => f.name === dataset);
  if (!field) return null;
  const group = await fieldsOf(unwrap(field.type));
  const out = {};
  for (const part of ['dimensions', 'sum', 'avg', 'max', 'quantiles']) {
    const f = group.find((g) => g.name === part);
    out[part] = f ? (await fieldsOf(unwrap(f.type))).map((x) => x.name) : [];
  }
  return out;
}

const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
const BUCKETS = ['datetimeHour', 'datetimeFifteenMinutes', 'date'];
const fmt = (v) => (v == null ? '-' : String(Math.round(Number(v))));

async function run(label, fn) {
  console.log('');
  console.log(`== ${label}`);
  try {
    await fn();
  } catch (err) {
    console.log(`   could not answer: ${err.message}`);
  }
}

// 1. D1 batch time per hour.
await run('D1 query time per hour', async () => {
  const shape = await shapeOf('d1AnalyticsAdaptiveGroups');
  if (!shape) throw new Error('no d1AnalyticsAdaptiveGroups');
  console.log(`   quantiles offered: ${shape.quantiles.join(', ') || '(none)'}`);
  const bucket = BUCKETS.find((b) => shape.dimensions.includes(b));
  const qs = shape.quantiles.filter((q) => /querybatchtime/i.test(q));
  const reads = shape.sum.find((f) => /^rows?_?read/i.test(f));
  const calls = shape.sum.find((f) => /^read_?quer/i.test(f));
  const data = await graphql(
    `query Q($a: String!, $s: Time!) { viewer { accounts(filter: { accountTag: $a }) {
       d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $s }, orderBy: [${bucket}_ASC]) {
         dimensions { ${bucket} } sum { ${[reads, calls].filter(Boolean).join(' ')} } quantiles { ${qs.join(' ')} }
       } } } }`,
    { a: ACCOUNT, s: since },
  );
  const rows = data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;
  // Several databases can share a bucket; fold them by the worst quantile.
  const byBucket = new Map();
  for (const r of rows) {
    const k = r.dimensions[bucket];
    const prev = byBucket.get(k) ?? { reads: 0, calls: 0, q: {} };
    prev.reads += Number(r.sum[reads] ?? 0);
    prev.calls += Number(r.sum[calls] ?? 0);
    for (const q of qs) prev.q[q] = Math.max(prev.q[q] ?? 0, Number(r.quantiles[q] ?? 0));
    byBucket.set(k, prev);
  }
  console.log(`   ${bucket.padEnd(22)} ${'reads'.padStart(9)} ${'calls'.padStart(7)} ${qs.map((q) => q.replace(/queryBatchTimeMs/i, 'ms').padStart(9)).join('')}`);
  for (const [k, v] of byBucket) {
    console.log(`   ${String(k).padEnd(22)} ${String(v.reads).padStart(9)} ${String(v.calls).padStart(7)} ${qs.map((q) => fmt(v.q[q]).padStart(9)).join('')}`);
  }
});

// 2. Which queries own the time.
await run('D1 queries by total duration', async () => {
  const shape = await shapeOf('d1QueriesAdaptiveGroups');
  if (!shape) throw new Error('no d1QueriesAdaptiveGroups');
  console.log(`   dims: ${shape.dimensions.join(', ')}`);
  console.log(`   sum: ${shape.sum.join(', ')} | avg: ${shape.avg.join(', ')} | max: ${shape.max.join(', ')} | quantiles: ${shape.quantiles.join(', ')}`);
  const dur = shape.sum.find((f) => /duration/i.test(f));
  const reads = shape.sum.find((f) => /rows?_?read/i.test(f));
  const countKey = ['count'].find(() => true);
  const maxDur = shape.max.find((f) => /duration/i.test(f));
  const qDur = shape.quantiles.filter((f) => /duration/i.test(f));
  const data = await graphql(
    `query Q($a: String!, $s: Time!) { viewer { accounts(filter: { accountTag: $a }) {
       d1QueriesAdaptiveGroups(limit: 25, filter: { datetime_geq: $s }, orderBy: [sum_${dur}_DESC]) {
         ${countKey} dimensions { query } sum { ${dur} ${reads ?? ''} }
         ${maxDur ? `max { ${maxDur} }` : ''} ${qDur.length ? `quantiles { ${qDur.join(' ')} }` : ''}
       } } } }`,
    { a: ACCOUNT, s: since },
  );
  const rows = data.viewer.accounts[0].d1QueriesAdaptiveGroups;
  console.log(`   ${'total s'.padStart(8)} ${'calls'.padStart(7)} ${'avg ms'.padStart(8)} ${'max ms'.padStart(8)} ${qDur.map((q) => q.replace(/queryDurationMs/i, 'ms').padStart(8)).join('')}  query`);
  for (const r of rows) {
    const total = Number(r.sum[dur] ?? 0);
    console.log(
      `   ${(total / 1000).toFixed(1).padStart(8)} ${String(r.count).padStart(7)} ${fmt(total / Math.max(1, r.count)).padStart(8)} ${fmt(r.max?.[maxDur]).padStart(8)} ${qDur.map((q) => fmt(r.quantiles?.[q]).padStart(8)).join('')}  ${String(r.dimensions.query).replace(/\s+/g, ' ').slice(0, 140)}`,
    );
  }
});

// 3. Worker wall time per hour.
await run(`Worker ${SCRIPT} wall time per hour`, async () => {
  const shape = await shapeOf('workersInvocationsAdaptive');
  if (!shape) throw new Error('no workersInvocationsAdaptive');
  console.log(`   dims: ${shape.dimensions.join(', ')}`);
  console.log(`   quantiles: ${shape.quantiles.join(', ')}`);
  const bucket = BUCKETS.find((b) => shape.dimensions.includes(b));
  const qs = shape.quantiles.filter((q) => /^(wallTime|cpuTime)P(50|99|999)$/.test(q));
  const extraDims = ['usageModel', 'status'].filter((d) => shape.dimensions.includes(d));
  const data = await graphql(
    `query Q($a: String!, $s: Time!, $n: String!) { viewer { accounts(filter: { accountTag: $a }) {
       workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $s, scriptName: $n }, orderBy: [${bucket}_ASC]) {
         dimensions { ${bucket} ${extraDims.join(' ')} } sum { requests errors } quantiles { ${qs.join(' ')} }
       } } } }`,
    { a: ACCOUNT, s: since, n: SCRIPT },
  );
  const rows = data.viewer.accounts[0].workersInvocationsAdaptive;
  console.log(`   ${bucket.padEnd(22)} ${extraDims.map((d) => d.padEnd(18)).join('')}${'reqs'.padStart(6)}${'errs'.padStart(6)} ${qs.map((q) => q.padStart(12)).join('')}   (wall time in microseconds)`);
  for (const r of rows) {
    console.log(
      `   ${String(r.dimensions[bucket]).padEnd(22)} ${extraDims.map((d) => String(r.dimensions[d]).padEnd(18)).join('')}${String(r.sum.requests).padStart(6)}${String(r.sum.errors).padStart(6)} ${qs.map((q) => fmt(r.quantiles[q]).padStart(12)).join('')}`,
    );
  }
});
