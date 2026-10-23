/**
 * Pick up and start, round 3 (20 October 2026), in one run: the McLaughlin
 * roster check, the call with every free agent's gain, and the data cost.
 *
 * The one combined production check this round is allowed. It reads
 * /api/health and /api/leagues once, Sleeper's public league, rosters and
 * transactions, and D1 SELECTs through the app's own code (the Team screen's
 * two gatherers on the code before the round and on this checkout, and a few
 * keyed reads for the roster check). Nothing is written.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
if (!SLEEPER_LEAGUE) {
  console.error('SLEEPER_LEAGUE_ID is not set. It is a repository secret: see docs/SETUP.md, "The league ID secret".');
  process.exit(1);
}
/* main when this round started: #382. */
const BEFORE_SHA = process.env.BEFORE_SHA ?? 'ffefdf01e23f3167018bd9abc909840ab3496b15';
const dir = mkdtempSync(join(tmpdir(), 'pickup-roster-'));

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

const ts = (cwd, args) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/pickup-roster-report.ts', ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

const beforeJson = join(dir, 'before.json');
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const before = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', before, BEFORE_SHA], { stdio: 'ignore' });
  mkdirSync(dirname(join(before, 'scripts/pickup-roster-report.ts')), { recursive: true });
  copyFileSync('scripts/pickup-roster-report.ts', join(before, 'scripts/pickup-roster-report.ts'));
  console.log(`before: ${BEFORE_SHA.slice(0, 7)} ` + ts(before, [leagueId, SLEEPER_LEAGUE, 'gather', beforeJson]));
} catch (err) {
  console.log(`BEFORE checkout failed: ${String(err).slice(0, 400)}`);
}
console.log('after: this checkout');
console.log(ts(process.cwd(), [leagueId, SLEEPER_LEAGUE, 'report', beforeJson]));
