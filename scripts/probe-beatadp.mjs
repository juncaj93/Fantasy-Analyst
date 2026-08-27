/**
 * Check that beatadp.com is still a source we can trust, and that it still
 * publishes the slice this league drafts in.
 *
 * Two questions, both of which have burned this project before:
 *
 *   1. Is the slice there, and how fresh is it? The page ships every
 *      platform/format combination it holds and keys each player's ADPs by
 *      slice, so the check is whether `SLEEPER|HALF_PPR|REDRAFT|1QB` is among
 *      them — and what date the page says those numbers were recorded on. A
 *      page that quietly stopped publishing a slice looks identical to one that
 *      never held it.
 *   2. Is the ordering sane past the top dozen? Sleeper's `search_rank` looked
 *      like ADP for twelve players and then put a retired running back in the
 *      third round. The tail is where a ranking source proves itself.
 *
 * Prints only; changes nothing.
 */

import { findSlice, parseBeatAdpPage, sliceKey, toAdpImportFile } from '../src/core/adp/beatadp.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const WANTED = { platform: 'SLEEPER', scoringFormat: 'HALF_PPR', draftType: 'REDRAFT', qbType: '1QB' };

const url = new URL('https://www.beatadp.com/platform-adp');
url.searchParams.set('scoringFormat', WANTED.scoringFormat);
url.searchParams.set('draftType', WANTED.draftType);
url.searchParams.set('qbType', WANTED.qbType);

const res = await fetch(url, { headers: { 'user-agent': UA } });
const page = parseBeatAdpPage(await res.text());
console.log(`${res.status} ${url.search}`);

// ------------------------------------------------------- 1. the slices -------
console.log(`\n=== slices the page publishes (${page.slices.length}) ===`);
for (const slice of page.slices) {
  console.log(`  ${sliceKey(slice).padEnd(34)} recorded ${slice.recordedAt ?? 'unstated'}  ${slice.playerCount ?? '?'} players`);
}

const wanted = findSlice(page.slices, WANTED);
const key = sliceKey(WANTED);
console.log(`\n${key}: ${wanted ? `published, recorded ${wanted.recordedAt ?? 'unstated'}` : 'NOT PUBLISHED — the refresh would refuse to import'}`);
if (!wanted) process.exit(0);

// ------------------------------------------------------- 2. data sanity ------
const rows = JSON.parse(toAdpImportFile(page.rows, key));
console.log(`\n=== ${key}: ${rows.length} ranked of ${page.rows.length} players on the page ===`);

const show = (r) => `${String(r.rank).padStart(4)}  ${String(r.adp).padStart(6)}  ${r.position ?? '??'} ${r.name} (${r.team})`;
console.log('--- top 15 ---');
for (const r of rows.slice(0, 15)) console.log(show(r));
console.log('--- last 10 ---');
for (const r of rows.slice(-10)) console.log(show(r));

console.log('\n=== position mix ===');
const byPos = {};
for (const r of rows) byPos[r.position || '??'] = (byPos[r.position || '??'] ?? 0) + 1;
console.log(' ', JSON.stringify(byPos));

// The specific players whose placement exposed the last bad ranking source.
console.log('\n=== spot checks ===');
for (const name of ['Drake Maye', 'Todd Gurley', 'Josh Allen', 'Lamar Jackson', 'Brock Bowers']) {
  const hit = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  console.log(`  ${name.padEnd(16)} ${hit ? `rank ${hit.rank}, adp ${hit.adp}` : 'not ranked'}`);
}
const firstQb = rows.find((r) => r.position === 'QB');
console.log(`  first QB:        ${firstQb ? `${firstQb.name} at rank ${firstQb.rank}` : 'none'}`);
