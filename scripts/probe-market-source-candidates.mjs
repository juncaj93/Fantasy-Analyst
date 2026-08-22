/**
 * Which site actually publishes season-long *betting* lines a person can copy?
 *
 * The first source probe learned only that these pages are client-rendered and
 * that a datacenter IP gets a 403 from several of them. That answered nothing,
 * because "the HTML is empty" is true of every modern site and says nothing
 * about whether the data behind it exists or is free.
 *
 * So this one goes after the data rather than the page. Three things worth
 * knowing, in order of how much they settle:
 *
 *   1. **Embedded initial state.** Next.js and Nuxt ship the page's data inside
 *      the HTML (`__NEXT_DATA__`, `__NUXT__`, an inline JSON island). When it is
 *      there it is the whole answer: the real rows, before any rendering.
 *   2. **The API the page calls.** A bundle that fetches `/api/props?...` names
 *      its own endpoint, and an endpoint usually answers a plain GET.
 *   3. **Whether what comes back is a market or a model.** The distinction that
 *      cost us the last attempt: prices and book names mean a market; a
 *      projections column and whole-number stats mean somebody's model.
 *
 * Read-only, one pass per URL, prints only. Nothing here is a scraper and
 * nothing it finds becomes a recurring fetch — it exists to decide which page a
 * person should copy from once a preseason.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Not)A;Brand";v="24"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

const CANDIDATES = [
  // Fantasy Team Advice — named first in the brief.
  ['FTA season-long props', 'https://www.fantasyteamadvice.com/nfl/season-long-props'],
  ['FTA prop edge', 'https://www.fantasyteamadvice.com/nfl/prop-edge'],
  ['FTA props hub', 'https://www.fantasyteamadvice.com/props'],
  ['FTA home', 'https://www.fantasyteamadvice.com/'],
  ['FTA sitemap', 'https://www.fantasyteamadvice.com/sitemap.xml'],
  // BettingOdds.
  ['BettingOdds NFL player props', 'https://www.bettingodds.com/nfl/player-props'],
  ['BettingOdds NFL futures', 'https://www.bettingodds.com/nfl/futures'],
  ['BettingOdds NFL', 'https://www.bettingodds.com/nfl'],
  ['BettingOdds home', 'https://www.bettingodds.com/'],
  ['BettingOdds sitemap', 'https://www.bettingodds.com/sitemap.xml'],
];

async function get(url, headers = HEADERS) {
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, url: res.url, type: res.headers.get('content-type') ?? '', body };
  } catch (err) {
    return { status: 0, url, type: '', body: '', error: err.message };
  }
}

/** Pull any embedded initial-state JSON out of the HTML. */
function embeddedState(html) {
  const found = [];
  const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (next?.[1]) found.push(['__NEXT_DATA__', next[1]]);
  const nuxt = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/);
  if (nuxt?.[1]) found.push(['__NUXT__', nuxt[1]]);
  for (const m of html.matchAll(
    /<script[^>]*type="application\/json"[^>]*>([\s\S]{200,}?)<\/script>/g,
  )) {
    found.push(['inline json', m[1] ?? '']);
  }
  return found;
}

/** Market or model? The question that cost us the last attempt. */
function marketSignals(text) {
  const priceTokens = [...text.matchAll(/["\s>]([+-]\d{3})\b/g)].map((m) => m[1]);
  const books = [
    'draftkings',
    'fanduel',
    'betmgm',
    'caesars',
    'pointsbet',
    'bet365',
    'espnbet',
    'hardrock',
    'fanatics',
  ].filter((b) => new RegExp(b, 'i').test(text));
  return {
    prices: priceTokens.length,
    priceSample: [...new Set(priceTokens)].slice(0, 6),
    books,
    overUnderWords: /\bover\b[\s\S]{0,40}\bunder\b/i.test(text),
    // The model tell-tales, from the Win With Odds file.
    projectionWords: [...new Set((text.match(/projection|projected|fantasy points|our model/gi) ?? []).map((s) => s.toLowerCase()))],
    seasonWords: /season[- ]long|season total|full season|2026 season/i.test(text),
    marketWords: [
      'receiving yards',
      'rushing yards',
      'passing yards',
      'receptions',
      'passing touchdowns',
    ].filter((w) => new RegExp(w, 'i').test(text)),
    seasonScaleNumbers: [...new Set((text.match(/\b\d{3,4}\.5\b/g) ?? []))].slice(0, 8),
  };
}

/** API endpoints the page's own code names. */
function apiHints(html) {
  const hits = new Set();
  for (const m of html.matchAll(/["'`](\/api\/[a-z0-9\-_/]{3,60})["'`]/gi)) hits.add(m[1]);
  for (const m of html.matchAll(/["'`](https?:\/\/[a-z0-9.\-]*api[a-z0-9.\-]*\/[a-z0-9\-_/]{2,60})["'`]/gi)) {
    hits.add(m[1]);
  }
  return [...hits].slice(0, 12);
}

for (const [name, url] of CANDIDATES) {
  console.log(`\n\n========== ${name} ==========`);
  console.log(url);
  const res = await get(url);
  console.log(`status ${res.status}${res.error ? ` (${res.error})` : ''}  type=${res.type.split(';')[0]}  bytes=${res.body.length}`);
  if (res.url !== url) console.log(`redirected -> ${res.url}`);
  if (!res.body) {
    console.log('  no body');
    continue;
  }

  if (/sitemap/i.test(url)) {
    // A sitemap names the pages worth asking about, which is the cheapest way
    // past guessing URLs.
    const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const interesting = locs.filter((l) => /prop|future|season|odds|nfl/i.test(l));
    console.log(`  ${locs.length} urls; ${interesting.length} mention props/futures/season:`);
    for (const l of interesting.slice(0, 25)) console.log(`    ${l}`);
    continue;
  }

  const states = embeddedState(res.body);
  console.log(`  embedded state blocks: ${states.length ? states.map((s) => s[0]).join(', ') : 'none'}`);

  // Judge on the embedded data when it exists, on the raw HTML otherwise.
  const haystack = states.length ? states.map((s) => s[1]).join('\n') : res.body;
  const sig = marketSignals(haystack);
  console.log(`  season-long language : ${sig.seasonWords}`);
  console.log(`  market words         : ${sig.marketWords.join(', ') || 'none'}`);
  console.log(`  season-scale numbers : ${sig.seasonScaleNumbers.join(', ') || 'none'}`);
  console.log(`  american prices      : ${sig.prices} found ${sig.priceSample.length ? `(e.g. ${sig.priceSample.join(', ')})` : ''}`);
  console.log(`  sportsbooks named    : ${sig.books.join(', ') || 'none'}`);
  console.log(`  projection language  : ${sig.projectionWords.join(', ') || 'none'}`);

  const apis = apiHints(res.body);
  if (apis.length) console.log(`  api paths in the page: ${apis.join(' ')}`);

  const verdict = sig.prices > 0 && sig.books.length > 0
    ? 'MARKET — prices and book names present'
    : sig.prices > 0
      ? 'probably market — prices but no book named'
      : sig.projectionWords.length > 0
        ? 'MODEL — projection language and no prices'
        : 'undetermined from the served HTML';
  console.log(`  VERDICT              : ${verdict}`);
}

console.log('\n\n========== what this can and cannot settle ==========');
console.log('Prices plus a named book is proof of a market. No prices plus projection language is');
console.log('proof of a model. Anything else needs a person with a browser: a rendered page can');
console.log('carry data that never appears in the HTML this fetched.');
