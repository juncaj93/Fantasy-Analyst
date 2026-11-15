/**
 * Round 28 (props reads): the round's one combined production check.
 *
 * Reads only. No odds are bought, nothing is written.
 *
 *   1. The production SHA (`/api/health`).
 *   2. Rows read and written per UTC day, this database and the account, last
 *      8 days (Cloudflare analytics, reads no database rows).
 *   3. Rows read per hour, last 30 hours, Eastern (analytics).
 *   4. The per-game lines read (`PropsRepo.currentForEvent`) by statement over
 *      the last 30 hours: the old form (`AND scope = 'week'`) and the new
 *      (`AND +scope = 'week'`), calls and rows per call (analytics).
 *   5. Same numbers, live: for the game with the most stored looks this week,
 *      the old and the new per-game read are both run (D1 SELECTs; the old one
 *      walks every weekly line once, about 50,000 rows), their D1 `rows_read`
 *      printed, and the newest line per player and market compared, with ten
 *      players listed (Alex's roster first, then rostered elsewhere, then free
 *      agents).
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (Probe workflow). STEPS: comma list of
 * sha,totals,hours,statements,live (empty runs all).
 */

import { createHash } from 'node:crypto';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID || null;
const STEPS = new Set(String(process.env.STEPS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const want = (s) => STEPS.size === 0 || STEPS.has(s);

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const et = (iso) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const heading = (t) => console.log(`\n## ${t}`);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

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
async function graphql(query, variables) {
  const res = await cf('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { a: await account(), ...variables } }) });
  if (res.body?.errors?.length) throw new Error(res.body.errors.map((e) => e.message).join(' | '));
  return res.body?.data?.viewer?.accounts?.[0] ?? {};
}
let DB_ID = null;
let probeRows = 0;
async function sql(text) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error('read-only');
  const res = await cf(`/accounts/${await account()}/d1/database/${DB_ID}/query`, { method: 'POST', body: JSON.stringify({ sql: text }) });
  const result = res.body?.result?.[0];
  if (!result) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body?.errors ?? '').slice(0, 200)}`);
  const read = Number(result.meta?.rows_read ?? 0);
  probeRows += read;
  return { rows: result.results ?? [], read };
}

console.log(`Round 28 props reads probe, started ${et(new Date().toISOString())} ET`);
if (!TOKEN) {
  console.log('No CLOUDFLARE_API_TOKEN: nothing to do.');
  process.exit(0);
}
DB_ID = (await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`)).body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;
console.log(`database fantasy_analyst: ${DB_ID ?? 'not found'}`);

/* --------------------------------------------------------------------- sha */
if (want('sha')) {
  heading('Production');
  const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`  live revision ${health?.release?.gitSha ?? '?'}`);
}

