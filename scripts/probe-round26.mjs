/**
 * Round 26 (smart Waivers): the round's ONE production check.
 * Read-only. Sleeper is never called by this script, nothing is written, and
 * the switch is not flipped: one request asks for the look-ahead with
 * `lookahead=1`, which only that request sees.
 *
 *   1. the deployed SHA (`/api/health`), the switches, and today's D1 rows
 *      before and after;
 *   2. Waivers on Alex's real league as the screen asks for it (switch off,
 *      "before"), rows read;
 *   3. the same with `lookahead=1` ("after"), rows read, and the three lines:
 *      the stash (an inherited role or not), the covers and the block.
 *
 * Every request carries `cost=1`, so the rows each one read are printed.
 * Times in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 26 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - started };
}

const cost = (b) => `${b?.cost?.rowsReturned ?? '?'} rows in ${b?.cost?.statements ?? '?'} statements`;
const bid = (b) => (b?.kind === 'claim' ? (b.low === b.high ? `bid $${b.high}` : `bid $${b.low} to $${b.high}`) : b?.kind === 'free' ? 'free agent, no bid' : '');
const room = (r) => (r?.kind === 'reserve' ? 'Open IR slot' : r?.kind === 'open' ? 'Open bench spot' : r ? `Drop ${r.name} (drop-ready)` : '');

console.log(`Round 26 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);
let probeRows = 0;

heading('Production revision');
const health = await get('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);
const status = await get('/api/auth/status');
console.log(`switches: ${JSON.stringify(status.body?.features ?? null)}`);
const leagues = await get('/api/leagues');
const leagueId = process.env.LEAGUE_ID || (leagues.body?.leagues ?? []).find((l) => l.isSelected)?.id || '';
if (!leagueId) {
  console.log('no selected league; stopping');
  process.exit(0);
}

heading('Waivers as the screen asks (before)');
const before = await get(`/api/leagues/${encodeURIComponent(leagueId)}/waivers?cost=1`);
probeRows += before.body?.cost?.rowsReturned ?? 0;
console.log(`status ${before.status}, ${cost(before.body)}, ${before.ms} ms, scanned ${before.body?.pool?.scanned ?? '?'}`);
const t0 = before.body?.tiers ?? {};
console.log(`  stash: ${t0.upsideStash ? `${t0.upsideStash.name} (${t0.upsideStash.reason})` : 'none'}`);
console.log(`  block: ${t0.block ? `${t0.block.name} (${t0.block.reason})` : 'none'}`);

heading('Waivers with the look-ahead, this request only (after)');
const after = await get(`/api/leagues/${encodeURIComponent(leagueId)}/waivers?cost=1&lookahead=1`);
probeRows += after.body?.cost?.rowsReturned ?? 0;
console.log(`status ${after.status}, ${cost(after.body)}, ${after.ms} ms, scanned ${after.body?.pool?.scanned ?? '?'}`);
const t = after.body?.tiers ?? {};
const lines = [];
if (t.upsideStash) lines.push([`Stash: ${t.upsideStash.name} (${t.upsideStash.reason}), ${bid(t.upsideStash.bid)}`, room(t.upsideStash.room), t.upsideStash.path?.kind]);
for (const c of t.cover ?? []) lines.push([`Add: ${c.name} (${c.reason}), ${bid(c.bid)}`, room(c.room), `week ${c.week}, +${c.gain}`]);
if (t.block) lines.push([`Block: ${t.block.name} (${t.block.reason}), ${bid(t.block.bid)}`, room(t.block.room), t.block.detail]);
if (lines.length === 0) console.log('  no stash, cover or block line this week');
for (const [line, where, note] of lines) console.log(`  ${line}\n     ${where} [${note ?? ''}]`);
console.log(`  do this: ${(t.doThese ?? []).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);
console.log(`  consider: ${(t.consider ?? []).slice(0, 3).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);

heading('Rows');
const rowsAfter = rowsToday();
console.log(`this probe's requests read ${probeRows} rows`);
console.log(`D1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore} while the probe ran, everyone's reads)` : ''}`);
console.log(`finished ${eastern()} ET`);
