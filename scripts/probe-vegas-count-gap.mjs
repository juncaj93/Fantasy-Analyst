/**
 * Why do the app's odds count and the provider's disagree?
 *
 * Alex noticed the two differ by about ten. This puts the numbers next to each
 * other and attributes the difference, using only reads:
 *
 *   1. the provider's own usage, read twice. `/account/usage` was measured not
 *      to move the counter, and reading it twice is the proof that this probe
 *      is not itself a source of the gap it is looking for;
 *   2. what the deployed app says it has used, from the public
 *      `/api/vegas/budget` (a read of the ledger, no provider call);
 *   3. with a Cloudflare token, the ledger itself: the provider's last stored
 *      reading, when it was taken, and every entity the ledger booked after it.
 *
 * The arithmetic that matters is the third one. The app stores the provider's
 * count when a refresh *starts*, so the number it shows afterwards is that
 * reading and not the post-refresh one:
 *
 *   expected provider count now = stored reading + ledger entities since it
 *   unexplained                 = actual provider count now - expected
 *
 * `unexplained` is calls the ledger never saw (a probe, another deployment, a
 * crash between the request and the write). The part the app can fix is the lag.
 *
 * Env: SPORTSGAMEODDS_API_KEY; CLOUDFLARE_API_TOKEN and ACCOUNT_ID for the
 * ledger half (optional). PRODUCTION_URL overrides the app.
 */

const APP = process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const KEY = process.env.SPORTSGAMEODDS_API_KEY;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';

async function providerUsage() {
  if (!KEY) return null;
  const res = await fetch('https://api.sportsgameodds.com/v2/account/usage', {
    headers: { 'X-Api-Key': KEY, accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, limits: body?.data?.rateLimits ?? null };
}

const month = (u) => u?.limits?.['per-month'] ?? null;

console.log('=== the provider, read twice (free) ===');
const first = await providerUsage();
const second = await providerUsage();
if (!first) console.log('  no SPORTSGAMEODDS_API_KEY in this run; skipping');
else {
  for (const [name, u] of [['first', first], ['second', second]]) {
    const m = month(u);
    console.log(`  ${name.padEnd(6)}: HTTP ${u.status}  current-entities=${m?.['current-entities']}  max-entities=${m?.['max-entities']}`);
  }
  console.log(`  reading usage moved the counter by: ${Number(month(second)?.['current-entities']) - Number(month(first)?.['current-entities'])}`);
  console.log('  every window the provider reports:');
  for (const [window, v] of Object.entries(first.limits ?? {})) console.log(`    ${window}: ${JSON.stringify(v)}`);
}

console.log('\n=== what the app says ===');
const budget = await (await fetch(`${APP}/api/vegas/budget`)).json().catch(() => null);
console.log(`  used=${budget?.budget?.used}  source=${budget?.budget?.source}  month=${budget?.budget?.month}  state=${budget?.budget?.state}`);
console.log(`  by source: ${JSON.stringify(budget?.bySource ?? null)}`);
for (const row of budget?.recent ?? []) {
  console.log(`  ${row.at}  ${String(row.source).padEnd(8)} ${String(row.outcome).padEnd(8)} entities=${row.entities} requests=${row.requests}  ${String(row.reason ?? '').slice(0, 70)}`);
}

async function call(path, init = {}) {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  return res.json().catch(() => null);
}

if (!TOKEN) {
  console.log('\n(no Cloudflare token in this run, so the ledger half is skipped)');
  process.exit(0);
}
if (!ACCOUNT) ACCOUNT = (await call('/accounts'))?.result?.[0]?.id;
const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;

async function select(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
  const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
  if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
  return r.result?.[0]?.results ?? [];
}

console.log('\n=== the ledger against the provider ===');
const months = await select('SELECT month, entities, requests, provider_entities, provider_limit, provider_read_at FROM vegas_usage ORDER BY month DESC LIMIT 3');
for (const m of months) {
  console.log(`  ${m.month}: ledger entities=${m.entities} requests=${m.requests}  provider reading=${m.provider_entities} (taken ${m.provider_read_at})`);
}
const latest = months[0];
if (latest?.provider_read_at) {
  const after = await select(
    `SELECT source, outcome, COUNT(*) AS rows_, SUM(entities) AS entities FROM vegas_usage_log WHERE at >= '${latest.provider_read_at}' AND outcome IN ('fetched','failed') GROUP BY 1,2`,
  );
  const since = after.reduce((s, r) => s + Number(r.entities ?? 0), 0);
  console.log(`\n  the stored reading was taken ${latest.provider_read_at}`);
  console.log(`  entities the ledger booked since then: ${since}  ${JSON.stringify(after)}`);
  const expected = Number(latest.provider_entities) + since;
  const actual = Number(month(first)?.['current-entities']);
  console.log(`  expected provider count now: ${latest.provider_entities} + ${since} = ${expected}`);
  console.log(`  actual provider count now:   ${Number.isFinite(actual) ? actual : '(no key)'}`);
  if (Number.isFinite(actual)) {
    console.log(`  calls the ledger never saw:  ${actual - expected}`);
    console.log(`  what the app shows as "used": ${budget?.budget?.used}  (provider now minus that: ${actual - Number(budget?.budget?.used)})`);
  }
}

console.log('\n=== the ledger\'s own failure rows, which are booked as spent ===');
const failed = await select(
  "SELECT at, source, event_id, entities, reason FROM vegas_usage_log WHERE outcome = 'failed' ORDER BY at DESC LIMIT 10",
);
for (const r of failed) console.log(`  ${r.at} ${r.source} entities=${r.entities} ${String(r.reason ?? '').slice(0, 80)}`);
