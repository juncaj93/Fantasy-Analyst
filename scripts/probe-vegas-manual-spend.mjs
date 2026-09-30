/**
 * Where does a manual Vegas refresh spend its entities?
 *
 * Alex reported, on 30 September 2026, that manual refreshes burn roughly 204
 * of the month's 258 odds credits. A manual refresh writes two kinds of rows to
 * the ledger: `manual` for per-game fetches, and `schedule` for the discovery
 * pass it may run first. Nothing links the two, so this lines every `schedule`
 * row up against the refresh that caused it: a `schedule` row within a minute
 * of a `vegas.lastRefresh`-shaped burst of `manual` rows, or on its own when
 * nothing else in that minute was bought.
 *
 * Read-only: every statement is a SELECT, and the script refuses anything else.
 *
 * Env: CLOUDFLARE_API_TOKEN, ACCOUNT_ID (optional), SINCE (default 2026-09-01).
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const SINCE = process.env.SINCE ?? '2026-09-01';
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is required.');
  process.exit(1);
}

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported below */
  }
  return { status: res.status, json, text };
}

if (!ACCOUNT) ACCOUNT = (await call('/accounts')).json?.result?.[0]?.id;
const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs.json?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
if (!DB) {
  console.error(`Could not resolve the database (HTTP ${dbs.status}).`);
  process.exit(1);
}

async function select(sql) {
  // This probe may only ever read.
  if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
  const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  if (!r.json?.success) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`);
  return r.json.result?.[0]?.results ?? [];
}

function print(title, rows) {
  console.log('');
  console.log(`=== ${title} ===`);
  if (!rows.length) console.log('  (no rows)');
  for (const row of rows) {
    console.log(
      '  ' +
        Object.entries(row)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}=${String(v).slice(0, 200)}`)
          .join('  '),
    );
  }
}

print('usage by month (ours and the provider\'s own count)', await select(`SELECT * FROM vegas_usage ORDER BY month DESC LIMIT 3`));
print(
  'ledger totals by source and outcome, since ' + SINCE,
  await select(
    `SELECT source, outcome, COUNT(*) AS rows_, SUM(entities) AS entities, SUM(requests) AS requests FROM vegas_usage_log WHERE at >= '${SINCE}' GROUP BY 1, 2 ORDER BY 4 DESC`,
  ),
);
print('Vegas settings (the schedule stamp is vegas.lastSchedule)', await select(`SELECT key, value_json, updated_at FROM settings WHERE key LIKE 'vegas.%'`));

// Every ledger row since SINCE, grouped into passes: rows within 90 seconds of
// the previous one belong to the same refresh.
const rows = await select(
  `SELECT id, at, source, event_id, entities, requests, outcome, reason FROM vegas_usage_log WHERE at >= '${SINCE}' ORDER BY at, id`,
);
const passes = [];
for (const row of rows) {
  const t = Date.parse(row.at);
  const last = passes.at(-1);
  if (last && t - last.end <= 90_000) {
    last.rows.push(row);
    last.end = t;
  } else passes.push({ start: t, end: t, rows: [row] });
}

console.log('');
console.log('=== refresh passes (rows within 90s grouped) ===');
const totals = { manualPasses: 0, manualEntities: 0, manualDiscovery: 0, manualGames: 0, otherEntities: 0 };
for (const pass of passes) {
  const sources = new Set(pass.rows.map((r) => r.source));
  const entities = pass.rows.reduce((s, r) => s + (r.entities ?? 0), 0);
  const discovery = pass.rows.filter((r) => r.source === 'schedule').reduce((s, r) => s + (r.entities ?? 0), 0);
  const games = pass.rows.filter((r) => r.source !== 'schedule').reduce((s, r) => s + (r.entities ?? 0), 0);
  // A pass is manual when it wrote a `manual` row, or when it is a lone
  // discovery at an hour no scheduled clock runs (the weekend crons are
  // Saturday 23:00 and Sunday 15:00 UTC).
  const at = new Date(pass.start);
  const cronHour =
    (at.getUTCDay() === 6 && at.getUTCHours() === 23) || (at.getUTCDay() === 0 && at.getUTCHours() === 15);
  const manual = sources.has('manual') || (!cronHour && !sources.has('weekly') && !sources.has('season'));
  if (manual) {
    totals.manualPasses++;
    totals.manualEntities += entities;
    totals.manualDiscovery += discovery;
    totals.manualGames += games;
  } else totals.otherEntities += entities;
  const reasons = pass.rows
    .filter((r) => r.source === 'schedule')
    .map((r) => `${r.outcome}:${r.reason}`)
    .join(' | ');
  console.log(
    `  ${new Date(pass.start).toISOString()}  ${manual ? 'MANUAL' : 'clock '}  sources=${[...sources].join(',')}  ` +
      `entities=${entities} (discovery ${discovery}, games ${games})${reasons ? `  schedule: ${reasons}` : ''}`,
  );
}
console.log('');
console.log('=== summary ===');
console.log(`  manual passes: ${totals.manualPasses}`);
console.log(`  entities they spent: ${totals.manualEntities}  (schedule discovery ${totals.manualDiscovery}, per-game ${totals.manualGames})`);
console.log(`  entities everything else spent: ${totals.otherEntities}`);

print(
  'stored games (vegas_events) upcoming or recent',
  await select(`SELECT event_id, kickoff, home_team, away_team, seen_at FROM vegas_events WHERE kickoff >= date('now', '-3 days') ORDER BY kickoff`),
);
