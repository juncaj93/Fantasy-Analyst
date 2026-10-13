/**
 * Which day, and which hour, does the provider's monthly count reset?
 *
 * Free: the provider's usage endpoint does not move the counter, and the ledger
 * reads are a few rows. Prints everything that bears on the question, so a
 * wrong `BILLING_RESET_DAY` is found from evidence and not guessed:
 *
 *   1. the whole usage answer, in case the provider names its own reset time;
 *   2. every provider reading the ledger has kept (one per month row), with when
 *      it was taken, so the readings bracket the days between a high count and
 *      the lower one that followed it;
 *   3. the provider's count now against what the ledger booked since the
 *      assumed reset, and how many hours into the reset day this is.
 *
 * What it can and cannot say: a count that is still high some hours after the
 * assumed reset is either a different day or a different hour. The readings
 * show which side of the assumed day the drop fell on. Run it again later the
 * same day before changing anything.
 *
 * Env: SPORTSGAMEODDS_API_KEY, CLOUDFLARE_API_TOKEN (and ACCOUNT_ID).
 */

import { BILLING_RESET_DAY } from '../src/core/vegas/billingPeriod.ts';

const KEY = process.env.SPORTSGAMEODDS_API_KEY;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';

if (KEY) {
  const res = await fetch('https://api.sportsgameodds.com/v2/account/usage', { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  console.log(`=== the provider's whole usage answer (HTTP ${res.status}) ===`);
  console.log(JSON.stringify(body, null, 2));
  const month = body?.data?.rateLimits?.['per-month'];
  console.log(`\nper-month count now: ${month?.['current-entities']} of ${month?.['max-entities']}`);
} else {
  console.log('no SPORTSGAMEODDS_API_KEY in this run');
}

if (TOKEN) {
  const call = async (path, init = {}) =>
    (await fetch(CF + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } })).json().catch(() => null);
  ACCOUNT ||= (await call('/accounts'))?.result?.[0]?.id;
  const DB = (await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`))?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
  const select = async (sql) => {
    if (!/^\s*select\b/i.test(sql)) throw new Error('refusing a non-SELECT');
    const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
    if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
    return r.result?.[0]?.results ?? [];
  };
  console.log('\n=== provider readings the ledger kept ===');
  for (const r of await select('SELECT month, entities, provider_entities, provider_read_at FROM vegas_usage ORDER BY provider_read_at DESC LIMIT 8')) {
    console.log(`  month ${r.month}: ledger ${r.entities}, provider said ${r.provider_entities} at ${r.provider_read_at}`);
  }
  console.log('\n=== what the ledger booked, by day, over the last 45 days ===');
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  for (const r of await select(`SELECT substr(at,1,10) AS day, SUM(entities) AS entities FROM vegas_usage_log WHERE at >= '${since}' AND outcome IN ('fetched','failed') GROUP BY 1 ORDER BY 1`)) {
    console.log(`  ${r.day}  ${r.entities}`);
  }
}

const now = new Date();
const resetStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), BILLING_RESET_DAY);
console.log(`\nassumed reset: the ${BILLING_RESET_DAY}th, 00:00 UTC. Now ${now.toISOString()}, ${(Math.max(0, now.getTime() - resetStart) / 3_600_000).toFixed(1)} h into that day (if this month's has begun).`);
