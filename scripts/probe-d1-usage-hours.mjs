/**
 * When were the rows actually read? — the question `d1 insights` cannot answer.
 *
 * `wrangler d1 insights` attributes rows to *queries* over a window and says
 * nothing about *when* inside it. That is the right tool for "which query is
 * expensive" and the wrong one for "was the allowance spent gradually or in one
 * half hour", which is the question an exhaustion 30 minutes after the daily
 * reset actually asks.
 *
 * The GraphQL Analytics API can bucket by time. This asks it, and prints one
 * line per bucket so the shape of a day is visible: a flat day and a spike look
 * nothing alike, and no amount of per-query averaging distinguishes them.
 *
 * Read-only. A metrics API, no user data, no SQL. Safe during an incident,
 * which is when it is wanted.
 *
 * ## Field names are found, never assumed
 *
 * #244 printed a column of zeroes because it guessed `rowsRead`/`sumRowsRead`/
 * `rows_read` and the payload used none of them. So this introspects the schema
 * for the dimension that buckets by time and for the metric that carries rows
 * read, prints both, and fails loudly rather than reporting a zero it invented.
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const HOURS = Number(process.env.HOURS ?? 36);

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}
if (!ACCOUNT) {
  console.error('ACCOUNT_ID is not set and could not be discovered.');
  process.exit(1);
}

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, and the body was not JSON:\n${text.slice(0, 800)}`);
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join(' | ')}`);
  }
  return body.data;
}

/** Walk the schema to the concrete type behind a field, however it is wrapped. */
function unwrap(type) {
  let t = type;
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
}

async function fieldsOf(typeName) {
  const data = await graphql(
    `query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } }`,
    { n: typeName },
  );
  return data?.__type?.fields ?? [];
}

const accountFields = await fieldsOf('Account');
const groups = accountFields.find((f) => f.name === 'd1AnalyticsAdaptiveGroups');
if (!groups) {
  console.error('This account type has no d1AnalyticsAdaptiveGroups field. Fields containing "d1":');
  console.error(accountFields.filter((f) => /d1/i.test(f.name)).map((f) => f.name).join(', ') || '(none)');
  process.exit(1);
}

const groupsType = unwrap(groups.type);
const groupFields = await fieldsOf(groupsType);
const dimensionsType = unwrap(groupFields.find((f) => f.name === 'dimensions')?.type ?? {});
const sumType = unwrap(groupFields.find((f) => f.name === 'sum')?.type ?? {});

const dimensionFields = (await fieldsOf(dimensionsType)).map((f) => f.name);
const sumFields = (await fieldsOf(sumType)).map((f) => f.name);

console.log(`group type      : ${groupsType}`);
console.log(`dimensions      : ${dimensionFields.join(', ')}`);
console.log(`sum             : ${sumFields.join(', ')}`);
console.log('');

/*
 * The finest time bucket this dataset actually offers, preferred in order.
 * Named from what the schema returned rather than from what the docs said.
 */
const BUCKETS = ['datetimeFifteenMinutes', 'datetimeHour', 'datetimeThirtyMinutes', 'datetime', 'date'];
const bucket = BUCKETS.find((b) => dimensionFields.includes(b));
if (!bucket) {
  console.error(`No time dimension among ${BUCKETS.join('/')}. Available: ${dimensionFields.join(', ')}`);
  process.exit(1);
}

const readKey = sumFields.find((f) => /^rows?_?read/i.test(f));
if (!readKey) {
  console.error(`No rows-read metric. Available: ${sumFields.join(', ')}`);
  process.exit(1);
}
const writeKey = sumFields.find((f) => /^rows?_?written/i.test(f));
const callKey = sumFields.find((f) => /^read_?quer/i.test(f));

const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
const selected = [readKey, writeKey, callKey].filter(Boolean).join(' ');

console.log(`bucketing by ${bucket}, metric ${readKey}, since ${since}`);
console.log('');

const data = await graphql(
  `query Usage($account: String!, $since: Time!) {
     viewer {
       accounts(filter: { accountTag: $account }) {
         d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since }, orderBy: [${bucket}_ASC]) {
           dimensions { ${bucket} }
           sum { ${selected} }
         }
       }
     }
   }`,
  { account: ACCOUNT, since },
);

const rows = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
if (rows.length === 0) {
  console.log('No usage rows returned for this window.');
  process.exit(0);
}

// One line per bucket, summed across databases.
const byBucket = new Map();
for (const row of rows) {
  const at = row.dimensions?.[bucket];
  const hit = byBucket.get(at) ?? { read: 0, written: 0, calls: 0 };
  hit.read += Number(row.sum?.[readKey] ?? 0);
  if (writeKey) hit.written += Number(row.sum?.[writeKey] ?? 0);
  if (callKey) hit.calls += Number(row.sum?.[callKey] ?? 0);
  byBucket.set(at, hit);
}

const LIMIT = 5_000_000;
console.log('bucket (UTC)            rows read    % of 5M    read queries');
console.log('--------------------------------------------------------------');
let day = null;
let runningDay = 0;
for (const [at, v] of [...byBucket.entries()].sort()) {
  const thisDay = String(at).slice(0, 10);
  if (day && thisDay !== day) {
    console.log(`  -- ${day} total: ${runningDay.toLocaleString('en-GB')} rows (${((100 * runningDay) / LIMIT).toFixed(1)}% of a day's allowance)`);
    runningDay = 0;
  }
  day = thisDay;
  runningDay += v.read;
  console.log(
    String(at).padEnd(24) +
      String(v.read).padStart(10) +
      ((100 * v.read) / LIMIT).toFixed(1).padStart(9) + '%' +
      String(v.calls).padStart(16),
  );
}
if (day) {
  console.log(`  -- ${day} total: ${runningDay.toLocaleString('en-GB')} rows (${((100 * runningDay) / LIMIT).toFixed(1)}% of a day's allowance)`);
}
