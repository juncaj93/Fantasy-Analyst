/**
 * Round 27 (game-day inactives): the round's ONE production check. Reads only.
 *
 *   1. The production SHA (`/api/health`) and today's D1 rows before and after.
 *   2. Who was inactive in weeks 9 and 10 (nflverse weekly rosters, status INA),
 *      with each player's final injury report status and kickoff (nflverse).
 *   3. Which of them a team in Alex's league STARTED (Sleeper's documented
 *      matchups endpoint), and whether the team was Alex's.
 *   4. What the app stored about them: injury designation changes
 *      (`injury_events`) and every time the nflverse injury file changed
 *      (`injury_source_runs`, written only when the file changed) since Nov 5.
 *
 * No writes. No odds calls. Sleeper: matchups for two weeks, rosters, users.
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID, SLEEPER_LEAGUE_ID (Probe workflow).
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID || null;
const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SEASON = '2026';
const WEEKS = ['9', '10'];
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

const et = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '-';
const heading = (t) => console.log(`\n## ${t}`);

function rowsToday() {
  if (!TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 27 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function account() {
  if (ACCOUNT) return ACCOUNT;
  ACCOUNT = (await cf('/accounts')).body?.result?.[0]?.id ?? null;
  return ACCOUNT;
}
let DB_ID = null;
let probeRows = 0;
async function sql(text, params = []) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error('read-only');
  if (!DB_ID) {
    const list = await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`);
    DB_ID = list.body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;
    if (!DB_ID) throw new Error(`database not found (HTTP ${list.status})`);
  }
  const res = await cf(`/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, { method: 'POST', body: JSON.stringify({ sql: text, params }) });
  const result = res.body?.result?.[0];
  if (!result) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body?.errors ?? '').slice(0, 200)}`);
  probeRows += Number(result.meta?.rows_read ?? 0);
  return result.results ?? [];
}

/** A small CSV reader: quoted fields, commas inside quotes. Enough for nflverse files. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
async function csv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { rows: parseCsv(await res.text()), modified: res.headers.get('last-modified') };
}
async function sleeper(path) {
  const res = await fetch(`https://api.sleeper.app/v1${path}`);
  return res.ok ? res.json() : null;
}

console.log(`Round 27 probe, ${et(new Date().toISOString())} ET`);
const before = rowsToday();
console.log(`D1 rows read today before: ${before ?? 'unknown'}`);
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

// ------------------------------------------------------------ 2. inactives
heading('Inactives, weeks 9 and 10 (nflverse weekly rosters, status INA)');
const [weekly, injuries, games] = await Promise.all([
  csv(`${RELEASE}/weekly_rosters/roster_weekly_${SEASON}.csv`),
  csv(`${RELEASE}/injuries/injuries_${SEASON}.csv`),
  csv(`${RELEASE}/schedules/games.csv`),
]);
console.log(`weekly rosters file last changed ${et(weekly.modified)} ET; injury file ${et(injuries.modified)} ET`);
const report = new Map(injuries.rows.map((r) => [`${r.week}|${r.gsis_id}`, r]));
const kickoff = new Map();
for (const g of games.rows) {
  if (g.season !== SEASON || !WEEKS.includes(g.week)) continue;
  const when = `${g.weekday.slice(0, 3)} ${g.gameday.slice(5)} ${g.gametime}`;
  kickoff.set(`${g.week}|${g.home_team}`, when);
  kickoff.set(`${g.week}|${g.away_team}`, when);
}
const inactive = new Map();
for (const r of weekly.rows) {
  if (!WEEKS.includes(r.week) || r.status !== 'INA' || !SKILL.has(r.position) || !r.sleeper_id) continue;
  const rep = report.get(`${r.week}|${r.gsis_id}`);
  inactive.set(`${r.week}|${r.sleeper_id}`, {
    week: r.week,
    sleeperId: r.sleeper_id,
    name: r.full_name,
    team: r.team,
    pos: r.position,
    report: rep?.report_status || 'none',
    kickoff: kickoff.get(`${r.week}|${r.team}`) ?? '?',
  });
}
for (const w of WEEKS) {
  const list = [...inactive.values()].filter((x) => x.week === w);
  const flagged = list.filter((x) => x.report === 'Questionable');
  console.log(`week ${w}: ${list.length} skill players inactive, ${flagged.length} of them Questionable on the final report`);
  for (const x of flagged) console.log(`  Q -> inactive: ${x.name} (${x.pos} ${x.team}), kickoff ${x.kickoff} ET`);
}

// ------------------------------------------------------------ 3. league starters
heading("Started in Alex's league while inactive (Sleeper matchups)");
let leagueId = process.env.SLEEPER_LEAGUE_ID || '';
let mine = null;
try {
  const league = (await sql(`SELECT id, sleeper_league_id FROM leagues WHERE is_selected = 1 LIMIT 1`))[0];
  if (!leagueId) leagueId = league?.sleeper_league_id ?? '';
  if (league) mine = (await sql(`SELECT roster_id FROM rosters WHERE league_id = ? AND is_mine = 1 LIMIT 1`, [league.id]))[0]?.roster_id ?? null;
} catch (err) {
  console.log(`  league lookup failed: ${err.message}`);
}
const [users, rosters] = leagueId ? await Promise.all([sleeper(`/league/${leagueId}/users`), sleeper(`/league/${leagueId}/rosters`)]) : [null, null];
const owner = new Map((users ?? []).map((u) => [u.user_id, u.display_name]));
const team = new Map((rosters ?? []).map((r) => [r.roster_id, r.roster_id === mine ? 'ALEX' : owner.get(r.owner_id) ?? `roster ${r.roster_id}`]));
const startedInactive = [];
const rostered = [];
for (const w of WEEKS) {
  const matchups = leagueId ? await sleeper(`/league/${leagueId}/matchups/${w}`) : null;
  if (!matchups) { console.log(`  week ${w}: no matchups answer`); continue; }
  for (const m of matchups) {
    for (const id of m.players ?? []) {
      const hit = inactive.get(`${w}|${id}`);
      if (!hit) continue;
      const started = (m.starters ?? []).includes(id);
      const row = { ...hit, by: team.get(m.roster_id) ?? `roster ${m.roster_id}`, started, points: m.players_points?.[id] ?? null };
      (started ? startedInactive : rostered).push(row);
    }
  }
}
for (const x of startedInactive) console.log(`  STARTED wk${x.week}: ${x.name} (${x.pos} ${x.team}) by ${x.by}, report ${x.report}, kickoff ${x.kickoff} ET, scored ${x.points}`);
if (!startedInactive.length) console.log('  none started');
for (const x of rostered) console.log(`  benched wk${x.week}: ${x.name} by ${x.by}, report ${x.report}`);

// ------------------------------------------------------------ 4. what the app stored
heading('What the app stored about them');
const ids = [...new Set([...startedInactive, ...rostered].map((x) => x.sleeperId))];
try {
  if (ids.length) {
    const events = await sql(
      `SELECT player_id, week, kind, from_value, to_value, source, source_modified_at, detected_at
         FROM injury_events WHERE detected_at >= '2026-11-01' AND player_id IN (${ids.map(() => '?').join(',')})
        ORDER BY detected_at`,
      ids,
    );
    for (const e of events) console.log(`  ${e.player_id} wk${e.week} ${e.kind} ${e.from_value} -> ${e.to_value} (${e.source}) file ${et(e.source_modified_at)}, seen ${et(e.detected_at)}`);
    if (!events.length) console.log('  no injury changes stored for them since Nov 1');
    const now = await sql(`SELECT id, status, updated_at FROM players WHERE id IN (${ids.map(() => '?').join(',')})`, ids).catch((err) => {
      console.log(`  players read failed: ${err.message}`);
      return [];
    });
    for (const p of now) console.log(`  Sleeper status stored now: ${p.id} ${p.status ?? 'none'} (row changed ${et(p.updated_at)})`);
  }
  const runs = await sql(
    `SELECT fetched_at, published_at, outcome, rows_returned, latest_week FROM injury_source_runs WHERE fetched_at >= '2026-11-05' ORDER BY fetched_at`,
  );
  console.log(`  nflverse injury file changes seen since Nov 5: ${runs.length}`);
  for (const r of runs) console.log(`    file ${et(r.published_at)}, seen ${et(r.fetched_at)}, ${r.outcome}, week ${r.latest_week}, ${r.rows_returned} rows`);
} catch (err) {
  console.log(`  D1 read failed: ${err.message}`);
}

const after = rowsToday();
console.log(`\nprobe rows read (D1 meta): ${probeRows}; account today before ${before ?? '?'}, after ${after ?? '?'}`);
