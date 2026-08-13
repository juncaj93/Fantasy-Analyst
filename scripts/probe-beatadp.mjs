/**
 * Check that beatadp.com is still a source we can trust, and that we know how
 * to ask it for this league's format.
 *
 * Two questions, both of which have burned this project before:
 *
 *   1. Do the filter parameters work? A page that silently ignores
 *      `scoringFormat=HALF_PPR` and serves full PPR looks identical to one that
 *      honoured it — unless you read back the filters it says it applied.
 *   2. Is the ordering sane past the top dozen? Sleeper's `search_rank` looked
 *      like ADP for twelve players and then put a retired running back in the
 *      third round. The tail is where a ranking source proves itself.
 *
 * Prints only; changes nothing.
 */

import { parseBeatAdpPage, toAdpImportFile } from '../src/core/adp/beatadp.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function load(params) {
  const url = new URL('https://www.beatadp.com/platform-adp');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const page = parseBeatAdpPage(await res.text());
  return { url: url.search || '(no params)', status: res.status, page };
}

// ---------------------------------------------------- 1. filter parameters ---
// The prop names the page renders with are the first candidates, but a Next.js
// page often names its search params differently from its props.
const CANDIDATES = [
  {},
  { scoringFormat: 'HALF_PPR', draftType: 'REDRAFT', qbType: '1QB' },
  { scoringFormat: 'HALF', draftType: 'REDRAFT', qbType: '1QB' },
  { scoring: 'HALF_PPR', draft: 'REDRAFT', qb: '1QB' },
  { scoringFormat: 'half-ppr', draftType: 'redraft', qbType: '1qb' },
  { format: 'HALF_PPR' },
];

console.log('=== which parameters change the applied filters? ===');
let working = null;
for (const params of CANDIDATES) {
  try {
    const { url, status, page } = await load(params);
    const f = page.filters;
    console.log(
      `  ${status}  ${url}\n      applied: ${f?.scoringFormat} / ${f?.draftType} / ${f?.qbType}  (${page.rows.length} rows)`,
    );
    if (!working && f?.scoringFormat && f.scoringFormat !== 'PPR') working = { params, page };
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}

// ------------------------------------------------------- 2. data sanity ------
const { page } = working ?? (await load({}));
if (working) console.log('\nusing half-PPR parameters:', JSON.stringify(working.params));
else console.log('\nno parameter spelling changed the format — falling back to the default page');

const rows = JSON.parse(toAdpImportFile(page.rows, 'SLEEPER'));
console.log(`\n=== Sleeper ADP: ${rows.length} ranked of ${page.rows.length} rows ===`);

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
