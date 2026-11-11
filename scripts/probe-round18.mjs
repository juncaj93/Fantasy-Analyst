/**
 * Round 18 (trust the pick): the round's ONE production check. Read-only, and
 * Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. when a game's lines first show up, by game day (`round18-lines-timing.ts`);
 *   3. Alex's real Team lineup, Best move and the Compare sheet it opens,
 *      rebuilt from production's database on the code before the round
 *      (BEFORE_SHA, default 7918f3f) and on this checkout, minutes apart, with
 *      every line that differs printed (`round18-report.ts`);
 *   4. this week's real byes against what Team, Matchup, Compare and Waivers
 *      decide for every rostered player (`round18-byes.ts`);
 *   5. what the live Matchup and Team screens returned (one support snapshot
 *      each): every player shown on a bye, and every player with no number.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || '7918f3f7c1ffe88791864ed651b7a8dd98e49e66';
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);
const ts = (script, cwd = '.', env = process.env) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', script], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
const safe = (fn) => {
  try {
    return fn();
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 3000)})`;
  }
};
const readLine = (t, label) => Number(new RegExp(`${label} rows read: (\\d+)`).exec(t)?.[1] ?? 0);

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 18 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Round 18 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);
let probeRows = 0;

heading('Production revision');
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; this checkout: ${(process.env.GITHUB_SHA ?? '?').slice(0, 7)}; before code: ${BEFORE_SHA.slice(0, 7)}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json()).catch(() => null);
const leagueId = process.env.LEAGUE_ID || (leagues?.leagues ?? []).find((l) => l.isSelected)?.id || '';
if (!leagueId) {
  console.log('no selected league; stopping');
  process.exit(0);
}
const env = { ...process.env, REPORT_NOW: new Date().toISOString(), LEAGUE_ID: leagueId };

heading('When lines first show up, by game day (Eastern)');
const timing = safe(() => ts('scripts/round18-lines-timing.ts', '.', env));
console.log(timing);
probeRows += readLine(timing, 'lines timing');

heading(`Alex's real Team, Best move and Compare: before (${BEFORE_SHA.slice(0, 7)}) and after (this checkout)`);
{
  const REPORT = 'scripts/round18-report.ts';
  const dir = mkdtempSync(join(tmpdir(), 'round18-'));
  let before = '(unavailable)';
  try {
    execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
    const tree = join(dir, 'before');
    execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: tree, stdio: 'ignore' });
    mkdirSync(dirname(join(tree, REPORT)), { recursive: true });
    copyFileSync(REPORT, join(tree, REPORT));
    mkdirSync(join(tree, 'scripts/lib'), { recursive: true });
    copyFileSync('scripts/lib/d1Http.ts', join(tree, 'scripts/lib/d1Http.ts'));
    before = safe(() => ts(REPORT, tree, env));
  } catch (err) {
    before = `(could not build the before tree: ${err instanceof Error ? err.message : String(err)})`;
  }
  const after = existsSync(REPORT) ? safe(() => ts(REPORT, '.', env)) : '(missing)';
  console.log('\n### BEFORE (code before the round)');
  console.log(before);
  console.log('\n### AFTER (this checkout)');
  console.log(after);
  console.log('\n### lines that differ (- before, + after)');
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  let n = 0;
  for (const l of before.split('\n')) if (!b.has(l) && !/rows read|clock /.test(l)) (console.log(`- ${l}`), n++);
  for (const l of after.split('\n')) if (!a.has(l) && !/rows read|clock /.test(l)) (console.log(`+ ${l}`), n++);
  if (n === 0) console.log('  (none)');
  probeRows += readLine(before, 'report') + readLine(after, 'report');
}

heading('Real byes against every screen, every rostered player');
const byes = safe(() => ts('scripts/round18-byes.ts', '.', env));
console.log(byes);
probeRows += readLine(byes, 'bye check');

heading('What the live Matchup and Team screens returned (one support snapshot each)');
for (const context of ['matchup', 'lineup']) {
  try {
    const started = Date.now();
    const res = await fetch(`${APP}/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=${context}`);
    const text = await res.text();
    console.log(`${context}: HTTP ${res.status}, ${Date.now() - started} ms, ${text.length} bytes`);
    const snap = JSON.parse(text);
    const onBye = new Map();
    const noNumber = new Map();
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      const id = v.playerId;
      const name = v.fullName ?? v.name;
      if (id && name) {
        if (v.onBye === true) onBye.set(id, `${name}${v.team ? ` (${v.team})` : ''}`);
        if ('projectedFinal' in v && v.projectedFinal == null && v.onBye !== true) noNumber.set(id, name);
      }
      for (const x of Object.values(v)) walk(x);
    };
    walk(snap?.decision?.output ?? snap);
    console.log(`  shown on bye: ${[...onBye.values()].join(', ') || 'nobody'}`);
    if (context === 'matchup') console.log(`  no number (now "No projection"): ${[...noNumber.values()].join(', ') || 'nobody'}`);
  } catch (err) {
    console.log(`  (${context} snapshot not read: ${String(err).slice(0, 200)})`);
  }
}

const rowsAfter = rowsToday();
console.log(`\nD1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`rows read by the probe's own queries: ${probeRows.toLocaleString('en-US')} (plus the two live snapshots)`);
console.log(`finished ${eastern()} ET`);
