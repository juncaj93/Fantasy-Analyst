/**
 * Round 34: why the probe's requests were refused, from Cloudflare's own
 * Workers Logs (free; reads no database rows). Lists every request event of
 * `fantasy-analyst` in a window with its outcome (exceededCpu,
 * exceededMemory, ok...), CPU and wall time, so CPU and memory can be told
 * apart. FROM/TO are ISO times; defaults to the last 15 minutes.
 */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const from = Date.parse(process.env.FROM ?? new Date(Date.now() - 15 * 60_000).toISOString());
const to = Date.parse(process.env.TO ?? new Date().toISOString());
if (!TOKEN || !ACCOUNT) {
  console.error('CLOUDFLARE_API_TOKEN and ACCOUNT_ID are both required.');
  process.exit(1);
}
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    queryId: `round34-${Date.now()}`,
    timeframe: { from, to },
    view: 'events',
    limit: 200,
    parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'fantasy-analyst' }] },
  }),
});
const json = await res.json().catch(() => null);
console.log(`Workers Logs ${new Date(from).toISOString()} to ${new Date(to).toISOString()} -> HTTP ${res.status}`);
if (!json?.success) {
  console.log(JSON.stringify(json?.errors ?? json).slice(0, 1500));
  process.exit(0);
}
const list = json.result?.events?.events ?? [];
console.log(`${list.length} event(s)`);
const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};
const pick = (f, re) => Object.entries(f).filter(([k]) => re.test(k)).map(([k, v]) => `${k.split('.').slice(-2).join('.')}=${String(v).slice(0, 90)}`);
const counts = new Map();
const rows = list
  .map((e) => flat(e))
  .sort((a, b) => Number(a.timestamp ?? a['$metadata.timestamp'] ?? 0) - Number(b.timestamp ?? b['$metadata.timestamp'] ?? 0));
for (const f of rows) {
  const outcome = Object.entries(f).find(([k]) => /outcome$/i.test(k))?.[1] ?? '?';
  counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const t = new Date(Number(f.timestamp ?? f['$metadata.timestamp'] ?? 0)).toISOString().slice(11, 23);
  const url = String(Object.entries(f).find(([k]) => /request\.url$|metadata\.url$/i.test(k))?.[1] ?? '').replace(/leagueId=[^&]+|leagues\/[^/]+/g, 'L').slice(0, 70);
  console.log(`  ${t}  ${String(outcome).padEnd(16)} ${pick(f, /cpuTime|wallTime|response\.status|memory/i).join(' ')}  ${url}`);
}
console.log('\noutcomes:', JSON.stringify(Object.fromEntries(counts)));
if (rows[0]) console.log('fields seen on one event:', Object.keys(rows[0]).filter((k) => /workers|metadata/.test(k)).slice(0, 40).join(', '));
