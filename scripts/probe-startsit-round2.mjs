/**
 * Start/Sit round 2, in one run: audit, backtest, replay, comparisons, cost.
 *
 * The one combined production check this round is allowed. Everything it
 * needs from production is read once, here:
 *
 *   - GET /api/health                       the production SHA
 *   - GET /api/leagues                      which league is selected
 *   - GET support-snapshot?context=lineup   the exact inputs Team's lineup read
 *   - GET /api/leagues/:id/lineup           the week's projected margin (posture)
 *   - D1 SELECTs, through the app's own repos: this season's stored prop
 *     snapshots and lines, usage weeks, players and fixtures
 *   - Cloudflare's D1 analytics             rows read per call, per statement
 *
 * plus Sleeper's public league, state and weekly stats for actual points. It
 * then runs, with no further network: `startsit-round2-build.ts` (gather),
 * `startsit-round2-score.ts` on the code before the round (BEFORE_SHA) and on
 * this checkout, `startsit-round2-report.ts`, and
 * `startsit-round2-statements.ts` on both checkouts for the cost per screen.
 *
 * Reads only. Nothing is written to the app or the database, and no odds are
 * bought.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app';
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID || '1385016656425668608';
/* main when this round started building: #357. */
const BEFORE_SHA = process.env.BEFORE_SHA ?? '76d8464fc49611090074223b6acbcd61f7cb9873';
const dir = mkdtempSync(join(tmpdir(), 'startsit-r2-'));

/*
 * WEEK AND LINEUP (STEPS=week-lineup, 13 October 2026): the one production
 * check for the stale-lineup fix. Reads the app's own answers once each (the
 * week it thinks it is, Team's slots, Best move) and Sleeper's public state,
 * rosters and this week's matchup row, and says whether Team now shows the
 * lineup Sleeper shows. D1 cost is every row the account read during the run,
 * from Cloudflare's analytics, so it includes anything else that ran then.
 */
