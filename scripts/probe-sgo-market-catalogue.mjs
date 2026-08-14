/**
 * Does SportsGameOdds model a season-long period at all?
 *
 * Two runs have established that every NFL event is a single game, and that
 * `type=prop` and `type=tournament` are empty for the league. This asks the
 * market catalogue itself — the definitive list of what the provider can quote
 * — for the set of periods and for anything season-shaped. If there is no
 * season period in the catalogue, there are no season-long markets to fetch,
 * and the honest thing is to stop looking and say so.
 *
 * One request. Prints identifiers and counts only; the key is never echoed.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

const res = await fetch(`${BASE}/markets?leagueID=NFL`, {
  headers: { 'X-Api-Key': KEY, accept: 'application/json' },
});
const body = await res.json();
const markets = body?.data ?? [];
console.log(`status ${res.status}, ${markets.length} market definition(s)`);

const periods = new Map();
const playerStats = new Set();
const seasonish = [];
for (const m of markets) {
  periods.set(m.periodID, (periods.get(m.periodID) ?? 0) + 1);
  if (m.playerID === 'PLAYER_ID' || m.statEntityID === 'PLAYER_ID') playerStats.add(m.statID);
  const blob = `${m.oddID ?? ''} ${m.statID ?? ''} ${m.periodID ?? ''} ${m.marketGroupName ?? ''}`.toLowerCase();
  if (/season|futures|total.*season|award|mvp/.test(blob)) seasonish.push(m);
}

console.log('\nperiods in the catalogue:');
for (const [period, count] of [...periods].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${period}: ${count} market(s)`);
}

console.log(`\nplayer-level stats offered (${playerStats.size}):`);
console.log(`  ${[...playerStats].sort().join(', ')}`);

console.log(`\nanything season-shaped: ${seasonish.length}`);
for (const m of seasonish.slice(0, 20)) {
  console.log(`  ${m.oddID} | activeEvents=${m.activeEvents} | "${m.marketGroupName}"`);
}

const active = markets.filter((m) => (m.activeEvents ?? 0) > 0);
console.log(`\nmarkets with at least one active event: ${active.length}`);
for (const m of active.slice(0, 25)) {
  console.log(`  ${m.statID} | period=${m.periodID} | bet=${m.betTypeID} | events=${m.activeEvents} | "${m.marketGroupName}"`);
}
