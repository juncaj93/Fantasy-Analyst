/**
 * Why is the Waivers screen nearly empty on a Tuesday night, and is it new?
 *
 * Read-only: one GET of the public waivers read, and SELECTs against D1. Nothing
 * here calls the odds provider or Sleeper, and nothing is written.
 *
 * Prints, in this order:
 *   1. what the live Waivers read says about itself: the headline, how many
 *      rows of each kind, how the pool was bounded, and the players it could not
 *      score;
 *   2. the week the app believes it is in, and the stored schedule for it (how
 *      many fixtures have already kicked off, which is what locks a player out);
 *   3. Sleeper's published projections as stored, per week;
 *   4. what each scheduled run did last, step by step, for the two steps that
 *      feed the board (published projections, and the Sleeper state);
 *   5. the odds the board could read at one moment on each of the last two
 *      Tuesdays (default 02:51 UTC on the Wednesday, which is 10:51 PM ET):
 *      the newest snapshot of every game that had not kicked off, and how many
 *      player lines and players each one carried;
 *   6. the odds log for the Tuesday window of both weeks;
 *   7. the one player the board could not score, in each of those places.
 *
 * Env: CLOUDFLARE_API_TOKEN and ACCOUNT_ID. Optional: NOW_CUT (ISO, default
 * 2026-10-07T02:51:00Z) and PREV_CUT (default seven days earlier), FOCUS_LAST
 * and FOCUS_FIRST (default Stroud, C).
 */

const BASE = process.env.BASE ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';
const NOW_CUT = process.env.NOW_CUT ?? '2026-10-07T02:51:00.000Z';
const PREV_CUT = process.env.PREV_CUT ?? new Date(Date.parse(NOW_CUT) - 7 * 86_400_000).toISOString();
const FOCUS_LAST = process.env.FOCUS_LAST ?? 'Stroud';
const FOCUS_FIRST = process.env.FOCUS_FIRST ?? 'C';

const z = (iso) => (iso ? String(iso).slice(0, 19).replace('T', ' ') + 'Z' : '(none)');
const short = (id) => (id ? String(id).slice(0, 10) : '-');

// ---------------------------------------------------------------- 1. the read
console.log('=== 1. the live Waivers read ===');
let board = null;
let leagueId = process.env.LEAGUE_ID;
try {
  const leagues = await fetch(`${BASE}/api/leagues`).then((r) => r.json());
  leagueId ||= leagues?.leagues?.find((l) => l.isSelected)?.id;
  const res = await fetch(`${BASE}/api/leagues/${leagueId}/waivers`);
  console.log(`  GET /api/leagues/<id>/waivers -> HTTP ${res.status}`);
  board = await res.json();
} catch (err) {
  console.log(`  could not read it: ${err}`);
}
const len = (x) => (Array.isArray(x) ? x.length : 0);
if (board) {
  console.log(`  found: ${board.found}   headline: ${board.headline ?? '(none)'}`);
  console.log(`  upgrades ${len(board.upgrades)}   valueAdds ${len(board.valueAdds)}   unknowns ${len(board.unknowns)}   moveGroups ${len(board.moveGroups)}`);
  console.log(`  considered ${board.considered}   skipped ${board.skipped}   threshold ${board.threshold}   pool ${JSON.stringify(board.pool)}`);
  console.log(`  notes: ${JSON.stringify(board.notes ?? [])}`);
  console.log(`  updatedAt ${board.updatedAt}   dataFreshness ${JSON.stringify(board.dataFreshness)}`);
  console.log(`  gameWindow ${JSON.stringify(board.gameWindow)}`);
  for (const u of board.unknowns ?? []) {
    console.log(`  unknown: ${u.name} (${u.position}, ${u.team})  id ${u.playerId}  ${u.statusFlag ?? ''}`);
  }
  console.log(`  top-level keys: ${Object.keys(board).join(', ')}`);
}

if (!TOKEN) {
  console.log('\nno CLOUDFLARE_API_TOKEN: the database sections are skipped');
  process.exit(0);
}

async function call(path, init = {}) {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  return res.json().catch(() => null);
}
if (!ACCOUNT) ACCOUNT = (await call('/accounts'))?.result?.[0]?.id;
const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
const select = async (sql) => {
  if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
  const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
  if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
  return r.result?.[0]?.results ?? [];
};
const safe = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.log(`  (${label} failed: ${String(err.message ?? err).slice(0, 200)})`);
    return null;
  }
};

