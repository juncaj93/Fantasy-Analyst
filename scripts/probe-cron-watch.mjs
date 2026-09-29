/**
 * Dry run of the Worker cron watch against Cloudflare, printing its verdicts.
 *
 * The watch's own workflow can only be dispatched once it is on the default
 * branch; this lets its real query and rules be run from a branch first.
 * Read-only.
 */
import { LOOKBACK_HOURS, fetchInvocations, judgeAll } from './cron-health-watch.mjs';

const now = new Date();
const rows = await fetchInvocations({
  token: process.env.CLOUDFLARE_API_TOKEN,
  account: process.env.ACCOUNT_ID,
  from: new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000),
  to: now,
});
console.log(`${rows.length} scheduled invocations over ${LOOKBACK_HOURS}h`);
for (const v of judgeAll(rows, now)) console.log(`${v.result === 'success' ? 'ok  ' : 'FAIL'}  ${v.name}: ${v.message}`);

// And the verdict the watch would have given at 10:20 UTC on 27 September.
const then = new Date('2026-09-27T10:20:00Z');
const upTo = rows.filter((r) => Date.parse(r.datetime) <= then.getTime());
console.log('');
console.log('as of 2026-09-27T10:20Z:');
for (const v of judgeAll(upTo, then)) console.log(`${v.result === 'success' ? 'ok  ' : 'FAIL'}  ${v.name}: ${v.message}`);
