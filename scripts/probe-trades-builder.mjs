/**
 * The Trades round's ONE combined production check (read-only).
 *
 *   1. the deployed SHA (`/api/health`, a handful of rows);
 *   2. the live Trades ideas endpoint, once, as the phone sees it;
 *   3. the replays on the real stored data (`trades-builder-replay.ts`): why the
 *      ideas board is empty (funnel, nearest misses, a wider-caps what-if), the
 *      trade builder on Alex's real roster for all teams and two real teams,
 *      and D1 rows read per Trades load and per build;
 *   4. the odds provider's billing reset check (`probe-vegas-count-gap.mjs` and
 *      `probe-sgo-reset.mjs`): zero provider lookups, since the provider's usage
 *      endpoint does not move its counter, and a few ledger rows.
 *
 * STEPS picks parts (sha,ideas,replay,reset). The round's last run, after the
 * merge, is STEPS=sha,reset: the deployed SHA and the reset check, without
 * reading the trade data a second time.
 *
 * The Probe workflow runs the D1 budget guard first and stands down past 50%.
 * Nothing is written anywhere and Sleeper is never called.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const steps = new Set((process.env.STEPS || 'sha,ideas,replay,reset').split(',').map((x) => x.trim()));
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

if (steps.has('sha')) {
  heading('Production SHA');
  const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
}

if (steps.has('ideas')) {
  heading('Trades ideas, live endpoint (one request)');
  const started = Date.now();
  const res = await fetch(`${APP}/api/trades/smart?limit=5`).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  console.log(`  HTTP ${res?.status ?? '?'}, ${Date.now() - started} ms, ${(body?.offers ?? []).length} ideas`);
  console.log(`  notes: ${JSON.stringify(body?.notes ?? [])}`);
  if (body?.pricing?.line) console.log(`  pricing line: ${body.pricing.line}`);
}

if (steps.has('replay')) {
  heading('Replays on the real stored data');
  const r = spawnSync('node', ['--experimental-transform-types', '--no-warnings', 'scripts/trades-builder-replay.ts'], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) console.log(`(replay exited with status ${r.status})`);
}

if (steps.has('reset')) {
  heading('Odds provider billing reset check (zero provider lookups)');
  for (const script of ['scripts/probe-vegas-count-gap.mjs', 'scripts/probe-sgo-reset.mjs']) {
    const r = spawnSync('node', ['--experimental-transform-types', '--no-warnings', script], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) console.log(`(${script} exited with status ${r.status})`);
  }
}
