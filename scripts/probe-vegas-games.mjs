/**
 * Which games each odds purchase covered, and how old each game's lines are.
 *
 * Read-only: every statement is a SELECT and nothing here calls the odds
 * provider. Env: CLOUDFLARE_API_TOKEN and ACCOUNT_ID. Optional: SINCE (ISO date,
 * default 2026-10-04), FOCUS_KICKOFF (ISO, default 2026-10-09T00:15:00Z, the
 * game to single out).
 *
 * Prints:
 *   1. the usage log since SINCE, one line per purchase, with the event it
 *      named if it named one (a schedule purchase names none);
 *   2. every stored game kicking off within a day before now and eight days
 *      after: teams, kickoff, when its lines were last bought (the same figure
 *      the job reads, `prop_snapshots` newest `week` row), the age now, the
 *      staleness wait for how close it is, and what the kickoff clock would
 *      decide about it right now;
 *   3. every purchase minute per game since SINCE, so a bulk purchase shows as
 *      the set of games sharing one minute;
 *   4. the focus game on its own.
 */

import { gameDueOnClock } from '../src/core/vegas/kickoffClock.ts';
import { manualRefreshThresholdMinutes } from '../src/core/vegas/staleness.ts';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';
const NOW = Date.now();
const SINCE = process.env.SINCE ?? '2026-10-04';
const FOCUS = Date.parse(process.env.FOCUS_KICKOFF ?? '2026-10-09T00:15:00Z');

if (!TOKEN) {
  console.log('no CLOUDFLARE_API_TOKEN: nothing to read');
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

const hhmm = (iso) => (iso ? iso.slice(5, 16).replace('T', ' ') + 'Z' : '(none)');
const short = (id) => (id ? String(id).slice(0, 10) : '-');

console.log(`=== the usage log since ${SINCE} ===`);
const log = await select(
  `SELECT at, source, event_id, entities, requests, outcome, reason FROM vegas_usage_log WHERE at >= '${SINCE}' ORDER BY at`,
);
for (const r of log) {
  console.log(
    `  ${r.at.slice(0, 19)}Z  ${String(r.source).padEnd(8)} ${String(r.outcome).padEnd(8)} entities=${r.entities} requests=${r.requests}  event=${short(r.event_id)}  ${String(r.reason ?? '').slice(0, 110)}`,
  );
}

const lo = new Date(NOW - 86_400_000).toISOString();
const hi = new Date(NOW + 8 * 86_400_000).toISOString();
const events = await select(
  `SELECT event_id, kickoff, home_team, away_team, seen_at, lines_seen_at FROM vegas_events WHERE kickoff >= '${lo}' AND kickoff <= '${hi}' ORDER BY kickoff`,
);
const newest = await select(
  `SELECT event_id, MAX(fetched_at) AS fetched_at, COUNT(*) AS rows FROM prop_snapshots WHERE scope = 'week' GROUP BY event_id`,
);
const newestBy = new Map(newest.map((r) => [r.event_id, r]));

console.log(`\n=== stored games kicking off ${hhmm(lo)} to ${hhmm(hi)}: ${events.length} ===`);
const verdicts = [];
for (const e of events) {
  const fetched = newestBy.get(e.event_id)?.fetched_at ?? null;
  const hours = (Date.parse(e.kickoff) - NOW) / 3_600_000;
  const age = fetched ? (NOW - Date.parse(fetched)) / 60_000 : null;
  const wait = manualRefreshThresholdMinutes(hours);
  const verdict = gameDueOnClock({ kickoff: e.kickoff, lastFetchedAt: fetched }, NOW);
  verdicts.push({ e, fetched, hours, age, wait, verdict });
  console.log(
    `  ${hhmm(e.kickoff)}  ${String(e.away_team).replace(/_NFL$/, '')} at ${String(e.home_team).replace(/_NFL$/, '')}  ` +
      `bought ${hhmm(fetched)}  age ${age == null ? 'never' : `${age.toFixed(0)} min`}  ` +
      `${hours.toFixed(1)}h out  wait ${wait ?? 'none'} min  clock: ${verdict.due ? 'DUE' : 'not due'} (${verdict.reason})  event=${short(e.event_id)}`,
  );
}

console.log(`\n=== purchase minutes per game since ${SINCE} (a bulk purchase is one minute shared by many games) ===`);
const batches = await select(
  `SELECT event_id, substr(fetched_at, 1, 16) AS minute, COUNT(*) AS rows FROM prop_snapshots WHERE scope = 'week' AND fetched_at >= '${SINCE}' GROUP BY event_id, minute ORDER BY minute, event_id`,
);
const nameOf = new Map(
  events.map((e) => [e.event_id, `${String(e.away_team).replace(/_NFL$/, '')} at ${String(e.home_team).replace(/_NFL$/, '')}`]),
);
const byMinute = new Map();
for (const b of batches) {
  const list = byMinute.get(b.minute) ?? [];
  list.push(`${nameOf.get(b.event_id) ?? `event ${short(b.event_id)} (outside the window above)`} [${b.rows} rows]`);
  byMinute.set(b.minute, list);
}
for (const [minute, list] of byMinute) {
  console.log(`  ${minute}Z  ${list.length} game(s)`);
  for (const item of list) console.log(`      ${item}`);
}

console.log('\n=== the focus game ===');
const focus = verdicts.find((v) => Math.abs(Date.parse(v.e.kickoff) - FOCUS) <= 30 * 60_000);
if (!focus) {
  console.log(`  no stored game kicks off within 30 min of ${new Date(FOCUS).toISOString()}`);
} else {
  const { e, fetched, hours, age, wait, verdict } = focus;
  console.log(`  ${String(e.away_team).replace(/_NFL$/, '')} at ${String(e.home_team).replace(/_NFL$/, '')}, kickoff ${e.kickoff}`);
  console.log(`  lines last bought: ${fetched ?? 'never'}  (age ${age == null ? 'n/a' : `${age.toFixed(0)} min`})`);
  console.log(`  hours to kickoff: ${hours.toFixed(2)}  staleness wait: ${wait ?? 'none'} min`);
  console.log(`  kickoff clock right now: ${verdict.due ? 'DUE' : 'not due'} (${verdict.reason})`);
  const at = fetched ? Date.parse(fetched) : NaN;
  const bulk = batches.filter((b) => b.event_id === e.event_id).map((b) => b.minute);
  console.log(`  purchase minutes on record since ${SINCE}: ${bulk.length ? bulk.map((m) => `${m}Z`).join(', ') : 'none'}`);
  void at;
}
