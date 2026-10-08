/**
 * The Waivers empty state on the live board, before and after.
 *
 * Fetches the public `waiver-plan` support snapshot and replays it through
 * `scripts/waiver-no-move-report.ts` on the code before this round and on this
 * checkout, then prints the difference. The decision lines must not change.
 *
 * Reads only: GETs of /api/health, /api/leagues and the support snapshot, and
 * a shallow fetch of the earlier commit. No odds are bought, nothing is written.
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
const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot (waiver-plan) -> HTTP ${res.status}`);
if (!res.ok) process.exit(1);
const dir = mkdtempSync(join(tmpdir(), 'waiver-no-move-'));
const file = join(dir, 'waiver-plan.json');
writeFileSync(file, await res.text());
const report = 'scripts/waiver-no-move-report.ts';
const run = (cwd) => execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, file], { cwd, encoding: 'utf8' });
let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  copyFileSync(report, join(tree, report));
  before = run(tree);
} catch (err) {
  before = `(failed: ${String(err).slice(0, 400)})`;
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
