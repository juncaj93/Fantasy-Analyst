/**
 * What a Waivers screen load reads from D1, statement by statement.
 *
 * Read-only: Cloudflare's GraphQL Analytics API, no SQL, no user data.
 *
 * Prints, for a 24-hour and a 2-hour window ending now, every SELECT the
 * Waivers endpoint issues (matched on the tables it reads) with its calls and
 * rows read per call, and the three reads the waiver tiers added: the
 * `settings` row for last week's points, the fixture read for bye weeks
 * (`nfl_schedule ... week >= ? AND week <= ? AND team IN`), and the
 * earlier-week projection read (`sleeper_weekly_projections ... week IN`).
 * Rows read per call is the number that survives a deploy in the middle of a
 * window, because it moves only when a statement does more or less work.
 *
 *   node scripts/probe-waiver-reads.mjs
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WINDOWS_HOURS = [24, 2];
/* The tables a Waivers load reads. */
const WAIVERS = /\b(leagues|rosters|prop_snapshots|player_props|settings|adp_snapshots|adp_rows|league_transactions|league_transaction_weeks|vegas_events|drafts|trending_snapshots|players|player_signal_cache|evidence_items|preseason_projection_snapshots|preseason_projections|manager_intel_profiles|sleeper_weekly_projections|player_injury_reports|player_usage_weeks|depth_chart_entries|nfl_schedule)\b/;
/*
 * The statements one Waivers load issues, by their opening words, as
 * `scripts/measure-api-budgets.ts` lists them on the seeded database. Summing
 * their rows a call gives an estimate of one load's cost (estimate: a batched
 * statement reads more or fewer rows with the size of its list).
 */
const WAIVER_LOAD = [
  'SELECT * FROM adp_snapshots WHERE source != ?',
  'SELECT * FROM drafts WHERE id = ?',
  'SELECT * FROM evidence_items WHERE player_id IN',
  'SELECT * FROM league_transaction_weeks WHERE league_id = ?',
  'SELECT * FROM leagues WHERE id = ?',
  'SELECT * FROM manager_intel_profiles WHERE league_id = ?',
  'SELECT * FROM player_signal_cache WHERE player_id IN',
  'SELECT * FROM player_usage_weeks WHERE season = ? AND player_id IN',
  'SELECT * FROM players WHERE id IN',
  'SELECT * FROM rosters WHERE league_id = ?',
  'SELECT * FROM vegas_events WHERE kickoff IS NOT NULL',
  'SELECT DISTINCT captured_at FROM depth_chart_entries',
  'SELECT captured_at, lookback_hours FROM trending_snapshots',
  'SELECT id FROM preseason_projection_snapshots',
  'SELECT p.id AS row_id, p.player_id, p.market',
  'SELECT payload_json FROM league_transactions',
  'SELECT player_id, source_player_name, adp, rank, match_status FROM adp_rows',
  'SELECT pp.* FROM player_props pp JOIN prop_snapshots ps',
  'SELECT pp.player_id AS player_id, ps.game_start',
  'SELECT provider, MAX(fetched_at) AS fetched_at, COUNT(DISTINCT event_id)',
  'SELECT r.* FROM player_injury_reports r',
  'SELECT season, week, team, opponent, home, kickoff, roof FROM nfl_schedule',
  'SELECT team, AVG(implied) AS implied',
  'SELECT value_json FROM settings WHERE key = ?',
  'select player_id, pts_std, pts_half_ppr, pts_ppr, publisher, defense_json from sleeper_weekly_projections',
  'select week, player_id, pts_std',
];

const NEW = [
  { label: 'fixture read for byes (new)', test: /nfl_schedule WHERE season = \? AND week >= \? AND week <= \? AND team IN/ },
  { label: 'earlier-week projections (new)', test: /sleeper_weekly_projections/i },
  { label: 'settings row (last week\'s points among them)', test: /FROM settings WHERE key = \?/ },
];

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}

async function account() {
  if (process.env.ACCOUNT_ID) return process.env.ACCOUNT_ID;
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => null);
  return body?.result?.[0]?.id ?? null;
}

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(async () => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

const ACCOUNT = await account();
if (!ACCOUNT) {
  console.error('Could not resolve the Cloudflare account id.');
  process.exit(1);
}

async function byQuery(hours) {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  const data = await graphql(
    `query Q($a: String!, $from: Time!, $to: Time!) {
       viewer { accounts(filter: { accountTag: $a }) {
         d1QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }, orderBy: [sum_rowsRead_DESC]) {
           dimensions { query }
           sum { rowsRead rowsWritten }
           count
         }
       } }
     }`,
    { a: ACCOUNT, from: from.toISOString(), to: to.toISOString() },
  );
  const out = new Map();
  for (const r of data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? []) {
    const q = String(r.dimensions?.query ?? '').replace(/\s+/g, ' ').trim();
    const hit = out.get(q) ?? { read: 0, written: 0, calls: 0 };
    hit.read += Number(r.sum?.rowsRead ?? 0);
    hit.written += Number(r.sum?.rowsWritten ?? 0);
    hit.calls += Number(r.count ?? 0);
    out.set(q, hit);
  }
  return { from, to, rows: [...out.entries()].map(([q, v]) => ({ q, ...v })) };
}

const n = (v) => Math.round(v).toLocaleString('en-GB');
for (const hours of WINDOWS_HOURS) {
  const { from, to, rows } = await byQuery(hours);
  console.log(`\n== last ${hours} h (${from.toISOString()} to ${to.toISOString()})`);
  console.log(`all queries: ${n(rows.reduce((a, r) => a + r.read, 0))} rows read`);
  console.log('\nthe reads the waiver tiers added');
  for (const watch of NEW) {
    for (const r of rows.filter((r) => watch.test.test(r.q) && /^SELECT/i.test(r.q))) {
      console.log(`  ${watch.label}: ${r.calls} calls, ${n(r.read / Math.max(1, r.calls))} rows a call   ${r.q.slice(0, 120)}`);
    }
  }
  /* One load: each statement's rows a call, once per distinct statement text. */
  const load = rows.filter((r) => WAIVER_LOAD.some((prefix) => r.q.startsWith(prefix)));
  const perLoad = load.reduce((a, r) => a + r.read / Math.max(1, r.calls), 0);
  console.log(`\none Waivers load, estimated from ${load.length} statement shapes: about ${n(perLoad)} rows read`);
  console.log('\nevery SELECT on a table the Waivers screen reads');
  console.log('   calls    rows read   per call   query');
  for (const r of rows.filter((r) => WAIVERS.test(r.q) && /^SELECT/i.test(r.q)).sort((a, b) => b.read - a.read).slice(0, 45)) {
    console.log(`${String(r.calls).padStart(8)} ${n(r.read).padStart(12)} ${n(r.read / Math.max(1, r.calls)).padStart(10)}   ${r.q.slice(0, 150)}`);
  }
}
