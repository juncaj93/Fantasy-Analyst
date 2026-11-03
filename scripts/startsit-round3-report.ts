/**
 * Round 3 (3 November 2026): Alex's real Team lineup, before and after the
 * 10-point rule could fire.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round3-report.ts <dir>
 *
 * Reads `<dir>/lineup.json`, a live lineup support snapshot, and rebuilds
 * Team's lineup from the same inputs twice: under Balanced, where Team was
 * stuck before the fix, and under the mode production resolved now. Prints
 * every spot, every row number and every swap that differs. No network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { weekPointsBeforeStatus } from '../src/core/startsit/weekPoints.ts';
import { rowFigure } from '../src/web/rowFigure.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import type { StartSitEvaluation } from '../src/core/startsit/engine.ts';
import type { StartSitMode } from '../src/core/startsit/mode.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: startsit-round3-report.ts <dir>');
const raw = JSON.parse(readFileSync(join(dir, 'lineup.json'), 'utf8'));
const inputs = raw.decision.inputs;
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const startSit = rehydrateStartSitInputs(inputs.startSit);
const published = new Map(Object.entries(inputs.published as Record<string, number>));
const fmt = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));

const build = (mode: StartSitMode) => {
  const lineup = assembleLineup({
    inputs: startSit,
    shape,
    profile,
    currentStarterIds: inputs.currentStarterIds,
    mode,
    published,
    unknownPlayers: inputs.unknownPlayers,
    now: raw.capturedAt,
  } as Parameters<typeof assembleLineup>[0]);
  const evals = [...lineup.starters, ...lineup.bench, ...lineup.undecidable] as StartSitEvaluation[];
  const figure = new Map(
    evals.map((e) => {
      const f = rowFigure(weekPointsBeforeStatus(e as never), e as never);
      return [e.playerId, { name: e.name, points: f.kind === 'plain' || f.kind === 'risk' ? f.points : f.kind === 'out' ? 0 : null }] as const;
    }),
  );
  return { lineup, figure };
};

const mode = inputs.mode as StartSitMode;
console.log(`captured ${raw.capturedAt}; mode now ${mode}; before the fix: balanced`);
const before = build('balanced');
const after = build(mode);
console.log('\nspot by spot (before -> now):');
before.lineup.slots.forEach((s, i) => {
  const a = after.lineup.slots[i];
  const same = s.playerId === a?.playerId;
  console.log(`  ${s.slot.padEnd(5)} ${String(s.name ?? '(empty)').padEnd(24)} ${same ? 'same' : `-> ${a?.name ?? '(empty)'}`}`);
});
console.log('\nrow numbers that moved (before -> now):');
let moved = 0;
for (const [id, b] of before.figure) {
  const a = after.figure.get(id);
  if (b.points == null || a?.points == null || Math.abs(b.points - a.points) < 0.005) continue;
  moved += 1;
  console.log(`  ${b.name.padEnd(24)} ${fmt(b.points)} -> ${fmt(a.points)}`);
}
if (moved === 0) console.log('  none');
const swaps = (l: typeof before.lineup) => l.swaps.map((w) => `${w.inName} over ${w.outName} at ${w.slot} +${fmt(w.gain)}`);
console.log(`\nBest move before: ${swaps(before.lineup)[0] ?? 'none'}`);
console.log(`Best move now:    ${swaps(after.lineup)[0] ?? 'none'}`);
console.log(`swaps before: ${swaps(before.lineup).join('; ') || 'none'}`);
console.log(`swaps now:    ${swaps(after.lineup).join('; ') || 'none'}`);
console.log(`recommended points before ${fmt(before.lineup.recommendedPoints)}, now ${fmt(after.lineup.recommendedPoints)}`);
