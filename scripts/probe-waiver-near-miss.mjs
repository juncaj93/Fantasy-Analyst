/**
 * How many free agents land close to the waiver bars, on the live league.
 *
 * Fetches the public `waiver-plan` support snapshot (the exact inputs the plan
 * read) and replays it with no network through
 * `scripts/waiver-near-miss-report.ts`, which prints every readable free agent
 * with his margin to the starter-upgrade bar (2.5, or 3.0 on Sleeper's
 * projection) and to the bench-add bar (0.5, or 1.0), plus why the unreadable
 * ones could not be read.
 *
 * Reads only: one GET of /api/health, one of /api/leagues and one of the
 * support snapshot. Nothing is written to the app and no odds are bought.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}

const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot (waiver-plan) -> HTTP ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 300));
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'waiver-near-miss-'));
const file = join(dir, 'waiver-plan.json');
writeFileSync(file, await res.text());

console.log(
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/waiver-near-miss-report.ts', file], {
    encoding: 'utf8',
  }),
);
