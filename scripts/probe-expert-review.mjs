/**
 * The expert review round's one combined production read (November 2026).
 *
 * GET only. Nothing is written, bought or refreshed. In order:
 *
 *   1. Sleeper's documented public API (no D1): state, league, rosters, users,
 *      matchups for every finished week. Stops before any app read unless
 *      Sleeper is on EXPECT_WEEK (default 9), so a run on the wrong day costs
 *      production nothing.
 *   2. The app's own reads, the ones Alex's screens make: Team's lineup,
 *      Matchup, Waivers (tiers, Best move, bids), the trade ideas as shown and
 *      with every rejection, Check a trade on each idea, Build a trade for
 *      every team (unmarked players on, as the screen's All teams does), the
 *      league's real trades replayed, manager profiles, and the lineup and
 *      waiver-plan support snapshots for offline replay.
 *   3. Through the read-only D1 adapter (SELECT only), the weeks 1 to 8
 *      backtest inputs for Alex's players (scripts/expert-review-build.ts).
 *   4. Cloudflare's free analytics, before and after, for the rows this cost.
 *
 * Then prints a gzipped copy of everything read (for offline replay) and the
 * report (scripts/expert-review-report.mjs), last, so the end of the log is
 * the answer.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app/v1';
const EXPECT_WEEK = Number(process.env.EXPECT_WEEK ?? 9);
const dir = mkdtempSync(join(tmpdir(), 'expert-review-'));
const et = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';
const save = (name, value) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
const meta = { startedEt: et(new Date()), requests: [] };

const budget = (label) => {
  try {
    const out = execFileSync('node', ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', label], { encoding: 'utf8', env: process.env });
    const m = out.match(/([\d,]+) of [\d,]+ rows read today/);
    console.log(`D1 ${label}: ${out.split('\n')[0]}`);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  } catch (err) {
    console.log(`D1 ${label}: could not read (${String(err).slice(0, 120)})`);
    return null;
  }
};

async function get(name, url, { app = true } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { nonJson: text.slice(0, 300) };
    }
    meta.requests.push({ name, status: res.status, ms: Date.now() - t0, bytes: text.length, ...(app && body?.cost ? { rows: body.cost.rowsReturned } : {}) });
    return body;
  } catch (err) {
    meta.requests.push({ name, status: 'ERR', ms: Date.now() - t0, bytes: 0 });
    return { error: String(err) };
  }
}

console.log(`started ${meta.startedEt} (${new Date().toISOString()})`);

/* ---------------------------------------------- 1. Sleeper, documented */
const state = await get('sleeper state', `${SLEEPER}/state/nfl`, { app: false });
meta.sleeperWeek = state?.week ?? null;
console.log(`Sleeper: ${state?.season} ${state?.season_type} week ${state?.week}`);
if (Number(state?.week) !== EXPECT_WEEK) {
  console.log(`Standing down: Sleeper is on week ${state?.week}, not ${EXPECT_WEEK}. Nothing was read from the app or D1.`);
  process.exit(0);
}
const before = budget('before');

const health = await get('health', `${APP}/api/health`);
meta.sha = health?.release?.gitSha ?? null;
const leagues = await get('leagues', `${APP}/api/leagues`);
const league = leagues?.leagues?.find((l) => l.isSelected) ?? null;
const L = process.env.LEAGUE_ID || league?.id;
if (!L) throw new Error('no selected league');
const SL = process.env.SLEEPER_LEAGUE_ID || league?.sleeperLeagueId || L;
const lastWeek = Number(state.week) - 1;

save('league', await get('sleeper league', `${SLEEPER}/league/${SL}`, { app: false }));
save('rosters', await get('sleeper rosters', `${SLEEPER}/league/${SL}/rosters`, { app: false }));
save('users', await get('sleeper users', `${SLEEPER}/league/${SL}/users`, { app: false }));
for (let w = 1; w <= lastWeek; w++) save(`matchups${w}`, await get(`sleeper matchups ${w}`, `${SLEEPER}/league/${SL}/matchups/${w}`, { app: false }));

/* ---------------------------------------------------- 2. the app's reads */
const teams = await get('trade teams', `${APP}/api/leagues/${L}/trades/check/teams`);
save('teams', teams);
const mine = teams?.teams?.find((t) => t.isMine)?.rosterId ?? null;
save('mine', { rosterId: mine });

save('lineup', await get('Team lineup', `${APP}/api/leagues/${L}/lineup`));
save('matchup', await get('Matchup', `${APP}/api/leagues/${L}/matchup`));
save('waivers', await get('Waivers', `${APP}/api/leagues/${L}/waivers`));
save('managers', await get('managers', `${APP}/api/leagues/${L}/managers`));
const smart = await get('trade ideas', `${APP}/api/trades/smart?leagueId=${encodeURIComponent(L)}`);
save('smart', smart);
save('smartdiag', await get('trade ideas, with rejections', `${APP}/api/diagnostics/smart-trades?leagueId=${encodeURIComponent(L)}`));

const checks = {};
for (const o of smart?.offers ?? []) {
  const give = (o.give ?? []).map((p) => p.playerId).join(',');
  const getIds = (o.get ?? []).map((p) => p.playerId).join(',');
  checks[o.id] = await get(`check: idea ${o.id}`, `${APP}/api/leagues/${L}/trades/check?a=${mine}&b=${o.partner?.rosterId}&give=${give}&get=${getIds}&cost=1`);
}
save('checks', checks);

const builder = {};
for (const t of (teams?.teams ?? []).filter((x) => !x.isMine)) {
  builder[t.rosterId] = await get(`build: team ${t.rosterId}`, `${APP}/api/leagues/${L}/trades/build?team=${t.rosterId}&unmarked=1&sweep=1&cost=1`);
}
save('builder', builder);
save('replay', await get('league trades replayed', `${APP}/api/diagnostics/trade-values?leagueId=${encodeURIComponent(L)}&limit=12&cost=1`));

for (const context of ['lineup', 'waiver-plan']) {
  save(`snapshot-${context}`, await get(`support snapshot ${context}`, `${APP}/api/leagues/${L}/support-snapshot?context=${context}`));
}

/* -------------------------------------------------- 3. the backtest (D1) */
try {
  const out = execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/expert-review-build.ts', dir], {
    encoding: 'utf8',
    env: { ...process.env, LAST_WEEK: String(lastWeek) },
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(out.trim());
} catch (err) {
  console.log(`backtest build failed: ${String(err.stdout ?? '')}${String(err.stderr ?? err).slice(0, 1500)}`);
}

const after = budget('after');
meta.d1 = { before, after, spent: before != null && after != null ? after - before : null };
meta.finishedEt = et(new Date());
save('meta', meta);

/* ------------------------------------- 4. the copy, then the report last */
const bundle = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) bundle[f] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
const blob = gzipSync(Buffer.from(JSON.stringify(bundle))).toString('base64');
console.log(`\nBLOB ${blob.length} chars (gzip, base64) begins`);
for (let i = 0; i < blob.length; i += 4000) console.log(`BLOB ${blob.slice(i, i + 4000)}`);
console.log('BLOB ends');

console.log(`\nD1 rows today: before ${before ?? '?'}, after ${after ?? '?'}, so about ${meta.d1.spent ?? '?'} during this run (Alex's own use and the crons included).`);
console.log(execFileSync('node', ['scripts/expert-review-report.mjs', dir], { encoding: 'utf8', env: { ...process.env, COMPLETE_WEEKS: String(lastWeek) }, maxBuffer: 64 * 1024 * 1024 }));
console.log(`finished ${meta.finishedEt}`);
