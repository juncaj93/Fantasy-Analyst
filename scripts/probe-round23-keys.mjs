/**
 * Round 23: do the two new odds keys work? One test call each. Never prints a key.
 *
 *   - TheRundown: one request for the next Sunday's NFL games (a few hundred
 *     data points of the 20,000 a day free). Prints the status, the answer's
 *     shape (field names) and, per game, the books with a total and a spread,
 *     so the adapter's reading can be checked against the real thing.
 *   - The Odds API: first `/sports`, which is free (0 credits), to check the key;
 *     then one totals-and-spreads request for the slate (2 of 500 credits), for
 *     the same shape check.
 *
 * No database is read. Env: THERUNDOWN_API_KEY, ODDS_API_KEY (Probe workflow).
 */

const RUNDOWN = process.env.THERUNDOWN_API_KEY ?? '';
const ODDS = process.env.ODDS_API_KEY ?? '';

const heading = (t) => console.log(`\n${'#'.repeat(60)}\n# ${t}\n${'#'.repeat(60)}`);

function shape(value, depth = 0, maxDepth = 3) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : depth >= maxDepth ? `[${value.length}]` : `[${value.length}] of ${shape(value[0], depth + 1, maxDepth)}`;
  if (typeof value === 'object') {
    if (depth >= maxDepth) return '{…}';
    return `{ ${Object.keys(value).slice(0, 20).map((k) => `${k}: ${shape(value[k], depth + 1, maxDepth)}`).join(', ')} }`;
  }
  return typeof value;
}

/** The headers worth seeing: quotas and limits, never anything that could echo a key. */
function quotaHeaders(headers) {
  return [...headers.entries()].filter(([k]) => /remaining|used|last|limit|datapoint|credit/i.test(k)).map(([k, v]) => `${k}: ${v}`);
}

function nextSunday() {
  const d = new Date();
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const add = (7 - et.getDay()) % 7;
  et.setDate(et.getDate() + add);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

heading('TheRundown');
if (!RUNDOWN) {
  console.log('THERUNDOWN_API_KEY is not set: TheRundown stays off. Nothing asked.');
} else {
  const date = nextSunday();
  try {
    const res = await fetch(`https://therundown.io/api/v1/sports/2/events/${date}?offset=300`, {
      headers: { 'X-TheRundown-Key': RUNDOWN, accept: 'application/json' },
    });
    console.log(`GET events for ${date}: HTTP ${res.status} ${res.ok ? '(key works)' : '(refused)'}`);
    for (const h of quotaHeaders(res.headers)) console.log(`  ${h}`);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      console.log('  answer was not JSON:', text.slice(0, 120));
    }
    if (body) {
      console.log('  shape:', shape(body, 0, 2));
      const events = body.events ?? [];
      console.log(`  games: ${events.length}`);
      if (events[0]) {
        console.log('  one game:', shape(events[0], 0, 2));
        console.log('  teams:', JSON.stringify((events[0].teams_normalized ?? events[0].teams ?? []).map((t) => ({ abbreviation: t.abbreviation, name: t.name, mascot: t.mascot, is_home: t.is_home }))));
        const lines = Object.entries(events[0].lines ?? {});
        if (lines[0]) console.log('  one book line:', shape(lines[0][1], 0, 2));
      }
      for (const e of events.slice(0, 16)) {
        const teams = (e.teams_normalized ?? e.teams ?? []).map((t) => t.abbreviation ?? t.name).join(' @ ');
        const books = Object.values(e.lines ?? {})
          .map((l) => `${l.affiliate?.affiliate_name ?? '?'} ${l.total?.total_over ?? '-'}/${l.spread?.point_spread_home ?? '-'}`)
          .join(', ');
        console.log(`  ${e.event_date} ${teams}: ${books || '(no lines)'}`);
      }
    }
  } catch (err) {
    console.log(`network error: ${err.message}`);
  }
}

heading('The Odds API');
if (!ODDS) {
  console.log('ODDS_API_KEY is not set: The Odds API stays off. Nothing asked.');
} else {
  const base = 'https://api.the-odds-api.com/v4';
  const q = (params) => new URLSearchParams({ ...params, apiKey: ODDS }).toString();
  try {
    const free = await fetch(`${base}/sports?${q({})}`);
    console.log(`GET /sports (free): HTTP ${free.status} ${free.ok ? '(key works)' : '(refused)'}`);
    for (const h of quotaHeaders(free.headers)) console.log(`  ${h}`);
    if (free.ok) {
      const res = await fetch(`${base}/sports/americanfootball_nfl/odds?${q({ regions: 'us', markets: 'totals,spreads', oddsFormat: 'american', dateFormat: 'iso' })}`);
      console.log(`GET NFL totals and spreads (2 credits): HTTP ${res.status}`);
      for (const h of quotaHeaders(res.headers)) console.log(`  ${h}`);
      const body = await res.json().catch(() => null);
      if (Array.isArray(body)) {
        console.log(`  games: ${body.length}`);
        if (body[0]) console.log('  one game:', shape(body[0], 0, 3));
        for (const g of body.slice(0, 16)) {
          const books = (g.bookmakers ?? [])
            .map((b) => {
              const tot = b.markets?.find((m) => m.key === 'totals')?.outcomes?.find((o) => o.name === 'Over')?.point ?? '-';
              const sp = b.markets?.find((m) => m.key === 'spreads')?.outcomes?.find((o) => o.name === g.home_team)?.point ?? '-';
              return `${b.key} ${tot}/${sp}`;
            })
            .join(', ');
          console.log(`  ${g.commence_time} ${g.away_team} @ ${g.home_team}: ${books}`);
        }
      }
    }
  } catch {
    // The URL carries the key, and a fetch error can repeat the URL: say nothing more.
    console.log('network error');
  }
}
