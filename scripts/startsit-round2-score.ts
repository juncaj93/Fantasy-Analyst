/**
 * Start/Sit round 2: score the same inputs on whichever checkout this runs in.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round2-score.ts <dir> <out.json> [posture]
 *
 * Run once on the code before the round and once after, on the same files. It
 * uses only what both versions have: `evaluatePlayer`, `compareStartSit`,
 * `assembleLineup` and the support-snapshot rehydration. Extra options the old
 * code does not know (the posture) are simply ignored there.
 *
 * Reads `<dir>/backtest-inputs.json` and `<dir>/lineup.json` (the production
 * lineup support snapshot). Writes the backtest scores, the lineup replay
 * (Best move, swaps and fills) and three sample comparisons.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { compareStartSit, evaluatePlayer } from '../src/core/startsit/engine.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';

const [dir, out, postureArg] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: startsit-round2-score.ts <dir> <out.json> [posture]');
const posture = postureArg === 'underdog' || postureArg === 'favourite' ? postureArg : null;
const result: Record<string, unknown> = {};

/* The backtest. */
const bt = JSON.parse(readFileSync(join(dir, 'backtest-inputs.json'), 'utf8'));
const profile = buildScoringProfile(bt.scoring, bt.rosterPositions);
const weekInputs = new Map<number, ReturnType<typeof rehydrateStartSitInputs>>();
for (const [w, bundle] of Object.entries(bt.bundles)) weekInputs.set(Number(w), rehydrateStartSitInputs(bundle as never));
result['backtest'] = bt.items.map((item: { week: number; idx: number; playerId: string }) => {
  const input = weekInputs.get(item.week)![item.idx]!;
  const e = evaluatePlayer(input, profile);
  return { week: item.week, playerId: item.playerId, score: e.score, vegas: e.expectation.points, coverage: e.expectation.coverage };
});

/* The lineup replay and three comparisons, from the production snapshot. */
if (existsSync(join(dir, 'lineup.json'))) {
  const snapshot = JSON.parse(readFileSync(join(dir, 'lineup.json'), 'utf8'));
  const inputs = snapshot.decision.inputs;
  const { shape, profile: lp } = rehydrateLeagueRules(inputs.rules);
  const startSit = rehydrateStartSitInputs(inputs.startSit);
  const published = new Map(Object.entries(inputs.published as Record<string, number>));
  const lineup = assembleLineup({
    inputs: startSit,
    shape,
    profile: lp,
    currentStarterIds: inputs.currentStarterIds,
    mode: inputs.mode,
    published,
    unknownPlayers: inputs.unknownPlayers,
    now: snapshot.capturedAt,
    ...(posture ? { posture } : {}),
  } as Parameters<typeof assembleLineup>[0]);
  const everyone = [...lineup.starters, ...lineup.bench, ...lineup.undecidable];
  result['lineup'] = {
    mode: inputs.mode,
    slots: lineup.slots.map((s) => ({ slot: s.slot, name: s.name, playerId: s.playerId })),
    swaps: lineup.swaps,
    fills: lineup.fills,
    players: everyone.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      position: e.position,
      score: e.score,
      decision: e.decision ?? null,
      vegas: e.expectation.points,
      pill: (e as { pill?: unknown }).pill ?? null,
      contributions: e.expectation.contributions,
      components: e.components.map((c) => ({ key: c.key, value: c.value, unknown: c.unknown })),
    })),
  };

  /* Three comparisons: the Best move pair, the closest same-position pair, a FLEX pair. */
  const priced = everyone.filter((e) => e.decision && e.decision.basis !== 'unpriced' && !e.ruledOut);
  const pairs: [string, string][] = [];
  const top = lineup.swaps[0];
  if (top) pairs.push([top.outPlayerId, top.inPlayerId]);
  const same = [...priced]
    .flatMap((a, i) => priced.slice(i + 1).filter((b) => b.position === a.position).map((b) => [a, b] as const))
    .sort((x, y) => Math.abs((x[0].decision!.points) - (x[1].decision!.points)) - Math.abs((y[0].decision!.points) - (y[1].decision!.points)));
  for (const [a, b] of same) {
    if (pairs.length >= 2) break;
    if (!pairs.some((p) => p.includes(a.playerId) && p.includes(b.playerId))) pairs.push([a.playerId, b.playerId]);
  }
  const flex = priced.filter((e) => ['RB', 'WR', 'TE'].includes(e.position));
  const rb = flex.find((e) => e.position === 'RB');
  const wr = flex.find((e) => e.position === 'WR');
  if (rb && wr && pairs.length < 3) pairs.push([rb.playerId, wr.playerId]);
  const byId = new Map(startSit.map((i) => [i.player.id, i]));
  result['comparisons'] = pairs.map(([a, b]) => {
    const c = compareStartSit([byId.get(a)!, byId.get(b)!], lp, { mode: inputs.mode, published, ...(posture ? { posture } : {}) } as Parameters<typeof compareStartSit>[2]);
    return {
      recommended: c.recommendedPlayerId,
      margin: c.margin,
      tiebreak: (c as { tiebreak?: unknown }).tiebreak ?? null,
      players: c.evaluations.map((e) => ({
        playerId: e.playerId,
        name: e.name,
        position: e.position,
        points: e.decision?.points ?? e.score,
        vegas: e.expectation.points,
        pill: (e as { pill?: unknown }).pill ?? null,
        rows: e.components.filter((x) => !x.unknown && x.value !== 0).map((x) => `${x.key} ${x.value.toFixed(2)}`),
      })),
    };
  });
}

writeFileSync(out, JSON.stringify(result));
console.log(`scored ${(result['backtest'] as unknown[]).length} player-weeks${result['lineup'] ? ', the lineup and three comparisons' : ''}`);
