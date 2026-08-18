#!/usr/bin/env node
/**
 * What Sleeper actually publishes about league transactions.
 *
 * Written before the league-intelligence schema, because every table in it is
 * shaped by an answer here. Read-only against the documented public endpoints;
 * no key, no account, no private paths.
 *
 * Run against any public league:
 *
 *   node scripts/probe-sleeper-transactions.mjs <league_id> [weeks]
 *
 * What the first run established (a real ten-team 2025 league, weeks 1 and 3):
 *
 *   /league/<id>/transactions/1  -> 113 transactions
 *        waiver/complete 20, waiver/failed 16, free_agent/complete 72,
 *        trade/complete 5
 *   /league/<id>/transactions/3  -> 16 transactions
 *        waiver/failed 9, waiver/complete 6, free_agent/complete 1
 *
 *   - FAILED claims are returned, with the bid attached. This is the only
 *     published evidence of what the rest of the league would have paid.
 *   - `settings.waiver_bid` is present on waivers and absent on free-agent
 *     adds, so a missing bid must not be read as a $0 bid.
 *   - Trades carry `draft_picks` and `waiver_budget` (FAAB moved between
 *     teams), and may contain no players at all.
 *   - `/league/<id>/rosters` reports `settings.waiver_budget_used`, so
 *     remaining FAAB is a subtraction against `league.settings.waiver_budget`.
 *   - `league.settings.faab_suggestions` exists as a 0/1 flag. It toggles a
 *     feature in Sleeper's own UI; **no documented endpoint returns a suggested
 *     bid**, and this app does not go looking for an undocumented one.
 *   - `/players/nfl` has 49 fields and none of them is a bye week, which is why
 *     bye planning reports "no source connected" rather than an all-clear.
 */

const BASE = 'https://api.sleeper.app/v1';

const leagueId = process.argv[2];
const weeks = Number(process.argv[3] ?? 4);

if (!leagueId) {
  console.error('usage: node scripts/probe-sleeper-transactions.mjs <league_id> [weeks]');
  process.exit(2);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  return text && text !== 'null' ? JSON.parse(text) : null;
}

const league = await get(`/league/${leagueId}`);
if (!league) {
  console.error(`no such league: ${leagueId}`);
  process.exit(1);
}

console.log(`league        ${league.name} (${league.season}, ${league.total_rosters} teams)`);
console.log(`waiver_type   ${league.settings?.waiver_type}`);
console.log(`waiver_budget ${league.settings?.waiver_budget}`);
console.log(`faab_suggest  ${league.settings?.faab_suggestions}  <- a UI flag, not an endpoint`);
console.log(`previous      ${league.previous_league_id ?? '(none — first season)'}`);

const rosters = await get(`/league/${leagueId}/rosters`);
const spend = (rosters ?? []).map((r) => r.settings?.waiver_budget_used);
console.log(`spend         ${JSON.stringify(spend)}`);

let totalBids = 0;
const prices = [];

for (let week = 1; week <= weeks; week++) {
  const transactions = (await get(`/league/${leagueId}/transactions/${week}`)) ?? [];
  const counts = {};
  for (const t of transactions) {
    const key = `${t.type}/${t.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (t.type === 'waiver' && t.settings && 'waiver_bid' in t.settings) {
      totalBids++;
      if (t.status === 'complete') prices.push(t.settings.waiver_bid);
    }
  }
  console.log(`week ${String(week).padStart(2)}       ${transactions.length.toString().padStart(3)}  ${JSON.stringify(counts)}`);
}

prices.sort((a, b) => a - b);
console.log(`\npriced claims ${totalBids} (${prices.length} winning)`);
console.log(`winning bids  ${JSON.stringify(prices)}`);
console.log(
  `median        $${prices.length ? prices[Math.floor(prices.length / 2)] : 'n/a'}   max $${prices.length ? prices[prices.length - 1] : 'n/a'}`,
);
