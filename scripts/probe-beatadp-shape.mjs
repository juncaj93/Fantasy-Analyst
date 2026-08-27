/**
 * What shape is the beatadp platform-ADP page in today?
 *
 * `refresh-adp.yml` has failed on every scheduled run since 2026-08-16 with
 * `applied: undefined undefined undefined` — the parser found no `filters`
 * object in the page at all. That is either an empty flight payload (the page
 * stopped being a streamed RSC render, or is now behind a challenge) or a
 * renamed key. This prints enough of the page's actual structure to tell those
 * apart without guessing.
 *
 * Prints only; changes nothing. Temporary: delete once the parser is fixed.
 */

import { decodeFlight } from '../src/core/adp/beatadp.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const url = new URL('https://www.beatadp.com/platform-adp');
url.searchParams.set('scoringFormat', 'HALF_PPR');
url.searchParams.set('draftType', 'REDRAFT');
url.searchParams.set('qbType', '1QB');

const res = await fetch(url, { headers: { 'user-agent': UA } });
const html = await res.text();

console.log('=== response ===');
console.log('  url:         ', url.toString());
console.log('  status:      ', res.status, res.statusText);
console.log('  content-type:', res.headers.get('content-type'));
console.log('  x-powered-by:', res.headers.get('x-powered-by'));
console.log('  html bytes:  ', html.length);

const pushes = [...html.matchAll(/self\.__next_f\.push\(\[/g)].length;
const flight = decodeFlight(html);
console.log('\n=== flight ===');
console.log('  __next_f.push( occurrences:', pushes);
console.log('  decoded flight bytes:      ', flight.length);

const MARKERS = [
  '"filters"',
  'scoringFormat',
  'draftType',
  'qbType',
  '"rows"',
  '"adps"',
  '"fullName"',
  '"players"',
  '"adp"',
  '"platform"',
  'HALF_PPR',
  'REDRAFT',
];
const haystack = flight.length > 0 ? flight : html;
console.log('\n=== markers in', flight.length > 0 ? 'flight' : 'raw html', '===');
for (const m of MARKERS) {
  const count = haystack.split(m).length - 1;
  console.log(`  ${m.padEnd(16)} ${count}`);
}

const context = (marker, limit = 3, before = 80, after = 220) => {
  console.log(`\n--- context: ${marker} ---`);
  let from = 0;
  for (let i = 0; i < limit; i++) {
    const at = haystack.indexOf(marker, from);
    if (at < 0) {
      if (i === 0) console.log('  (not present)');
      return;
    }
    console.log(
      `  [${at}] ${JSON.stringify(haystack.slice(Math.max(0, at - before), at + after))}`,
    );
    from = at + marker.length;
  }
};

context('scoringFormat');
context('"adps"');
context('"fullName"');
context('HALF_PPR');

console.log('\n=== first 1200 bytes of the payload we parse ===');
console.log(JSON.stringify(haystack.slice(0, 1200)));

console.log('\n=== first 600 bytes of raw html ===');
console.log(JSON.stringify(html.slice(0, 600)));

// A page that moved its table to a client fetch would name the endpoint here.
console.log('\n=== api-looking paths in the html ===');
const paths = new Set(
  [...html.matchAll(/["'](\/(?:api|_next\/data|trpc)\/[^"']{0,120})["']/g)].map((m) => m[1]),
);
for (const p of [...paths].slice(0, 25)) console.log('  ', p);
if (paths.size === 0) console.log('   (none)');
