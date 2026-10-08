/**
 * What the betting-line and injury reads cost per call, and what the database
 * writes in a day (finding D5).
 *
 * Read-only: Cloudflare's GraphQL Analytics API, no SQL, no user data.
 *
 * Per-call cost is the measure that survives a deploy in the middle of a
 * window. A day's total moves with how often Alex opened a screen; rows read
 * per call of the same statement moves only when the database does less work
 * to answer it. So this prints, for three windows ending now (24 h, 6 h,
 * 2 h), every statement that reads `player_props` or `player_injury_reports`
 * with its calls, rows read, rows read per call and rows written, and then the
 * window's ten biggest writers and its total rows written, because an index
 * costs a write on every row it covers and D1's free plan allows 100,000
 * written rows a day.
 *
 *   node scripts/probe-d1-query-costs.mjs
 *
 * The account comes from ACCOUNT_ID, or from the token's own account list.
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WINDOWS_HOURS = [24, 6, 2];
const WATCH = /player_props|player_injury_reports/;

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

const ACCOUNT = await account();
if (!ACCOUNT) {
  console.error('Could not resolve the Cloudflare account id.');
  process.exit(1);
}

async function byQuery(hours) {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  const data = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) {
       viewer { accounts(filter: { accountTag: $a }) {
         d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
           dimensions { query }
           sum { rowsRead rowsWritten }
           count
         }
       } }
     }`,
    { a: ACCOUNT, from: from.toISOString(), to: to.toISOString() },
  );
  const out = new Map();
  for (const r of data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
    const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
    const hit = out.get(q) ?? { read: 0, written: 0, calls: 0 };
    hit.read += Number(r.sum?.rowsRead ?? 0);
    hit.written += Number(r.sum?.rowsWritten ?? 0);
    hit.calls += Number(r.count ?? 0);
    out.set(q, hit);
  }
  return { from, to, rows: [...out.entries()].map(([q, v]) => ({ q, ...v })) };
}

const n = (v) => Math.round(v).toLocaleString('en-GB');
for (const hours of WINDOWS_HOURS) {
  const { from, to, rows } = await byQuery(hours);
  const read = rows.reduce((a, r) => a + r.read, 0);
  const written = rows.reduce((a, r) => a + r.written, 0);
  console.log(`\n== last ${hours} h (${from.toISOString()} to ${to.toISOString()})`);
  console.log(`all queries: ${n(read)} rows read, ${n(written)} rows written`);
  console.log(`\nbetting-line and injury reads`);
  console.log(`   calls    rows read   per call   written   query`);
  for (const r of rows.filter((r) => WATCH.test(r.q) && /^SELECT/i.test(r.q)).sort((a, b) => b.read - a.read)) {
    console.log(
      `${String(r.calls).padStart(8)} ${n(r.read).padStart(12)} ${n(r.read / Math.max(1, r.calls)).padStart(10)} ${n(r.written).padStart(9)}   ${r.q.slice(0, 160)}`,
    );
  }
  console.log(`\nbiggest writers`);
  console.log(`   calls  rows written   query`);
  for (const r of rows.filter((r) => r.written > 0).sort((a, b) => b.written - a.written).slice(0, 10)) {
    console.log(`${String(r.calls).padStart(8)} ${n(r.written).padStart(13)}   ${r.q.slice(0, 160)}`);
  }
}
