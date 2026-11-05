/**
 * Waivers round 8 (November 2026 review: W5, W10; the block, the upside
 * stash, the week 16 return, a rival's Doubtful starter): the round's ONE
 * production check. Read-only, and Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. ONE read of Alex's Waivers support snapshot
 *      (`/api/leagues/:id/support-snapshot?context=waiver-plan`): every input
 *      the screen used and the screen's own answer;
 *   3. that answer (after), and the same inputs replayed on the code before
 *      round 8 (before, BEFORE_SHA, default d40bc39) with the free agents only
 *      round 8's scan adds left out, side by side, then what changed;
 *   4. this week's opponent, and which of his players read Doubtful or Out.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || 'd40bc397b2452ae3733e275121976b62b6c3ef38';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'waivers round 8 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);

heading('Production SHA');
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; before = ${BEFORE_SHA.slice(0, 7)}`);
const setup = await fetch(`${APP}/api/setup/status`).then((r) => r.json()).catch(() => null);
const leagueId = process.env.LEAGUE_ID || setup?.league?.id;
if (!leagueId) {
  console.log('league: ?');
  process.exit(0);
}

heading("Alex's Waivers snapshot (one request)");
const started = Date.now();
const res = await fetch(`${APP}/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=waiver-plan`);
const text = await res.text();
console.log(`HTTP ${res.status}, ${Date.now() - started} ms, ${text.length} bytes`);
let snap = null;
try {
  snap = JSON.parse(text);
} catch {
  console.log('not JSON');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'waivers-round8-'));
const file = join(dir, 'waiver-plan.json');
writeFileSync(file, text);

const inputs = snap?.decision?.inputs ?? {};
const pool = snap?.decision?.context?.pool ?? {};
const nameOf = new Map((inputs.players ?? []).map((p) => [p.id, `${p.name} (${p.position})`]));
const points = inputs.round2?.seasonPoints ?? {};
const through = inputs.round2?.seasonPointsThrough ?? 0;
console.log(`week ${inputs.week}; season row through week ${through}; wire scanned ${pool.scanned ?? '?'}`);
console.log(
  `W10, last week's top free-agent scorers added to the scan: ${
    (pool.lastWeekIds ?? []).map((id) => `${nameOf.get(id) ?? id} ${points[id]?.[through - 1] ?? '?'} pts`).join('; ') || (pool.lastWeekIds ? 'none new' : 'not recorded')
  }`,
);
console.log(`backs behind hurt top backs added to the scan: ${(pool.stashIds ?? []).map((id) => nameOf.get(id) ?? id).join('; ') || 'none'}`);

heading("This week's opponent (the stored matchup row)");
const opp = inputs.opponent ?? null;
if (!opp) console.log('no stored pairing for this week: no block can show');
else {
  const roster = (inputs.rosters ?? []).find((r) => r.rosterId === opp.rosterId);
  console.log(`opponent roster ${opp.rosterId} (${roster?.ownerName ?? '?'}), ${roster?.playerIds?.length ?? '?'} players`);
  const hurt = Object.entries(opp.designations ?? {}).filter(([, d]) => d !== 'healthy');
  console.log(`his designations, worse of Sleeper and the injury report: ${hurt.map(([id, d]) => `${nameOf.get(id) ?? id} ${d}`).join('; ') || 'all healthy'}`);
}

const run = (cwd, flag) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/waiver-round8-report.ts', file, ...(flag ? [flag] : [])], { cwd, encoding: 'utf8' });
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 1500)})`;
  }
};
let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  copyFileSync('scripts/waiver-round8-report.ts', join(tree, 'scripts/waiver-round8-report.ts'));
  before = run(tree, '--before');
} catch (err) {
  before = `(failed: ${String(err).slice(0, 400)})`;
}
const after = run(process.cwd(), null);

heading(`BEFORE: the code before round 8 (${BEFORE_SHA.slice(0, 7)}), same inputs`);
console.log(before);
heading('AFTER: this code, the same inputs (the live screen runs this)');
console.log(after);
heading('What the live screen itself returned (the snapshot output)');
const live = snap?.decision?.output?.tiers ?? null;
console.log(`stash: ${live?.upsideStash ? `${live.upsideStash.name}, "${live.upsideStash.reason}"` : 'none'}`);
console.log(`block: ${live?.block ? `${live.block.name}, "${live.block.reason}" (${live.block.detail})` : 'none'}`);
console.log(`Do this: ${(live?.doThese ?? []).map((r) => r.name).join(', ') || 'none'}; Worth considering: ${(live?.consider ?? []).map((r) => r.name).join(', ') || 'none'}`);

heading('What changed');
const a = new Set(after.split('\n'));
const b = new Set(before.split('\n'));
for (const l of before.split('\n').filter((l) => l && !a.has(l))) console.log(`- ${l}`);
for (const l of after.split('\n').filter((l) => l && !b.has(l))) console.log(`+ ${l}`);

const rowsAfter = rowsToday();
console.log(`\nD1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`Finished ${eastern()} ET`);
