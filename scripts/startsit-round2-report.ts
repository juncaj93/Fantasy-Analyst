/**
 * Start/Sit round 2: the report.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round2-report.ts <dir>
 *
 * Reads what `startsit-round2-build.ts` gathered and what
 * `startsit-round2-score.ts` produced on the old checkout (`old.json`) and on
 * this one (`new.json`), and prints, in this order:
 *
 *  1. AUDIT: how prop lines become points (5 to 8 real players, raw line,
 *     de-vigged over chance, average, points before and after); the stale-prop
 *     check on this week's games; weather coverage of this week's fixtures;
 *     pill counts this week under the shipped thresholds and two alternatives.
 *  2. BACKTEST: old method (the code before the round), the new rules, and
 *     one switch at a time, against league-scored actual points: mean absolute
 *     error, bias, and how often the higher-scored of two players scored more.
 *     Then the ship rule and the rules it picks.
 *  3. REPLAY: the Best move before and after on the real roster.
 *  4. COMPARE: three sample comparisons, old and new numbers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { LINE_AS_MEDIAN, overChance, type ConversionRules } from '../src/core/startsit/propConversion.ts';
import { LEGACY_RULES, SCORING_RULES, type ScoringRules } from '../src/core/startsit/scoringRules.ts';
import { PILL_RULES, pillFor, type PillRules } from '../src/core/startsit/pills.ts';
import { rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: startsit-round2-report.ts <dir>');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const r2 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const bt = read('backtest-inputs.json');
const current = read('current.json');
const profile = buildScoringProfile(bt.scoring, bt.rosterPositions);
const old = existsSync(join(dir, 'old.json')) ? read('old.json') : null;
const neu = read('new.json');

/* ================================================================ AUDIT */
console.log('\n################ 1. AUDIT ################');

console.log('\n== how prop lines become points, real players this week ==');
type Cur = { playerId: string; name: string; position: string; team: string; props: PlayerProp[] };
const cur: Cur[] = current.players;
const rosterIds = new Set<string>((neu.lineup?.players ?? []).map((p: { playerId: string }) => p.playerId));
const sample = [
  ...cur.filter((p) => rosterIds.has(p.playerId)),
  ...cur.filter((p) => !rosterIds.has(p.playerId)),
]
  .filter((p, i, all) => all.findIndex((q) => q.position === p.position) === i || i < 8)
  .slice(0, 8);
for (const p of sample) {
  const before = buildExpectation(p.position, p.props, profile, LINE_AS_MEDIAN);
  const after = buildExpectation(p.position, p.props, profile);
  console.log(`\n${p.name} (${p.position} ${p.team})${rosterIds.has(p.playerId) ? ' [on your roster]' : ''}`);
  for (const prop of p.props) {
    const q = overChance(prop.overPrice, prop.underPrice);
    const c = after.contributions.find((x) => x.market === prop.market);
    console.log(
      `  ${prop.market.padEnd(16)} line ${String(prop.line ?? '-').padStart(6)}  over ${prop.overPrice ?? '-'} / under ${prop.underPrice ?? '-'}` +
        `  de-vigged over ${q == null ? (prop.impliedProbability != null ? `${pct(prop.impliedProbability)} (TD)` : '-') : pct(q)}` +
        `  avg ${c?.mean != null ? r2(c.mean) : '-'}  pts ${r2(c?.linePoints ?? c?.points)} -> ${r2(c?.points)}`,
    );
  }
  console.log(`  Vegas market expectation: ${r2(before.points)} -> ${r2(after.points)} (${before.points ? pct((after.points! - before.points) / before.points) : '-'})`);
}
const shifts = cur
  .map((p) => {
    const b = buildExpectation(p.position, p.props, profile, LINE_AS_MEDIAN).points;
    const a = buildExpectation(p.position, p.props, profile).points;
    return b && a ? { pos: p.position, d: a - b, r: a / b } : null;
  })
  .filter((x): x is { pos: string; d: number; r: number } => x != null);
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const xs = shifts.filter((s) => s.pos === pos);
  if (!xs.length) continue;
  const mean = (f: (s: { d: number; r: number }) => number) => xs.reduce((a, s) => a + f(s), 0) / xs.length;
  console.log(`  ${pos}: ${xs.length} priced, average move +${mean((s) => s.d).toFixed(2)} pts (${pct(mean((s) => s.r) - 1)})`);
}

