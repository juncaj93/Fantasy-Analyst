/**
 * Which of Alex's players change status when the worse injury status wins?
 *
 * One combined read of production (24 October 2026): the release SHA, then
 * Team's lineup and Matchup's card for the selected league. Every player's
 * injury observations come back inside Team's evaluations; this hands them to
 * `injury-severity-report.ts`, which prints the old rule's answer beside the
 * new one. Matchup's status chip is printed beside it as the live screen's own
 * word. Waivers, Trades and Compare read the same `InjuryService.statesFor`,
 * so their status is Team's by construction (`tests/numbersAgree.crossScreen.test.ts`).
 *
 * Reads only.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const get = async (path) => {
  const res = await fetch(`${APP}${path}`);
  console.log(`GET ${path} -> HTTP ${res.status}`);
  return res.ok ? res.json() : null;
};

const health = await get('/api/health');
console.log(`production gitSha=${health?.release?.gitSha ?? health?.gitSha ?? '(none)'}`);

const leagues = await get('/api/leagues');
const league = (leagues?.leagues ?? []).find((l) => l.isSelected) ?? (leagues?.leagues ?? [])[0];
if (!league) {
  console.log('no league');
  process.exit(0);
}
const lineup = await get(`/api/leagues/${league.id}/lineup`);
const matchup = await get(`/api/leagues/${league.id}/matchup`);

const rows = [];
for (const e of [...(lineup?.starters ?? []), ...(lineup?.bench ?? []), ...(lineup?.undecidable ?? [])]) {
  const observations = e.injury?.observations ?? [];
  if (observations.length === 0) continue;
  rows.push({ playerId: e.playerId, name: e.name ?? e.playerId, screen: 'Team', observations });
}

const chips = new Map();
for (const slot of matchup?.forecast?.slots ?? []) if (slot.mine) chips.set(slot.mine.playerId, slot.mine.statusFlag);
for (const p of matchup?.forecast?.bench?.mine ?? []) chips.set(p.playerId, p.statusFlag);

console.log('\nLive, as deployed: Team designation and Matchup chip');
for (const e of [...(lineup?.starters ?? []), ...(lineup?.bench ?? [])]) {
  const d = e.injury?.designation ?? 'unknown';
  if (d === 'unknown' || d === 'healthy') continue;
  console.log(`  ${(e.name ?? e.playerId).padEnd(24)} Team=${d.padEnd(12)} from=${e.injury?.designationSource ?? '-'}  Matchup chip=${chips.get(e.playerId) ?? '-'}`);
}

console.log('\nOld rule vs new rule, from the same observations');
const dir = mkdtempSync(join(tmpdir(), 'injury-severity-'));
const file = join(dir, 'rows.json');
writeFileSync(file, JSON.stringify(rows));
const report = new URL('./injury-severity-report.ts', import.meta.url).pathname;
process.stdout.write(execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, file], { encoding: 'utf8' }));
