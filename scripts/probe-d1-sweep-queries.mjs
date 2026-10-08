/**
 * Which queries the nightly production sweep spends its D1 rows on (finding D2).
 *
 * Read-only: Cloudflare's GraphQL Analytics API, no SQL, no user data.
 *
 * `d1 insights` ranks queries over whole days, and `probe-d1-usage-hours`
 * buckets a day by hour without saying which query. The sweep is a burst inside
 * one window, so this asks for rows read per query inside the sweep's window
 * and inside a quiet window of the same length, and prints both and the
 * difference: what the sweep added, query by query.
 *
 *   SWEEP_FROM=2026-10-07T00:00:00Z SWEEP_TO=2026-10-07T02:00:00Z \
 *   QUIET_FROM=2026-10-07T03:00:00Z QUIET_TO=2026-10-07T05:00:00Z \
 *   node scripts/probe-d1-sweep-queries.mjs
 *
 * The defaults are the 7 October window that read about 2.4 million rows (two
 * hand-dispatched full passes, 00:04 and 01:31 UTC) and the two hours after it.
 * The account comes from ACCOUNT_ID, or from the token's own account list.
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SWEEP = [process.env.SWEEP_FROM ?? '2026-10-07T00:00:00Z', process.env.SWEEP_TO ?? '2026-10-07T02:00:00Z'];
const QUIET = [process.env.QUIET_FROM ?? '2026-10-07T03:00:00Z', process.env.QUIET_TO ?? '2026-10-07T05:00:00Z'];
const TOP = Number(process.env.TOP ?? 25);

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}

async function account() {
  if (process.env.ACCOUNT_ID) return process.env.ACCOUNT_ID;
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => null);
  return body?.result?.[0]?.id ?? null;
}

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(async () => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

const unwrap = (t) => {
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
};
const fieldsOf = async (name) =>
  (await graphql(`query F($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } }`, { n: name }))
    ?.__type?.fields ?? [];

const ACCOUNT = await account();
if (!ACCOUNT) {
  console.error('Could not resolve the Cloudflare account id.');
  process.exit(1);
}
const root = (await graphql('{ __schema { queryType { name } } }')).__schema.queryType.name;
const viewer = unwrap((await fieldsOf(root)).find((f) => f.name === 'viewer').type);
const acct = unwrap((await fieldsOf(viewer)).find((f) => f.name === 'accounts').type);
const accountFields = await fieldsOf(acct);
const groupField = accountFields.find((f) => f.name === 'd1QueriesAdaptiveGroups');
if (!groupField) {
  console.error(`No d1QueriesAdaptiveGroups on ${acct}. D1 fields: ${accountFields.filter((f) => /d1/i.test(f.name)).map((f) => f.name).join(', ')}`);
  process.exit(1);
}
const groupType = unwrap(groupField.type);
const groupFields = await fieldsOf(groupType);
const dims = (await fieldsOf(unwrap(groupFields.find((f) => f.name === 'dimensions').type))).map((f) => f.name);
const sums = (await fieldsOf(unwrap(groupFields.find((f) => f.name === 'sum').type))).map((f) => f.name);
const queryDim = dims.find((d) => /^query$/i.test(d)) ?? dims.find((d) => /query/i.test(d));
const readKey = sums.find((s) => /^rows?_?read/i.test(s));
const countField = groupFields.find((f) => f.name === 'count') ? 'count' : null;
console.log(`dimensions: ${dims.join(', ')}`);
console.log(`sums: ${sums.join(', ')}`);
if (!queryDim || !readKey) {
  console.error('No query dimension or rows-read metric to rank by.');
  process.exit(1);
}

async function window([from, to]) {
  const data = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) {
       viewer { accounts(filter: { accountTag: $a }) {
         d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_${readKey}_DESC]) {
           dimensions { ${queryDim} }
           sum { ${readKey} }
           ${countField ?? ''}
         }
       } }
     }`,
    { a: ACCOUNT, from, to },
  );
  const rows = data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
  const out = new Map();
  for (const r of rows) {
    const q = String(r.dimensions?.[queryDim] ?? '').replace(/\s+/g, ' ').trim();
    const hit = out.get(q) ?? { rows: 0, calls: 0 };
    hit.rows += Number(r.sum?.[readKey] ?? 0);
    hit.calls += Number(r.count ?? 0);
    out.set(q, hit);
  }
  return out;
}

const sweep = await window(SWEEP);
const quiet = await window(QUIET);
const total = (m) => [...m.values()].reduce((a, v) => a + v.rows, 0);
console.log(`\nsweep window ${SWEEP[0]} to ${SWEEP[1]}: ${total(sweep).toLocaleString('en-GB')} rows`);
console.log(`quiet window ${QUIET[0]} to ${QUIET[1]}: ${total(quiet).toLocaleString('en-GB')} rows`);
console.log(`\nrank  added rows   sweep rows (calls)   quiet rows   query`);
const ranked = [...sweep.entries()]
  .map(([q, v]) => ({ q, ...v, quiet: quiet.get(q)?.rows ?? 0, added: v.rows - (quiet.get(q)?.rows ?? 0) }))
  .sort((a, b) => b.added - a.added)
  .slice(0, TOP);
ranked.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(4)}  ${String(r.added).padStart(10)}   ${String(r.rows).padStart(10)} (${String(r.calls).padStart(4)})   ${String(r.quiet).padStart(10)}   ${r.q.slice(0, 150)}`,
  );
});