console.log('\n== stale props: props older than the latest game line, this week ==');
let older = 0;
let moved = 0;
for (const s of current.stale as { event: string; propsAt: string; linesAt: string | null; propsTotal: number | null; nowTotal: number | null; propsSpread: number | null; nowSpread: number | null }[]) {
  const isOlder = s.linesAt != null && s.propsAt < s.linesAt;
  const differs = s.propsTotal !== s.nowTotal || s.propsSpread !== s.nowSpread;
  if (isOlder) older++;
  if (isOlder && differs) moved++;
  console.log(`  ${s.event.padEnd(14)} props ${s.propsAt.slice(5, 16)}  line seen ${s.linesAt?.slice(5, 16) ?? '-'}  total ${s.propsTotal ?? '-'} -> ${s.nowTotal ?? '-'}  spread ${s.propsSpread ?? '-'} -> ${s.nowSpread ?? '-'}${isOlder && differs ? '  <- scaled' : ''}`);
}
console.log(`  ${current.stale.length} games; props older than the line in ${older}; line moved since in ${moved}`);

console.log('\n== weather coverage, this week ==');
const wx = current.weather as { game: string; kickoff: string | null; roof: string | null; table: string | null }[];
for (const g of wx) console.log(`  ${g.game.padEnd(12)} ${g.kickoff?.slice(0, 16) ?? '-'}  roof ${g.roof ?? '(blank)'}  table ${g.table ?? 'open air'}`);
const dome = wx.filter((g) => ['dome', 'closed'].includes((g.roof ?? '').toLowerCase()) || (!g.roof && g.table === 'dome')).length;
console.log(`  ${wx.length} games: ${dome} under a fixed or closed roof (known, unaffected); ${wx.length - dome} outdoors or retractable with no forecast, labelled "no forecast yet". No forecast feed is connected.`);

