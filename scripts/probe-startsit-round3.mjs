/**
 * Round 3 (Start/Sit bugs, 3 November 2026): the one combined production read.
 *
 * Run after the D1 daily reset (7:05 PM ET in November, 00:05 UTC). Reads, once each:
 *
 *   - GET  /api/health                      the production SHA
 *   - GET  /api/leagues                     the selected league
 *   - GET  /api/leagues/:id/lineup          the 10-point rule's read (review S2): mode,
 *                                           margin, both sides' coverage; Team's
 *                                           lineup and Best move under that mode
 *   - GET  support-snapshot?context=lineup  Team's own inputs, rebuilt with no network
 *                                           under Balanced (where Team was stuck) and
 *                                           under the mode now (`startsit-round3-report.ts`)
 *   - GET  /api/leagues/:id/waivers         "Pick up and start" (review S1): who
 *                                           the card names, and who he replaces
 *
 * Reads only. No odds are bought, nothing is written, Sleeper is not asked.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const et = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';
const json = async (res) => (res.ok ? res.json() : { httpStatus: res.status });
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));

console.log(`started ${et(new Date())}`);
const health = await fetch(`${APP}/api/health`).then(json).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then(json);
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

/* S2: the rule's read, as Team gets it. */
const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then(json);
const s = lineup?.modeSuggestion;
console.log('\n## S2, the 10-point rule on Team');
console.log(`mode: ${lineup?.mode ?? '?'} (auto ${s?.auto ?? '?'}, state ${s?.state ?? '?'}, margin ${s?.margin ?? 'none'})`);
console.log(`detail: ${s?.detail ?? '?'}`);
for (const r of s?.reasons ?? []) console.log(`  ${r}`);
const side = (x) => (x ? `${x.slotsPriced}/${x.slotsTotal} slots priced (${x.slotsBorrowed} from Sleeper's week), total ${fmt(x.total)}` : 'not projected');
console.log(`mine: ${side(s?.mine)}`);
console.log(`opponent: ${side(s?.opponent)}`);
console.log(`firing: ${s?.auto === true && s?.state !== 'unknown' ? 'yes' : 'no'}`);

/* Old vs new: Team's own inputs (the lineup support snapshot), rebuilt under Balanced and under the mode now. */
const snap = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
console.log(`\n## Alex's lineup, before (Balanced) and now (${lineup?.mode ?? '?'}); GET support-snapshot (lineup) -> HTTP ${snap.status}`);
if (snap.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'round3-'));
  writeFileSync(join(dir, 'lineup.json'), await snap.text());
  try {
    console.log(execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/startsit-round3-report.ts', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    console.log(`(report failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 1500)})`);
  }
}
console.log(`swaps Team shows now: ${(lineup?.swaps ?? []).map((w) => `${w.inName} over ${w.outName} at ${w.slot} +${fmt(w.gain)}`).join('; ') || 'none'}`);
console.log(`fills: ${(lineup?.fills ?? []).map((f) => `${f.inName} at ${f.slot}`).join('; ') || 'none'}`);
console.log(`recommended ${fmt(lineup?.recommendedPoints)} vs Sleeper's lineup ${fmt(lineup?.currentPoints)}`);

/* S1: who "Pick up and start" names. */
const waivers = await fetch(`${APP}/api/leagues/${leagueId}/waivers`).then(json);
const p = waivers?.pickupStart;
console.log('\n## S1, Pick up and start');
const say = (m) =>
  m
    ? `${m.name} (${m.position}) at ${m.slot ?? '?'}, ${fmt(m.points)}, gain +${fmt(m.gain)}: card says "over ${m.over?.name ?? '(empty slot)'}"; replaces ${m.displaces?.name ?? 'nobody'} ${m.displaces ? fmt(m.displaces.points) : ''}`
    : 'none';
console.log(`START: ${say(p?.start)}`);
for (const c of p?.consider ?? []) console.log(`tie: ${say(c)}`);
for (const n of p?.notNow ?? []) console.log(`not now: ${n.name} +${fmt(n.gain)} (${n.why})`);
const bad = [p?.start, ...(p?.consider ?? [])].filter((m) => m && m.over && m.displaces && m.over.playerId !== m.displaces.playerId);
console.log(`card names someone other than the player he replaces: ${bad.length === 0 ? 'no' : bad.map((m) => m.name).join(', ')}`);

console.log(`\nfinished ${et(new Date())}. Endpoints read once each: health, leagues, lineup, support-snapshot (lineup), waivers.`);