// ----------------------------------------------------- 2. the week, and locks
console.log('\n=== 2. the week the app believes it is in ===');
const stateRow = await safe('nflState', () => select("SELECT value_json, updated_at FROM settings WHERE key = 'sleeper.nflState'"));
const state = stateRow?.[0] ? JSON.parse(stateRow[0].value_json) : null;
console.log(`  nflState: ${JSON.stringify(state)}  (stored ${z(stateRow?.[0]?.updated_at)})`);
const week = Number(state?.week);
const league = await safe('league', () => select('SELECT season FROM leagues WHERE is_selected = 1 LIMIT 1'));
const season = league?.[0]?.season ?? '2026';
const NOW = new Date().toISOString();
for (const w of [week - 1, week, week + 1].filter((n) => Number.isInteger(n) && n > 0)) {
  const rows = await safe(`schedule week ${w}`, () =>
    select(`SELECT team, kickoff FROM nfl_schedule WHERE season = '${season}' AND week = ${w} AND opponent IS NOT NULL`),
  );
  if (!rows) continue;
  const past = rows.filter((r) => r.kickoff && r.kickoff <= NOW).length;
  const kicks = rows.map((r) => r.kickoff).filter(Boolean).sort();
  console.log(`  week ${w}: ${rows.length} team rows, ${past} already kicked off, kickoffs ${z(kicks[0])} to ${z(kicks.at(-1))}`);
}

// ------------------------------------------------- 3. published projections
console.log('\n=== 3. Sleeper published projections, as stored ===');
const proj = await safe('projections', () =>
  select(
    `SELECT week, COUNT(*) AS rows, SUM(CASE WHEN pts_ppr IS NOT NULL THEN 1 ELSE 0 END) AS with_ppr, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM sleeper_weekly_projections WHERE season = '${season}' GROUP BY week ORDER BY week`,
  ),
);
for (const r of proj ?? []) {
  console.log(`  week ${String(r.week).padStart(2)}: ${String(r.rows).padStart(5)} rows (${r.with_ppr} with a PPR figure)  stored ${z(r.oldest)} to ${z(r.newest)}`);
}
console.log(`  (a stored row keeps only its newest fetch time, so this cannot say when a week was first published)`);

// ---------------------------------------------------------- 4. scheduled runs
console.log('\n=== 4. what each scheduled run last did ===');
const runs = await safe('cron_run_state', () =>
  select('SELECT cron, label, trigger, started_at, finished_at, outcome, release_sha, steps_json FROM cron_run_state ORDER BY started_at DESC'),
);
for (const r of runs ?? []) {
  console.log(`  ${String(r.cron).padEnd(16)} ${z(r.started_at)}  ${r.outcome}  release ${String(r.release_sha ?? '').slice(0, 7)}  (${r.label})`);
  let steps = [];
  try {
    const parsed = JSON.parse(r.steps_json);
    steps = Array.isArray(parsed) ? parsed : (parsed?.steps ?? []);
  } catch {
    /* leave empty */
  }
  for (const s of steps) {
    const id = String(s.id ?? s.key ?? s.name ?? '');
    if (/projection|state|schedule|trend|vegas|player/i.test(id + String(s.label ?? ''))) {
      console.log(`      ${id.padEnd(24)} ${String(s.outcome ?? '').padEnd(10)} items ${s.items ?? '-'}  ${String(s.note ?? '').slice(0, 110)}`);
    }
  }
}

// ----------------------------------------------- 5. odds at one moment, twice
async function oddsAsOf(cut) {
  const snaps = await select(
    `SELECT id, event_id, game_start, fetched_at FROM prop_snapshots WHERE scope = 'week' AND fetched_at <= '${cut}' AND game_start > '${cut}' AND game_start <= '${new Date(Date.parse(cut) + 8 * 86_400_000).toISOString()}' ORDER BY fetched_at`,
  );
  const newest = new Map();
  for (const s of snaps) newest.set(s.event_id, s);
  const ids = [...newest.values()].map((s) => s.id);
  const counts = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const rows = await select(
      `SELECT snapshot_id, COUNT(*) AS lines, COUNT(DISTINCT player_id) AS players FROM player_props WHERE snapshot_id IN (${batch.join(',')}) GROUP BY snapshot_id`,
    );
    for (const r of rows) counts.set(r.snapshot_id, r);
  }
  return [...newest.values()]
    .sort((a, b) => a.game_start.localeCompare(b.game_start))
    .map((s) => ({ ...s, lines: counts.get(s.id)?.lines ?? 0, players: counts.get(s.id)?.players ?? 0 }));
}

for (const [label, cut] of [
  ['LAST Tuesday', PREV_CUT],
  ['THIS Tuesday', NOW_CUT],
]) {
  console.log(`\n=== 5. odds the board could read as of ${z(cut)} (${label}) ===`);
  const list = await safe(`odds ${label}`, () => oddsAsOf(cut));
  let totalLines = 0;
  let totalPlayers = 0;
  for (const s of list ?? []) {
    totalLines += s.lines;
    totalPlayers += s.players;
    console.log(`  kickoff ${z(s.game_start)}  bought ${z(s.fetched_at)}  ${String(s.lines).padStart(4)} player lines, ${String(s.players).padStart(3)} players  event ${short(s.event_id)}`);
  }
  console.log(`  ${(list ?? []).length} games with a snapshot; ${totalLines} player lines in all; ${totalPlayers} player-games priced`);
}

