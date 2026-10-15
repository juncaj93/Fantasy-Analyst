/**
 * Compare round of 15 October 2026: the report.
 *
 *   node --experimental-transform-types --no-warnings scripts/compare-vegas-report.ts <dir>
 *
 * Reads what `probe-compare-vegas.mjs` gathered (`backtest-inputs.json`,
 * `current.json`, `lineup.json`) and what `startsit-round2-score.ts` produced
 * on the code before the round (`old.json`) and on this checkout
 * (`new.json`), and prints:
 *
 *  1. BACKTEST: average miss before and after the uncertainty penalty left
 *     the score, on the fully priced player-weeks the 4.840 was measured on,
 *     and the ship rule (no worse by more than 0.01).
 *  2. ROWS: the Compare table this checkout would draw for G. Wilson against
 *     N. Collins and for one QB comparison, from Alex's lineup snapshot.
 *  3. SHIFTS: the five largest moves in Alex's roster's numbers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { compareStartSit, evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { compareTable } from '../src/web/compareTable.ts';
import type { StartSitEvaluation } from '../src/web/api.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: compare-vegas-report.ts <dir>');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const r3 = (v: number) => v.toFixed(3);

/* ================================================================ BACKTEST */
console.log('\n################ 1. BACKTEST: uncertainty out of the score ################');
const bt = read('backtest-inputs.json');
const profile = buildScoringProfile(bt.scoring, bt.rosterPositions);
const weekInputs = new Map<number, StartSitInput[]>();
for (const [w, bundle] of Object.entries(bt.bundles)) weekInputs.set(Number(w), rehydrateStartSitInputs(bundle as never));
type Item = { week: number; idx: number; playerId: string; name: string; position: string; actual: number };
const items: Item[] = bt.items;
const key = (week: number, id: string) => `${week}:${id}`;
const scoresOf = (file: string) =>
  existsSync(join(dir, file))
    ? new Map<string, number | null>(read(file).backtest.map((r: { week: number; playerId: string; score: number | null }) => [key(r.week, r.playerId), r.score]))
    : null;
const before = scoresOf('old.json');
const after = scoresOf('new.json')!;
const complete = items.filter((i) => evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile).expectation.coverage === 1);

function measure(set: Item[], scores: Map<string, number | null>) {
  const rows = set.map((i) => ({ i, s: scores.get(key(i.week, i.playerId)) })).filter((r): r is { i: Item; s: number } => r.s != null);
  const err = rows.map((r) => r.s - r.i.actual);
  let right = 0;
  let total = 0;
  for (const w of bt.weeks as number[]) {
    const wk = rows.filter((r) => r.i.week === w);
    for (let a = 0; a < wk.length; a++)
      for (let b = a + 1; b < wk.length; b++) {
        const x = wk[a]!;
        const y = wk[b]!;
        const group = (p: string) => (p === 'QB' ? 'QB' : 'FLEX');
        if (group(x.i.position) !== group(y.i.position) || x.s === y.s || x.i.actual === y.i.actual) continue;
        total++;
        if ((x.s > y.s) === (x.i.actual > y.i.actual)) right++;
      }
  }
  return {
    n: rows.length,
    mae: err.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, err.length),
    bias: err.reduce((a, e) => a + e, 0) / Math.max(1, err.length),
    pair: right / Math.max(1, total),
  };
}

console.log(`weeks ${bt.weeks.join(', ')}; ${items.length} priced player-weeks with a game played; ${complete.length} with every market priced (the set the 4.840 was measured on)`);
const line = (label: string, m: ReturnType<typeof measure>) =>
  console.log(`${label.padEnd(34)} n ${String(m.n).padStart(4)}  average miss ${r3(m.mae)}  bias ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(2)}  higher-scored won ${(m.pair * 100).toFixed(1)}%`);
const fullBefore = before ? measure(complete, before) : null;
const fullAfter = measure(complete, after);
if (fullBefore) line('before (startsit@5, with it)', fullBefore);
line('after (startsit@6, without it)', fullAfter);
if (before) {
  line('every priced week, before', measure(items, before));
  line('every priced week, after', measure(items, after));
  const moved = complete.filter((i) => before.get(key(i.week, i.playerId)) !== after.get(key(i.week, i.playerId))).length;
  console.log(`player-weeks whose score moved: ${moved} of ${complete.length}`);
}
if (fullBefore) {
  const delta = fullAfter.mae - fullBefore.mae;
  console.log(`\nchange in average miss: ${delta >= 0 ? '+' : ''}${r3(delta)}`);
  console.log(`DECISION: ${delta <= 0.01 ? 'KEEP the removal (not worse by more than 0.01)' : 'DO NOT MERGE the removal (worse by more than 0.01): a decision for Alex'}`);
} else {
  console.log('DECISION: no before-scores, so no comparison. Do not merge on this run.');
}

/* ===================================================================== ROWS */
console.log('\n################ 2. COMPARE ROWS on Alex’s roster (this checkout) ################');
const snapshot = read('lineup.json');
const inputs = snapshot.decision.inputs;
const { profile: lp } = rehydrateLeagueRules(inputs.rules);
const startSit: StartSitInput[] = rehydrateStartSitInputs(inputs.startSit);
const published = new Map(Object.entries(inputs.published as Record<string, number>));
console.log(`snapshot captured ${snapshot.capturedAt}; ${startSit.length} players`);

