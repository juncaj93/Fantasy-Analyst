/**
 * The odds job's next seven days, from production data, and what is deployed.
 *
 * Prints, in this order:
 *   1. the production release SHA, from `/api/health`, to compare with the SHA
 *      this change was merged as (set EXPECT_SHA to have it say so);
 *   2. the gate the job keeps and the passes it plans, from the deployed app's
 *      own `/api/vegas/budget` (`clock`): this is the job's view of itself;
 *   3. the same passes computed here, from the stored `nfl_schedule` rows read
 *      straight out of D1 with the same pure module the job imports. If the two
 *      disagree, one of them is wrong, and the disagreement is the finding;
 *   4. nflverse's `games.csv` `Last-Modified`, which is how often the file the
 *      schedule reads from is actually rebuilt.
 *
 * Read-only: every statement is a SELECT and nothing here calls the odds
 * provider. Env: CLOUDFLARE_API_TOKEN and ACCOUNT_ID for part 3 (optional);
 * EXPECT_SHA; DAYS (default 7).
 */

import { plannedPasses } from '../src/core/vegas/kickoffClock.ts';

const APP = process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const DAYS = Number(process.env.DAYS ?? 7);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';
const NOW = Date.now();

const hhmm = (iso) => iso.slice(5, 16).replace('T', ' ') + 'Z';
const eastern = (iso) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

console.log('=== production release ===');
const health = await (await fetch(`${APP}/api/health`)).json().catch(() => null);
const sha = health?.release?.gitSha ?? null;
console.log(`  gitSha: ${sha}`);
if (process.env.EXPECT_SHA) {
  console.log(`  expected: ${process.env.EXPECT_SHA}  ->  ${sha === process.env.EXPECT_SHA ? 'MATCH' : 'DIFFERENT (is the deploy finished?)'}`);
}

console.log(`\n=== the job's own view, from the deployed app (next ${DAYS} days) ===`);
const budget = await (await fetch(`${APP}/api/vegas/budget`)).json().catch(() => null);
const clock = budget?.clock ?? null;
if (!clock) {
  console.log('  the deployed app has no `clock` block yet: the odds job is not deployed');
} else {
  console.log(`  gate: ${JSON.stringify(clock.state)}`);
  const upcoming = (clock.upcoming ?? []).filter((p) => Date.parse(p.at) <= NOW + DAYS * 86_400_000);
  let games = 0;
  let worst = 0;
  for (const p of upcoming) {
    games += p.leagueGames;
    worst += p.rosterGames;
    const kick = p.kickoffs.map((k) => `${k.hoursBefore}h before ${hhmm(k.kickoff)}`).join('; ');
    console.log(`  ${hhmm(p.at)} (${eastern(p.at)} ET)  league games ${String(p.leagueGames).padStart(2)}  roster games ${String(p.rosterGames).padStart(2)}  <- ${kick}`);
  }
  console.log(`  ${upcoming.length} passes in ${DAYS} days; at most ${worst} entities if every roster game were stale at every look`);
}

async function call(path, init = {}) {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  return res.json().catch(() => null);
}

if (TOKEN) {
  if (!ACCOUNT) ACCOUNT = (await call('/accounts'))?.result?.[0]?.id;
  const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
  const DB = dbs?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
  const select = async (sql) => {
    if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
    const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
    if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
    return r.result?.[0]?.results ?? [];
  };

  console.log(`\n=== recomputed here from the stored schedule (next ${DAYS} days) ===`);
  const state = await select("SELECT value_json FROM settings WHERE key = 'sleeper.nflState'");
  const week = Number(JSON.parse(state[0]?.value_json ?? 'null')?.week);
  const league = await select("SELECT season FROM leagues WHERE is_selected = 1 LIMIT 1").catch(() => []);
  const season = league[0]?.season ?? String(new Date().getUTCFullYear());
  console.log(`  season ${season}, NFL week ${week}`);
  const rows = await select(
    `SELECT week, team, opponent, kickoff FROM nfl_schedule WHERE season = '${season}' AND week IN (${week}, ${week + 1}) AND opponent IS NOT NULL ORDER BY week, kickoff`,
  );
  const kickoffs = [...new Set(rows.map((r) => r.kickoff).filter(Boolean))];
  console.log(`  ${rows.length / 2} games stored for weeks ${week} and ${week + 1}, ${kickoffs.length} distinct kickoff slots:`);
  for (const k of kickoffs) {
    const n = rows.filter((r) => r.kickoff === k).length / 2;
    console.log(`    ${hhmm(k)} (${eastern(k)} ET)  ${n} game${n === 1 ? '' : 's'}`);
  }
  const passes = plannedPasses(kickoffs, NOW, NOW + DAYS * 86_400_000);
  console.log(`  ${passes.length} passes:`);
  for (const p of passes) console.log(`    ${hhmm(p.at)} (${eastern(p.at)} ET)  ${p.games.map((g) => `${g.hoursBefore}h before ${hhmm(g.kickoff)}`).join('; ')}`);

  if (clock) {
    const deployed = new Set((clock.upcoming ?? []).filter((p) => Date.parse(p.at) <= NOW + DAYS * 86_400_000).map((p) => p.at));
    const here = new Set(passes.map((p) => p.at));
    const missing = [...here].filter((a) => !deployed.has(a));
    const extra = [...deployed].filter((a) => !here.has(a));
    console.log(`\n  deployed vs recomputed: ${missing.length === 0 && extra.length === 0 ? 'IDENTICAL' : `DIFFERENT (only here: ${missing.join(', ') || 'none'}; only deployed: ${extra.join(', ') || 'none'})`}`);
  }

  const gate = await select("SELECT value_json, updated_at FROM settings WHERE key = 'vegas.clock'");
  console.log(`\n  stored gate row: ${gate[0] ? `${gate[0].value_json} (updated ${gate[0].updated_at})` : '(none yet)'}`);
}

console.log('\n=== how often the schedule file is rebuilt (nflverse games.csv) ===');
const head = await fetch('https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv', { method: 'HEAD' });
console.log(`  HTTP ${head.status}  Last-Modified: ${head.headers.get('last-modified')}  ETag: ${head.headers.get('etag')}`);
