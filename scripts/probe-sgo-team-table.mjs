/**
 * The provider's whole team table, printed once so it can be hard-coded.
 *
 * `teamID=SF` returns nothing and `teamID=SAN_FRANCISCO_49ERS_NFL` returns the
 * fixtures, so the refresh service needs a Sleeper-code -> provider-id mapping.
 * That mapping should be a literal in the adapter rather than a lookup: the
 * team list is billed one entity per team — 34 of an allowance of 2,500 every
 * time it is read — and the league has had the same members for twenty years.
 *
 * So this is run once, by hand, and its output becomes source. Printing the
 * provider's own `names.short` alongside its id is the point: the table is then
 * something the provider said rather than something inferred from a naming rule
 * that happens to hold for the five teams somebody sampled.
 *
 * Prints only. Changes nothing, and never echoes the key.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const before = (await get('/account/usage')).json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;

const teams = await get('/teams?leagueID=NFL');
const rows = teams.json?.data ?? [];
console.log(`status ${teams.status}, ${rows.length} rows\n`);

console.log('short | provider teamID | long name');
console.log('------|-----------------|----------');
for (const t of rows) {
  console.log(`${String(t.names?.short ?? '?').padEnd(5)} | ${String(t.teamID ?? '?').padEnd(31)} | ${t.names?.long ?? '?'}`);
}

console.log('\n--- as a literal, keyed by the short code ---');
for (const t of rows) {
  if (!t.names?.short || !t.teamID) continue;
  console.log(`  ${t.names.short}: '${t.teamID}',`);
}

const after = (await get('/account/usage')).json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;
console.log(`\nentities: ${before} -> ${after} (cost ${before != null && after != null ? after - before : '?'})`);
