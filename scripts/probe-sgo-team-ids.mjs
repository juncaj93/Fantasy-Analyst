/**
 * Does the provider's `teamID` filter accept Sleeper's abbreviations?
 *
 * `VegasRefreshService.rosterTeams()` collects the team codes off the user's
 * rostered players — Sleeper's, so `SF`, `KC`, `NE` — and hands them straight to
 * `getPropsForTeams`, which puts them into `teamID=`. Every provider id seen in
 * a live payload so far has been the long shouted form
 * (`SAN_FRANCISCO_49ERS_NFL`), which would make every discovery request a filter
 * that matches nothing.
 *
 * That distinction decides whether turning the real provider on produces lines
 * or produces an empty database that looks exactly like "the provider has no
 * data". An empty response still costs one entity, so getting this wrong is
 * also the expensive kind of wrong.
 *
 * Asks three things and nothing else:
 *   1. is there a canonical team list to map against, and what does it cost;
 *   2. does the short Sleeper code return events;
 *   3. does the long provider id return events.
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, json, text };
}

async function monthEntities() {
  const res = await get('/account/usage');
  return res.json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;
}

const before = await monthEntities();
console.log(`entities used this month, before: ${before}`);

// 1. A canonical team list would let the mapping be looked up rather than
//    guessed, so it is worth knowing whether one exists and what it costs.
console.log('\n=== GET /teams?leagueID=NFL ===');
const teams = await get('/teams?leagueID=NFL');
console.log(`status ${teams.status}`);
const teamRows = teams.json?.data ?? [];
if (Array.isArray(teamRows) && teamRows.length) {
  console.log(`  ${teamRows.length} teams listed. First five, with every id-ish field:`);
  for (const t of teamRows.slice(0, 5)) {
    console.log(
      `    teamID=${t.teamID ?? '?'} names=${JSON.stringify(t.names ?? null)} ` +
        `abbr=${t.abbreviation ?? t.abbr ?? 'none'}`,
    );
  }
} else {
  console.log(`  no team list: ${(teams.text ?? '').slice(0, 300)}`);
}

// 2 and 3. The same question asked twice, with the only difference being the
//    vocabulary the id is written in.
const YEAR = new Date().getUTCFullYear();
const window_ = `&startsAfter=${YEAR}-09-08&limit=2`;

for (const [label, teamId] of [
  ['SHORT — the Sleeper abbreviation the app actually sends', 'SF'],
  ['LONG — the provider id seen in live payloads', 'SAN_FRANCISCO_49ERS_NFL'],
]) {
  console.log(`\n=== ${label}: teamID=${teamId} ===`);
  const res = await get(`/events?leagueID=NFL&type=match&teamID=${encodeURIComponent(teamId)}${window_}`);
  const data = res.json?.data;
  console.log(`  status ${res.status}`);
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`  NO EVENTS — ${(res.text ?? '').slice(0, 250)}`);
  } else {
    console.log(`  ${data.length} event(s):`);
    for (const ev of data) {
      const sides = Object.values(ev.teams ?? {}).map((t) => t?.teamID ?? '?');
      console.log(`    ${ev.eventID} starts=${ev.status?.startsAt ?? '?'} teams=${sides.join(' v ')}`);
    }
  }
}

const after = await monthEntities();
console.log(`\nentities used this month, after: ${after}`);
console.log(`this probe cost: ${before != null && after != null ? after - before : 'unknown'} entities`);
