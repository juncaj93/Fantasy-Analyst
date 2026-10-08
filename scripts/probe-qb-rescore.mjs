/**
 * Live decisions with and without this league's rescored quarterbacks (F5).
 *
 * Fetches the public `lineup`, `waiver-plan` and `matchup` support snapshots and
 * Sleeper's public projection feed for the same week, writes copies of the
 * snapshots with each quarterback's rescored number added
 * (`scripts/qb-rescore-inject.ts`), and replays both sets through
 * `scripts/decision-replay-report.ts` on this checkout. BEFORE is today's
 * production inputs; AFTER is the same inputs with the quarterbacks read.
 *
 * Reads only: GETs of the app, the three snapshots and Sleeper's public feed.
 * No odds are bought, nothing is written.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const league = leagues?.leagues?.find((l) => l.isSelected) ?? leagues?.leagues?.[0];
const dir = mkdtempSync(join(tmpdir(), 'qb-rescore-'));
const files = [];
let week = null;
for (const context of ['lineup', 'waiver-plan', 'matchup']) {
  const res = await fetch(`${APP}/api/leagues/${league.id}/support-snapshot?context=${context}`);
  console.log(`GET support-snapshot (${context}) -> HTTP ${res.status}`);
  if (!res.ok) continue;
  const text = await res.text();
  week ??= JSON.parse(text)?.decision?.context?.week ?? null;
  const file = join(dir, `${context}.json`);
  writeFileSync(file, text);
  files.push(file);
}
const season = league?.season ?? '2026';
const feedUrl = `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=DEF&order_by=ppr`;
const feed = await fetch(feedUrl).then((r) => r.text());
const feedFile = join(dir, 'feed.json');
writeFileSync(feedFile, feed);
console.log(`Sleeper feed week ${week}: ${JSON.parse(feed).length} rows`);
const outDir = join(dir, 'after');
mkdirSync(outDir);
const node = (args) => execFileSync('node', ['--experimental-transform-types', '--no-warnings', ...args], { encoding: 'utf8' });
console.log(node(['scripts/qb-rescore-inject.ts', feedFile, outDir, ...files]));
const report = 'scripts/decision-replay-report.ts';
const before = node([report, ...files]);
const after = node([report, ...files.map((f) => join(outDir, f.split('/').pop()))]);
console.log(`\n================ BEFORE (quarterbacks unread) ================\n${before}`);
console.log(`\n================ AFTER (quarterbacks rescored) ================\n${after}`);
console.log('\n================ WHAT CHANGED ================');
const a = new Set(before.split('\n'));
const b = new Set(after.split('\n'));
for (const l of before.split('\n').filter((l) => !b.has(l))) console.log(`- ${l}`);
for (const l of after.split('\n').filter((l) => !a.has(l))) console.log(`+ ${l}`);
