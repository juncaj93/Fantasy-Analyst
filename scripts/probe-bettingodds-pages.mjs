/**
 * Follow BettingOdds' own sitemap to the page a person would copy from.
 *
 * The first pass established two things worth building on: Fantasy Team Advice
 * answers a datacenter IP with 403 on every URL including its sitemap — an edge
 * block, so nothing about it can be learned from a runner at all — while
 * BettingOdds answers 200 and publishes a sitemap index. Guessed URLs 404'd,
 * which is a fact about the guess rather than about the site.
 *
 * So this stops guessing. It reads the sub-sitemaps, picks the pages whose URLs
 * mention the NFL and props or futures, and asks the same market-or-model
 * question of each. Where a page turns out to be client-rendered it goes one
 * level further and reads the page's own JavaScript for the endpoint it calls,
 * because an endpoint usually answers a plain GET and is the shortest path to
 * "what data is actually behind this".
 *
 * Read-only, printed, nothing stored and nothing automated.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const SITEMAPS = [
  'https://www.bettingodds.com/sitemap-pages0.xml',
  'https://www.bettingodds.com/sitemap-articles0.xml',
];

async function get(url, headers = HEADERS) {
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    return { status: res.status, url: res.url, body: await res.text() };
  } catch (err) {
    return { status: 0, url, body: '', error: err.message };
  }
}

function prices(text) {
  return [...new Set([...text.matchAll(/["\s>(]([+-]\d{3})\b/g)].map((m) => m[1]))];
}

function books(text) {
  return ['draftkings', 'fanduel', 'betmgm', 'caesars', 'bet365', 'espnbet', 'fanatics', 'pointsbet'].filter(
    (b) => new RegExp(b, 'i').test(text),
  );
}

function marketWords(text) {
  return [
    'receiving yards',
    'rushing yards',
    'passing yards',
    'receptions',
    'passing touchdowns',
    'rushing touchdowns',
  ].filter((w) => new RegExp(w, 'i').test(text));
}

console.log('=== reading the sitemaps ===');
const pages = new Set();
for (const sm of SITEMAPS) {
  const res = await get(sm);
  const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  console.log(`${sm} -> ${res.status}, ${locs.length} urls`);
  for (const l of locs) {
    if (/nfl/i.test(l) && /prop|future|season|odds/i.test(l)) pages.add(l);
  }
}

console.log(`\n${pages.size} NFL prop/futures/odds pages named by the sitemap:`);
for (const p of [...pages].slice(0, 40)) console.log(`  ${p}`);

// Ask the market-or-model question of the most promising handful.
const ranked = [...pages].sort((a, b) => {
  const score = (u) => (/player/i.test(u) ? 2 : 0) + (/prop/i.test(u) ? 2 : 0) + (/season|future/i.test(u) ? 1 : 0);
  return score(b) - score(a);
});

for (const url of ranked.slice(0, 6)) {
  console.log(`\n\n========== ${url} ==========`);
  const res = await get(url);
  console.log(`status ${res.status} bytes=${res.body.length}`);
  if (!res.body) continue;

  const p = prices(res.body);
  const b = books(res.body);
  const m = marketWords(res.body);
  console.log(`  prices  : ${p.length} ${p.slice(0, 8).join(', ')}`);
  console.log(`  books   : ${b.join(', ') || 'none'}`);
  console.log(`  markets : ${m.join(', ') || 'none'}`);
  console.log(`  season  : ${/season[- ]long|season total|2026 season/i.test(res.body)}`);
  console.log(`  tables  : <table>=${(res.body.match(/<table[\s>]/gi) ?? []).length}`);

  if (p.length === 0) {
    // Client-rendered: read the page's own scripts for the endpoint it calls.
    const scripts = [...res.body.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
      .map((s) => new URL(s[1], url).href)
      .filter((s) => /\.js/.test(s))
      .slice(0, 4);
    const apis = new Set();
    for (const src of scripts) {
      const js = await get(src);
      for (const hit of js.body.matchAll(/["'`](https?:\/\/[a-z0-9.\-]+\/[a-z0-9\-_/]{3,60}|\/api\/[a-z0-9\-_/]{3,60})["'`]/gi)) {
        if (/api|odds|prop|feed|graphql/i.test(hit[1])) apis.add(hit[1]);
      }
    }
    console.log(`  endpoints named by its own javascript: ${[...apis].slice(0, 10).join(' ') || 'none found'}`);
  }
}

console.log('\n\n=== note ===');
console.log('Fantasy Team Advice answers 403 to every request from this network, sitemap included,');
console.log('so nothing about it can be established here. Whether it is usable is a question only');
console.log('a person with a browser can answer.');
