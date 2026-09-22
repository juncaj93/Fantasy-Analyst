/**
 * Does the waiver board have rows, and does role trend have readings?
 *
 * The two symptoms that opened the data-pipeline round: a waiver board that
 * scanned 68 free agents and scored none, and "insufficient data" for role
 * trend on nine of ten rostered players. This reads both from production the
 * way the screens do, and prints counts rather than a verdict.
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

/** Every value under a key named `name`, anywhere in the tree. */
function collect(node, name, out = []) {
  if (Array.isArray(node)) for (const n of node) collect(n, name, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === name) out.push(v);
      collect(v, name, out);
    }
  }
  return out;
}

function tally(values) {
  const m = new Map();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

const setup = await get('/api/setup/status');
const leagueId = process.env.LEAGUE_ID || setup.body?.league?.id;
console.log(`league ${leagueId ?? '(none selected)'}  (setup ${setup.status})`);
if (!leagueId) process.exit(1);

// ------------------------------------------------------------- waiver board
const w = await get(`/api/leagues/${leagueId}/waivers`);
console.log(`\nGET waivers -> ${w.status}`);
if (w.body) {
  const b = w.body;
  console.log(`found ${b.found}  considered ${b.considered ?? '?'}  upgrades ${b.upgrades?.length ?? '?'}`);
  console.log(`headline ${JSON.stringify(b.headline)}`);
  console.log(`pool ${JSON.stringify(b.pool)}`);
  for (const n of (b.notes ?? []).slice(0, 8)) console.log(`note ${JSON.stringify(n).slice(0, 300)}`);
  for (const u of (b.upgrades ?? []).slice(0, 5)) {
    const name = u.add?.name ?? u.add?.fullName ?? u.player?.name ?? u.name ?? '?';
    console.log(`upgrade ${name}: ${JSON.stringify(u).slice(0, 200)}`);
  }
  console.log(`role trend values on the board: ${JSON.stringify(tally(collect(b, 'roleTrend')))}`);
} else {
  console.log(w.text.slice(0, 1000));
}

// ------------------------------------------------------ role trend on Team
const l = await get(`/api/leagues/${leagueId}/lineup`);
console.log(`\nGET lineup -> ${l.status}`);
if (l.body) {
  const factors = collect(l.body, 'factors').flat().filter((f) => f && f.key === 'role_trend');
  console.log(`role_trend factors: ${factors.length}`);
  console.log(`  displays: ${JSON.stringify(tally(factors.map((f) => f.display)))}`);
  console.log(`  unknown:  ${JSON.stringify(tally(factors.map((f) => f.unknown)))}`);
  const trends = collect(l.body, 'trend').filter((t) => typeof t === 'string');
  console.log(`every "trend" string in the lineup: ${JSON.stringify(tally(trends))}`);
} else {
  console.log(l.text.slice(0, 1000));
}
