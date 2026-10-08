/**
 * Waivers before and after the tiers, and the bid backtest, on the live league.
 *
 * 1. Fetches the public `waiver-plan` support snapshot (the exact inputs the
 *    deployed Waivers screen read, and what it drew).
 * 2. Fetches Sleeper's public answers for the league: the schedule, weekly
 *    stats and projections, rosters, users, transactions and draft picks.
 * 3. Runs `scripts/waiver-tiers-report.ts` (before vs after on the snapshot)
 *    and `scripts/waiver-bid-backtest.ts` (this season's claims, predicted vs
 *    actual).
 *
 * Reads only: GETs to the app and to Sleeper's public API. Nothing is written
 * and no odds are bought.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
/* Tony's Pizza Fantasy on Sleeper. Public, like every Sleeper league id. */
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID || '1385016656425668608';
const SLEEPER = 'https://api.sleeper.app';

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'waiver-tiers-'));
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
};
const save = async (name, url) => writeFileSync(join(dir, name), await get(url));

const t0 = Date.now();
const snap = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot (waiver-plan) -> HTTP ${snap.status} in ${Date.now() - t0} ms`);
if (!snap.ok) {
  console.log((await snap.text()).slice(0, 300));
  process.exit(1);
}
const snapshotFile = join(dir, 'waiver-plan.json');
writeFileSync(snapshotFile, await snap.text());

const state = JSON.parse(await get(`${SLEEPER}/v1/state/nfl`));
const season = state.season;
const league = JSON.parse(await get(`${SLEEPER}/v1/league/${SLEEPER_LEAGUE}`));
writeFileSync(join(dir, 'league.json'), JSON.stringify(league));
await save('users.json', `${SLEEPER}/v1/league/${SLEEPER_LEAGUE}/users`);
await save('rosters.json', `${SLEEPER}/v1/league/${SLEEPER_LEAGUE}/rosters`);
await save('schedule.json', `${SLEEPER}/schedule/nfl/regular/${season}`);
await save('players.json', `${SLEEPER}/v1/players/nfl`);
if (league.draft_id) await save('picks.json', `${SLEEPER}/v1/draft/${league.draft_id}/picks`);
const positions = ['QB', 'RB', 'WR', 'TE', 'DEF'].map((p) => `position[]=${p}`).join('&');
for (let w = 1; w <= state.week; w++) {
  await save(`tx${w}.json`, `${SLEEPER}/v1/league/${SLEEPER_LEAGUE}/transactions/${w}`);
  await save(`stats${w}.json`, `${SLEEPER}/v1/stats/nfl/regular/${season}/${w}`);
  await save(`proj${w}.json`, `${SLEEPER}/projections/nfl/${season}/${w}?season_type=regular&${positions}&order_by=ppr`);
}

const run = (script, args) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', script, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

console.log(run('scripts/waiver-tiers-report.ts', [snapshotFile, dir]));
console.log('\n=== BID BACKTEST: this season\'s claims, predicted vs actual ===');
console.log(run('scripts/waiver-bid-backtest.ts', [dir]));
