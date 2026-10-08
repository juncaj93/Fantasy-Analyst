/**
 * The touchdown-line question (audit finding F1), replayed on the live lineup.
 *
 * Fetches the public `lineup` support snapshot and runs
 * `scripts/td-line-options-report.ts` on it: the lineup as stored, option A
 * (a touchdown quote above 0.5 is dropped and the player falls back to
 * Sleeper's week) and option B (a 1.5 quote is converted to an any-touchdown
 * chance with a Poisson rate). No app code changes; this is evidence for a
 * decision, not a fix.
 *
 * Reads only: GETs of /api/health, /api/leagues and the support snapshot. No
 * odds are bought and nothing is written.
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
const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
console.log(`GET support-snapshot (lineup) -> HTTP ${res.status}`);
if (!res.ok) process.exit(1);
const dir = mkdtempSync(join(tmpdir(), 'td-line-options-'));
const file = join(dir, 'lineup.json');
writeFileSync(file, await res.text());
const out = execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/td-line-options-report.ts', file], {
  encoding: 'utf8',
});
console.log(out);
