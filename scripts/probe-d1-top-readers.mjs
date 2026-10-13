/**
 * Which queries read the most rows, per UTC day (cleanup round, audit).
 *
 * Read-only and free: Cloudflare's GraphQL Analytics API, no SQL against the
 * database, no call to the live app. Prints, for each of the last three UTC
 * days (today so far, then the two before it):
 *
 *   - total rows read and written, as a share of the 5,000,000 / 100,000 daily
 *     allowances, and whether the day reached the cap;
 *   - the ten queries that read the most rows, with calls and rows per call.
 *
 * A day is a calendar UTC day (00:00 to 24:00), because that is when the
 * allowance resets. A rolling 24 hours can straddle the reset and show more
 * than any one day spent.
 *
 *   node scripts/probe-d1-top-readers.mjs
 *
 * Env: CLOUDFLARE_API_TOKEN, and ACCOUNT_ID (or the token's own account list).
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DAILY_READ = 5_000_000;
const DAILY_WRITE = 100_000;
const DAYS = Number(process.env.DAYS ?? 3);

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
  const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

const ACCOUNT = await account();
if (!ACCOUNT) {
  console.error('Could not resolve the Cloudflare account id.');
  process.exit(1);
}

async function byQuery(from, to) {
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
  return [...out.entries()].map(([q, v]) => ({ q, ...v }));
}

const n = (v) => Math.round(v).toLocaleString('en-GB');
const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const now = new Date();
const today = startOfUtcDay(now);

for (let back = 0; back < DAYS; back++) {
  const from = new Date(today.getTime() - back * 86_400_000);
  const to = back === 0 ? now : new Date(from.getTime() + 86_400_000);
  const rows = await byQuery(from, to);
  const read = rows.reduce((a, r) => a + r.read, 0);
  const written = rows.reduce((a, r) => a + r.written, 0);
  const label = from.toISOString().slice(0, 10) + (back === 0 ? ' (so far)' : '');
  console.log(`\n== UTC day ${label}`);
  console.log(
    `rows read ${n(read)} (${((100 * read) / DAILY_READ).toFixed(1)}% of the 5M cap${read >= DAILY_READ ? ', CAP REACHED' : ''}); ` +
      `rows written ${n(written)} (${((100 * written) / DAILY_WRITE).toFixed(1)}% of 100k)`,
  );
  console.log(`   calls    rows read   per call   share   query`);
  for (const r of rows.sort((a, b) => b.read - a.read).slice(0, 10)) {
    console.log(
      `${String(r.calls).padStart(8)} ${n(r.read).padStart(12)} ${n(r.read / Math.max(1, r.calls)).padStart(10)} ` +
        `${((100 * r.read) / Math.max(1, read)).toFixed(1).padStart(6)}%   ${r.q.slice(0, 170)}`,
    );
  }
}
