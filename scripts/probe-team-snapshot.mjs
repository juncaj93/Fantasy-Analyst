/**
 * The Team screen's own reads, as one compressed blob, for replaying locally.
 *
 * The sandbox this app is developed in cannot reach production, and the screen
 * bugs reported on 30 September 2026 depend on the real roster: two
 * questionable players with partial markets, an Out receiver on the bench, a
 * TE in FLEX. So this prints the public GETs the screen makes, gzipped and
 * base64-encoded between two markers, and a developer replays them with
 * Playwright route stubs. Reads only, GET only, nothing that needs a login.
 */
import { gzipSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  return { status: res.status, body: await res.text() };
}

const leagues = await get('/api/leagues');
const league = (JSON.parse(leagues.body).leagues ?? []).find((l) => l.isSelected) ?? null;
if (!league) {
  console.log('no selected league');
  process.exit(0);
}
const paths = [
  '/api/overview',
  '/api/leagues',
  `/api/leagues/${league.id}/roster`,
  `/api/leagues/${league.id}/lineup`,
  `/api/leagues/${league.id}/waivers`,
  `/api/players?q=&leagueId=${league.id}&limit=40`,
];
const out = {};
for (const path of paths) {
  const r = await get(path);
  out[path] = r;
  console.log(`${r.status} ${path} (${r.body.length} bytes)`);
}
const blob = gzipSync(Buffer.from(JSON.stringify(out))).toString('base64');
console.log('=== SNAPSHOT BEGIN ===');
for (let i = 0; i < blob.length; i += 4000) console.log(blob.slice(i, i + 4000));
console.log('=== SNAPSHOT END ===');
