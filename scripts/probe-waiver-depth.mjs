/**
 * Why does the waiver board stack one position, and what does "See why" say?
 *
 * Opened by a live board that recommended four tight ends at once to a roster
 * that already holds two and starts one. Prints, from production and the way
 * the Waivers screen reads it:
 *
 *   - the roster by position, and who the lineup starts;
 *   - every value add with the man it was measured against and its gain;
 *   - the claim plan's lines and each claim's "See why" text;
 *   - Sleeper trending rank for each board player, where the response has it.
 *
 * Then, between two marker lines, the `waiver-plan` support snapshot as
 * gzip+base64, so the exact state can be replayed offline through the shipped
 * engine (`npm run support:fixture`). Reads only, and only GET.
 */

import { gzipSync } from 'node:zlib';

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* printed raw below */
  }
  return { status: res.status, body, text };
}

const setup = await get('/api/setup/status');
const leagueId = process.env.LEAGUE_ID || setup.body?.league?.id;
console.log(`league ${leagueId ?? '(none selected)'}  (setup ${setup.status})`);
if (!leagueId) process.exit(1);

const w = await get(`/api/leagues/${leagueId}/waivers`);
console.log(`\nGET waivers -> ${w.status}`);
if (!w.body) {
  console.log(w.text.slice(0, 2000));
  process.exit(1);
}
const b = w.body;
console.log(`week ${b.week ?? '?'}  considered ${b.considered ?? '?'}  threshold ${b.threshold ?? '?'}`);

const slots = b.lineup?.slots ?? [];
console.log('\nlineup:');
for (const s of slots) console.log(`  ${s.slot.padEnd(6)} ${s.name ?? '(empty)'}  ${s.position ?? ''}  score ${s.score ?? '?'}`);

for (const u of b.upgrades ?? []) {
  console.log(`\nupgrade ${u.slot} (${u.need}) over ${u.currentName ?? '-'} bar ${u.bar}`);
  for (const c of u.candidates ?? []) console.log(`  ${c.position} ${c.name}  score ${c.score}  gain ${c.gain}`);
}

console.log('\nvalue adds:');
for (const v of b.valueAdds ?? []) {
  console.log(`  ${v.position.padEnd(3)} ${v.name.padEnd(24)} score ${v.score}  gain ${v.gain}  over ${v.overName}  | ${(v.reasons ?? []).join(' / ')}`);
}

console.log('\nunknowns (trending, unscored):');
for (const u of (b.unknowns ?? []).slice(0, 10)) console.log(`  ${u.position} ${u.name} rank ${u.leagueRank} adds ${u.adds}`);

const plan = b.claimPlan;
console.log(`\nclaim plan: state ${plan?.state}  headline ${JSON.stringify(plan?.headline)}`);
for (const c of plan?.claims ?? []) {
  console.log(`  ${c.rank}. ${c.headline}${c.qualifier ? `  [${c.qualifier}]` : ''}`);
  for (const line of c.why ?? []) console.log(`       why: ${line}`);
}

const snap = await get(`/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`\nGET support-snapshot -> ${snap.status}  ${snap.text.length} bytes`);
if (snap.status === 200) {
  const packed = gzipSync(Buffer.from(snap.text)).toString('base64');
  console.log(`packed ${packed.length} chars`);
  console.log('-----BEGIN SNAPSHOT-----');
  for (let i = 0; i < packed.length; i += 4000) console.log(packed.slice(i, i + 4000));
  console.log('-----END SNAPSHOT-----');
} else {
  console.log(snap.text.slice(0, 1000));
}