// ---------------------------------------------------------------- 6. the log
for (const [label, cut] of [
  ['LAST Tuesday', PREV_CUT],
  ['THIS Tuesday', NOW_CUT],
]) {
  const from = new Date(Date.parse(cut) - 30 * 3_600_000).toISOString();
  console.log(`\n=== 6. odds purchases ${z(from)} to ${z(cut)} (${label}) ===`);
  const log = await safe(`log ${label}`, () =>
    select(`SELECT at, source, entities, outcome, reason FROM vegas_usage_log WHERE at >= '${from}' AND at <= '${cut}' ORDER BY at`),
  );
  for (const r of log ?? []) {
    console.log(`  ${z(r.at)}  ${String(r.source).padEnd(8)} ${String(r.outcome).padEnd(8)} entities=${r.entities}  ${String(r.reason ?? '').slice(0, 100)}`);
  }
  if (log && log.length === 0) console.log('  (none)');
}

// ------------------------------------------------------ 7. the unscored player
console.log(`\n=== 7. ${FOCUS_FIRST}. ${FOCUS_LAST}, in each place the board looks ===`);
const found = await safe('player', () =>
  select(
    `SELECT id, full_name, team, position, status, active FROM players WHERE last_name = '${FOCUS_LAST.replace(/'/g, "''")}' AND first_name LIKE '${FOCUS_FIRST.replace(/'/g, "''")}%'`,
  ),
);
for (const p of found ?? []) {
  console.log(`  player: ${p.full_name} id ${p.id} ${p.position} ${p.team} status ${p.status ?? '-'} active ${p.active}`);
  const props = await safe('his props', () =>
    select(
      `SELECT s.fetched_at, s.game_start, s.event_id, COUNT(*) AS lines FROM player_props pp JOIN prop_snapshots s ON s.id = pp.snapshot_id WHERE pp.player_id = '${p.id}' GROUP BY s.id ORDER BY s.fetched_at DESC LIMIT 6`,
    ),
  );
  console.log(`  odds lines on file (newest six snapshots): ${props && props.length ? '' : 'none'}`);
  for (const r of props ?? []) console.log(`     bought ${z(r.fetched_at)}  kickoff ${z(r.game_start)}  ${r.lines} lines`);
  const pub = await safe('his published', () =>
    select(`SELECT week, pts_ppr, pts_half_ppr, pts_std, fetched_at FROM sleeper_weekly_projections WHERE season = '${season}' AND player_id = '${p.id}' ORDER BY week DESC LIMIT 4`),
  );
  console.log(`  published projections on file: ${pub && pub.length ? '' : 'none'}`);
  for (const r of pub ?? []) console.log(`     week ${r.week}: PPR ${r.pts_ppr}  half ${r.pts_half_ppr}  std ${r.pts_std}  stored ${z(r.fetched_at)}`);
  const trend = await safe('his trending', () =>
    select(`SELECT captured_at, rank, count FROM trending_snapshots WHERE trend_type = 'add' AND player_id = '${p.id}' ORDER BY captured_at DESC LIMIT 3`),
  );
  for (const r of trend ?? []) console.log(`  trending add rank ${r.rank} (${r.count}) captured ${z(r.captured_at)}`);
}
if (found && found.length === 0) console.log('  no such player in the table');

// ------------------------------------------- 8. can the board read his number?
console.log('\n=== 8. can the board read a published number for him? ===');
const { buildScoringProfile } = await import('../src/core/sleeper/scoring.ts');
const { sleeperScoringKey, publishedRefusal } = await import('../src/core/sleeper/weeklyProjections.ts');
const lg = await safe('league settings', () => select('SELECT scoring_settings_json, roster_positions_json FROM leagues WHERE is_selected = 1 LIMIT 1'));
if (lg?.[0]) {
  const scoring = JSON.parse(lg[0].scoring_settings_json || '{}');
  const profile = buildScoringProfile(scoring, JSON.parse(lg[0].roster_positions_json || '[]'));
  const shown = ['pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td', 'fum_lost', 'bonus_rec_te'].map((k) => `${k}=${scoring[k] ?? '(unset)'}`);
  console.log(`  scoring: ${shown.join('  ')}`);
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
    console.log(`  ${pos}: key ${sleeperScoringKey(profile, pos) ?? 'NONE'}  refusal: ${publishedRefusal(profile, pos) ?? '(none)'}`);
  }
}
for (const p of found ?? []) {
  const mk = await safe('his markets', () =>
    select(
      `SELECT pp.market, pp.line, pp.over_price, pp.implied_probability, pp.book_count FROM player_props pp WHERE pp.snapshot_id = (SELECT s.id FROM player_props q JOIN prop_snapshots s ON s.id = q.snapshot_id WHERE q.player_id = '${p.id}' ORDER BY s.fetched_at DESC LIMIT 1) AND pp.player_id = '${p.id}'`,
    ),
  );
  console.log(`  his newest odds lines: ${(mk ?? []).map((m) => `${m.market} ${m.line ?? '-'} (${m.book_count} books)`).join('; ') || 'none'}`);
}
if (board) {
  const ids = (board.unknowns ?? []).map((u) => u.playerId);
  console.log(`  unknown rows on the board: ${JSON.stringify((board.unknowns ?? []).map((u) => ({ ...u, reasons: undefined })))}`);
  console.log(`  unknown row reasons: ${JSON.stringify((board.unknowns ?? []).map((u) => u.reasons ?? u.trending ?? null))}`);
  void ids;
}
