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
 * Exits non-zero when the page reports filters other than the ones requested,
 * so a mismatch fails the run instead of quietly importing full-PPR numbers
 * into a half-PPR league.
 */

import { writeFileSync } from 'node:fs';
import { parseBeatAdpPage, toAdpImportFile } from '../src/core/adp/beatadp.ts';

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

// What the page applied, not what we asked for. These have to agree or the
// numbers describe a different league than ours.
const applied = page.filters;
console.log('requested:', scoring, draft, qb);
console.log('applied:  ', applied?.scoringFormat, applied?.draftType, applied?.qbType);
const mismatch =
  !applied ||
  applied.scoringFormat !== scoring ||
  applied.draftType !== draft ||
  applied.qbType !== qb;
if (mismatch) {
  console.error('the page did not apply the requested filters — refusing to write a mislabelled snapshot');
  process.exit(2);
}

const content = toAdpImportFile(page.rows, platform);
const count = JSON.parse(content).length;
if (count === 0) {
  console.error(`no ${platform} ADP values on the page`);
  process.exit(3);
}
writeFileSync(out, content);
console.log(`rows on page: ${page.rows.length} | with ${platform} ADP: ${count} -> ${out}`);
