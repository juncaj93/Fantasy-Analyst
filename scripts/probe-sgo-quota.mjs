/**
 * What does SportsGameOdds actually charge for?
 *
 * The refresh strategy depends entirely on the answer. If the free plan counts
 * requests, fetching a whole slate is sixteen units and the problem is small.
 * If it counts returned objects — which the current notes assume — then one
 * Sunday is ~3,200 units against 2,500 a month, and the fetch has to be
 * targeted before the provider can ever be switched on.
 *
 * So this measures rather than infers. It reads the account's own usage, makes
 * one deliberately small request, reads usage again, and reports the delta. The
 * same trick then prices each candidate query shape: a bare event listing, a
 * listing with odds, a single event, and a single event narrowed by market.
 *
 * Deliberately frugal: every request uses the smallest limit the endpoint
 * allows, and the whole run is a couple of dozen objects. Measuring the quota
 * must not be the thing that spends it.
 *
 * Read-only. Prints identifiers, counts and headers; never the key.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';

if (!KEY) {
  console.log('SPORTSGAMEODDS_API_KEY is not set for this run — nothing to ask.');
  process.exit(1);
}

/** Response headers worth seeing. Rate-limit headers are the cheapest usage meter there is. */
const INTERESTING_HEADER = /^(x-)?(ratelimit|rate-limit|quota|usage|objects?)/i;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Api-Key': KEY, accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  const headers = {};
  for (const [k, v] of res.headers) if (INTERESTING_HEADER.test(k)) headers[k] = v;
  return { status: res.status, json, text: text.slice(0, 400), headers };
}

/* ------------------------------------------------------------------ usage */

/**
 * The account's own view of what it has spent.
 *
 * Documented endpoints move; rather than trusting one name, ask the plausible
 * ones and use whichever answers. If none does, the run falls back to counting
 * objects in the payloads, which is an estimate and is labelled as one.
 */
const USAGE_PATHS = ['/account/usage', '/account', '/usage', '/account/limits'];
let usagePath = null;

async function readUsage() {
  if (usagePath) {
    const res = await get(usagePath);
    return res.status === 200 ? res.json : null;
  }
  for (const path of USAGE_PATHS) {
    const res = await get(path);
    console.log(`  ${path} -> HTTP ${res.status}`);
    if (res.status === 200) {
      usagePath = path;
      console.log(`  usage endpoint: ${path}`);
      console.log(`  ${JSON.stringify(res.json).slice(0, 600)}`);
      return res.json;
    }
  }
  return null;
}

/** Pull whatever looks like a running total out of an arbitrary usage payload. */
function usageNumbers(payload) {
  const out = {};
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number') out[key] = v;
      else if (v && typeof v === 'object') walk(v, key);
    }
  };
  walk(payload, '');
  return out;
}

function deltaOf(before, after) {
  const a = usageNumbers(before);
  const b = usageNumbers(after);
  const changed = {};
  for (const [k, v] of Object.entries(b)) if (a[k] !== v) changed[k] = `${a[k] ?? '—'} -> ${v}`;
  return changed;
}

/* ---------------------------------------------------------------- objects */

/** How many odds objects a payload actually carries, and how many we would keep. */
const WANTED_STATS = new Set([
  'passing_yards',
  'passing_touchdowns',
  'rushing_yards',
  'receiving_receptions',
  'receptions',
  'receiving_yards',
  'touchdowns',
]);

function countOdds(events) {
  let odds = 0;
  let gameLines = 0;
  let wanted = 0;
  let overOnly = 0;
  for (const event of events) {
    for (const odd of Object.values(event.odds ?? {})) {
      odds++;
      if (odd.betTypeID === 'ou' && odd.periodID === 'game') gameLines++;
      const isWanted =
        odd.betTypeID === 'ou' && odd.periodID === 'game' && WANTED_STATS.has(odd.statID ?? '');
      if (isWanted) {
        wanted++;
        if (odd.sideID === 'over') overOnly++;
      }
    }
  }
  return { events: events.length, odds, gameLines, wanted, overOnly };
}

/* -------------------------------------------------------------------- run */

console.log('1. Does the account expose its own usage?\n');
let usage = await readUsage();
if (!usage) console.log('  no usage endpoint answered; falling back to payload counting\n');

const measurements = [];

async function measure(label, path) {
  const before = usage;
  const res = await get(path);
  const events = res.json?.data ?? [];
  const counted = Array.isArray(events) ? countOdds(events.filter((e) => e && typeof e === 'object')) : null;
  usage = await readUsage();
  const delta = before && usage ? deltaOf(before, usage) : {};

  measurements.push({ label, path, status: res.status, counted, delta, headers: res.headers });
  console.log(`\n── ${label}`);
  console.log(`   ${path}`);
  console.log(`   HTTP ${res.status}`);
  if (res.status !== 200) console.log(`   body: ${res.text}`);
  if (counted) {
    console.log(
      `   ${counted.events} event(s), ${counted.odds} odds object(s), ${counted.gameLines} full-game o/u, ` +
        `${counted.wanted} in our market whitelist, ${counted.overOnly} of those are the over side we keep`,
    );
  }
  if (Object.keys(res.headers).length > 0) console.log(`   headers: ${JSON.stringify(res.headers)}`);
  if (Object.keys(delta).length > 0) console.log(`   usage delta: ${JSON.stringify(delta)}`);
  return res;
}

console.log('\n2. What does each candidate query shape cost?');

// The cheapest possible thing: one event, no odds asked for.
const bare = await measure('event listing, no odds', '/events?leagueID=NFL&type=match&limit=1');
const eventId = bare.json?.data?.[0]?.eventID ?? null;

await measure('event listing, odds included', '/events?leagueID=NFL&type=match&oddsAvailable=true&limit=1');

if (eventId) {
  await measure('one event by id', `/events?eventID=${encodeURIComponent(eventId)}`);

  // Server-side market filtering is the whole question. If `oddIDs` is honoured
  // and charged by what comes back, a targeted fetch is cheap; if it is not,
  // every fetch pays for the event's entire odds board.
  await measure(
    'one event, one market via oddIDs',
    `/events?eventID=${encodeURIComponent(eventId)}&oddIDs=receiving_yards-all-game-ou-over`,
  );
  await measure(
    'one event, market group filter',
    `/events?eventID=${encodeURIComponent(eventId)}&marketOddsAvailable=true&statID=receiving_yards`,
  );
  await measure(
    'one event, single bookmaker',
    `/events?eventID=${encodeURIComponent(eventId)}&bookmakerID=fanduel`,
  );
  await measure(
    'one event, no alternate lines',
    `/events?eventID=${encodeURIComponent(eventId)}&includeAltLine=false`,
  );
}

console.log('\n3. Summary\n');
for (const m of measurements) {
  const cost = Object.keys(m.delta).length > 0 ? JSON.stringify(m.delta) : 'no usage signal';
  console.log(
    `  ${m.label.padEnd(38)} HTTP ${m.status}  ` +
      `${m.counted ? `${m.counted.odds} odds / ${m.counted.overOnly} kept` : '—'}  ${cost}`,
  );
}

console.log(`\nusage endpoint: ${usagePath ?? 'none found'}`);
console.log('Nothing was written anywhere. This run only read.');
