/**
 * Round 17 (blend tune): the round's ONE production check. Read-only, and
 * Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. Alex's real Team lineup (every lean), Waivers list (names, values,
 *      drops) and Trades free-agent levels, rebuilt from production's
 *      database on the code before the round (BEFORE_SHA, default b123d70)
 *      and on this checkout, against the same data minutes apart, with every
 *      line that differs printed;
 *   3. what the live Waivers screen itself returned (one support snapshot),
 *      to show production is running the "after" code.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || 'b123d70a5072c27358a04ed3bd41630113927c05';
const REPORT = 'scripts/round17-report.ts';
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 17 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Round 17 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);

heading('Production revision');
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; this checkout: ${(process.env.GITHUB_SHA ?? '?').slice(0, 7)}; before code: ${BEFORE_SHA.slice(0, 7)}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json()).catch(() => null);
const leagueId = process.env.LEAGUE_ID || (leagues?.leagues ?? []).find((l) => l.isSelected)?.id || '';
if (!leagueId) {
  console.log('no selected league; stopping');
  process.exit(0);
}

heading(`Alex's real Team, Waivers and Trades: before (${BEFORE_SHA.slice(0, 7)}) and after (this checkout)`);
let probeRows = 0;
if (!existsSync(REPORT)) {
  console.log(`  ${REPORT} is missing; skipped`);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'round17-'));
  const env = { ...process.env, REPORT_NOW: new Date().toISOString(), LEAGUE_ID: leagueId };
  const run = (cwd, label) => {
    try {
      const out = execFileSync('node', ['--experimental-transform-types', '--no-warnings', REPORT], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
      writeFileSync(join(dir, `${label}.txt`), out);
      return out;
    } catch (err) {
      return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 3000)})`;
    }
  };
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
    before = run(tree, 'before');
  } catch (err) {
    before = `(could not build the before tree: ${err instanceof Error ? err.message : String(err)})`;
  }
  const after = run('.', 'after');
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
  const readLine = (t) => Number(/report rows read: (\d+)/.exec(t)?.[1] ?? 0);
  probeRows += readLine(before) + readLine(after);
}

heading('What the live Waivers screen returned (one support snapshot)');
try {
  const started = Date.now();
  const res = await fetch(`${APP}/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=waiver-plan`);
  const text = await res.text();
  console.log(`HTTP ${res.status}, ${Date.now() - started} ms, ${text.length} bytes`);
  const snap = JSON.parse(text);
  const live = snap?.decision?.output?.tiers ?? null;
  console.log(`engine: ${snap?.release?.engineVersion ?? '?'}`);
  console.log(`Do this: ${(live?.doThese ?? []).map((r) => r.name).join(', ') || 'none'}; Worth considering: ${(live?.consider ?? []).map((r) => r.name).join(', ') || 'none'}`);
} catch (err) {
  console.log(`(snapshot not read: ${String(err).slice(0, 200)})`);
}

const rowsAfter = rowsToday();
console.log(`\nD1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`rows read by the two replays: ${probeRows.toLocaleString('en-US')}`);
console.log(`finished ${eastern()} ET`);