if (process.env.STEPS === 'week-lineup') {
  const started = new Date();
  const get = (path) => fetch(`${APP}${path}`).then((r) => r.json()).catch(() => null);
  const sleeper = (path) => fetch(`${SLEEPER}/v1${path}`).then((r) => r.json()).catch(() => null);
  const health = await get('/api/health');
  console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
  const leagues = await get('/api/leagues');
  const selected = leagues?.leagues?.find((l) => l.isSelected) ?? null;
  const leagueId = process.env.LEAGUE_ID || selected?.id;
  if (!leagueId) throw new Error('no selected league');
  console.log(`league: ${selected?.name ?? leagueId}, last synced ${selected?.lastSyncedAt ?? '?'}`);

  const state = await sleeper('/state/nfl');
  console.log(`Sleeper state: week ${state?.week}, leg ${state?.leg}, display_week ${state?.display_week}, ${state?.season_type}`);

  const roster = await get(`/api/leagues/${leagueId}/roster`);
  const matchup = await get(`/api/leagues/${leagueId}/matchup`);
  const lineup = await get(`/api/leagues/${leagueId}/lineup`);
  console.log(`week the app shows on Matchup: ${matchup?.week ?? '?'}`);
  const names = new Map([...(roster?.starters ?? []), ...(roster?.bench ?? [])].map((p) => [p.playerId, `${p.name} (${p.position})`]));
  const slots = roster?.rosterPositions ?? [];
  const appSlots = roster?.starterSlotIds ?? (roster?.starters ?? []).map((p) => p.playerId);
  console.log('\nTeam lineup as the app reads it:');
  appSlots.forEach((id, i) => console.log(`  ${(slots[i] ?? '?').padEnd(5)} ${id ? (names.get(id) ?? id) : 'empty'}`));
  const best = lineup?.swaps?.[0] ?? lineup?.fills?.[0] ?? null;
  console.log(`Best move: ${best ? (best.outName ? `start ${best.inName} over ${best.outName} (${best.slot})` : `start ${best.inName} at ${best.slot}`) : 'no swap clears the bar'}`);

  const users = (await sleeper(`/league/${SLEEPER_LEAGUE}/users`)) ?? [];
  const rosters = (await sleeper(`/league/${SLEEPER_LEAGUE}/rosters`)) ?? [];
  const week = Number(state?.week ?? 0);
  const rows = week > 0 ? ((await sleeper(`/league/${SLEEPER_LEAGUE}/matchups/${week}`)) ?? []) : [];
  const me = users.find((u) => /junc/i.test(`${u.display_name} ${u.username}`));
  const mine = rosters.find((r) => r.owner_id === me?.user_id);
  const row = rows.find((r) => r.roster_id === mine?.roster_id);
  const clean = (list) => (list ?? []).map((id) => (id && id !== '0' ? id : null));
  const sleeperWeek = row?.starters?.some((id) => id && id !== '0') ? clean(row.starters) : clean(mine?.starters);
  console.log(`\nSleeper /rosters starters:      ${JSON.stringify(clean(mine?.starters))}`);
  console.log(`Sleeper /matchups/${week} starters: ${JSON.stringify(clean(row?.starters))}`);
  const same = JSON.stringify(sleeperWeek) === JSON.stringify(appSlots.map((id) => id ?? null));
  console.log(same ? `Team matches Sleeper's Week ${week} lineup.` : `Team does NOT match Sleeper's Week ${week} lineup yet (the next league read or a refresh stores it).`);

  const CF = process.env.CLOUDFLARE_API_TOKEN;
  if (CF) {
    await new Promise((r) => setTimeout(r, 90_000)); // analytics lag
    const account =
      process.env.ACCOUNT_ID ||
      (await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${CF}` } }).then((r) => r.json()))?.result?.[0]?.id;
    const body = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${CF}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
          d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) { sum { rowsRead } count } } } }`,
        variables: { a: account, from: started.toISOString(), to: new Date().toISOString() },
      }),
    }).then((r) => r.json());
    const groups = body?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
    const read = groups.reduce((a, g) => a + Number(g.sum?.rowsRead ?? 0), 0);
    const calls = groups.reduce((a, g) => a + Number(g.count ?? 0), 0);
    console.log(`\nD1 during this run (account-wide, includes any cron that ran): ${read} rows read over ${calls} statements`);
  }
  console.log('production endpoints read once each: /api/health, /api/leagues, /roster, /matchup, /lineup');
  process.exit(0);
}

/*
 * FOLLOW-UP (the default since 13 October 2026): the round's second and last
 * production check. Pills under the tightened thresholds, the tie-break on the
 * real matchup, and the Best move card against the lineup rows. The full
 * audit and backtest below run only with FULL=1, which the Probe workflow
 * never sets, so re-running this workflow cannot repeat that read.
 */
