/**
 * Put this league's rescored quarterback numbers into live support snapshots.
 *
 *   node --experimental-transform-types --no-warnings scripts/qb-rescore-inject.ts feed.json out-dir snap.json [...]
 *
 * For the before/after replay of finding F5. Production stores no quarterback
 * lines until the first refresh after deploy, so a snapshot captured today has
 * every rescorable quarterback missing from its published map. This reads
 * Sleeper's public feed for the same week through the app's own parser and
 * `qbRescore`, adds each rostered or listed quarterback's rescored number where
 * the snapshot has none, and writes the copies to `out-dir` under the same
 * names, printing what it added.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseSleeperWeeklyProjections, qbRescore, rescoreQbTotal } from '../src/core/sleeper/weeklyProjections.ts';
import { rehydrateLeagueRules } from '../src/core/support/inseason.ts';

const [feedFile, outDir, ...snaps] = process.argv.slice(2);
if (!feedFile || !outDir || snaps.length === 0) {
  console.error('usage: qb-rescore-inject.ts feed.json out-dir snapshot.json [...]');
  process.exit(1);
}
const rows = new Map(parseSleeperWeeklyProjections(JSON.parse(readFileSync(feedFile, 'utf8'))).map((r) => [r.playerId, r] as const));

type Input = { player?: { id?: string; fullName?: string; position?: string } };
const inputsOf = (inputs: Record<string, unknown>): Input[] => {
  const out: Input[] = [];
  for (const key of ['startSit', 'roster', 'candidates']) {
    const bundle = inputs[key] as { inputs?: Input[] } | undefined;
    if (bundle?.inputs) out.push(...bundle.inputs);
  }
  return out;
};

for (const file of snaps) {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const inputs = snap.decision.inputs as Record<string, unknown> & { rules: never; published?: Record<string, number> };
  const { profile } = rehydrateLeagueRules(inputs.rules);
  const rescore = qbRescore(profile);
  const published = (inputs.published ??= {});
  const added: string[] = [];
  for (const input of inputsOf(inputs)) {
    const id = input.player?.id;
    if (!id || String(input.player?.position).toUpperCase() !== 'QB' || published[id] != null || !rescore) continue;
    const row = rows.get(id);
    const points = row ? rescoreQbTotal(row.points, row.qb, rescore) : null;
    if (points == null) continue;
    published[id] = points;
    added.push(`${input.player?.fullName ?? id} ${points} (published ${row!.points[rescore.key]})`);
  }
  writeFileSync(join(outDir, basename(file)), JSON.stringify(snap));
  console.log(`${snap.decision.kind}: ${added.length} quarterback(s) given a rescored number${added.length ? `: ${added.join('; ')}` : ''}`);
}
