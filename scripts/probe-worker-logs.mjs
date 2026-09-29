/**
 * Search the Worker's own logs for a phrase, and count it by hour.
 *
 * Written for one question: does the runtime report promises settled from a
 * request context that had already ended? When that happens workerd cancels
 * the waiting request's continuation, and the request hangs until the client
 * gives up, which is the 45-second `clientDisconnected` pattern the analytics
 * show. The runtime logs a warning each time; this counts them.
 *
 * Read-only. Workers Observability telemetry query API.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID, HOURS (default 72),
 *      NEEDLE (default "different request context"), SCRIPT_NAME.
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const HOURS = Number(process.env.HOURS ?? 72);
const NEEDLE = process.env.NEEDLE ?? 'different request context';
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';

if (!TOKEN || !ACCOUNT) {
  console.error('CLOUDFLARE_API_TOKEN and ACCOUNT_ID are both required.');
  process.exit(1);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`;
const to = Date.now();
const from = to - HOURS * 3_600_000;

async function query(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* printed below */
  }
  return { status: res.status, json, text };
}

const filters = [
  { key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT },
  { key: '$metadata.message', operation: 'includes', type: 'string', value: NEEDLE },
];

const events = await query({
  queryId: `probe-${to}`,
  timeframe: { from, to },
  view: 'events',
  limit: 100,
  parameters: { datasets: ['cloudflare-workers'], filters, filterCombination: 'and' },
});

console.log(`searching ${SCRIPT} logs for "${NEEDLE}" over ${HOURS}h -> HTTP ${events.status}`);
if (!events.json?.success) {
  console.log(events.text.slice(0, 2000));
  process.exit(0);
}

const list = events.json.result?.events?.events ?? [];
console.log(`${list.length} matching event(s) returned (capped at 100)`);
const byHour = new Map();
for (const e of list) {
  const at = new Date(Number(e.timestamp ?? e.$metadata?.timestamp ?? 0)).toISOString().slice(0, 13) + ':00Z';
  byHour.set(at, (byHour.get(at) ?? 0) + 1);
}
for (const [hour, n] of [...byHour].sort()) console.log(`  ${hour}  ${n}`);
for (const e of list.slice(0, 5)) {
  const m = e.$metadata ?? {};
  console.log('');
  console.log(`  ${new Date(Number(e.timestamp ?? m.timestamp ?? 0)).toISOString()}  ${m.url ?? m.trigger ?? ''}`);
  console.log(`  ${String(m.message ?? JSON.stringify(e.source ?? e)).slice(0, 400)}`);
}
