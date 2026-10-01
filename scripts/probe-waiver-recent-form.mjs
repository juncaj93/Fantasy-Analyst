/**
 * The waiver plan on the league's real data, before and after the 7-day round.
 *
 * Takes the live waivers support snapshot (the inputs the engine actually read,
 * with the 7-day and 30-day tallies on every player), then replays it twice
 * through the real engine with no further network: once on the code as it stood
 * before the round (BEFORE_SHA, default the commit the round started from) and
 * once on this checkout. Prints both and the difference.
 *
 * Reads only: one GET of the public support snapshot, and a shallow fetch of
 * the earlier commit. Nothing is written to the app.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA ?? '3dd088ba55007a82e41468fb641e614f4eaa7873';
const REPORT = 'scripts/waiver-recent-form-report.ts';

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}
const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot (waiver-plan) -> HTTP ${res.status}`);
if (!res.ok) {
  console.error((await res.text()).slice(0, 400));
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'waiver-form-'));
const snapshot = join(dir, 'snapshot.json');
writeFileSync(snapshot, await res.text());

const run = (cwd) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', REPORT, snapshot], { cwd, encoding: 'utf8' });

const after = run(process.cwd());

let before = null;
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  copyFileSync(REPORT, join(tree, REPORT));
  before = run(tree);
} catch (err) {
  console.log(`could not build the BEFORE checkout (${BEFORE_SHA}): ${String(err).slice(0, 300)}`);
}

console.log(`\n================ BEFORE (${BEFORE_SHA.slice(0, 7)}) ================\n${before ?? '(unavailable)'}`);
console.log(`\n================ AFTER (this checkout) ================\n${after}`);

if (before != null) {
  const a = before.split('\n');
  const b = after.split('\n');
  console.log('\n================ WHAT CHANGED ================');
  let any = false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      any = true;
      console.log(`- ${a[i] ?? ''}`);
      console.log(`+ ${b[i] ?? ''}`);
    }
  }
  if (!any) console.log("(identical: the 7-day tally changed nothing on today's real data)");
}