function draw(title: string, pair: StartSitInput[]) {
  const c = compareStartSit(pair, lp, { mode: inputs.mode, published } as Parameters<typeof compareStartSit>[2]);
  const columns = c.evaluations as unknown as StartSitEvaluation[];
  const { rows, score } = compareTable(columns);
  const w = 12;
  console.log(`\n${title}   (* = grey)`);
  console.log(`${''.padEnd(14)}${columns.map((e) => e.name.split(' ').slice(-1)[0]!.padStart(w)).join('')}`);
  const cell = (x: { text: string; muted?: boolean }) => `${x.text}${x.muted ? '*' : ' '}`.padStart(w);
  for (const row of rows) console.log(`${(row.kind === 'line' ? '  ' + row.label : row.label).padEnd(14)}${row.cells.map(cell).join('')}`);
  console.log(`${'Score'.padEnd(14)}${score.map(cell).join('')}`);
  console.log(`${'card label'.padEnd(14)}${columns.map((e) => (e.decision?.basis === 'published' ? 'Sleeper' : '').padStart(w)).join('')}`);
  console.log(`recommended: ${columns.find((e) => e.playerId === c.recommendedPlayerId)?.name ?? '-'}`);
}

const byName = (part: string) => startSit.filter((i) => i.player.fullName.toLowerCase().includes(part));
/* PAIR_A and PAIR_B exist for the dry run on the demo seed, which has neither man. */
const pick = (part: string) => byName(part).find((i) => i.player.position === 'WR') ?? byName(part)[0];
const wilson = pick(process.env.PAIR_A ?? 'wilson');
const collins = pick(process.env.PAIR_B ?? 'collins');
if (wilson && collins) draw(`${wilson.player.fullName} vs ${collins.player.fullName}`, [wilson, collins]);
else console.log(`Wilson or Collins not in the lineup snapshot (Wilson ${wilson ? 'found' : 'missing'}, Collins ${collins ? 'found' : 'missing'})`);

/*
 * A QB comparison. Alex's league starts one QB, so his roster may hold only
 * one; then the second is this week's most-priced other QB from the stored
 * props, evaluated on his lines alone (no news or opponent read), which is
 * enough to show the rows.
 */
const qbs = startSit.filter((i) => i.player.position === 'QB');
if (qbs.length >= 2) draw(`${qbs[0]!.player.fullName} vs ${qbs[1]!.player.fullName}`, qbs.slice(0, 2));
else if (qbs.length === 1) {
  const current = read('current.json') as { players: { playerId: string; name: string; position: string; team: string; props: StartSitInput['props'] }[] };
  const other = current.players
    .filter((p) => p.position === 'QB' && p.playerId !== qbs[0]!.player.id)
    .sort((a, b) => b.props.length - a.props.length)[0];
  if (other) {
    const stranger: StartSitInput = {
      player: { ...qbs[0]!.player, id: other.playerId, fullName: other.name, team: other.team },
      props: other.props,
      signal: null,
    };
    draw(`${qbs[0]!.player.fullName} vs ${other.name} (not rostered; lines only)`, [qbs[0]!, stranger]);
  } else console.log('only one QB anywhere this week; no QB comparison');
} else console.log('no QB in the lineup snapshot');

/* =================================================================== SHIFTS */
console.log('\n################ 3. SHIFTS: Alex’s roster, before and after ################');
const oldLineup = before ? read('old.json').lineup : null;
const newLineup = read('new.json').lineup;
if (oldLineup && newLineup) {
  type P = { playerId: string; name: string; position: string; decision: { points: number; basis: string } | null; components: { key: string; value: number }[] };
  const was = new Map<string, P>(oldLineup.players.map((p: P) => [p.playerId, p]));
  const shifts = (newLineup.players as P[])
    .map((p) => ({ p, b: was.get(p.playerId)?.decision?.points ?? null, a: p.decision?.points ?? null }))
    // A number a screen prints: a market or Sleeper's week, and not an Out player's gate.
    .filter((x): x is { p: P; b: number; a: number } => x.a != null && x.b != null && x.a > -50 && ['market', 'published'].includes(x.p.decision?.basis ?? ''))
    .map((x) => ({ ...x, d: x.a - x.b, charge: was.get(x.p.playerId)?.components.find((c) => c.key === 'uncertainty')?.value ?? 0 }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  console.log(`${shifts.filter((s) => Math.abs(s.d) >= 0.005).length} of ${shifts.length} roster numbers moved`);
  console.log('player                     pos   before   after   change   basis      old uncertainty charge');
  for (const s of shifts.slice(0, 5)) {
    console.log(
      `${s.p.name.padEnd(26)} ${s.p.position.padEnd(4)} ${s.b.toFixed(2).padStart(7)} ${s.a.toFixed(2).padStart(7)} ${(s.d >= 0 ? '+' : '') + s.d.toFixed(2)}`.padEnd(62) +
        `${(s.p.decision?.basis ?? '-').padEnd(10)} ${s.charge.toFixed(2)}`,
    );
  }
  const swapsOf = (l: { swaps: { inName: string; outName: string; slot: string }[] }) => l.swaps.map((s) => `${s.inName} over ${s.outName} (${s.slot})`).join('; ') || 'none';
  console.log(`\nBest move before: ${swapsOf(oldLineup)}`);
  console.log(`Best move after:  ${swapsOf(newLineup)}`);
} else console.log('no before lineup to compare against');
