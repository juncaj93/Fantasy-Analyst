/**
 * The Start/Sit score on the league's real lineup, before and after the
 * "Vegas is about 90% of the score" round.
 *
 * Takes the live lineup support snapshot (the inputs the engine actually read),
 * replays it through the real engine twice with no further network: once on the
 * code as it stood before the round (BEFORE_SHA, default the commit the round
 * started from) and once on this checkout. Also replays the waiver-plan snapshot
 * the same way, to show the waiver planner's printed numbers did not move.
 *
 * Reads only: two GETs of the public support snapshot, one GET of /api/health
 * for the production SHA, and a shallow fetch of the earlier commit. Nothing is
 * written to the app.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA ?? 'ee89443bbf593a6fdfb116bb1279a65d99f5c5e6';

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? health?.releaseSha ?? JSON.stringify(health)?.slice(0, 200)}`);

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'startsit-weight-'));

async function snapshotOf(context) {
  const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=${context}`);
  console.log(`GET support-snapshot (${context}) -> HTTP ${res.status}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 300));
    return null;
  }
  const file = join(dir, `${context}.json`);
  writeFileSync(file, await res.text());
  return file;
}

const run = (cwd, report, file) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, file], { cwd, encoding: 'utf8' });

let beforeTree = null;
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  beforeTree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', beforeTree, BEFORE_SHA], { stdio: 'ignore' });
} catch (err) {
  console.log(`could not build the BEFORE checkout (${BEFORE_SHA}): ${String(err).slice(0, 300)}`);
}

function compare(title, report, file) {
  const after = run(process.cwd(), report, file);
  let before = null;
  if (beforeTree) {
    copyFileSync(report, join(beforeTree, report));
    try {
      before = run(beforeTree, report, file);
    } catch (err) {
      before = `(failed: ${String(err).slice(0, 300)})`;
    }
  }
  console.log(`\n################ ${title} ################`);
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
    if (!any) console.log('(identical)');
  }
}

const lineup = await snapshotOf('lineup');
if (lineup) compare('LINEUP (Start/Sit)', 'scripts/startsit-vegas-weighting-report.ts', lineup);
const waiver = await snapshotOf('waiver-plan');
if (waiver) compare('WAIVER PLAN (printed numbers must not move)', 'scripts/waiver-recent-form-report.ts', waiver);
