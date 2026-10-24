/**
 * The "numbers agree" round's one combined production read (23 October 2026).
 *
 * Reads once, after the D1 daily reset (8:05 PM ET, 00:05 UTC):
 *
 *   - GET /api/health                                 the production SHA
 *   - GET /api/leagues                                the selected league
 *   - GET /api/leagues/:id/lineup                     the projected margin (posture, D5)
 *   - GET support-snapshot?context=lineup|matchup|waiver-plan
 *   - Cloudflare's D1 analytics (free, no SQL): rows read per statement over
 *     the last 24 hours, for rows per Team and Matchup load
 *   - for the Questionable backtest: Sleeper's public state, league and weekly
 *     stats, and through the read-only D1 adapter the stored prop snapshots
 *     (`startsit-round2-build.ts`, the existing harness) and the weekly
 *     injury reports (`numbers-agree-backtest.ts`)
 *
 * then, with no further network, runs `scripts/numbers-agree-report.ts` on
 * the code before the round (BEFORE_SHA, 41058f5) and on this checkout, and
 * prints both and the lines that changed: every player's number on Team,
 * Matchup, Waivers, Trades and Compare, the lineup, Best move, Matchup's
 * decision, the waiver plan, the Compare slot, close calls and kickoff ties.
 *
 * Reads only. No odds are bought, nothing is written.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const BEFORE_SHA = process.env.BEFORE_SHA || '41058f5f696832be4cd024b4754f57e3c5724427';
const dir = mkdtempSync(join(tmpdir(), 'numbers-agree-'));
const et = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';

console.log(`started ${et(new Date())} (${new Date().toISOString()})`);
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; before = ${BEFORE_SHA.slice(0, 7)}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then((r) => r.json()).catch(() => null);
const s = lineup?.modeSuggestion;
console.log(`\n## D5 posture: ${s?.detail ?? '?'} (margin ${s?.margin ?? 'unknown'}, state ${s?.state ?? '?'}, auto ${s?.auto ?? '?'})`);
for (const r of s?.reasons ?? []) console.log(`  ${r}`);
console.log(`  mine: ${s?.mine ? `${s.mine.slotsPriced}/${s.mine.slotsTotal} slots priced, coverage ${s.mine.coverage}` : 'not projected'}; opponent: ${s?.opponent ? `${s.opponent.slotsPriced}/${s.opponent.slotsTotal}, coverage ${s.opponent.coverage}` : 'not projected'}`);

for (const context of ['lineup', 'matchup', 'waiver-plan']) {
  const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=${context}`);
  console.log(`GET support-snapshot (${context}) -> HTTP ${res.status}`);
  if (res.ok) writeFileSync(join(dir, `${context}.json`), await res.text());
}

const report = 'scripts/numbers-agree-report.ts';
const run = (cwd) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', report, dir], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return `(failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 2000)})`;
  }
};
let before = '(unavailable)';
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const tree = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', tree, BEFORE_SHA], { stdio: 'ignore' });
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: tree, stdio: 'ignore' });
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
for (const l of before.split('\n').filter((l) => !b.has(l))) console.log(`- ${l}`);
for (const l of after.split('\n').filter((l) => !a.has(l))) console.log(`+ ${l}`);

/* The Questionable backtest, on the existing harness's player-weeks. */
console.log('\n## Backtest: Questionable at full value against discounted');
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
if (!SLEEPER_LEAGUE || !process.env.CLOUDFLARE_API_TOKEN) {
  console.log('skipped: SLEEPER_LEAGUE_ID or the Cloudflare token is not set in this run');
} else {
  try {
    const get = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return res.text();
    };
    const state = JSON.parse(await get('https://api.sleeper.app/v1/state/nfl'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    writeFileSync(join(dir, 'league.json'), await get(`https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE}`));
    for (let w = 1; w < Number(state.week); w++) {
      writeFileSync(join(dir, `stats${w}.json`), await get(`https://api.sleeper.app/v1/stats/nfl/regular/${state.season}/${w}`));
    }
    const ts = (script) =>
      execFileSync('node', ['--experimental-transform-types', '--no-warnings', script, dir], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    console.log(ts('scripts/startsit-round2-build.ts'));
    console.log(ts('scripts/numbers-agree-backtest.ts'));
  } catch (err) {
    console.log(`backtest failed: ${String(err).slice(0, 600)}`);
  }
}

/* D1 rows read (Cloudflare analytics, free, no SQL). The workflow passes no account id, so ask the token. */
const token = process.env.CLOUDFLARE_API_TOKEN;
const account =
  process.env.ACCOUNT_ID ||
  (token
    ? await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((b) => b?.result?.[0]?.id ?? null)
        .catch(() => null)
    : null);
const d1Rows = async (from, to) => {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
          count dimensions { query } sum { rowsRead } } } } }`,
      variables: { a: account, from, to },
    }),
  }).then((r) => r.json()).catch(() => null);
  return res?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
};
const sumRows = (rows) => rows.reduce((sum, r) => sum + Number(r.sum?.rowsRead ?? 0), 0);
/* This round's deploy runs, start to finish (GitHub Actions run times, UTC). */
const DEPLOYS = [
  ['#411 (D1 rule)', '2026-10-23T15:06:27Z', '2026-10-23T15:10:47Z'],
  ['#412 (minus 2)', '2026-10-23T18:01:10Z', '2026-10-23T18:04:34Z'],
  ['#413 (Matchup card)', '2026-10-23T18:45:57Z', '2026-10-23T18:50:30Z'],
  ['#414 (Compare slot)', '2026-10-23T19:28:30Z', '2026-10-23T19:32:49Z'],
  ['#415 stood down', '2026-10-23T20:06:52Z', '2026-10-23T20:07:01Z'],
  ['#415 (tie line)', '2026-10-24T00:23:05Z', '2026-10-24T00:27:21Z'],
  ['#416 (kickoff order)', '2026-10-24T00:47:30Z', '2026-10-24T00:52:47Z'],
  ['#416 smoke re-run', '2026-10-24T00:58:45Z', '2026-10-24T01:03:00Z'],
];
if (token && account) {
  const to = new Date();
  const rows = await d1Rows(new Date(to.getTime() - 24 * 3600 * 1000).toISOString(), to.toISOString());
  const total = sumRows(rows);
  console.log(`\n## D1, last 24 hours to ${et(to)}: ${total} rows read across ${rows.length} statements (${Math.round((total / 5_000_000) * 100)}% of 5,000,000)`);
  for (const r of rows.slice(0, 25)) {
    const per = Number(r.count) ? Math.round(Number(r.sum.rowsRead) / Number(r.count)) : 0;
    console.log(`  ${r.count} calls, ${r.sum.rowsRead} rows (${per}/call): ${String(r.dimensions.query).replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  const today = await d1Rows('2026-10-24T00:00:00Z', to.toISOString());
  console.log(`\n## D1 since the reset (8:00 PM ET): ${sumRows(today)} rows read (${((sumRows(today) / 5_000_000) * 100).toFixed(1)}% of 5,000,000)`);
  console.log('\n## Rows read per deploy run (all D1 reads in the window, the gate and anyone else)');
  for (const [label, from, until] of DEPLOYS) {
    const w = await d1Rows(from, until);
    console.log(`  ${label.padEnd(22)} ${et(new Date(from))} to ${et(new Date(until))}: ${sumRows(w)} rows, ${w.length} statements`);
  }
} else {
  console.log(`\n## D1: ${token ? 'no Cloudflare account id resolved' : 'no Cloudflare token'} in this run`);
}
