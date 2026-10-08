/**
 * The live Matchup forecast, before and after the bye-week fix.
 *
 * Fetches the public `matchup` support snapshot and the live matchup read,
 * then replays them through `scripts/matchup-bye-report.ts` twice with no
 * further network: once on the code as it stood before the fix (BEFORE_SHA,
 * default `main` at the start of the October 2026 round) and once on this
 * checkout. The line-by-line difference is printed at the end.
 *
 * Reads only: GETs of /api/health, /api/leagues, the support snapshot and the
 * matchup read, and a shallow fetch of the earlier commit. No odds are bought.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA ?? '1a2bf0942f826992794d2efc2f6e73d9a3a5e455';

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'matchup-bye-'));
const snapRes = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=matchup`);
console.log(`GET support-snapshot (matchup) -> HTTP ${snapRes.status}`);
const liveRes = await fetch(`${APP}/api/leagues/${leagueId}/matchup`);
console.log(`GET matchup -> HTTP ${liveRes.status}`);
if (!snapRes.ok || !liveRes.ok) process.exit(1);
const snapshot = join(dir, 'matchup.json');
const live = join(dir, 'live.json');
writeFileSync(snapshot, await snapRes.text());
writeFileSync(live, await liveRes.text());

const report = 'scripts/matchup-bye-report.ts';
const run = (cwd) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, snapshot, live], { cwd, encoding: 'utf8' });

let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  copyFileSync(report, join(tree, report));
  before = run(tree);
} catch (err) {
  before = `(failed: ${String(err).slice(0, 300)})`;
}
const after = run(process.cwd());
console.log(`\n================ BEFORE (${BEFORE_SHA.slice(0, 7)}) ================\n${before}`);
console.log(`\n================ AFTER (this checkout) ================\n${after}`);
console.log('\n================ WHAT CHANGED ================');
const a = before.split('\n');
const b = after.split('\n');
let any = false;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    any = true;
    console.log(`- ${a[i] ?? ''}`);
    console.log(`+ ${b[i] ?? ''}`);
  }
}
if (!any) console.log('(identical)');
