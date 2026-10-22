/**
 * "Pick up and start" round of 18 October 2026, in one run: the replay of
 * Alex's week, the Vegas-only test, and the data cost.
 *
 * The one combined production check this round is allowed. What it reads:
 *
 *   - GET /api/health, /api/leagues        the production SHA, the league
 *   - Sleeper's public state, league and weekly stats (actual points)
 *   - D1 SELECTs through the app's own code: the backtest's stored props and
 *     usage (`startsit-round2-build.ts`), the evidence rows for its news, and
 *     the Team screen's two decision gatherers, once on the code before the
 *     round (BEFORE_SHA) and once on this checkout, for rows read per load
 *
 * then prints `pickup-start-report.ts`. Reads only: nothing is written to the
 * app or the database, and no odds are bought.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app';
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
if (!SLEEPER_LEAGUE) {
  console.error('SLEEPER_LEAGUE_ID is not set. It is a repository secret: see docs/SETUP.md, "The league ID secret".');
  process.exit(1);
}
/* main when this round started building: #381. */
const BEFORE_SHA = process.env.BEFORE_SHA ?? 'a322a10be3218f4145635ab8e40d7a0cd513a4dc';
const dir = mkdtempSync(join(tmpdir(), 'pickup-start-'));

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');
console.log(`league: ${leagueId}`);

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
};
const state = JSON.parse(await get(`${SLEEPER}/v1/state/nfl`));
writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
writeFileSync(join(dir, 'league.json'), await get(`${SLEEPER}/v1/league/${SLEEPER_LEAGUE}`));
for (let w = 1; w < Number(state.week); w++) {
  writeFileSync(join(dir, `stats${w}.json`), await get(`${SLEEPER}/v1/stats/nfl/regular/${state.season}/${w}`));
}

const ts = (cwd, script, args) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', script, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

console.log(ts(process.cwd(), 'scripts/startsit-round2-build.ts', [dir]));

/* The code before the round: the Team gatherers only, for rows read. */
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  const before = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', before, BEFORE_SHA], { stdio: 'ignore' });
  for (const f of ['scripts/pickup-start-report.ts']) {
    mkdirSync(dirname(join(before, f)), { recursive: true });
    copyFileSync(f, join(before, f));
  }
  console.log(`before: ${BEFORE_SHA.slice(0, 7)} ` + ts(before, 'scripts/pickup-start-report.ts', [dir, leagueId, 'gather', join(dir, 'cost-before.json')]));
} catch (err) {
  console.log(`BEFORE checkout failed: ${String(err).slice(0, 400)}`);
}

console.log('after: this checkout');
console.log(ts(process.cwd(), 'scripts/pickup-start-report.ts', [dir, leagueId, 'report']));
console.log('production endpoints read once each: /api/health, /api/leagues; D1 SELECTs as reported above');
