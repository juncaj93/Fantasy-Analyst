/**
 * How does the SportsGameOdds bill scale?
 *
 * The first quota probe established the unit: usage is counted in *entities*,
 * and one request for one event cost exactly one entity even when the response
 * carried 194 odds objects. That contradicts the assumption in docs/VEGAS.md
 * that a Sunday slate costs ~3,200 units, and it changes the whole fetch
 * strategy — so before rewriting anything, the two follow-up questions:
 *
 *   1. what are the account's real per-month limits (the first read truncated
 *      the payload before the monthly line);
 *   2. does a listing that returns N events cost N entities or one — which is
 *      the difference between "list the slate freely" and "never list it".
 *
 * Also checks whether server-side odd filtering works on a real player market,
 * because payload size still matters for the worker's CPU and D1 rows even
 * when it does not matter for the bill.
 *
 * Read-only. The account payload carries an email, a customer id and a key
 * hash; all three are redacted before printing, because these logs are public.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

const SECRET_FIELDS = new Set(['keyID', 'customerID', 'email', 'apiKey', 'name']);

function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = SECRET_FIELDS.has(k) ? '[redacted]' : redact(v);
    return out;
  }
  return node;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Api-Key': KEY, accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

/** Reading usage does not itself move the counters — established by the first probe. */
async function usage() {
  const res = await get('/account/usage');
  return res.json?.data?.rateLimits ?? null;
}

function monthly(limits) {
  return limits?.['per-month']?.['current-entities'] ?? null;
}

console.log('1. The account, in full (minus anything identifying)\n');
const account = await get('/account/usage');
console.log(JSON.stringify(redact(account.json), null, 2));

console.log('\n2. Does a listing cost one entity, or one per event returned?\n');

let before = monthly(await usage());
async function priceOf(label, path) {
  const res = await get(path);
  const events = res.json?.data ?? [];
  const after = monthly(await usage());
  const cost = before != null && after != null ? after - before : null;
  before = after;
  const odds = Array.isArray(events)
    ? events.reduce((sum, e) => sum + Object.keys(e?.odds ?? {}).length, 0)
    : 0;
  console.log(
    `  ${label.padEnd(34)} HTTP ${res.status}  ` +
      `${Array.isArray(events) ? events.length : 0} event(s), ${odds} odds object(s)  ` +
      `cost ${cost == null ? 'unknown' : `${cost} entit${cost === 1 ? 'y' : 'ies'}`}`,
  );
  return events;
}

await priceOf('listing, limit=1', '/events?leagueID=NFL&type=match&limit=1');
const five = await priceOf('listing, limit=5', '/events?leagueID=NFL&type=match&limit=5');
await priceOf('listing, limit=10', '/events?leagueID=NFL&type=match&limit=10');

console.log('\n3. Can a fetch be narrowed to the markets we keep?\n');

const event = Array.isArray(five) ? five[0] : null;
const eventId = event?.eventID ?? null;
if (eventId) {
  // A real player-market odd id off this very event, rather than a guessed one.
  const sample = Object.values(event.odds ?? {}).find(
    (o) => o?.betTypeID === 'ou' && o?.periodID === 'game' && o?.playerID && o?.sideID === 'over',
  );
  console.log(`  sample odd id on this event: ${sample?.oddID ?? 'none found'}`);

  if (sample?.oddID) {
    const narrowed = await priceOf(
      'one event, one real player oddID',
      `/events?eventID=${encodeURIComponent(eventId)}&oddIDs=${encodeURIComponent(sample.oddID)}`,
    );
    const kept = Array.isArray(narrowed) ? Object.keys(narrowed[0]?.odds ?? {}).length : 0;
    console.log(`  narrowed response carries ${kept} odds object(s)`);
  }

  // Several events in one request: if this is honoured and priced per event, it
  // is the cheapest shape there is for a roster that spans eight games.
  const ids = (Array.isArray(five) ? five : []).slice(0, 3).map((e) => e.eventID).filter(Boolean);
  if (ids.length > 1) {
    await priceOf('three events in one request', `/events?eventID=${encodeURIComponent(ids.join(','))}`);
  }
}

console.log('\nNothing was written anywhere. This run only read.');
