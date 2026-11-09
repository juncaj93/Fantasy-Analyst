/**
 * Round 13 (whole-site check): the round's ONE production probe.
 * Read-only. No odds are bought, nothing is written, Sleeper is never called.
 * Run after 7:05 PM ET (the D1 day starts at 7:00 PM ET).
 *
 *   1. Every GET the season screens make on open (Team, Matchup, Waivers,
 *      Trades ideas, Build a trade's team list, Players, Data health, Setup),
 *      the same list `probe-screens-snapshot.mjs` reads.
 *   2. Build a trade for all teams (`team=all&unmarked=1`), once.
 *   3. The five in-season support snapshots (lineup, matchup, waiver-plan,
 *      dst-plan, trade-offer). Compare is a POST that needs the passphrase,
 *      so the report rebuilds it from the lineup snapshot instead.
 *   4. `scripts/site-check-round13-report.ts` on the code live before this
 *      round (BEFORE_SHA, 97d1a39) and on this checkout, same inputs, and the
 *      lines that changed.
 *   5. Everything in 1 and 2, gzipped and base64 between two markers, so
 *      `scripts/replay-screens.mjs` can draw the screens locally at phone
 *      widths without asking production again.
 *
 * The Probe workflow runs the D1 budget guard first. Times are Eastern.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || '97d1a39cd13e16bd827042871737896887ae8154';
const REPORT = 'scripts/site-check-round13-report.ts';
const dir = mkdtempSync(join(tmpdir(), 'site-check-13-'));
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true }) + ' ET';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

const out = {};
async function call(method, path, body) {
  const started = Date.now();
  let status;
  let text = '';
  try {
    const res = await fetch(`${APP}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    status = `network error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const key = method === 'GET' ? path : `${method} ${path} ${JSON.stringify(body)}`;
  out[key] = { status, body: text };
  console.log(`${status} ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''} (${text.length} bytes, ${Date.now() - started} ms)`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

console.log(`started ${eastern()} (${new Date().toISOString()})`);
const health = await call('GET', '/api/health');
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; before = ${BEFORE_SHA.slice(0, 7)}`);

heading('1. Screen reads');
const leagues = await call('GET', '/api/leagues');
const league = (leagues?.leagues ?? []).find((l) => l.isSelected) ?? null;
if (!league) {
  console.log('no selected league; stopping');
  process.exit(0);
}
const id = encodeURIComponent(process.env.LEAGUE_ID || league.id);
for (const path of [
  '/api/auth/status',
  '/api/overview',
  '/api/setup/status',
  '/api/setup/newsletter',
  '/api/data-health',
  `/api/leagues/${id}/roster`,
  `/api/leagues/${id}/lineup`,
  `/api/leagues/${id}/waivers`,
  `/api/leagues/${id}/matchup`,
  '/api/trades',
  '/api/trades/smart',
  `/api/leagues/${id}/trades/check/teams`,
  `/api/players?q=&leagueId=${id}&limit=40&offset=0`,
  '/api/review/queue',
  '/api/review/applied',
  '/api/newsletter/messages',
  '/api/preseason-projection',
  '/api/repair',
]) {
  await call('GET', path);
}

heading('2. Build a trade, all teams');
await call('GET', `/api/leagues/${id}/trades/build?team=all&unmarked=1`);

heading('3. Support snapshots');
for (const context of ['lineup', 'matchup', 'waiver-plan', 'dst-plan', 'trade-offer']) {
  const path = `/api/leagues/${id}/support-snapshot?context=${context}`;
  await call('GET', path);
  const body = out[path]?.body;
  if (out[path]?.status === 200 && body) writeFileSync(join(dir, `${context}.json`), body);
}
writeFileSync(join(dir, 'screens.json'), JSON.stringify(out));
console.log(`finished reading ${eastern()}`);

heading(`4. Report: before (${BEFORE_SHA.slice(0, 7)}) and this checkout, same inputs`);
const run = (cwd) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', REPORT, dir], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 3000)})`;
  }
};
let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: tree, stdio: 'ignore' });
  mkdirSync(dirname(join(tree, REPORT)), { recursive: true });
  copyFileSync(REPORT, join(tree, REPORT));
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
let changed = 0;
for (const l of before.split('\n').filter((l) => !b.has(l))) {
  console.log(`- ${l}`);
  changed++;
}
for (const l of after.split('\n').filter((l) => !a.has(l))) {
  console.log(`+ ${l}`);
  changed++;
}
if (changed === 0) console.log('(nothing: same output on both)');

heading('5. Snapshot for local replay');
/* The screens' own reads only: the support snapshots were for the report above, and would triple the log. */
const replay = Object.fromEntries(Object.entries(out).filter(([key]) => !key.includes('support-snapshot')));
const blob = gzipSync(Buffer.from(JSON.stringify(replay))).toString('base64');
console.log(`${blob.length} characters`);
console.log('=== SNAPSHOT BEGIN ===');
for (let i = 0; i < blob.length; i += 4000) console.log(blob.slice(i, i + 4000));
console.log('=== SNAPSHOT END ===');
console.log(`done ${eastern()}`);
