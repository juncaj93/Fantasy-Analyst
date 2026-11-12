/**
 * Round 24 (Players tab in season): the round's ONE production check.
 * Read-only, Sleeper is never called, and the switch stays off: these routes
 * exist on the live site but the screen does not ask them until it is on.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. the board on Alex's real league, twice: the first open builds it, the
 *      second should be the ten-minute memo (same Worker permitting);
 *   3. what the filters would show (computed here from the one answer: a
 *      filter reads nothing on the phone);
 *   4. one card each for the top trade target and an injured player.
 *
 * Every request carries `cost=1`, so the rows each one read are printed.
 * Times in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 24 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - started };
}

const cost = (b) => `${b?.cost?.rowsReturned ?? '?'} rows in ${b?.cost?.statements ?? '?'} statements`;

console.log(`Round 24 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);
let probeRows = 0;

heading('Production revision');
const health = await get('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);
const status = await get('/api/auth/status');
console.log(`switches: ${JSON.stringify(status.body?.features ?? null)}`);
const leagues = await get('/api/leagues');
const leagueId = process.env.LEAGUE_ID || (leagues.body?.leagues ?? []).find((l) => l.isSelected)?.id || '';
if (!leagueId) {
  console.log('no selected league; stopping');
  process.exit(0);
}
const q = `leagueId=${encodeURIComponent(leagueId)}&cost=1`;

heading('Opening the tab: the board');
const first = await get(`/api/players/season?${q}`);
probeRows += first.body?.cost?.rowsReturned ?? 0;
if (first.status !== 200 || !first.body) {
  console.log(`  HTTP ${first.status} ${JSON.stringify(first.body)?.slice(0, 300)}`);
  process.exit(0);
}
const board = first.body;
console.log(`  first open: ${cost(board)}, ${first.ms} ms, ${board.rows?.length ?? 0} players, week ${board.week}, trades open: ${board.tradeOpen}`);
const second = await get(`/api/players/season?${q}`);
probeRows += second.body?.cost?.rowsReturned ?? 0;
console.log(`  second open: ${cost(second.body)}, ${second.ms} ms (the memo, when the same Worker answers)`);
if (board.reason) console.log(`  reason: ${board.reason}`);

const teams = new Map((board.teams ?? []).map((t) => [t.rosterId, t.isMine ? 'You' : t.ownerName ?? `Team ${t.rosterId}`]));
const who = (r) => (r.ownerRosterId == null ? 'Available' : teams.get(r.ownerRosterId) ?? '?');
const v = (n) => (n == null ? '-' : n.toFixed(1));

heading('Default sort, top 10 by rest-of-season value');
for (const r of board.rows.slice(0, 10)) console.log(`  ${v(r.value)}  ${r.name} (${r.position}, ${who(r)})  pick ${r.draftPick ?? '-'}  7d ${r.last7}  30d ${r.last30}`);

heading('Trade targets (0 rows: a filter runs on the phone)');
const targets = board.rows.filter((r) => r.trade);
const words = { Likely: 0, Maybe: 0, Unlikely: 0 };
for (const r of targets) words[r.trade.willingness] += 1;
console.log(`  ${targets.length} targets: ${words.Likely} Likely, ${words.Maybe} Maybe, ${words.Unlikely} Unlikely`);
for (const r of targets.slice(0, 8)) console.log(`  ${r.trade.willingness.padEnd(8)} ${r.name} (${who(r)}): ${r.trade.reason}`);

heading('Injured / returning (0 rows)');
const hurt = board.rows.filter((r) => r.injury);
console.log(`  ${hurt.length} out now`);
for (const r of hurt.slice(0, 8)) console.log(`  ${r.name} (${r.position}, ${who(r)}, ${r.status ?? '?'}): ${r.injury.backWeek ? `back week ${r.injury.backWeek}` : 'not back this season'}`);

heading('Cards');
for (const r of [targets[0], hurt[0], board.rows[0]].filter(Boolean)) {
  const card = await get(`/api/players/${encodeURIComponent(r.id)}/season?${q}`);
  probeRows += card.body?.cost?.rowsReturned ?? 0;
  const c = card.body;
  if (card.status !== 200 || !c) {
    console.log(`  ${r.name}: HTTP ${card.status}`);
    continue;
  }
  const next = (c.next ?? []).map((x) => `wk${x.week} ${x.bye ? 'BYE' : x.out ? 'Out' : v(x.points)}${x.sleeper ? '*' : ''}`).join(', ');
  const last = (c.last ?? []).map((x) => `wk${x.week} ${v(x.points)}`).join(', ');
  console.log(`  ${r.name}: this week ${c.thisWeek.out ? 'Out' : v(c.thisWeek.points)}${c.thisWeek.sleeper ? '*' : ''}; next ${next}; last ${last}; ${cost(c)}, ${card.ms} ms`);
}
console.log('  (* = built on Sleeper’s projection)');

heading('Rows');
const rowsAfter = rowsToday();
console.log(`rows read by this probe's requests (metered): ${probeRows}`);
console.log(`D1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}, Cloudflare's count, which lags a few minutes)` : ''}`);
console.log(`finished ${eastern()} ET`);
