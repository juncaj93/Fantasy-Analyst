/**
 * The Start/Sit score on the league's real lineup, with the market's share of it.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-vegas-weighting-report.ts snapshot.json
 *
 * Replays a `lineup` support snapshot through the real `assembleLineup`, with no
 * network, and prints for every rostered player the Vegas number, the sum of
 * every secondary adjustment, and that sum as a percent of Vegas. Then the
 * distribution, the two news lines' share on their own, the recommended slots,
 * and every change the lineup would suggest.
 *
 * Run once against the code before the round and once after, on the same file.
 * It reads only fields both versions have (`key`, `value`, `unknown`), and it
 * names the secondary keys itself, so the same file works on either checkout.
 * Where a component carries `preBudgetValue` (after the round) the report also
 * prints what the sum would have been without the budget.
 */

import { readFileSync } from 'node:fs';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';

const NEWS = ['news_recent', 'news_raw'];
const LIMIT = 0.1;

const file = process.argv[2];
if (!file) {
  console.error('usage: startsit-vegas-weighting-report.ts snapshot.json');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const inputs = snapshot.decision.inputs;
const { shape, profile } = rehydrateLeagueRules(inputs.rules);

const lineup = assembleLineup({
  inputs: rehydrateStartSitInputs(inputs.startSit),
  shape,
  profile,
  currentStarterIds: inputs.currentStarterIds,
  mode: inputs.mode,
  published: new Map(Object.entries(inputs.published as Record<string, number>)),
  unknownPlayers: inputs.unknownPlayers,
  now: snapshot.capturedAt,
});

type Comp = { key: string; value: number; unknown: boolean; preBudgetValue?: number; display?: string };
const everyone = [...lineup.starters, ...lineup.bench, ...lineup.undecidable];
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const sumOf = (comps: Comp[], keys: string[], raw = false) =>
  comps.filter((c) => !c.unknown && keys.includes(c.key)).reduce((a, c) => a + (raw ? (c.preBudgetValue ?? c.value) : c.value), 0);

/*
 * The base a decision is made on, per player: the market's number when it is a
 * complete market, Rotowire's published week when it is not, and nothing at all
 * when neither exists. `decision` is what the lineup and the Compare sheet rank
 * on, so it is what is measured here, and both versions of the engine have it.
 *
 * "Secondary" is the decision's adjustments less availability, which is a gate
 * and not a nudge.
 */
interface Row {
  name: string;
  slot: string;
  basis: string;
  base: number;
  secondary: number;
  news: number;
  status: number;
  points: number | null;
}
const starterSlot = new Map(lineup.slots.map((s) => [s.playerId, s.slot]));
const rows: Row[] = everyone
  .map((e) => {
    const comps = e.components as Comp[];
    const d = e.decision;
    const status = sumOf(comps, ['status']);
    return {
      name: `${e.name} (${e.position})`,
      slot: starterSlot.get(e.playerId) ?? 'bench',
      basis: d?.basis ?? 'none',
      base: d?.base ?? NaN,
      secondary: d == null ? 0 : d.adjustments - status,
      news: sumOf(comps, NEWS),
      status,
      points: d?.points ?? null,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`week ${snapshot.decision.context.week} · ${inputs.mode} · ${rows.length} rostered players\n`);
console.log('player | slot | basis | base | secondary | secondary % of base | news lines (engine) | availability | decision points');
for (const r of rows) {
  const ok = Number.isFinite(r.base) && r.base > 0 && r.basis !== 'unpriced';
  console.log(
    [
      r.name,
      r.slot,
      r.basis,
      ok ? r.base.toFixed(2) : 'n/a',
      r.secondary.toFixed(2),
      ok ? pct(r.secondary / r.base) : 'n/a',
      r.news.toFixed(2),
      r.status.toFixed(2),
      r.points == null ? 'unscored' : r.points.toFixed(2),
    ].join(' | '),
  );
}

const priced = rows.filter((r) => Number.isFinite(r.base) && r.base > 0 && r.basis !== 'unpriced');
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const absShare = priced.map((r) => Math.abs(r.secondary) / r.base);
const newsShare = priced.map((r) => Math.abs(r.news) / r.base);
const count = (b: string) => rows.filter((r) => r.basis === b).length;
console.log(`\nbases: market ${count('market')} · partial market ${count('partial')} · published week ${count('published')} · unpriced ${count('unpriced')}`);
console.log(`measurable players (a base above zero): ${priced.length} of ${rows.length}`);
if (priced.length > 0) {
  console.log('|secondary| / base       median ' + pct(quantile(absShare, 0.5)) + ' · p90 ' + pct(quantile(absShare, 0.9)) + ' · max ' + pct(Math.max(...absShare)));
  console.log('|news, both lines| / base   median ' + pct(quantile(newsShare, 0.5)) + ' · p90 ' + pct(quantile(newsShare, 0.9)) + ' · max ' + pct(Math.max(...newsShare)));
}
const worst = [...priced].sort((a, b) => Math.abs(b.secondary) / b.base - Math.abs(a.secondary) / a.base).slice(0, 5);
console.log('largest secondary shares:');
for (const w of worst) console.log(`  ${w.name}: base ${w.base.toFixed(2)} (${w.basis}), secondary ${w.secondary.toFixed(2)} (${pct(w.secondary / w.base)}), news ${w.news.toFixed(2)}`);
const over = priced.filter((r) => Math.abs(r.secondary) > r.base * LIMIT + 0.011);
console.log(`\nINVARIANT players over ${LIMIT * 100}% of base: ${over.length}${over.length ? ' -> ' + over.map((o) => o.name).join(', ') : ''}`);
if (over.length > 0 && process.env.STRICT) process.exitCode = 1;

console.log('\nrecommended lineup');
for (const s of lineup.slots) console.log(`  ${s.slot}: ${s.name ?? '(empty)'} · ${s.score == null ? 'unscored' : r2(s.score)}`);
console.log(`\nswaps (${lineup.swaps.length})`);
for (const s of lineup.swaps) console.log(`  ${s.slot}: start ${s.inName} over ${s.outName} · +${r2(s.gain)} · ${s.reason}`);
console.log(`fills (${lineup.fills.length})`);
for (const f of lineup.fills) console.log(`  ${f.slot}: ${f.inName} · +${r2(f.gain)}`);

console.log('\nbreakdowns, three largest secondary shares');
for (const w of worst.slice(0, 3)) {
  const e = everyone.find((x) => `${x.name} (${x.position})` === w.name)!;
  console.log(`  ${w.name}`);
  for (const c of e.components as Comp[]) {
    if (c.unknown) continue;
    const was = c.preBudgetValue == null ? '' : ` (was ${c.preBudgetValue.toFixed(2)})`;
    console.log(`    ${c.key}: ${c.value.toFixed(2)}${was}`);
  }
}
