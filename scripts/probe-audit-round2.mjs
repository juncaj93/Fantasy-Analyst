/**
 * The site audit's one combined production read (second audit, October 2026).
 *
 * Reads every season screen once (the Compare sheet through its picker), and
 * Sleeper's own public roster and matchup feeds, then prints:
 *
 *   1. each request's status, size and time;
 *   2. the same player's weekly number on every screen that shows one, and
 *      every disagreement between them;
 *   3. the IR check: who sits in an injured-reserve slot, and whether any
 *      screen starts or suggests him;
 *   4. D1's own per-statement read counts for the last 24 hours, so rows per
 *      screen load can be built from the statements each screen runs;
 *   5. the whole set of responses as one gzipped blob, for offline replay.
 *
 * GET only. Nothing that needs a login, no odds bought: none of these reads
 * calls the provider.
 *
 *   node scripts/probe-audit-round2.mjs
 */

import { gzipSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app/v1';
const out = {};

async function call(path, init) {
  const t0 = Date.now();
  const res = await fetch(`${APP}${path}`, init);
  const body = await res.text();
  const key = init?.body ? `POST ${path} ${init.body}` : path;
  out[key] = { status: res.status, body };
  console.log(`${res.status} ${key.slice(0, 120)} (${body.length} bytes, ${Date.now() - t0} ms)`);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function sleeper(path) {
  const res = await fetch(`${SLEEPER}${path}`);
  const body = await res.text();
  out[`sleeper:${path}`] = { status: res.status, body };
  return res.ok ? JSON.parse(body) : null;
}

const started = new Date();
console.log(`## Requests (started ${started.toISOString()})`);
const health = await call('/api/health');
console.log(`deployed sha: ${health?.sha ?? health?.releaseSha ?? JSON.stringify(health).slice(0, 120)}`);
const leagues = await call('/api/leagues');
const league = (leagues?.leagues ?? []).find((l) => l.isSelected) ?? null;
if (!league) {
  console.log('no selected league');
  process.exit(0);
}
const id = encodeURIComponent(league.id);

const screens = {
  roster: `/api/leagues/${id}/roster`,
  lineup: `/api/leagues/${id}/lineup`,
  waivers: `/api/leagues/${id}/waivers`,
  matchup: `/api/leagues/${id}/matchup`,
  bench: `/api/leagues/${id}/bench`,
  plan: `/api/leagues/${id}/plan`,
  trades: '/api/trades',
  smart: '/api/trades/smart',
  checkTeams: `/api/leagues/${id}/trades/check/teams`,
  poolMine: `/api/leagues/${id}/compare-pool?tab=mine`,
  poolWaivers: `/api/leagues/${id}/compare-pool?tab=waivers`,
  players: `/api/players?q=&leagueId=${id}&limit=60&offset=0`,
  overview: '/api/overview',
  setup: '/api/setup/status',
  dataHealth: '/api/data-health',
};
const body = {};
for (const [name, path] of Object.entries(screens)) body[name] = await call(path);

/*
 * The Compare sheet's own POST needs an unlocked session, so the sheet is read
 * through its picker (`compare-pool`), whose rows carry the same weekly number.
 */
const lineup = body.lineup ?? {};
const mine = [...(lineup.starters ?? []), ...(lineup.bench ?? []), ...(lineup.undecidable ?? [])];

/* Sleeper's own view: who is in an IR slot, and what the matchup feed lists. */
const sleeperLeague = league.sleeperLeagueId ?? league.id;
const state = await sleeper('/state/nfl');
const week = state?.display_week ?? state?.week ?? null;
const rosters = (await sleeper(`/league/${sleeperLeague}/rosters`)) ?? [];
const matchups = week ? ((await sleeper(`/league/${sleeperLeague}/matchups/${week}`)) ?? []) : [];

/* --- 2. One player, every screen ------------------------------------------ */

const NUMERIC = /^(projection|projectedFinal|points|score|gain|lineupGain|slotValue)$/;
const seen = new Map();
function note(pid, where, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  if (!seen.has(pid)) seen.set(pid, {});
  seen.get(pid)[where] = Math.round(value * 100) / 100;
}
function walk(node, path, screen) {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, `${path}[]`, screen);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const pid = node.playerId ?? null;
  if (pid) {
    for (const [k, v] of Object.entries(node)) {
      if (NUMERIC.test(k)) note(pid, `${screen}${path}.${k}`, v);
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.points === 'number') note(pid, `${screen}${path}.${k}.points`, v.points);
    }
  }
  for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, screen);
}
for (const [name, b] of Object.entries(body)) walk(b, '', name);