if (!process.env.FULL) {
  const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
  const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
  const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
  if (!leagueId) throw new Error('no selected league');
  const snap = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
  console.log(`support snapshot (lineup): HTTP ${snap.status}`);
  writeFileSync(join(dir, 'lineup.json'), await snap.text());
  const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then((r) => r.json()).catch(() => null);
  const margin = lineup?.modeSuggestion?.margin ?? null;
  const posture = margin == null || margin === 0 ? '' : margin < 0 ? 'underdog' : 'favourite';
  console.log(`matchup: ${lineup?.modeSuggestion?.detail ?? '?'} (margin ${margin ?? 'unknown'}) -> posture ${posture || 'none'}`);
  writeFileSync(join(dir, 'roster.json'), await fetch(`${APP}/api/leagues/${leagueId}/roster`).then((r) => r.text()));
  console.log(
    execFileSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/startsit-round2-followup.ts', dir, posture], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  console.log('production endpoints read once each: /api/health, /api/leagues, the lineup support snapshot, /lineup, /roster');
  process.exit(0);
}

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

const snap = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
console.log(`support snapshot (lineup): HTTP ${snap.status}`);
if (snap.ok) writeFileSync(join(dir, 'lineup.json'), await snap.text());
const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then((r) => r.json()).catch(() => null);
const margin = lineup?.modeSuggestion?.margin ?? null;
const posture = margin == null || margin === 0 ? '' : margin < 0 ? 'underdog' : 'favourite';
console.log(`matchup margin ${margin ?? 'unknown'} -> posture ${posture || 'none'}`);

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

/* The code before the round, on the same files. */
let before = null;
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', BEFORE_SHA], { stdio: 'ignore' });
  before = join(dir, 'before');
  execFileSync('git', ['worktree', 'add', '--detach', before, BEFORE_SHA], { stdio: 'ignore' });
  for (const f of ['scripts/startsit-round2-score.ts', 'scripts/startsit-round2-statements.ts']) {
    mkdirSync(dirname(join(before, f)), { recursive: true });
    copyFileSync(f, join(before, f));
  }
  console.log(ts(before, 'scripts/startsit-round2-score.ts', [dir, join(dir, 'old.json')]));
} catch (err) {
  console.log(`BEFORE checkout failed: ${String(err).slice(0, 400)}`);
}
console.log(ts(process.cwd(), 'scripts/startsit-round2-score.ts', [dir, join(dir, 'new.json'), posture]));
console.log(ts(process.cwd(), 'scripts/startsit-round2-report.ts', [dir]));

/* ------------------------------------------- D1 rows read per screen, per load */
console.log('\n################ 5. DATA COST: D1 rows read per screen load ################');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const norm = (sql) =>
  sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?)')
    .replace(/^SELECT .*? FROM /i, 'SELECT … FROM ');
let perCall = new Map();
if (TOKEN) {
  const account =
    process.env.ACCOUNT_ID ||
    (await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()))
      ?.result?.[0]?.id;
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3_600_000);
  const body = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) { dimensions { query } sum { rowsRead } count } } } }`,
      variables: { a: account, from: from.toISOString(), to: to.toISOString() },
    }),
  }).then((r) => r.json());
  for (const r of body?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
    const k = norm(String(r.dimensions?.query ?? ''));
    const hit = perCall.get(k) ?? { read: 0, calls: 0 };
    hit.read += Number(r.sum?.rowsRead ?? 0);
    hit.calls += Number(r.count ?? 0);
    perCall.set(k, hit);
  }
  console.log(`production statements seen in the last 24 h: ${perCall.size}`);
} else {
  console.log('(no Cloudflare token: per-statement production costs unavailable)');
}
const stmts = {};
stmts.after = JSON.parse((ts(process.cwd(), 'scripts/startsit-round2-statements.ts', [join(dir, 'stmts-after.json')]), readFileSync(join(dir, 'stmts-after.json'), 'utf8')));
if (before) stmts.before = JSON.parse((ts(before, 'scripts/startsit-round2-statements.ts', [join(dir, 'stmts-before.json')]), readFileSync(join(dir, 'stmts-before.json'), 'utf8')));
const estimate = (sqls) => {
  let rows = 0;
  let unknown = 0;
  for (const s of sqls) {
    const hit = perCall.get(norm(s));
    if (hit && hit.calls > 0) rows += hit.read / hit.calls;
    else unknown++;
  }
  return { rows: Math.round(rows), unknown, statements: sqls.length };
};
console.log('screen                                   before (rows, statements)        after (rows, statements)');
for (const screen of Object.keys(stmts.after)) {
  const a = stmts.after[screen];
  const b = stmts.before?.[screen];
  const fa = a.status.every((s) => s === 200) ? estimate(a.sql) : null;
  const fb = b && b.status.every((s) => s === 200) ? estimate(b.sql) : null;
  const show = (f) => (f ? `~${f.rows} rows, ${f.statements} stmts${f.unknown ? ` (${f.unknown} not seen in prod)` : ''}` : 'n/a');
  console.log(`${screen.padEnd(40)} ${show(fb).padEnd(32)} ${show(fa)}`);
}
