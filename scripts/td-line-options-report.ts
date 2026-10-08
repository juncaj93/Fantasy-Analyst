/**
 * The touchdown-line question, replayed on a real lineup three ways.
 *
 *   node --experimental-transform-types --no-warnings scripts/td-line-options-report.ts snapshot.json
 *
 * Audit finding F1 (October 2026). The odds provider quotes one full-game
 * touchdowns over/under per player, and the adapter files it as `anytime_td`
 * whatever its line. On the week-5 board 14 of Alex's 15 quotes were "over 1.5"
 * (two or more touchdowns), so `expectation.ts` scored a two-touchdown chance
 * as if it were an any-touchdown chance, and every market number came out low.
 *
 * This changes no app code. It rebuilds the same lineup from a `lineup` support
 * snapshot three times:
 *
 *   now  the props exactly as stored;
 *   A    a touchdown quote with a line above 0.5 is dropped, so that player's
 *        market is partial and he ranks on Sleeper's published week instead,
 *        the existing fallback for an incomplete market;
 *   B    a touchdown quote with a line of 1.5 is converted: solve a Poisson
 *        touchdown rate from P(2 or more), then use P(1 or more) at that rate,
 *        which is what the 0.5 line would have priced.
 *
 * and prints, per player, the market number and decision number under each,
 * then the recommended lineup and the suggested changes under each.
 */

import { readFileSync } from 'node:fs';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';

type Prop = { market: string; line: number | null; impliedProbability: number | null; [k: string]: unknown };
type Input = { player: { id: string; fullName?: string; position?: string }; props?: Prop[]; [k: string]: unknown };

const file = process.argv[2];
if (!file) {
  console.error('usage: td-line-options-report.ts snapshot.json');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const inputs = snapshot.decision.inputs;
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The Poisson rate whose chance of two or more is `p2`, by bisection. */
export function rateFromTwoOrMore(p2: number): number {
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const atLeastTwo = 1 - Math.exp(-mid) * (1 + mid);
    if (atLeastTwo < p2) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function variant(kind: 'now' | 'A' | 'B') {
  const bundle = structuredClone(inputs.startSit) as { inputs: Input[] };
  for (const input of bundle.inputs) {
    if (!Array.isArray(input.props)) continue;
    if (kind === 'A') {
      input.props = input.props.filter((p) => !(p.market === 'anytime_td' && p.line != null && p.line > 0.5));
    } else if (kind === 'B') {
      input.props = input.props.map((p) => {
        if (p.market !== 'anytime_td' || p.line == null || p.line <= 0.5 || p.impliedProbability == null) return p;
        if (p.line !== 1.5) return { ...p, impliedProbability: null, line: null };
        const rate = rateFromTwoOrMore(p.impliedProbability);
        return { ...p, line: 0.5, impliedProbability: 1 - Math.exp(-rate) };
      });
    }
  }
  return assembleLineup({
    inputs: rehydrateStartSitInputs(bundle as never),
    shape,
    profile,
    currentStarterIds: inputs.currentStarterIds,
    mode: inputs.mode,
    published: new Map(Object.entries(inputs.published as Record<string, number>)),
    unknownPlayers: inputs.unknownPlayers,
    now: snapshot.capturedAt,
  });
}

const runs = { now: variant('now'), A: variant('A'), B: variant('B') };
type Lineup = (typeof runs)['now'];
const everyone = (l: Lineup) => [...l.starters, ...l.bench, ...l.undecidable];
const byId = (l: Lineup) => new Map(everyone(l).map((e) => [e.playerId, e] as const));
const maps = { now: byId(runs.now), A: byId(runs.A), B: byId(runs.B) };

const tdQuote = new Map<string, string>();
for (const input of (inputs.startSit.inputs ?? []) as Input[]) {
  const td = (input.props ?? []).find((p) => p.market === 'anytime_td');
  if (td) tdQuote.set(input.player.id, `TD line ${td.line} at ${td.impliedProbability == null ? '-' : Math.round(td.impliedProbability * 100) + '%'}`);
}

console.log(`week ${snapshot.decision.context?.week} · captured ${snapshot.capturedAt} · ${everyone(runs.now).length} rostered players\n`);
console.log('player | touchdown quote | Vegas number now / A / B | decision number now / A / B | basis now / A / B');
const fmt = (v: number | null | undefined) => (v == null ? '-' : r2(v).toFixed(1));
for (const e of [...everyone(runs.now)].sort((a, b) => a.name.localeCompare(b.name))) {
  const a = maps.A.get(e.playerId);
  const b = maps.B.get(e.playerId);
  console.log(
    [
      `${e.name} (${e.position})`,
      tdQuote.get(e.playerId) ?? 'no TD quote',
      [e, a, b].map((x) => fmt(x?.expectation?.points)).join(' / '),
      [e, a, b].map((x) => fmt(x?.decision?.points)).join(' / '),
      [e, a, b].map((x) => x?.decision?.basis ?? 'none').join(' / '),
    ].join(' | '),
  );
}

for (const [kind, lineup] of Object.entries(runs)) {
  console.log(`\n---- ${kind}: recommended lineup, ${fmt(lineup.recommendedPoints)} pts ----`);
  for (const s of lineup.slots) console.log(`  ${s.slot}: ${s.name ?? '(empty)'} · ${s.score == null ? 'unscored' : r2(s.score)}`);
  console.log(`  changes (${lineup.swaps.length + lineup.fills.length}):`);
  for (const s of lineup.swaps) console.log(`    ${s.slot}: start ${s.inName} over ${s.outName} · +${r2(s.gain)}`);
  for (const f of lineup.fills) console.log(`    ${f.slot}: fill with ${f.inName} · +${r2(f.gain)}`);
}

const starters = (l: Lineup) => l.slots.map((s) => `${s.slot}:${s.name ?? '-'}`).join(', ');
console.log('\n---- what changes ----');
for (const kind of ['A', 'B'] as const) {
  const same = starters(runs[kind]) === starters(runs.now);
  console.log(`${kind}: starters ${same ? 'unchanged' : 'CHANGED'}; changes suggested ${runs.now.swaps.length + runs.now.fills.length} -> ${runs[kind].swaps.length + runs[kind].fills.length}`);
  if (!same) {
    const was = new Set(runs.now.slots.map((s) => s.name));
    const is = new Set(runs[kind].slots.map((s) => s.name));
    console.log(`   in: ${[...is].filter((n) => !was.has(n)).join(', ') || '-'}   out: ${[...was].filter((n) => !is.has(n)).join(', ') || '-'}`);
  }
}
