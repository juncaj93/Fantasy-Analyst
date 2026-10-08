/**
 * Live decisions, replayed on the code before a change and after it.
 *
 * Fetches the public `lineup`, `waiver-plan`, `matchup` and `trade-offer` support snapshots
 * and runs `scripts/decision-replay-report.ts` on BEFORE_SHA (default: the SHA
 * production reports) and on this checkout, then prints both and the lines
 * that differ. For the "replay before and after, with names and reasons" rule.
 *
 * Reads only: GETs of /api/health, /api/leagues and four support snapshots,
 * and a shallow fetch of the earlier commit. No odds are bought, nothing is
 * written.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
const live = health?.release?.gitSha ?? null;
const BEFORE_SHA = process.env.BEFORE_SHA || live || '1a2bf0942f826992794d2efc2f6e73d9a3a5e455';
console.log(`production sha: ${live ?? '?'}; before = ${BEFORE_SHA}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
const dir = mkdtempSync(join(tmpdir(), 'decision-replay-'));
const files = [];
for (const context of ['lineup', 'waiver-plan', 'matchup', 'trade-offer']) {
  const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=${context}`);
  console.log(`GET support-snapshot (${context}) -> HTTP ${res.status}`);
  if (!res.ok) continue;
  const file = join(dir, `${context}.json`);
  writeFileSync(file, await res.text());
  files.push(file);
}
const report = 'scripts/decision-replay-report.ts';
const run = (cwd) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, ...files], { cwd, encoding: 'utf8' });
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 1500)})`;
  }
};
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
const a = new Set(before.split('\n'));
const b = new Set(after.split('\n'));
const gone = before.split('\n').filter((l) => !b.has(l));
const added = after.split('\n').filter((l) => !a.has(l));
for (const l of gone) console.log(`- ${l}`);
for (const l of added) console.log(`+ ${l}`);
if (gone.length + added.length === 0) console.log('(identical)');
