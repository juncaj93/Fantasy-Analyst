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
// leagueID rather than a date range: the point is one small page, not a week.
const events = await get('/events?leagueID=NFL&limit=3');
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
for (const field of ['eventID', 'leagueID', 'startTime', 'status', 'teams', 'odds']) {
  console.log(`  ${field}:`, field in first ? shape(first[field], 0, 2) : '(absent)');
}

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

const sampleKeys = oddKeys.slice(0, 15);
console.log('\nsample market identifiers:');
for (const k of sampleKeys) console.log('  ', k);

const sample = Array.isArray(odds) ? odds[0] : odds[sampleKeys[0]];
console.log('\none quote, shaped:');
console.log(' ', shape(sample, 0, 3));

// Which of our six internal markets appear at all.
const WANTED = ['passing_yards', 'passing_touchdowns', 'rushing_yards', 'receptions', 'receiving_yards', 'touchdowns'];
const haystack = (Array.isArray(odds) ? odds.map((o) => JSON.stringify(o)) : oddKeys).join(' ').toLowerCase();
console.log('\nmarkets we need, by whether the identifier appears anywhere:');
for (const want of WANTED) console.log(`  ${want}: ${haystack.includes(want.replace(/_/g, '')) || haystack.includes(want) ? 'present' : 'not found'}`);
