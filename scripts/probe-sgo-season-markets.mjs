/**
 * Does SportsGameOdds carry season-long NFL player markets, and what are they called?
 *
 * The draft cares about the whole season, not Sunday. The weekly adapter was
 * written against live responses rather than documentation, and this asks the
 * same kind of question for season-long props: which events exist that are not
 * a single game, what `statID`/`periodID` they use, and whether the entity on
 * each quote is a player we could resolve.
 *
 * The first run established that `type` accepts only match, prop and tournament,
 * that prop and tournament are both empty for the NFL, and that an ordinary game
 * carries passing/rushing/receiving yards on named players. This run looks past
 * the near horizon — a season-long market would be dated at the end of the
 * season, not today — and takes stock of what a regular-season game carries, for
 * the weekly Start/Sit layer.
 *
 * Deliberately frugal: the free plan meters objects, so this makes a handful of
 * requests with small limits and prints identifiers and counts, never whole
 * payloads. Prints only; changes nothing, stores nothing. The key is read from
 * the environment and never echoed — only whether it was present.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

let requests = 0;

async function get(path) {
  requests++;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the raw text for the report */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: `fetch failed: ${err.message}` };
  }
}

function head(title) {
  console.log(`\n=== ${title} ===`);
}

function describeEvents(res, limit = 8) {
  console.log(`status ${res.status}`);
  const data = res.json?.data;
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`  no data (${(res.text ?? '').slice(0, 200)})`);
    return [];
  }
  for (const event of data.slice(0, limit)) {
    console.log(
      `  ${event.eventID} type=${event.type} starts=${event.status?.startsAt ?? '?'} ` +
        `odds=${Object.keys(event.odds ?? {}).length} players=${Object.keys(event.players ?? {}).length}`,
    );
  }
  return data;
}

/** Summarise an event's odds by market identity, without printing payloads. */
function summariseOdds(event, { maxRows = 40 } = {}) {
  const odds = Object.values(event.odds ?? {});
  const players = event.players ?? {};
  const combos = new Map();
  for (const odd of odds) {
    if (odd?.cancelled) continue;
    const key = `${odd?.statID ?? '?'} | period=${odd?.periodID ?? '?'} | bet=${odd?.betTypeID ?? '?'}`;
    const entry = combos.get(key) ?? { count: 0, playerEntities: 0, example: null };
    entry.count++;
    const entity = odd?.playerID ?? odd?.statEntityID ?? '';
    const known = entity && players[entity];
    if (known) entry.playerEntities++;
    if (!entry.example && (odd?.sideID === 'over' || odd?.sideID === 'yes')) {
      entry.example = {
        entity,
        name: known ? (players[entity]?.name ?? null) : null,
        line: odd?.bookOverUnder ?? odd?.fairOverUnder ?? null,
        odds: odd?.bookOdds ?? odd?.fairOdds ?? null,
        marketName: odd?.marketName ?? null,
      };
    }
    combos.set(key, entry);
  }
  const rows = [...combos.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxRows);
  for (const [key, entry] of rows) {
    console.log(
      `  ${key} -> ${entry.count} quote(s), ${entry.playerEntities} on known players` +
        (entry.example
          ? ` | e.g. ${entry.example.name ?? entry.example.entity} line=${entry.example.line} odds=${entry.example.odds}` +
            (entry.example.marketName ? ` "${entry.example.marketName}"` : '')
          : ''),
    );
  }
  if (combos.size > rows.length) console.log(`  … and ${combos.size - rows.length} more combinations`);
  if (combos.size === 0) console.log('  (no odds on this event)');
}

const year = new Date().getUTCFullYear();

// 1. Anything dated past the end of the season — where a season-long market
//    would have to live, since it settles when the season does.
head('NFL events starting after the regular season ends');
describeEvents(await get(`/events?leagueID=NFL&startsAfter=${year}-12-20&limit=10`));

head('NFL events with type=prop, over the whole year');
describeEvents(await get(`/events?leagueID=NFL&type=prop&startsAfter=${year}-01-01&limit=10`));

head('NFL events with type=tournament, over the whole year');
const tournaments = describeEvents(await get(`/events?leagueID=NFL&type=tournament&startsAfter=${year}-01-01&limit=10`));
if (tournaments.length > 0) {
  head('markets on the first tournament event');
  summariseOdds(tournaments[0]);
}

// 2. Is there a catalogue of markets/stats we could read instead of guessing?
for (const path of ['/stats?leagueID=NFL', '/markets?leagueID=NFL', '/leagues?leagueID=NFL']) {
  head(`GET ${path}`);
  const res = await get(path);
  console.log(`status ${res.status}`);
  console.log(`  ${(res.text ?? '').slice(0, 600)}`);
}

// 3. What a REGULAR-season game carries. Preseason games are thin; the weekly
//    Start/Sit layer will live on these, so the vocabulary matters.
head('markets on a regular-season NFL game');
const regular = await get(`/events?leagueID=NFL&type=match&oddsAvailable=true&startsAfter=${year}-09-08&limit=1`);
const event = regular.json?.data?.[0];
if (event) {
  console.log(`  ${event.eventID} starts=${event.status?.startsAt ?? '?'} players=${Object.keys(event.players ?? {}).length}`);
  summariseOdds(event, { maxRows: 60 });
} else {
  console.log(`  no data (${(regular.text ?? '').slice(0, 300)})`);
}

head('cost of this probe');
console.log(`${requests} request(s) made.`);
