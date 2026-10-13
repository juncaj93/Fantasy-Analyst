/**
 * The cleanup round's ONE combined production check (read-only).
 *
 * One run answers everything the round needs, so the database is asked once:
 *
 *   1. the deployed SHA (`/api/health`, a handful of rows);
 *   2. the top readers per UTC day, from Cloudflare's analytics (free);
 *   3. the live Trades ideas endpoint, timed three times, with a fingerprint of
 *      what it returned;
 *   4. the replays on the real stored data (`cleanup-d1-replay.ts`): the odds
 *      job's staleness read before and after, the depth chart capture list, and
 *      the Trades check before and after;
 *   5. the provider's lookup count against the app's ledger
 *      (`probe-vegas-count-gap.mjs`), for the billing reset day.
 *
 * Set STEPS to a comma list (sha,readers,trades,replay,gap) to run part of it.
 * Production reads are a few hundred thousand rows at most; the Probe workflow
 * runs the budget guard first and stands down when the day is past 50%.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const steps = new Set((process.env.STEPS || 'sha,readers,trades,replay,gap').split(',').map((s) => s.trim()));
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);

function child(args, label) {
  const r = spawnSync('node', args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) console.log(`(${label} exited with status ${r.status})`);
}

if (steps.has('sha')) {
  heading('Production SHA');
  const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
}

if (steps.has('readers')) {
  heading('Top D1 readers per UTC day');
  child(['scripts/probe-d1-top-readers.mjs'], 'top readers');
}

if (steps.has('trades')) {
  heading('Trades ideas, live endpoint');
  const times = [];
  let fingerprint = '';
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    const res = await fetch(`${APP}/api/trades/smart?limit=5`);
    const body = await res.text();
    times.push(Date.now() - started);
    let ideas = '?';
    try {
      const j = JSON.parse(body);
      ideas = (j.offers ?? []).length;
      fingerprint = createHash('sha1').update(JSON.stringify(j.offers ?? [])).digest('hex').slice(0, 12);
    } catch {}
    console.log(`  request ${i + 1}: HTTP ${res.status}, ${times[i]} ms, ${ideas} ideas`);
  }
  console.log(`  ideas fingerprint ${fingerprint}; times ${times.join(' / ')} ms`);
}

if (steps.has('replay')) {
  heading('Replays on the real stored data');
  child(['--experimental-transform-types', '--no-warnings', 'scripts/cleanup-d1-replay.ts'], 'replay');
}

if (steps.has('gap')) {
  heading('Provider count vs ledger (billing reset day)');
  child(['--experimental-transform-types', '--no-warnings', 'scripts/probe-vegas-count-gap.mjs'], 'count gap');
}
