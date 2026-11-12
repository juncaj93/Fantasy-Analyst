/**
 * Round 20 (smart bids): the round's ONE production check. Read-only, and
 * Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. ONE read of Alex's Waivers support snapshot
 *      (`/api/leagues/:id/support-snapshot?context=waiver-plan`): every input
 *      the screen used and the screen's own answer;
 *   3. those inputs replayed on the code before the round (BEFORE_SHA,
 *      default 0ab5a39, main with rounds 18 and 19) and on this code, side
 *      by side: the old bid and the new bid for every pickup on the list,
 *      with the new reason;
 *   4. what the live screen itself returned, to show production runs the new
 *      code.
 *
 * The replays read no database: they run on the snapshot file alone. The
 * Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || '0ab5a39eeb1a2b6dc86d982260da6019543ba01d';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 20 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Round 20 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);

heading('Production SHA');
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; before = ${BEFORE_SHA.slice(0, 7)}; this checkout = ${(process.env.GITHUB_SHA ?? '?').slice(0, 7)}`);
const setup = await fetch(`${APP}/api/setup/status`).then((r) => r.json()).catch(() => null);
const leagueId = process.env.LEAGUE_ID || setup?.league?.id;
if (!leagueId) {
  console.log('league: ?');
  process.exit(0);
}

heading("Alex's Waivers snapshot (one request)");
const started = Date.now();
const res = await fetch(`${APP}/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=waiver-plan`);
const text = await res.text();
console.log(`HTTP ${res.status}, ${Date.now() - started} ms, ${text.length} bytes`);
let snap = null;
try {
  snap = JSON.parse(text);
} catch {
  console.log('not JSON');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'round20-'));
const file = join(dir, 'waiver-plan.json');
writeFileSync(file, text);
console.log(`engine: ${snap?.release?.engineVersion ?? snap?.decision?.engineVersion ?? '?'}`);

const run = (cwd) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/round20-report.ts', file], { cwd, encoding: 'utf8' });
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 1500)})`;
  }
};
let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  copyFileSync('scripts/round20-report.ts', join(tree, 'scripts/round20-report.ts'));
  before = run(tree);
} catch (err) {
  before = `(failed: ${String(err).slice(0, 400)})`;
}
const after = run(process.cwd());

heading(`OLD BID: the code before the round (${BEFORE_SHA.slice(0, 7)}), same inputs`);
console.log(before);
heading('NEW BID: this code, the same inputs (the live screen runs this)');
console.log(after);

heading('Old and new bid, side by side');
const bidOf = (out) => {
  const m = new Map();
  for (const line of out.split('\n')) {
    const hit = /^(Do this|Worth considering|Watch|Stash|Block): (.+?) \((\w+)\)[^|]*\| bid ([^|]+?)(?: \| (.*))?$/.exec(line);
    if (hit) m.set(`${hit[1]}: ${hit[2]} (${hit[3]})`, { bid: hit[4].trim(), reason: hit[5] ?? '' });
  }
  return m;
};
const oldBids = bidOf(before);
const newBids = bidOf(after);
for (const key of new Set([...oldBids.keys(), ...newBids.keys()])) {
  const o = oldBids.get(key);
  const n = newBids.get(key);
  console.log(`${key}: old ${o?.bid ?? '(not listed)'} -> new ${n?.bid ?? '(not listed)'}${n?.reason ? ` | ${n.reason}` : ''}`);
}

heading('What the live screen itself returned (the snapshot output)');
const live = snap?.decision?.output?.tiers ?? null;
const show = (r) => `${r.name} ${r.bid?.kind === 'claim' ? `$${r.bid.recommended}` : r.bid?.kind ?? ''}`;
console.log(`Do this: ${(live?.doThese ?? []).map(show).join(', ') || 'none'}`);
console.log(`Worth considering: ${(live?.consider ?? []).map(show).join(', ') || 'none'}`);
console.log(`stash: ${live?.upsideStash ? live.upsideStash.name : 'none'}; block: ${live?.block ? live.block.name : 'none'}`);

const rowsAfter = rowsToday();
console.log(`\nD1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`Finished ${eastern()} ET`);
