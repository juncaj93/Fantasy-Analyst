/**
 * Round 23 (Vegas build): the round's combined production check, after step 2.
 *
 * Reads only. No odds are bought (nothing here calls an odds provider).
 *
 *   1. The production SHA (`/api/health`).
 *   2. Team's lineup as the app serves it (`/api/leagues/:id/lineup`, a public
 *      read): each player's Game total and Team points, the two Vegas numbers
 *      Compare shows, and whether his number is Vegas-priced. The same rows the
 *      Team and Compare screens draw at every phone width.
 *   3. The stored odds since step 2: looks written, lines written per look,
 *      books behind each line, game lines and their books (D1 SELECTs, small).
 *   4. Ladd McConkey's current lines (the Round 23 case).
 *   5. Rows written: account and fantasy_analyst per UTC day, and the odds
 *      statements' share over the last 24 hours (Cloudflare analytics, free).
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (Probe workflow). STEP2_AT optional:
 * when step 2 went live (ISO), so only its looks are counted.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID || null;
const STEP2_AT = process.env.STEP2_AT || new Date(Date.now() - 24 * 3_600_000).toISOString();

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const et = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

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
  probeRows += Number(result.meta?.rows_read ?? 0);
  return result.results ?? [];
}
const getJson = async (path) => {
  const res = await fetch(`${APP}${path}`, { headers: { 'cache-control': 'no-cache' } });
  return res.json().catch(() => null);
};

console.log(`Round 23 check, ${et(new Date().toISOString())} ET. Step 2 counted from ${et(STEP2_AT)} ET.`);
const health = await getJson('/api/health');
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

// ------------------------------------------------------------ 2. Team / Compare
heading('2. Team lineup: Game total and Team points per player (what Compare shows)');
try {
  const leagues = await getJson('/api/leagues');
  const list = Array.isArray(leagues) ? leagues : (leagues?.leagues ?? []);
  const league = list.find((l) => l.selected) ?? list[0];
  const lineup = league ? await getJson(`/api/leagues/${league.id}/lineup`) : null;
  const evaluations = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.evaluations)) evaluations.push(...v.evaluations);
    for (const k of Object.keys(v)) if (k !== 'evaluations' && typeof v[k] === 'object') walk(v[k]);
  };
  walk(lineup);
  const seen = new Set();
  let priced = 0;
  let withLine = 0;
  for (const e of evaluations) {
    const id = e.playerId ?? e.player?.id ?? e.name;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = e.name ?? e.player?.name ?? id;
    const g = e.gameLine;
    const basis = e.decision?.basis ?? '?';
    if (basis === 'market') priced++;
    if (g?.total != null) withLine++;
    console.log(`  ${String(name).padEnd(24)} ${String(e.position ?? '').padEnd(4)} total ${g?.total ?? '-'}  team pts ${g?.teamPoints ?? '-'}  number: ${basis}`);
  }
  console.log(`  players: ${seen.size}; with a game total: ${withLine}; Vegas-priced: ${priced}`);
  const bad = evaluations.filter((e) => e.gameLine?.total != null && (e.gameLine.total < 25 || e.gameLine.total > 70));
  console.log(bad.length ? `  CHECK: ${bad.length} game total(s) outside 25 to 70` : '  every game total is between 25 and 70');
} catch (err) {
  console.log(`lineup read failed: ${err.message}`);
}

if (!TOKEN) {
  console.log('\nNo Cloudflare token: stored odds and writes not read.');
  process.exit(0);
}
DB_ID = (await cf(`/accounts/${await account()}/d1/database?name=fantasy_analyst`)).body?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid ?? null;

// ------------------------------------------------------------ 3. stored odds
heading('3. Looks since step 2, and books behind each line');
try {
  const looks = await sql(`
    SELECT ps.id, ps.event_id, ps.provider, ps.fetched_at, ps.game_start,
           json_extract(ps.raw_json, '$.delta') AS delta, json_extract(ps.raw_json, '$.topUp') AS top_up,
           (SELECT COUNT(*) FROM player_props pp WHERE pp.snapshot_id = ps.id) AS lines
      FROM prop_snapshots ps
     WHERE ps.scope = 'week' AND ps.fetched_at >= '${STEP2_AT.replace(/'/g, '')}'
     ORDER BY ps.fetched_at`);
  const delta = looks.filter((l) => l.delta);
  const written = delta.reduce((s, l) => s + Number(l.lines), 0);
  console.log(`  looks: ${looks.length} (${delta.length} change-only, ${looks.filter((l) => l.top_up).length} top-up)`);
  console.log(`  player lines written: ${written} (${delta.length ? (written / delta.length).toFixed(1) : '-'} a look)`);
  for (const l of looks.slice(-12)) console.log(`    ${et(l.fetched_at)} ${l.provider} ${l.event_id} kickoff ${et(l.game_start)}: ${l.lines} line(s) written`);

  const books = await sql(`
    SELECT pp.book_count AS books, pp.consensus_method AS method, COUNT(*) AS n
      FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
     WHERE ps.scope = 'week' AND ps.fetched_at >= '${STEP2_AT.replace(/'/g, '')}'
     GROUP BY pp.book_count, pp.consensus_method ORDER BY pp.book_count`);
  console.log('  books behind each written line:', books.map((b) => `${b.books} (${b.method}): ${b.n}`).join(', ') || '-');

  const games = await sql(`
    SELECT event_id, kickoff, home_team, away_team, game_total, spread, spread_team, lines_seen_at
      FROM vegas_events WHERE kickoff >= datetime('now') AND kickoff <= datetime('now', '+6 days') ORDER BY kickoff`);
  const stored = await sql(`SELECT value_json FROM settings WHERE key = 'vegas.gameBooks'`);
  const gb = stored[0] ? JSON.parse(stored[0].value_json) : {};
  console.log(`  tracked games: ${games.length}`);
  for (const g of games) {
    const entry = gb[g.event_id];
    const bk = (entry?.books ?? []).map((b) => `${b.book}${b.source && b.source !== 'sportsgameodds' ? `(${b.source})` : ''} ${b.total ?? '-'}/${b.spread ?? '-'}`).join(', ');
    console.log(`    ${et(g.kickoff)} ${[g.home_team, g.away_team].filter(Boolean).join('/')}: total ${g.game_total ?? '-'}, ${g.spread_team ?? ''} ${g.spread ?? '-'} (changed ${et(g.lines_seen_at)}) | ${bk || 'no books yet'}`);
  }
  const extra = await sql(`SELECT value_json FROM settings WHERE key = 'vegas.extraSources'`);
  console.log(`  extra sources: ${extra[0]?.value_json ?? 'not run (no keys)'}`);
} catch (err) {
  console.log(`stored odds failed: ${err.message}`);
}

// ------------------------------------------------------------ 4. McConkey
heading('4. Ladd McConkey');
try {
  const rows = await sql(`
    SELECT pp.market, pp.line, pp.book_count, pp.consensus_method, pp.implied_probability, ps.fetched_at, ps.provider
      FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
     WHERE pp.player_id = '11635' AND ps.scope = 'week' AND ps.game_start >= datetime('now', '-1 day')
     ORDER BY ps.fetched_at DESC, pp.id DESC LIMIT 30`);
  const newest = new Map();
  for (const r of rows) if (!newest.has(r.market)) newest.set(r.market, r);
  for (const r of newest.values()) {
    console.log(`  ${r.market}: ${r.consensus_method === 'none' ? 'gone' : r.line ?? `${Math.round((r.implied_probability ?? 0) * 1000) / 10}%`} from ${r.book_count} book(s), ${r.consensus_method}, written ${et(r.fetched_at)}`);
  }
  const has = (m) => newest.has(m) && newest.get(m).consensus_method !== 'none';
  console.log(`  priced (yards, catches and a TD price all present): ${has('receiving_yards') && has('receptions') && has('anytime_td') ? 'yes' : 'no'}`);
} catch (err) {
  console.log(`McConkey read failed: ${err.message}`);
}

// ------------------------------------------------------------ 5. writes
heading('5. Rows written (UTC day; resets 7:00 PM ET). Cap: 100,000 a day, account-wide');
try {
  const from = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  const acct = await graphql(
    `query Q($a: String!, $from: Date!) { viewer { accounts(filter: { accountTag: $a }) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $from }) { dimensions { date databaseId } sum { rowsRead rowsWritten } } } } }`,
    { from },
  );
  const byDate = new Map();
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    const hit = byDate.get(g.dimensions.date) ?? { all: 0, mine: 0, read: 0 };
    hit.all += Number(g.sum.rowsWritten);
    hit.read += Number(g.sum.rowsRead);
    if (g.dimensions.databaseId === DB_ID) hit.mine += Number(g.sum.rowsWritten);
    byDate.set(g.dimensions.date, hit);
  }
  for (const [d, v] of [...byDate].sort()) console.log(`  ${d}: account ${n(v.all)} written (${((v.all / 100_000) * 100).toFixed(1)}%), fantasy_analyst ${n(v.mine)}; read ${n(v.read)}`);

  const to = new Date();
  const since = new Date(to.getTime() - 24 * 3_600_000);
  const q = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsWritten_DESC]) {
        count dimensions { query databaseId } sum { rowsWritten } } } } }`,
    { from: since.toISOString(), to: to.toISOString() },
  );
  let odds = 0;
  let all = 0;
  for (const r of q.d1QueriesAdaptiveGroups ?? []) {
    if (DB_ID && r.dimensions?.databaseId !== DB_ID) continue;
    const w = Number(r.sum?.rowsWritten ?? 0);
    all += w;
    const text = String(r.dimensions?.query ?? '');
    if (/player_props|prop_snapshots|vegas_events|vegas\.gameBooks|vegas\.extraSources|vegas_usage/.test(text)) odds += w;
  }
  console.log(`  last 24 hours, fantasy_analyst (sampled): ${n(all)} written, of which odds tables ${n(odds)}`);
} catch (err) {
  console.log(`writes failed: ${err.message}`);
}
console.log(`\nD1 rows read by this probe: ${n(probeRows)}`);