console.log('\n== pills this week ==');
function pillCounts(rules: PillRules) {
  const counts: Record<string, Record<string, number>> = {};
  for (const p of cur) {
    const e = buildExpectation(p.position, p.props, profile);
    const pill = pillFor(p.position, p.props, e, rules)?.pill ?? 'none';
    (counts[p.position] ??= {})[pill] = ((counts[p.position] ??= {})[pill] ?? 0) + 1;
  }
  return counts;
}
const scale = (k: number): PillRules => ({
  receiver: { ...PILL_RULES.receiver, explosiveMinYards: PILL_RULES.receiver.explosiveMinYards * k, explosiveMinTd: PILL_RULES.receiver.explosiveMinTd * k, steadyMinCatches: PILL_RULES.receiver.steadyMinCatches * k },
  back: { ...PILL_RULES.back, explosiveMinTd: PILL_RULES.back.explosiveMinTd * k, steadyMinRush: PILL_RULES.back.steadyMinRush * k },
  quarterback: { ...PILL_RULES.quarterback, explosiveMinRush: PILL_RULES.quarterback.explosiveMinRush * k, steadyMinPass: PILL_RULES.quarterback.steadyMinPass * k },
  wideMinTdShare: PILL_RULES.wideMinTdShare * k,
  minPoints: PILL_RULES.minPoints,
});
for (const [label, rules] of [['shipped', PILL_RULES], ['10% looser', scale(0.9)], ['10% stricter', scale(1.1)]] as const) {
  const c = pillCounts(rules);
  const total = Object.values(c).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const of = (k: string) => Object.values(c).reduce((a, m) => a + (m[k] ?? 0), 0);
  console.log(`  ${label.padEnd(13)} ${total} players: Explosive ${of('explosive')}, Steady ${of('steady')}, Wide range ${of('wide_range')}, none ${of('none')} (${pct(of('none') / Math.max(1, total))})`);
  if (label === 'shipped') for (const [pos, m] of Object.entries(c)) console.log(`      ${pos}: ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

/* ============================================================= BACKTEST */
console.log('\n################ 2. BACKTEST ################');
const weekInputs = new Map<number, ReturnType<typeof rehydrateStartSitInputs>>();
for (const [w, bundle] of Object.entries(bt.bundles)) weekInputs.set(Number(w), rehydrateStartSitInputs(bundle as never));
type Item = { week: number; idx: number; playerId: string; name: string; position: string; actual: number };
const items: Item[] = bt.items;
const complete = (i: Item) => {
  const e = evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile, LEGACY_RULES);
  return e.expectation.coverage === 1;
};
const scored = items.filter(complete);
console.log(`weeks ${bt.weeks.join(', ')}; ${items.length} priced player-weeks with a game played, ${scored.length} with every market priced (the set measured)`);

function measure(scoreOf: (i: Item) => number | null) {
  const rows = scored.map((i) => ({ i, s: scoreOf(i) })).filter((r): r is { i: Item; s: number } => r.s != null);
  const err = rows.map((r) => r.s - r.i.actual);
  const mae = err.reduce((a, e) => a + Math.abs(e), 0) / err.length;
  const bias = err.reduce((a, e) => a + e, 0) / err.length;
  let right = 0;
  let total = 0;
  let closeRight = 0;
  let closeTotal = 0;
  const group = (p: string) => (p === 'QB' ? 'QB' : 'FLEX');
  for (const w of bt.weeks as number[]) {
    const wk = rows.filter((r) => r.i.week === w);
    for (let a = 0; a < wk.length; a++) {
      for (let b = a + 1; b < wk.length; b++) {
        const x = wk[a]!;
        const y = wk[b]!;
        if (group(x.i.position) !== group(y.i.position) || x.s === y.s || x.i.actual === y.i.actual) continue;
        const ok = (x.s > y.s) === (x.i.actual > y.i.actual);
        total++;
        if (ok) right++;
        if (Math.abs(x.s - y.s) < 2) {
          closeTotal++;
          if (ok) closeRight++;
        }
      }
    }
  }
  return { n: rows.length, mae, bias, pair: right / Math.max(1, total), pairs: total, close: closeRight / Math.max(1, closeTotal), closePairs: closeTotal };
}
const withRules = (rules: ScoringRules) => (i: Item) => evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile, rules).score;
const oldScores = new Map<string, number | null>((old?.backtest ?? []).map((r: { week: number; playerId: string; score: number | null }) => [`${r.week}:${r.playerId}`, r.score]));

const conv = (c: Partial<ConversionRules>): ConversionRules => ({ devig: false, skew: false, tdRate: false, ...c });
const without = (key: string): ScoringRules => ({ ...SCORING_RULES, textOnly: SCORING_RULES.textOnly.filter((k) => k !== key) });
const plus = (key: string): ScoringRules => ({ ...SCORING_RULES, textOnly: [...SCORING_RULES.textOnly, key] });
const variants: [string, (i: Item) => number | null][] = [
  ['OLD (code before the round)', (i) => (old ? (oldScores.get(`${i.week}:${i.playerId}`) ?? null) : withRules(LEGACY_RULES)(i))],
  ['old rules, this checkout (fidelity)', withRules(LEGACY_RULES)],
  ['NEW (shipped rules)', withRules(SCORING_RULES)],
  ['conversion only, factors as before', withRules({ ...LEGACY_RULES, conversion: SCORING_RULES.conversion })],
  ['factors removed, bare lines', withRules({ ...SCORING_RULES, conversion: LINE_AS_MEDIAN })],
  ['new, de-vig only', withRules({ ...SCORING_RULES, conversion: conv({ devig: true }) })],
  ['new, skew only', withRules({ ...SCORING_RULES, conversion: conv({ skew: true }) })],
  ['new, TD rate only', withRules({ ...SCORING_RULES, conversion: conv({ tdRate: true }) })],
  ['new, keeping opportunity', withRules(without('usage_level'))],
  ['new, dropping opponent by role', withRules(plus('matchup_role'))],
  ['new, dropping uncertainty', withRules(plus('uncertainty'))],
  ['market number alone (no adjustments)', (i) => evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile, SCORING_RULES).expectation.points],
];
console.log('\nmethod                                     n     MAE    bias   higher-scored won (pairs)   close calls <2 pts (pairs)');
const results = new Map<string, ReturnType<typeof measure>>();
for (const [label, f] of variants) {
  const m = measure(f);
  results.set(label, m);
  console.log(`${label.padEnd(40)} ${String(m.n).padStart(4)}  ${m.mae.toFixed(3)}  ${(m.bias >= 0 ? '+' : '') + m.bias.toFixed(2)}   ${pct(m.pair)} (${m.pairs})            ${pct(m.close)} (${m.closePairs})`);
}
const fidelity = old
  ? scored.filter((i) => {
      const a = oldScores.get(`${i.week}:${i.playerId}`);
      const b = withRules(LEGACY_RULES)(i);
      return a != null && b != null && Math.abs(a - b) > 0.011;
    }).length
  : null;
console.log(`\nfidelity: the old rules on this checkout differ from the old code on ${fidelity ?? '(old code not run)'} player-weeks`);

const O = results.get('OLD (code before the round)')!;
const N = results.get('NEW (shipped rules)')!;
const atLeastAsGood = (m: ReturnType<typeof measure>) => m.mae <= O.mae + 1e-9 && m.pair >= O.pair - 1e-9;
console.log('\n== ship rule: the new method must be at least as good as the old on both error and ranking ==');
console.log(`  MAE ${O.mae.toFixed(3)} -> ${N.mae.toFixed(3)} (${N.mae <= O.mae ? 'better or equal' : 'WORSE'}); ranking ${pct(O.pair)} -> ${pct(N.pair)} (${N.pair >= O.pair ? 'better or equal' : 'WORSE'})`);
console.log(`  VERDICT: ${atLeastAsGood(N) ? 'SHIP the new scoring' : 'DO NOT SHIP the new scoring as it stands'}`);
for (const key of ['usage_level', 'matchup_role', 'uncertainty']) {
  const label = key === 'usage_level' ? 'new, keeping opportunity' : key === 'matchup_role' ? 'new, dropping opponent by role' : 'new, dropping uncertainty';
  const alt = results.get(label)!;
  const altBetter = alt.mae < N.mae - 0.005 && alt.pair >= N.pair;
  console.log(`  ${key}: shipped ${SCORING_RULES.textOnly.includes(key) ? 'text only' : 'scored'}; the other way is ${altBetter ? 'BETTER, switch it' : 'not better, keep as shipped'} (MAE ${alt.mae.toFixed(3)}, ranking ${pct(alt.pair)})`);
}
for (const label of ['new, de-vig only', 'new, skew only', 'new, TD rate only', 'conversion only, factors as before', 'factors removed, bare lines']) {
  const m = results.get(label)!;
  console.log(`  ${label}: MAE ${(m.mae - O.mae >= 0 ? '+' : '') + (m.mae - O.mae).toFixed(3)} vs old, ranking ${((m.pair - O.pair) * 100 >= 0 ? '+' : '') + ((m.pair - O.pair) * 100).toFixed(1)} pts`);
}
const byPos: Record<string, { line: number; actual: number; n: number }> = {};
for (const i of scored) {
  const e = evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile, LEGACY_RULES);
  const b = (byPos[i.position] ??= { line: 0, actual: 0, n: 0 });
  b.line += e.expectation.points ?? 0;
  b.actual += i.actual;
  b.n++;
}
console.log('\n  actual points over the bare-line market number, by position (above 100% means lines read low):');
for (const [pos, b] of Object.entries(byPos)) console.log(`    ${pos}: ${pct(b.actual / b.line)} over ${b.n} player-weeks`);

/* =============================================================== REPLAY */
console.log('\n################ 3. REPLAY: your roster, Best move before and after ################');
const showLineup = (label: string, l: { mode: string; swaps: { slot: string; inName: string; outName: string; gain: number; reason: string; tiebreak?: { sentence: string } }[]; fills: { slot: string; inName: string; gain: number }[]; slots: { slot: string; name: string | null }[] } | undefined) => {
  if (!l) return console.log(`${label}: (no lineup snapshot)`);
  console.log(`\n${label} (mode ${l.mode})`);
  const best = l.fills[0] && (!l.swaps[0] || l.fills[0].gain >= l.swaps[0].gain) ? `Start ${l.fills[0].inName} at ${l.fills[0].slot} (empty), +${r2(l.fills[0].gain)}` : l.swaps[0] ? `Start ${l.swaps[0].inName} over ${l.swaps[0].outName} at ${l.swaps[0].slot}, ${l.swaps[0].gain >= 0 ? '+' : ''}${r2(l.swaps[0].gain)}${l.swaps[0].tiebreak ? ` (${l.swaps[0].tiebreak.sentence})` : ''}` : 'no change';
  console.log(`  Best move: ${best}`);
  for (const s of l.swaps.slice(1)) console.log(`  also: ${s.inName} over ${s.outName} (${s.slot}) ${r2(s.gain)}`);
  console.log(`  lineup: ${l.slots.map((s) => `${s.slot} ${s.name ?? '-'}`).join(' | ')}`);
};
showLineup('BEFORE', old?.lineup);
showLineup('AFTER', neu.lineup);
if (old?.lineup && neu.lineup) {
  console.log('\n  per player: old score -> new score (market number old -> new) [pill]');
  for (const p of neu.lineup.players as { playerId: string; name: string; position: string; score: number | null; vegas: number | null; decision: { points: number } | null; pill: { label: string } | null }[]) {
    const o = (old.lineup.players as { playerId: string; score: number | null; vegas: number | null; decision: { points: number } | null }[]).find((x) => x.playerId === p.playerId);
    console.log(`    ${p.name.padEnd(24)} ${p.position.padEnd(3)} ${r2(o?.decision?.points ?? o?.score)} -> ${r2(p.decision?.points ?? p.score)}   (${r2(o?.vegas)} -> ${r2(p.vegas)})${p.pill ? ` [${p.pill.label}]` : ''}`);
  }
}

/* ============================================================== COMPARE */
console.log('\n################ 4. COMPARE: three sample comparisons ################');
type Cmp = { recommended: string | null; margin: number | null; tiebreak: { sentence: string } | null; players: { playerId: string; name: string; position: string; points: number | null; vegas: number | null; pill: { label: string } | null; rows: string[] }[] };
(neu.comparisons as Cmp[] | undefined)?.forEach((c, k) => {
  const o = (old?.comparisons as Cmp[] | undefined)?.[k];
  console.log(`\n#${k + 1}: ${c.players.map((p) => `${p.name} (${p.position})`).join(' vs ')}`);
  for (const p of c.players) {
    const op = o?.players.find((x) => x.playerId === p.playerId);
    console.log(`  ${p.name.padEnd(24)} ${r2(op?.points)} -> ${r2(p.points)}${p.pill ? ` [${p.pill.label}]` : ''}`);
    console.log(`     old rows: ${op?.rows.join(', ') ?? '-'}`);
    console.log(`     new rows: ${p.rows.join(', ')}`);
  }
  const nameOf = (id: string | null | undefined) => c.players.find((p) => p.playerId === id)?.name ?? '-';
  console.log(`  verdict: ${nameOf(o?.recommended)} by ${r2(o?.margin)} -> ${nameOf(c.recommended)} by ${r2(c.margin)}${c.tiebreak ? `; ${c.tiebreak.sentence}` : ''}`);
});

const cost = read('cost.json');
console.log(`\nthis probe's own D1 reads for the audit and backtest: ${cost.statements} statements, ${cost.rowsRead} rows`);
