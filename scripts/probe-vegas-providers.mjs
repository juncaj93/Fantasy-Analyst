/**
 * Which odds provider is actually free enough to use?
 *
 * The brief names three in preference order — SharpAPI, SportsGameOdds, The
 * Odds API — and says to pick on observed coverage rather than on the order.
 * That decision costs the user a signup, so it should be made against current
 * published limits rather than remembered ones.
 *
 * What matters, in order:
 *   1. is there a genuinely free tier, with no card;
 *   2. does it carry NFL *player props*, not just game lines;
 *   3. how many requests, and does that survive a weekly refresh cadence.
 *
 * Prints only; changes nothing. No key is used, so most endpoints answer 401 —
 * the point is the documentation and the shape of the refusal.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function fetchText(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...(opts.headers ?? {}) }, redirect: 'follow' });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: `fetch failed: ${err.message}` };
  }
}

/** Pull the sentences that mention money or quotas out of a docs page. */
function quotaLines(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const wanted =
    /(free|trial|no credit card|credit card|per month|\/month|requests|credits|calls|rate limit|\$\d)/i;
  return [...new Set(text.split(/(?<=[.!?])\s+/).filter((s) => wanted.test(s) && s.length < 220))].slice(0, 8);
}

const PROVIDERS = [
  {
    name: 'SharpAPI',
    docs: ['https://sharpapi.com/', 'https://sharpapi.com/pricing'],
    api: 'https://api.sharpapi.com/v1/sports/nfl/odds',
  },
  {
    name: 'SportsGameOdds',
    docs: ['https://sportsgameodds.com/pricing/', 'https://sportsgameodds.com/'],
    api: 'https://api.sportsgameodds.com/v2/events?leagueID=NFL',
  },
  {
    name: 'The Odds API',
    docs: ['https://the-odds-api.com/#get-access', 'https://the-odds-api.com/'],
    api: 'https://api.the-odds-api.com/v4/sports',
  },
];

for (const provider of PROVIDERS) {
  console.log(`\n================ ${provider.name} ================`);

  for (const url of provider.docs) {
    const { status, text } = await fetchText(url);
    console.log(`  docs ${status}  ${url}`);
    if (status === 200) for (const line of quotaLines(text)) console.log(`      ${line.trim()}`);
  }

  const { status, text } = await fetchText(provider.api);
  console.log(`  api  ${status}  ${provider.api}`);
  console.log(`      ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
}

// Player props are the part that separates a usable provider from a scoreboard.
console.log('\n================ NFL player-prop coverage ================');
const propDocs = [
  ['The Odds API', 'https://the-odds-api.com/sports-odds-data/betting-markets.html'],
  ['SportsGameOdds', 'https://sportsgameodds.com/docs/data/markets'],
  ['SharpAPI', 'https://sharpapi.com/documentation'],
];
for (const [name, url] of propDocs) {
  const { status, text } = await fetchText(url);
  const keys = [...new Set((text.match(/player_[a-z_]+/g) ?? []))];
  const mentionsProps = /player prop|player props|passing yards|receiving yards|anytime touchdown/i.test(text);
  console.log(`  ${name}: ${status} | player_* keys: ${keys.length} | mentions props: ${mentionsProps}`);
  if (keys.length) console.log(`      ${keys.slice(0, 12).join(', ')}`);
}
