/**
 * What does production say about its own scheduled runs and sources?
 *
 * `/api/data-health` already carries the answer — the last recorded cron run
 * with each step's outcome, and every source's last attempt and last success —
 * but the sandbox this repo is worked from cannot reach production, and the
 * Probe workflow can. This prints that view in a shape a log can be read in.
 *
 * Reads only, and only GET. No passphrase, no writes.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* printed raw below */ }
  return { status: res.status, body, text };
}

const health = await get('/api/health');
console.log(`GET /api/health -> ${health.status}`);
console.log(JSON.stringify(health.body ?? health.text.slice(0, 500), null, 2));

const dh = await get('/api/data-health');
console.log(`\nGET /api/data-health -> ${dh.status}`);
if (!dh.body) {
  console.log(dh.text.slice(0, 2000));
  process.exit(1);
}

const { overall, lastRun, sources, generatedAt, release } = dh.body;
console.log(`generatedAt ${generatedAt}  release ${release?.gitSha}`);
console.log(`overall     ${JSON.stringify(overall)}`);

console.log('\n## Last recorded scheduled run');
console.log(JSON.stringify(lastRun, null, 2));

console.log('\n## Sources');
for (const s of sources ?? []) {
  const { steps, ...rest } = s;
  console.log(JSON.stringify(rest));
}
