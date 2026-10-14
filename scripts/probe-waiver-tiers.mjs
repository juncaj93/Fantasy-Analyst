/**
 * Waivers round 2, the one combined Probe (13 October 2026).
 *
 * The file name is kept because the Probe workflow already hands this script
 * the Cloudflare token for D1's own counts; the job is round 2's:
 *
 * 1. The production SHA (`/api/health`), and one Waivers support snapshot:
 *    the exact inputs the deployed Waivers screen read and what it drew. This
 *    is one Waivers load on production, the only D1 cost here.
 * 2. Sleeper's public answers, every one of them a documented endpoint except
 *    the weekly stats the app already reads for last week's points: the league
 *    and its `previous_league_id` chain, each season's users, rosters, drafts,
 *    draft picks and transactions, and the weekly stats. No D1 rows.
 * 3. The code before this round, fetched as its own commit, so the report can
 *    hand the same inputs to the old assembly and the new one.
 * 4. `waiver-round2-report.ts`: before, production, and the board once the
 *    Wednesday rival rows land; names, drops, bids, rivals and reasons.
 * 5. `waiver-rival-backtest.ts`: the old rival model against the new one on
 *    every published claim in every season.
 * 6. `probe-waiver-reads.mjs`: D1's own per-statement counts from Cloudflare's
 *    analytics (free), so one run answers the rows-read question too.
 *
 * Reads only. Nothing is written and no odds are bought.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
/* Tony's Pizza Fantasy on Sleeper. Public, like every Sleeper league id. */
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID || '1385016656425668608';
const SLEEPER = 'https://api.sleeper.app';
/* Earlier builds to replay on the same inputs, oldest first: before round 2, round 2 as first shipped (#367), and the follow-up Alex saw on 14 October (#368). */
const BEFORES = (process.env.BEFORE_SHAS || 'before round 2=35c4054f677071903379d2c21c133fbd95b2dde9,round 2 as first shipped=d8a6bc1a72b9f3515b8f2071440c1abc8eb17384,live on 14 October (#368)=cc425394962452ace3516ab034f6cee7010adc2f')
  .split(',')
  .map((pair) => pair.split('='))
  .map(([label, sha]) => ({ label, sha }));

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'waiver-round2-'));
let sleeperCalls = 0;
const pause = () => new Promise((r) => setTimeout(r, 120));
const get = async (url) => {
  sleeperCalls += url.startsWith(SLEEPER) ? 1 : 0;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
};
const save = async (name, url) => {
  writeFileSync(join(dir, name), await get(url));
  await pause();
};

const t0 = Date.now();
const snap = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot (waiver-plan) -> HTTP ${snap.status} in ${Date.now() - t0} ms (one Waivers load on production)`);
if (!snap.ok) {
  console.log((await snap.text()).slice(0, 300));
  process.exit(1);
}
const snapshotFile = join(dir, 'waiver-plan.json');
writeFileSync(snapshotFile, await snap.text());

/* Sleeper's public answers: the chain, each season's league data, the weekly stats. */
const state = JSON.parse(await get(`${SLEEPER}/v1/state/nfl`));
await save('players.json', `${SLEEPER}/v1/players/nfl`);
for (let id = SLEEPER_LEAGUE, depth = 0; id && id !== '0' && depth < 6; depth++) {
  const league = JSON.parse(await get(`${SLEEPER}/v1/league/${id}`));
  writeFileSync(join(dir, `league_${id}.json`), JSON.stringify(league));
  await save(`users_${id}.json`, `${SLEEPER}/v1/league/${id}/users`);
  await save(`rosters_${id}.json`, `${SLEEPER}/v1/league/${id}/rosters`);
  if (league.draft_id) await save(`picks_${id}.json`, `${SLEEPER}/v1/draft/${league.draft_id}/picks`);
  const lastWeek = league.season === state.season ? Math.min(18, state.week) : 18;
  for (let w = 1; w <= lastWeek; w++) await save(`tx_${id}_${w}.json`, `${SLEEPER}/v1/league/${id}/transactions/${w}`);
  const statWeeks = league.season === state.season ? state.week - 1 : 18;
  for (let w = 1; w <= statWeeks; w++) await save(`stats_${league.season}_${w}.json`, `${SLEEPER}/v1/stats/nfl/regular/${league.season}/${w}`).catch(() => {});
  id = league.previous_league_id;
}
console.log(`Sleeper public calls: ${sleeperCalls} (no D1 rows)`);

/* Each earlier build, in its own checkout. */
const olds = [];
BEFORES.forEach(({ label, sha }, i) => {
  const at = join(dir, `before-${i}`);
  try {
    execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', sha], { stdio: 'inherit' });
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', at, sha], { stdio: 'inherit' });
    olds.push(`${label}=${at}`);
  } catch (err) {
    console.log(`could not check out ${label} (${sha}): ${err}; that board is skipped`);
  }
});

const run = (script, args) => {
  try {
    return execFileSync('node', ['--experimental-transform-types', '--no-warnings', script, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}\n(${script} exited ${err.status})`;
  }
};

console.log(run('scripts/waiver-round2-report.ts', [snapshotFile, dir, ...olds]));
console.log("\n=== RIVAL BACKTEST: old model vs need-aware model, every published claim in every season ===");
const backtest = run('scripts/waiver-rival-backtest.ts', [dir, SLEEPER_LEAGUE]);
/* The per-claim table is long; the summary is what is read. Both are printed, the table last. */
const [table, ...summary] = backtest.split('\n== ');
console.log(['', ...summary].join('\n== '));
console.log('\n--- per-claim table ---');
console.log(table);

if (process.env.CLOUDFLARE_API_TOKEN) {
  console.log('\n=== D1 ROWS READ (Cloudflare analytics; costs no D1 rows) ===');
  try {
    console.log(execFileSync('node', ['scripts/probe-waiver-reads.mjs'], { encoding: 'utf8', env: process.env, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    console.log(`${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}
