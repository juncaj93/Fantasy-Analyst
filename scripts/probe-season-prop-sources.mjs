/**
 * Where can a person actually copy season-long NFL market lines from?
 *
 * SportsGameOdds publishes none — established twice, most recently against a
 * 344-market catalogue with no season period in it — so the season-long side of
 * the draft board has to come from a human copying a table once or twice a
 * preseason. This asks which tables are worth copying.
 *
 * It is an investigation, not a scraper: it fetches each candidate once, says
 * what shape the page is in, and prints nothing that would let anything be
 * imported automatically. Nothing here becomes a recurring fetch.
 *
 * The question that actually decides the workflow is not "is the data there"
 * but "does it survive a Cmd-C". A real <table> pastes into Numbers or a
 * textarea as clean TSV; a virtualised div grid or a canvas pastes as a column
 * of orphaned words, and that is the case the ChatGPT normalisation fallback
 * exists for. So for each candidate this reports:
 *
 *   - reachable at all, and under what status;
 *   - whether the season-long page is behind a login or a paywall;
 *   - whether the numbers are in the HTML or arrive later from an XHR (a page
 *     whose table is empty in the source is a page a person can still copy from
 *     the browser, but not one whose shape can be verified from here);
 *   - <table> vs div-grid vs canvas — the copy-fidelity question;
 *   - whether an export/download link exists;
 *   - whether what is published is a real market line or somebody's own
 *     fantasy projection, which is a different thing and must not be imported
 *     as a betting line.
 *
 * Prints only. Changes nothing, stores nothing, sends no credentials.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const CANDIDATES = [
  { name: 'Win With Odds — NFL season long', url: 'https://winwithodds.com/nfl-season-long-props' },
  { name: 'Win With Odds — home', url: 'https://winwithodds.com/' },
  { name: 'Fantasy Team Advice — season props', url: 'https://www.fantasyteamadvice.com/season-long-props' },
  { name: 'Fantasy Team Advice — prop edge', url: 'https://www.fantasyteamadvice.com/prop-edge' },
  { name: 'Fantasy Team Advice — home', url: 'https://www.fantasyteamadvice.com/' },
  { name: 'Sportsbook Review — NFL season props', url: 'https://www.sportsbookreview.com/betting-odds/nfl-football/player-props/' },
  { name: 'Action Network — NFL futures', url: 'https://www.actionnetwork.com/nfl/props' },
  { name: 'BetMGM — NFL season specials', url: 'https://sports.betmgm.com/en/sports/football-11/betting/usa-9/nfl-35' },
];

async function get(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    return { status: res.status, finalUrl: res.url, html: await res.text() };
  } catch (err) {
    return { status: 0, finalUrl: url, html: '', error: err.message };
  }
}

/** Strip tags for the prose tests, keeping it cheap and obvious. */
function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Does this page carry season-shaped market language, and does it carry the
 * numbers to go with it? Both, or it is not a source.
 */
function seasonSignals(html) {
  const t = text(html);
  const marketWords = [
    'receiving yards',
    'rushing yards',
    'passing yards',
    'receptions',
    'passing touchdowns',
    'rushing touchdowns',
    'receiving touchdowns',
  ].filter((w) => new RegExp(w, 'i').test(t));

  // A season receiving-yards line is a four-figure number, usually with a half
  // point. A weekly one is two or three figures. The magnitude is the tell.
  const seasonScale = [...t.matchAll(/\b(\d{3,4}\.5)\b/g)].map((m) => m[1]).slice(0, 12);
  const priceLike = [...t.matchAll(/([+-]\d{3})\b/g)].map((m) => m[1]).slice(0, 8);

  return {
    saysSeasonLong: /season[- ]long|season total|full season/i.test(t),
    marketWords,
    seasonScale,
    priceLike,
    // The distinction that matters most for integrity: a site's own projection
    // is not a sportsbook's line and must never be imported as one.
    mentionsProjection: /projection|projected|our model|fantasy points/i.test(t),
  };
}

/** How well would this survive a copy-paste? */
function copyShape(html) {
  const tables = (html.match(/<table[\s>]/gi) ?? []).length;
  const rows = (html.match(/<tr[\s>]/gi) ?? []).length;
  const canvas = (html.match(/<canvas[\s>]/gi) ?? []).length;
  const gridRole = (html.match(/role=["'](grid|row|gridcell)["']/gi) ?? []).length;
  const download = [...html.matchAll(/href=["']([^"']*(?:\.csv|export|download)[^"']*)["']/gi)]
    .map((m) => m[1])
    .slice(0, 5);
  return { tables, rows, canvas, gridRole, download };
}

function gate(html) {
  const t = text(html);
  return {
    login: /sign in|log in|create account|subscribe to view/i.test(t),
    paywall: /upgrade|premium|pro plan|paid plan|subscription required/i.test(t),
    cloudflare: /just a moment|checking your browser|cf-browser-verification/i.test(t),
  };
}

for (const c of CANDIDATES) {
  console.log(`\n\n========== ${c.name} ==========`);
  console.log(c.url);
  const res = await get(c.url);
  console.log(`status ${res.status}${res.error ? ` (${res.error})` : ''}`);
  if (res.finalUrl !== c.url) console.log(`redirected to ${res.finalUrl}`);
  if (!res.html) {
    console.log('  no body — cannot characterise');
    continue;
  }
  console.log(`  html bytes: ${res.html.length}`);

  const g = gate(res.html);
  console.log(`  gates      : login=${g.login} paywall=${g.paywall} bot-check=${g.cloudflare}`);

  const s = seasonSignals(res.html);
  console.log(`  season-long language : ${s.saysSeasonLong}`);
  console.log(`  market words present : ${s.marketWords.join(', ') || 'none'}`);
  console.log(`  season-scale numbers : ${s.seasonScale.join(', ') || 'none in the HTML'}`);
  console.log(`  american prices      : ${s.priceLike.join(', ') || 'none in the HTML'}`);
  console.log(`  mentions projections : ${s.mentionsProjection}  <- if true, check it is not a model output`);

  const shape = copyShape(res.html);
  console.log(
    `  copy shape : <table>=${shape.tables} <tr>=${shape.rows} <canvas>=${shape.canvas} ` +
      `aria-grid=${shape.gridRole}`,
  );
  console.log(`  export links: ${shape.download.join(', ') || 'none found'}`);

  // The verdict a person needs, stated plainly.
  const numbersInHtml = s.seasonScale.length > 0;
  const copyable = shape.tables > 0 && shape.rows > 5;
  console.log(
    `  VERDICT    : ${
      !numbersInHtml
        ? 'numbers are NOT in the served HTML — rendered client-side, so shape cannot be verified from here'
        : copyable
          ? 'real <table> with season-scale numbers — a browser copy should paste as clean TSV'
          : 'numbers present but not in a <table> — a copy will likely paste as unstructured text'
    }`,
  );
}

console.log('\n\n========== note ==========');
console.log('A page whose numbers are absent from the served HTML is not disqualified: a person');
console.log('copying from a rendered browser still gets them. It only means this probe cannot');
console.log('prove the clipboard shape, which is exactly the uncertainty the ChatGPT');
console.log('normalisation fallback is there to absorb.');
