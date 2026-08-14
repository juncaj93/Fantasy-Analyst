/**
 * Can we ask nflverse "has this changed?" without downloading it?
 *
 * The whole five-minute cadence rests on this. If the answer is no, checking
 * every five minutes means downloading a 700KB file 288 times a day and the
 * design has to change. So this is asked of the real endpoint rather than
 * assumed from how HTTP is supposed to work.
 *
 * The complication is the shape of the URL. A GitHub release asset is a 302 to
 * a signed CDN URL whose query string carries an expiry and a signature — so
 * the redirect target is different on every request even when the file is not,
 * and any fingerprint taken from the URL itself would report a change every
 * time. What matters is whether the validators survive the redirect.
 *
 * Read-only. No key, no account.
 */

const SEASONS = ['2025', '2024'];
const url = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;

function show(label, value) {
  console.log(`  ${label.padEnd(22)} ${value ?? '—'}`);
}

for (const season of SEASONS) {
  console.log(`\n=== injuries_${season}.csv`);

  // 1. Does HEAD work at all, and does it carry validators?
  let head;
  try {
    head = await fetch(url(season), { method: 'HEAD' });
  } catch (err) {
    console.log(`  HEAD threw: ${err.message}`);
    continue;
  }
  console.log(`\n  HEAD -> ${head.status}`);
  show('etag', head.headers.get('etag'));
  show('last-modified', head.headers.get('last-modified'));
  show('content-length', head.headers.get('content-length'));
  show('cache-control', head.headers.get('cache-control'));

  if (!head.ok) continue;

  // 2. Are they stable across two calls? A validator that changes on its own
  //    is worse than none: it would report a change every five minutes.
  const second = await fetch(url(season), { method: 'HEAD' });
  const stable =
    second.headers.get('etag') === head.headers.get('etag') &&
    second.headers.get('last-modified') === head.headers.get('last-modified');
  console.log(`\n  stable across two HEADs? ${stable ? 'yes' : 'NO — unusable'}`);
  if (!stable) {
    show('etag #2', second.headers.get('etag'));
    show('last-modified #2', second.headers.get('last-modified'));
  }

  /*
   * 3. Does the server actually honour a conditional request?
   *
   * This is the one that decides the architecture. A 304 means the common
   * five-minute tick costs one round trip and no body at all.
   */
  const etag = head.headers.get('etag');
  const lastModified = head.headers.get('last-modified');

  if (etag) {
    const res = await fetch(url(season), { headers: { 'if-none-match': etag } });
    console.log(`\n  GET If-None-Match -> ${res.status} ${res.status === 304 ? '(not modified)' : ''}`);
    if (res.status !== 304) {
      const body = await res.text();
      show('body bytes', body.length);
    }
  }

  if (lastModified) {
    const res = await fetch(url(season), { headers: { 'if-modified-since': lastModified } });
    console.log(`  GET If-Modified-Since -> ${res.status} ${res.status === 304 ? '(not modified)' : ''}`);
    if (res.status !== 304) {
      const body = await res.text();
      show('body bytes', body.length);
    }
  }

  // 4. And a deliberately stale validator must NOT come back 304, or the
  //    mechanism would never notice a real change.
  const stale = new Date(Date.parse(lastModified ?? '') - 86_400_000).toUTCString();
  const staleRes = await fetch(url(season), { headers: { 'if-modified-since': stale } });
  console.log(
    `  GET If-Modified-Since (a day earlier) -> ${staleRes.status} ` +
      `${staleRes.status === 200 ? '(change detected, correct)' : '(WRONG — would miss updates)'}`,
  );
  if (staleRes.status === 200) show('body bytes', (await staleRes.text()).length);

  /*
   * 5. What the redirect actually looks like, since that is what makes this
   *    non-obvious. Recorded so the next person does not have to rediscover
   *    that the signed URL is not a usable fingerprint.
   */
  const noFollow = await fetch(url(season), { method: 'HEAD', redirect: 'manual' });
  console.log(`\n  raw request -> ${noFollow.status}`);
  const location = noFollow.headers.get('location');
  if (location) {
    const parsed = new URL(location);
    show('redirect host', parsed.host);
    show('signed params', [...parsed.searchParams.keys()].join(', '));
  }
}

console.log('\n(the 2026 file is expected to 404 until the season starts)');
const preseason = await fetch(url('2026'), { method: 'HEAD' });
console.log(`injuries_2026.csv HEAD -> ${preseason.status}`);
