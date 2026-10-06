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
 * 4. **Did the count fall at the reset?** The app assumes the provider's billing
 *    month starts on the 13th (`BILLING_RESET_DAY`, assumed from the signup date,
 *    not confirmed). From the first period that began after that assumption was
 *    adopted, the provider's count should be close to what the ledger booked
 *    since the reset day. If it is far above it, the count did not fall to near
 *    zero when the app thought it would, the assumption is wrong, and this prints
 *    that loudly and fails the run. The first such check is any time after
 *    13 October 2026; run it then.
 *
 * Env: SPORTSGAMEODDS_API_KEY; CLOUDFLARE_API_TOKEN and ACCOUNT_ID for the
 * ledger half (optional). PRODUCTION_URL overrides the app.
 */

import { BILLING_RESET_DAY, BILLING_RESET_NOTE, billingPeriodOf } from '../src/core/vegas/billingPeriod.ts';

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

// ---------------------------------------------------------- the reset check

/** The first date a reset check is a verdict and not a note: when the assumption was adopted. */
const ASSUMPTION_ADOPTED = Date.parse('2026-10-07T00:00:00Z');
/** Calls a probe can cost between two readings (the team table alone is 34), so not a verdict below this. */
const TOLERANCE = 40;

console.log('\n=== the reset check: did the count fall when the app thinks the month began? ===');
const period = billingPeriodOf();
console.log(`  assumed reset day: the ${BILLING_RESET_DAY}th (UTC). ${BILLING_RESET_NOTE}`);
console.log(`  the current period: ${period.label} (${period.start} to ${period.end})`);
const live = Number(month(second ?? first)?.['current-entities']);
if (!Number.isFinite(live) || !ACCOUNT || !DB) {
  console.log('  cannot check without the provider key and the ledger; skipping');
  process.exit(0);
}
const since = await select(
  `SELECT COALESCE(SUM(entities), 0) AS n FROM vegas_usage_log WHERE at >= '${period.start}' AND at < '${period.end}' AND outcome IN ('fetched','failed') AND COALESCE(reason, '') NOT LIKE '%rate limited%'`,
);
const ledgerSince = Number(since[0]?.n ?? 0);
const before = await select(
  `SELECT provider_entities, provider_read_at FROM vegas_usage WHERE provider_read_at < '${period.start}' AND provider_entities IS NOT NULL ORDER BY provider_read_at DESC LIMIT 1`,
);
const unexplained = live - ledgerSince;
console.log(`  provider's count now:                 ${live}`);
console.log(`  ledger booked since ${period.start.slice(0, 10)}:       ${ledgerSince}`);
console.log(`  provider minus ledger (unexplained):  ${unexplained}   (probes and anything the ledger never saw; the tolerance is ${TOLERANCE})`);
if (before[0]) console.log(`  last reading before the reset:        ${before[0].provider_entities} at ${before[0].provider_read_at}  ->  now ${live}`);

const verdictApplies = period.startMs >= ASSUMPTION_ADOPTED;
if (unexplained <= TOLERANCE) {
  console.log(`  CONSISTENT: the count is about what we spent since the ${BILLING_RESET_DAY}th, so it did fall at the reset${verdictApplies ? '' : ' (or the ledger and a few probes happen to add up)'}.`);
} else if (!verdictApplies) {
  console.log(
    `  NOTE, not a verdict: this period began on ${period.start.slice(0, 10)}, before the ${BILLING_RESET_DAY}th was adopted. The count is ${unexplained} above the ledger,` +
      ' which is either probes since then or a reset that did not fall on this day. The first real check is any time after 13 October 2026.',
  );
} else {
  const msg =
    `THE RESET ASSUMPTION LOOKS WRONG: the provider's count is ${live}, which is ${unexplained} above the ${ledgerSince} the ledger booked since ` +
    `${period.start.slice(0, 10)}. It did not fall to near zero when the app assumed the month began. Check whether a probe spent calls since the reset; ` +
    'if none did, the provider resets on a different day. Change BILLING_RESET_DAY in src/core/vegas/billingPeriod.ts (one place) and run probe-sgo-reset.mjs on a branch to look for the real day.';
  console.log(`  ${msg}`);
  console.log(`::error title=Odds provider reset assumption looks wrong::${msg}`);
  process.exitCode = 1;
}
