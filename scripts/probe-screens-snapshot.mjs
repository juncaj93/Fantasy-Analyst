/**
 * Every public read the app's screens make on open, as one compressed blob.
 *
 * The sandbox this app is developed in cannot reach production, so a screen
 * audit against the real league needs the real responses brought to it. This
 * prints the GETs Team, Matchup, Waivers, Trades, Players and Setup make when
 * they open, gzipped and base64-encoded between two markers, and
 * `scripts/replay-screens.mjs` serves them back to a local build of the app
 * through Playwright route stubs. A wider cousin of `probe-team-snapshot.mjs`.
 *
 * Reads only, GET only, nothing that needs a login. No odds are bought: the
 * lineup, waivers and matchup reads never call the odds provider.
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
const id = encodeURIComponent(league.id);
const paths = [
  '/api/auth/status',
  '/api/overview',
  '/api/leagues',
  '/api/setup/status',
  '/api/setup/newsletter',
  '/api/data-health',
  `/api/leagues/${id}/roster`,
  `/api/leagues/${id}/lineup`,
  `/api/leagues/${id}/waivers`,
  `/api/leagues/${id}/matchup`,
  '/api/trades',
  '/api/trades/smart',
  `/api/leagues/${id}/trades/check/teams`,
  `/api/players?q=&leagueId=${id}&limit=40&offset=0`,
  `/api/players?q=&leagueId=${id}&limit=60&offset=0`,
  '/api/review/queue',
  '/api/review/applied',
  '/api/newsletter/messages',
  '/api/preseason-projection',
];
const out = {};
for (const path of paths) {
  const t0 = Date.now();
  const r = await get(path);
  out[path] = r;
  console.log(`${r.status} ${path} (${r.body.length} bytes, ${Date.now() - t0} ms)`);
}
const blob = gzipSync(Buffer.from(JSON.stringify(out))).toString('base64');
console.log('=== SNAPSHOT BEGIN ===');
for (let i = 0; i < blob.length; i += 4000) console.log(blob.slice(i, i + 4000));
console.log('=== SNAPSHOT END ===');