/* ------------------------------------------------------------------ totals */
if (want('totals')) {
  heading('Rows per UTC day (resets 7:00 PM ET). Caps: 5,000,000 read, 100,000 written');
  try {
    const from = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const acct = await graphql(
      `query Q($a: String!, $from: Date!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $from }) {
          dimensions { date databaseId } sum { rowsRead rowsWritten } } } } }`,
      { from },
    );
    const byDate = new Map();
    for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
      const v = byDate.get(g.dimensions.date) ?? { read: 0, written: 0, mineRead: 0, mineWritten: 0 };
      v.read += Number(g.sum.rowsRead);
      v.written += Number(g.sum.rowsWritten);
      if (g.dimensions.databaseId === DB_ID) {
        v.mineRead += Number(g.sum.rowsRead);
        v.mineWritten += Number(g.sum.rowsWritten);
      }
      byDate.set(g.dimensions.date, v);
    }
    console.log('  date        account read   (%)  account written  (%)   app read     app written');
    for (const [d, v] of [...byDate].sort()) {
      console.log(
        `  ${d} ${n(v.read).padStart(13)} ${(v.read / 50_000).toFixed(1).padStart(5)} ${n(v.written).padStart(15)} ${(v.written / 1_000).toFixed(1).padStart(5)} ${n(v.mineRead).padStart(11)} ${n(v.mineWritten).padStart(11)}`,
      );
    }
  } catch (err) {
    console.log(`  totals failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------- hours */
if (want('hours') && DB_ID) {
  heading('App rows per hour, last 30 hours (Eastern)');
  try {
    const now = new Date();
    const from = new Date(Math.floor((now.getTime() - 30 * 3_600_000) / 3_600_000) * 3_600_000).toISOString();
    const acct = await graphql(
      `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 2000, filter: { datetimeHour_geq: $from, datetimeHour_leq: $to }) {
          dimensions { databaseId datetimeHour } sum { rowsRead rowsWritten } } } } }`,
      { from, to: now.toISOString() },
    );
    const mine = (acct.d1AnalyticsAdaptiveGroups ?? []).filter((g) => g.dimensions.databaseId === DB_ID);
    for (const g of mine.sort((a, b) => a.dimensions.datetimeHour.localeCompare(b.dimensions.datetimeHour))) {
      console.log(`  ${et(g.dimensions.datetimeHour).padEnd(20)} read ${n(g.sum.rowsRead).padStart(10)}  written ${n(g.sum.rowsWritten).padStart(7)}`);
    }
  } catch (err) {
    console.log(`  hours failed: ${err.message}`);
  }
}

/* -------------------------------------------------------------- statements */
if (want('statements') && DB_ID) {
  heading('The per-game lines read, last 30 hours (sampled by statement; check against the hours above)');
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 3_600_000).toISOString();
    const acct = await graphql(
      `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
          count dimensions { query databaseId } sum { rowsRead } } } } }`,
      { from, to: now.toISOString() },
    );
    const agg = new Map();
    let all = 0;
    for (const r of acct.d1QueriesAdaptiveGroups ?? []) {
      if (r.dimensions?.databaseId && r.dimensions.databaseId !== DB_ID) continue;
      const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
      all += Number(r.sum?.rowsRead ?? 0);
      if (!/^SELECT \* FROM player_props WHERE snapshot_id IN/.test(q)) continue;
      const form = q.includes('+scope') ? 'new (+scope)' : 'old (scope)';
      const v = agg.get(form) ?? { calls: 0, read: 0 };
      v.calls += Number(r.count ?? 0);
      v.read += Number(r.sum?.rowsRead ?? 0);
      agg.set(form, v);
    }
    console.log(`  all statements, app database: ${n(all)} rows read`);
    for (const [form, v] of agg) {
      console.log(`  ${form.padEnd(14)} ${String(v.calls).padStart(5)} calls  ${n(v.read).padStart(11)} rows  ${n(Math.round(v.read / Math.max(1, v.calls))).padStart(8)} a call  (${((100 * v.read) / Math.max(1, all)).toFixed(1)}% of the app)`);
    }
    if (agg.size === 0) console.log('  no per-game reads in the window');
  } catch (err) {
    console.log(`  statements failed: ${err.message}`);
  }
}

/* -------------------------------------------------------------------- live */
if (want('live') && DB_ID) {
  heading('Same numbers, live: old per-game read against the new, one game');
  try {
    const now = Date.now();
    const from = new Date(now - 5 * 86_400_000).toISOString();
    const to = new Date(now + 3 * 86_400_000).toISOString();
    // Alex's roster and everyone rostered, from the selected league (about ten rows).
    const rosters = (await sql(`SELECT is_mine, players_json FROM rosters WHERE league_id = (SELECT id FROM leagues WHERE is_selected = 1 LIMIT 1)`)).rows;
    const mine = new Set();
    const rostered = new Set();
    for (const r of rosters) {
      let ids = [];
      try {
        ids = JSON.parse(r.players_json);
      } catch {
        /* skip */
      }
      for (const id of ids) (Number(r.is_mine) === 1 ? mine : rostered).add(String(id));
    }
    console.log(`  rosters read: ${rosters.length} (Alex ${mine.size} players, others ${rostered.size})`);

    // This week's games with their looks (window index).
    const looks = (
      await sql(
        `SELECT id, event_id, fetched_at, json_extract(raw_json, '$.delta') AS delta FROM prop_snapshots
          WHERE scope = 'week' AND game_start >= ${lit(from)} AND game_start <= ${lit(to)}`,
      )
    ).rows;
    const byEvent = new Map();
    for (const s of looks) {
      const list = byEvent.get(s.event_id) ?? [];
      list.push(s);
      byEvent.set(s.event_id, list);
    }
    // Eligible looks, newest first, back to the newest full copy (PropsRepo.eligibleSnapshots).
    const eligible = (list) => {
      const sorted = [...list].sort((a, b) => String(b.fetched_at).localeCompare(String(a.fetched_at)) || b.id - a.id);
      const out = [];
      for (const s of sorted) {
        out.push(s);
        if (!(s.delta === 1 || s.delta === true || s.delta === 'true')) break;
      }
      return out;
    };
    const ranked = [...byEvent].map(([id, list]) => ({ id, ids: eligible(list).map((s) => Number(s.id)) })).sort((a, b) => b.ids.length - a.ids.length);
    const game = ranked[0];
    if (!game || game.ids.length < 2) {
      console.log('  no game with two or more looks this week; nothing to compare');
    } else {
      console.log(`  game ${game.id}: ${game.ids.length} eligible looks (of ${byEvent.get(game.id).length} stored)`);
      const inList = game.ids.join(',');
      const oldQ = await sql(`SELECT * FROM player_props WHERE snapshot_id IN (${inList}) AND scope = 'week'`);
      const newQ = await sql(`SELECT * FROM player_props WHERE snapshot_id IN (${inList}) AND +scope = 'week'`);
      const order = new Map(game.ids.map((id, i) => [id, i]));
      const newest = (rows) => {
        const m = new Map();
        for (const r of rows) {
          const k = `${String(r.source_player_name ?? '').toLowerCase()}|${r.market}`;
          const h = m.get(k);
          const ra = order.get(Number(r.snapshot_id)) ?? Infinity;
          const rb = h ? (order.get(Number(h.snapshot_id)) ?? Infinity) : Infinity;
          if (!h || ra < rb || (ra === rb && Number(r.id) > Number(h.id))) m.set(k, r);
        }
        return m;
      };
      const fp = (m) =>
        createHash('sha1')
          .update([...m.values()].map((r) => JSON.stringify(r)).sort().join('\n'))
          .digest('hex')
          .slice(0, 12);
      const a = newest(oldQ.rows);
      const b = newest(newQ.rows);
      console.log(`  old read: ${n(oldQ.read)} rows read, ${oldQ.rows.length} rows back, newest lines ${a.size}, fingerprint ${fp(a)}`);
      console.log(`  new read: ${n(newQ.read)} rows read, ${newQ.rows.length} rows back, newest lines ${b.size}, fingerprint ${fp(b)}`);
      console.log(`  same lines: ${fp(a) === fp(b) && a.size === b.size ? 'YES' : 'NO'}`);

      // Ten players: Alex's first, then rostered elsewhere (Compare, opponent), then free agents (Waivers).
      const players = new Map();
      for (const r of b.values()) {
        if (r.player_id == null || r.consensus_method === 'none') continue;
        const p = players.get(r.player_id) ?? { name: r.source_player_name, lines: [] };
        p.lines.push(r);
        players.set(String(r.player_id), p);
      }
      const tag = (id) => (mine.has(id) ? 'Alex' : rostered.has(id) ? 'rostered' : 'free agent');
      const groups = ['Alex', 'rostered', 'free agent'].map((t) => [...players.keys()].filter((id) => tag(id) === t).sort());
      const ten = [];
      for (const [want, g] of [[4, groups[0]], [3, groups[1]], [3, groups[2]]]) ten.push(...g.slice(0, want));
      for (const g of groups) for (const id of g) if (ten.length < 10 && !ten.includes(id)) ten.push(id);
      const show = (m, id) =>
        [...m.values()]
          .filter((r) => String(r.player_id) === id && r.consensus_method !== 'none')
          .map((r) => `${r.market}=${r.line ?? r.over_price}`)
          .sort()
          .join(' ');
      for (const id of ten) {
        const before = show(a, id);
        const after = show(b, id);
        console.log(`  ${tag(id).padEnd(10)} ${String(players.get(id).name).padEnd(24)} ${before === after ? 'same' : 'DIFF'}  ${after}`);
      }
    }
  } catch (err) {
    console.log(`  live failed: ${err.message}`);
  }
}

heading('This probe');
console.log(`  rows read by this probe's own SQL: ${n(probeRows)}`);
console.log(`  finished ${et(new Date().toISOString())} ET`);
