/**
 * Fetch Sleeper ADP for a specific league format and write an importable file.
 *
 * Run from CI, never from the worker: the draft board must not depend on a
 * third-party site being reachable while a draft is running. The output is the
 * plain JSON the existing ADP importer accepts.
 *
 * Usage:
 *   node scripts/fetch-beatadp.mjs [--scoring HALF_PPR] [--draft REDRAFT]
 *                                  [--qb 1QB] [--platform SLEEPER]
 *                                  [--out adp.json]
 *
 * Exits non-zero when the page does not publish the exact slice requested, so a
 * mismatch fails the run instead of quietly importing full-PPR numbers into a
 * half-PPR league.
 */

import { writeFileSync } from 'node:fs';
import { findSlice, parseBeatAdpPage, sliceKey, toAdpImportFile } from '../src/core/adp/beatadp.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const scoring = arg('scoring', 'HALF_PPR');
const draft = arg('draft', 'REDRAFT');
const qb = arg('qb', '1QB');
const platform = arg('platform', 'SLEEPER');
const out = arg('out', 'adp.json');

const url = new URL('https://www.beatadp.com/platform-adp');
url.searchParams.set('scoringFormat', scoring);
url.searchParams.set('draftType', draft);
url.searchParams.set('qbType', qb);

const res = await fetch(url, { headers: { 'user-agent': UA } });
if (!res.ok) {
  console.error(`beatadp returned ${res.status}`);
  process.exit(1);
}
const page = parseBeatAdpPage(await res.text());

// The page ships every slice it holds and keys each player's ADPs by slice, so
// the numbers are taken by name rather than trusted to be the ones asked for.
const wanted = { platform, scoringFormat: scoring, draftType: draft, qbType: qb };
const key = sliceKey(wanted);
console.log('requested:', key);

if (page.slices.length === 0) {
  console.error('the page published no ADP slices at all — its payload has changed shape again');
  console.error(`(rows parsed: ${page.rows.length})`);
  process.exit(2);
}

const slice = findSlice(page.slices, wanted);
if (!slice) {
  console.error(`the page does not publish ${key} — refusing to write a mislabelled snapshot`);
  console.error('it publishes:');
  for (const published of page.slices) {
    console.error(`  ${sliceKey(published)}  recorded ${published.recordedAt ?? 'unstated'}`);
  }
  process.exit(2);
}
console.log(`recorded: ${slice.recordedAt ?? 'unstated'} | the page counts ${slice.playerCount ?? '?'} players in it`);

const content = toAdpImportFile(page.rows, key);
const count = JSON.parse(content).length;
if (count === 0) {
  console.error(`the page publishes ${key} but no player carries an ADP under it`);
  process.exit(3);
}
writeFileSync(out, content);
console.log(`rows on page: ${page.rows.length} | with ${key} ADP: ${count} -> ${out}`);
