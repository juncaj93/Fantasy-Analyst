/**
 * Does SportsGameOdds carry season-long NFL player markets, and what are they called?
 *
 * The draft cares about the whole season, not Sunday. The weekly adapter was
 * written against live responses rather than documentation, and this asks the
 * same kind of question for season-long props: which events exist that are not
 * a single game, what `statID`/`periodID` they use, and whether the entity on
 * each quote is a player we could resolve.
 *
 * Deliberately frugal: the free plan meters objects, so this makes a handful of
 * requests with small limits and prints identifiers and counts, never whole
 * payloads. Running it should cost a rounding error against the monthly budget.
 *
 * Prints only; changes nothing, stores nothing. The key is read from the
 * environment and never echoed — only whether it was present.
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
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the raw text for the report */
    }
    return {
      status: res.status,
      json,
      text,
      rateLimit: {
        remaining: res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining'),
        limit: res.headers.get('x-ratelimit-limit') ?? res.headers.get('ratelimit-limit'),
        objects: res.headers.get('x-objects-remaining') ?? res.headers.get('x-ratelimit-remaining-objects'),
      },
    };
  } catch (err) {
    return { status: 0, json: null, text: `fetch failed: ${err.message}`, rateLimit: {} };
  }
}

function head(title) {
  console.log(`\n=== ${title} ===`);
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
    if (!entry.example && odd?.sideID === 'over') {
      entry.example = {
        entity,
        name: known ? players[entity]?.name ?? null : null,
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

const season = new Date().getUTCFullYear();

// 1. What kinds of NFL event exist right now, beyond single games?
head('NFL events, unfiltered by type');
const all = await get(`/events?leagueID=NFL&oddsAvailable=true&limit=20`);
console.log(`status ${all.status}, rate limit headers: ${JSON.stringify(all.rateLimit)}`);
if (all.json?.data) {
  const byType = new Map();
  for (const event of all.json.data) {
    const t = event?.type ?? '(none)';
    const list = byType.get(t) ?? [];
    list.push(event);
    byType.set(t, list);
  }
  for (const [type, events] of byType) {
    console.log(`  type="${type}": ${events.length} event(s)`);
    for (const event of events.slice(0, 4)) {
      console.log(
        `    ${event.eventID} starts=${event.status?.startsAt ?? '?'} odds=${Object.keys(event.odds ?? {}).length} players=${Object.keys(event.players ?? {}).length}`,
      );
    }
  }
} else {
  console.log(all.text.slice(0, 400));
}

// 2. The documented way to ask for anything that is not a single game.
for (const type of ['futures', 'prop', 'season', 'tournament']) {
  head(`NFL events with type=${type}`);
  const res = await get(`/events?leagueID=NFL&type=${type}&limit=5&oddsAvailable=true`);
  console.log(`status ${res.status}`);
  if (res.json?.data?.length) {
    for (const event of res.json.data) {
      console.log(
        `  ${event.eventID} type=${event.type} starts=${event.status?.startsAt ?? '?'} odds=${Object.keys(event.odds ?? {}).length} players=${Object.keys(event.players ?? {}).length}`,
      );
    }
    head(`markets on the first type=${type} event`);
    summariseOdds(res.json.data[0]);
  } else {
    console.log(`  no data (${(res.text ?? '').slice(0, 200)})`);
  }
}

// 3. Season identity, if the API accepts it as a filter.
head(`NFL events for season=${season}, no type filter`);
const seasonal = await get(`/events?leagueID=NFL&season=${season}&limit=5&oddsAvailable=true`);
console.log(`status ${seasonal.status}`);
if (seasonal.json?.data?.length) {
  for (const event of seasonal.json.data) {
    console.log(
      `  ${event.eventID} type=${event.type} starts=${event.status?.startsAt ?? '?'} odds=${Object.keys(event.odds ?? {}).length}`,
    );
  }
} else {
  console.log(`  no data (${(seasonal.text ?? '').slice(0, 200)})`);
}

// 4. For contrast: what a normal game event carries, so the two are comparable.
head('markets on one ordinary NFL game');
const match = await get(`/events?leagueID=NFL&type=match&oddsAvailable=true&limit=1`);
if (match.json?.data?.[0]) {
  const event = match.json.data[0];
  console.log(`  ${event.eventID} starts=${event.status?.startsAt ?? '?'}`);
  summariseOdds(event, { maxRows: 12 });
} else {
  console.log(`  no data (${(match.text ?? '').slice(0, 200)})`);
}

head('cost of this probe');
console.log(`${requests} request(s) made.`);
