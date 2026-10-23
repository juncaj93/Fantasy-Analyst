/**
 * Rows read per D1 statement, for the second audit's per-screen table.
 *
 * Read-only and free: Cloudflare's GraphQL Analytics API, no SQL against the
 * database, no call to the live app. Prints every statement's calls, rows read
 * and rows per call for the last 24 hours and the 30 seconds the combined
 * audit probe (run 39876202484) spent on the live app, then the total rows read
 * during each deploy of the evening: four before the deploy gate gained its
 * Matchup and waiver plan checks (#407) and the deploys from #407 on, so the
 * difference is what those two checks cost a deploy.
 *
 *   node scripts/probe-audit-d1.mjs
 *
 * Env: CLOUDFLARE_API_TOKEN, and ACCOUNT_ID (or the token's own account list).
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const PROBE = ['2026-10-23T00:07:50Z', '2026-10-23T00:08:20Z'];
/* Deploy runs, start to finish (GitHub Actions run times, UTC). */
const DEPLOYS = [
  ['#403, before', '2026-10-23T00:40:37Z', '2026-10-23T00:43:51Z'],
  ['#404, before', '2026-10-23T01:21:40Z', '2026-10-23T01:25:18Z'],
  ['#405, before', '2026-10-23T02:03:52Z', '2026-10-23T02:08:17Z'],
  ['#406, before', '2026-10-23T02:44:32Z', '2026-10-23T02:48:19Z'],
  ['#407, after', '2026-10-23T03:26:41Z', '2026-10-23T03:31:23Z'],
  ['#408, after', '2026-10-23T04:06:10Z', '2026-10-23T04:10:01Z'],
];

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

const ACCOUNT = await account();
if (!ACCOUNT) {
  console.error('Could not resolve the Cloudflare account id.');
  process.exit(1);
}

async function byQuery(from, to) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
          count dimensions { query } sum { rowsRead } } } } }`,
      variables: { a: ACCOUNT, from, to },
    }),
  });
  const body = await res.json().catch(() => null);
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  const agg = new Map();
  for (const r of body?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
    const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
    const hit = agg.get(q) ?? { calls: 0, read: 0 };
    hit.calls += Number(r.count ?? 0);
    hit.read += Number(r.sum?.rowsRead ?? 0);
    agg.set(q, hit);
  }
  return [...agg].sort((a, b) => b[1].read - a[1].read);
}

function print(label, rows) {
  const total = rows.reduce((s, [, v]) => s + v.read, 0);
  console.log(`\n## ${label}: ${rows.length} statements, ${total} rows read`);
  console.log('  calls  rows read  per call  query');
  for (const [q, v] of rows) {
    console.log(`${String(v.calls).padStart(7)} ${String(v.read).padStart(10)} ${String(Math.round(v.read / Math.max(1, v.calls))).padStart(9)}  ${q.slice(0, 300)}`);
  }
}

const now = new Date();
print('Last 24 hours', await byQuery(new Date(now.getTime() - 24 * 3_600_000).toISOString(), now.toISOString()));
print(`Audit probe window ${PROBE[0]} to ${PROBE[1]}`, await byQuery(PROBE[0], PROBE[1]));

console.log('\n## Rows read per deploy run');
for (const [label, from, to] of DEPLOYS) {
  const rows = await byQuery(from, to);
  const total = rows.reduce((s, [, v]) => s + v.read, 0);
  console.log(`${label.padEnd(14)} ${from} to ${to}  ${String(total).padStart(9)} rows, ${rows.length} statements`);
}
