/**
 * Can the weekly schedule be discovered without paying for the whole slate?
 *
 * Established: the bill is one entity per event returned. So listing a
 * sixteen-game Sunday costs sixteen entities even if the user's roster only
 * touches eight of those games. If `/events` honours a team filter, discovery
 * costs what the roster actually spans; if it ignores it, the request silently
 * returns everything and costs the full slate — which is exactly the kind of
 * filter that must be verified before it is trusted.
 *
 * Bounded on purpose: a handful of entities, and every request carries a small
 * limit so a misunderstood parameter cannot run away with the month.
 *
 * Read-only.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Api-Key': KEY, accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 200) };
  }
}

async function monthUsed() {
  const res = await get('/account/usage');
  return res.json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;
}

const limit = { max: Number(process.env.MAX_ENTITIES ?? 40) };
let spent = 0;
let before = await monthUsed();
console.log(`month so far: ${before} entities of 2500\n`);

async function priceOf(label, path) {
  if (spent >= limit.max) {
    console.log(`  ${label}: skipped, this run has spent its ${limit.max}-entity allowance`);
    return null;
  }
  const res = await get(path);
  const events = Array.isArray(res.json?.data) ? res.json.data : [];
  const after = await monthUsed();
  const cost = before != null && after != null ? after - before : null;
  before = after;
  spent += cost ?? 0;
  const teams = new Set();
  for (const e of events) for (const t of Object.values(e?.teams ?? {})) if (t?.teamID) teams.add(t.teamID);
  console.log(
    `  ${label.padEnd(38)} HTTP ${res.status}  ${events.length} event(s)  cost ${cost ?? '?'}  teams: ${[...teams].slice(0, 6).join(', ') || 'none'}`,
  );
  if (res.status !== 200) console.log(`    body: ${res.text ?? JSON.stringify(res.json).slice(0, 200)}`);
  return events;
}

// A real team id off a real event, rather than a guessed one.
const seed = await priceOf('one event, to learn a team id', '/events?leagueID=NFL&type=match&limit=1');
const teamId = seed?.[0] ? Object.values(seed[0].teams ?? {})[0]?.teamID : null;
console.log(`\nteam id to filter on: ${teamId ?? 'none found'}\n`);

if (teamId) {
  const filtered = await priceOf(
    'listing filtered by teamID',
    `/events?leagueID=NFL&type=match&teamID=${encodeURIComponent(teamId)}&limit=5`,
  );
  if (filtered) {
    const everyEventHasTeam = filtered.every((e) =>
      Object.values(e?.teams ?? {}).some((t) => t?.teamID === teamId),
    );
    console.log(
      `  filter honoured: ${everyEventHasTeam ? 'yes — every event returned involves that team' : 'NO — the parameter was ignored'}`,
    );
  }

  await priceOf(
    'listing filtered by a nonsense teamID',
    '/events?leagueID=NFL&type=match&teamID=NOT_A_REAL_TEAM_NFL&limit=5',
  );
  console.log('  (an ignored filter answers with events here; an honoured one answers with none)');
}

console.log(`\nthis run spent ${spent} entities.`);
