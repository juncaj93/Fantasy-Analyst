/**
 * What does SportsGameOdds actually return?
 *
 * The provider was chosen on published limits, but an adapter cannot be written
 * from a pricing page. This asks the live API two questions — what an NFL event
 * looks like, and what its player props look like — and prints the SHAPE of the
 * answers: key names, nesting, market identifiers, one example value each.
 *
 * Deliberately frugal. The free plan meters objects rather than requests, so
 * this fetches one page of events and the props for a single event, and nothing
 * else. Running it should cost a rounding error against 2,500 a month.
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

async function get(path) {
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
    return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
  } catch (err) {
    return { status: 0, json: null, text: `fetch failed: ${err.message}`, headers: {} };
  }
}

/**
 * Describe a value's shape without printing the value.
 *
 * Depth-limited, and arrays are described by their first element, so a payload
 * with two hundred quotes prints as one line rather than two hundred.
 */
function shape(value, depth = 0, maxDepth = 4) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(empty)';
    return depth >= maxDepth ? `array(${value.length})` : `array(${value.length}) of ${shape(value[0], depth + 1, maxDepth)}`;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return 'object';
    const keys = Object.keys(value).slice(0, 24);
    return `{ ${keys.map((k) => `${k}: ${shape(value[k], depth + 1, maxDepth)}`).join(', ')} }`;
  }
  if (typeof value === 'string') return value.length > 40 ? 'string(long)' : `string("${value}")`;
  return typeof value;
}

function rateLimitHeaders(headers) {
  return Object.entries(headers)
    .filter(([k]) => /rate|limit|quota|remaining|reset|credit/i.test(k))
    .map(([k, v]) => `${k}: ${v}`);
}

console.log('=== 1. upcoming NFL events ===');
/*
 * Filtered to real, future games.
 *
 * An unfiltered NFL query answers with novelty events — the first page came
 * back as Puppy Bowl XX from 2024, whose odds are "sex of the winning
 * touchdown scorer". Those are `type: 'prop'` rather than a match, and writing
 * an adapter against them would map the wrong thing entirely.
 */
const from = new Date().toISOString().slice(0, 10);
const events = await get(`/events?leagueID=NFL&type=match&startsAfter=${from}&oddsAvailable=true&limit=3`);
console.log('status:', events.status);
for (const line of rateLimitHeaders(events.headers)) console.log('  header', line);

if (events.status !== 200) {
  console.log('body (first 500 chars):', events.text.slice(0, 500));
  console.log('\nStopping: no usable event list, so there is nothing to ask for props about.');
  process.exit(1);
}

const list = Array.isArray(events.json?.data) ? events.json.data : Array.isArray(events.json) ? events.json : [];
console.log('envelope:', shape(events.json, 0, 2));
console.log('events returned:', list.length);

const first = list[0];
if (!first) {
  console.log('No events in the response — likely out of season. Shape of the envelope is above.');
  process.exit(0);
}

console.log('\nfirst event shape:');
console.log(' ', shape(first, 0, 3));
// The few fields the adapter actually needs, named explicitly so a rename is obvious.
// Kickoff lives on `status.startsAt`, not a top-level `startTime` — worth
// naming explicitly, because the absence is silent and the adapter needs it.
for (const field of ['eventID', 'leagueID', 'type', 'status', 'teams', 'players']) {
  console.log(`  ${field}:`, field in first ? shape(first[field], 0, 2) : '(absent)');
}
console.log('  status.startsAt:', first.status?.startsAt ?? '(absent)');

const eventId = first.eventID ?? first.id ?? null;
console.log('\n=== 2. player props for one event ===');
if (!eventId) {
  console.log('Could not find an event id on the first event; see the shape above.');
  process.exit(0);
}

const props = await get(`/events?eventID=${encodeURIComponent(eventId)}&oddsAvailable=true`);
console.log('status:', props.status);
for (const line of rateLimitHeaders(props.headers)) console.log('  header', line);

if (props.status !== 200) {
  console.log('body (first 500 chars):', props.text.slice(0, 500));
  process.exit(1);
}

const detail = (Array.isArray(props.json?.data) ? props.json.data : [props.json])[0] ?? null;
const odds = detail?.odds ?? null;
if (!odds) {
  console.log('No odds on the event detail. Envelope:', shape(props.json, 0, 3));
  process.exit(0);
}

// Odds arrive keyed by market identifier. The identifiers are the whole point:
// the adapter maps them onto our six internal market keys, and guessing them
// is exactly the mistake this probe exists to prevent.
const oddKeys = Array.isArray(odds) ? [] : Object.keys(odds);
console.log('odds container:', Array.isArray(odds) ? `array(${odds.length})` : `object with ${oddKeys.length} keys`);

/*
 * An oddID is `{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}`.
 *
 * statID is the market, statEntityID is who it is about (a side for a game
 * line, a player id for a prop), and betTypeID separates over/under from
 * moneyline. Those three are what the adapter maps; everything else is detail.
 */
const values = Array.isArray(odds) ? odds : Object.values(odds);
const statIds = [...new Set(values.map((o) => o?.statID).filter(Boolean))].sort();
const betTypes = [...new Set(values.map((o) => o?.betTypeID).filter(Boolean))].sort();
const periods = [...new Set(values.map((o) => o?.periodID).filter(Boolean))].sort();

console.log('quotes on this event:', values.length);
console.log('betTypeIDs:', betTypes.join(', '));
console.log('periodIDs:', periods.join(', '));
console.log(`\ndistinct statIDs (${statIds.length}):`);
for (const id of statIds) console.log('  ', id);

// A player prop rather than a game line: statEntityID that is not a side.
const playerQuote = values.find((o) => o?.betTypeID === 'ou' && !/^(side1|side2|home|away|all)$/.test(String(o?.statEntityID ?? '')));
console.log('\none player over/under quote, shaped:');
console.log(' ', playerQuote ? shape(playerQuote, 0, 3) : '(none found — this event may carry game lines only)');
if (playerQuote) {
  console.log('  oddID:', playerQuote.oddID);
  console.log('  marketName:', playerQuote.marketName);
  console.log('  statEntityID:', playerQuote.statEntityID);
  // Where the actual number lives is the one thing an adapter cannot guess.
  for (const field of ['bookOverUnder', 'fairOverUnder', 'overUnder', 'bookOdds', 'fairOdds', 'closeOverUnder']) {
    if (field in playerQuote) console.log(`  ${field}:`, JSON.stringify(playerQuote[field]));
  }
  const books = playerQuote.byBookmaker ?? {};
  const bookNames = Object.keys(books);
  console.log('  byBookmaker keys:', bookNames.slice(0, 8).join(', ') || '(empty)');
  if (bookNames[0]) console.log('  one bookmaker entry:', shape(books[bookNames[0]], 0, 2));
}

// How a player id resolves to a name — identity matching depends on it.
const players = detail?.players ?? null;
console.log('\nplayer directory on the event:', players ? shape(players, 0, 2) : '(absent)');
