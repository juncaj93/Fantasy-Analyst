/**
 * The Trades round's ONE combined production check (read-only).
 *
 *   1. the deployed SHA (`/api/health`, a handful of rows);
 *   2. the live Trades ideas endpoint, once, as the phone sees it;
 *   3. the replays on the real stored data (`trades-builder-replay.ts`): why the
 *      ideas board is empty (funnel, nearest misses, a wider-caps what-if), the
 *      trade builder on Alex's real roster for all teams and two real teams,
 *      and D1 rows read per Trades load and per build.
 *
 * The Probe workflow runs the D1 budget guard first and stands down past 50%.
 * Nothing is written anywhere and Sleeper is never called.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

heading('Production SHA');
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);

heading('Trades ideas, live endpoint (one request)');
{
  const started = Date.now();
  const res = await fetch(`${APP}/api/trades/smart?limit=5`).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  console.log(`  HTTP ${res?.status ?? '?'}, ${Date.now() - started} ms, ${(body?.offers ?? []).length} ideas`);
  console.log(`  notes: ${JSON.stringify(body?.notes ?? [])}`);
  if (body?.pricing?.line) console.log(`  pricing line: ${body.pricing.line}`);
}

heading('Replays on the real stored data');
const r = spawnSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/trades-builder-replay.ts'], { stdio: 'inherit', env: process.env });
if (r.status !== 0) console.log(`(replay exited with status ${r.status})`);