const names = new Map();
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (!node || typeof node !== 'object') return;
  if (node.playerId && node.name) names.set(node.playerId, node.name);
  Object.values(node).forEach(collect);
})(body);

console.log('\n## Every number per player (rostered first)');
const rosteredIds = new Set(mine.map((p) => p.playerId));
const order = [...seen.keys()].sort((a, b) => Number(rosteredIds.has(b)) - Number(rosteredIds.has(a)));
for (const pid of order) {
  const where = seen.get(pid);
  const keys = Object.keys(where);
  if (keys.length < 2) continue;
  console.log(`${pid} ${names.get(pid) ?? ''}${rosteredIds.has(pid) ? ' (mine)' : ''}`);
  for (const k of keys.sort()) console.log(`    ${where[k].toFixed(2).padStart(8)}  ${k}`);
}

/* --- 3. IR ---------------------------------------------------------------- */

console.log('\n## Injured reserve');
const myRosterId = rosters.find((r) => mine.some((p) => (r.players ?? []).includes(p.playerId)))?.roster_id ?? null;
for (const r of rosters) {
  const reserve = r.reserve ?? [];
  if (reserve.length === 0) continue;
  const m = matchups.find((x) => x.roster_id === r.roster_id);
  const listed = reserve.filter((pid) => (m?.players ?? []).includes(pid));
  const starting = reserve.filter((pid) => (m?.starters ?? []).includes(pid));
  console.log(
    `roster ${r.roster_id}${r.roster_id === myRosterId ? ' (mine)' : ''}: IR ${reserve.join(', ')}; in the matchup feed's players: ${listed.join(', ') || 'none'}; starting: ${starting.join(', ') || 'none'}`,
  );
}
const irIds = new Set(rosters.flatMap((r) => r.reserve ?? []));
for (const s of lineup.starters ?? []) if (irIds.has(s.playerId)) console.log(`!! Team starts IR player ${s.playerId}`);
const moves = JSON.stringify(body.matchup?.forecast?.decision ?? null);
for (const pid of irIds) if (moves.includes(`"${pid}"`)) console.log(`!! Matchup best move names IR player ${pid}`);

/* --- 4. D1 per statement ---------------------------------------------------- */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
if (TOKEN && ACCOUNT) {
  console.log('\n## D1 statements, last 24 hours (calls, rows read, per call)');
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3_600_000);
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
          count dimensions { query } sum { rowsRead } } } } }`,
      variables: { a: ACCOUNT, from: from.toISOString(), to: to.toISOString() },
    }),
  });
  const data = await res.json().catch(() => null);
  const rows = data?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
  if (data?.errors?.length) console.log(`analytics error: ${data.errors.map((e) => e.message).join(' | ')}`);
  const agg = new Map();
  for (const r of rows) {
    const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
    const hit = agg.get(q) ?? { calls: 0, read: 0 };
    hit.calls += Number(r.count ?? 0);
    hit.read += Number(r.sum?.rowsRead ?? 0);
    agg.set(q, hit);
  }
  /* What this probe itself cost: D1's own count from its start, after the analytics lag. */
  await new Promise((r) => setTimeout(r, 240_000));
  const own = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query U($a: String!, $from: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 100, filter: { datetime_geq: $from }) { sum { rowsRead } } } } }`,
      variables: { a: ACCOUNT, from: started.toISOString() },
    }),
  }).then((r) => r.json()).catch(() => null);
  const ownRows = (own?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []).reduce((a, g) => a + Number(g.sum?.rowsRead ?? 0), 0);
  console.log(`rows read since this probe started (all traffic, including the app's own jobs): ${ownRows}`);

  let total = 0;
  for (const [, v] of agg) total += v.read;
  console.log(`total rows read in the window: ${total}`);
  for (const [q, v] of [...agg].sort((a, b) => b[1].read - a[1].read).slice(0, 120)) {
    console.log(`${String(v.calls).padStart(7)} ${String(v.read).padStart(10)} ${String(Math.round(v.read / Math.max(1, v.calls))).padStart(8)}  ${q.slice(0, 400)}`);
  }
}

/* --- 5. Everything, for replay --------------------------------------------- */

const blob = gzipSync(Buffer.from(JSON.stringify(out))).toString('base64');
console.log('\n=== SNAPSHOT BEGIN ===');
for (let i = 0; i < blob.length; i += 4000) console.log(blob.slice(i, i + 4000));
console.log('=== SNAPSHOT END ===');
