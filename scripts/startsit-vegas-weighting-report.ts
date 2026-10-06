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

/** Everything that is neither the market nor availability. */
const SECONDARY = [
  'news_recent',
  'news_raw',
  'uncertainty',
  'usage_level',
  'role_trend',
  'td_dependency',
  'game_script',
  'weather',
  'matchup_role',
  'explosiveness',
];
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

interface Row {
  name: string;
  slot: string;
  vegas: number;
  secondary: number;
  secondaryRaw: number;
  news: number;
  newsRaw: number;
  status: number;
  share: number | null;
  score: number | null;
}
const starterSlot = new Map(lineup.slots.map((s) => [s.playerId, s.slot]));
const rows: Row[] = everyone
  .map((e) => {
    const comps = e.components as Comp[];
    const vegas = e.expectation.points == null ? null : (comps.find((c) => c.key === 'vegas')?.value ?? null);
    return {
      name: `${e.name} (${e.position})`,
      slot: starterSlot.get(e.playerId) ?? 'bench',
      vegas: vegas ?? NaN,
      secondary: sumOf(comps, SECONDARY),
      secondaryRaw: sumOf(comps, SECONDARY, true),
      news: sumOf(comps, NEWS),
      newsRaw: sumOf(comps, NEWS, true),
      status: sumOf(comps, ['status']),
      share: vegas == null || vegas <= 0 ? null : Math.abs(sumOf(comps, SECONDARY)) / vegas,
      score: e.score,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`week ${snapshot.decision.context.week} · ${inputs.mode} · ${rows.length} rostered players\n`);
console.log('player | slot | vegas | secondary | secondary % of vegas | news (both) | availability | score');
for (const r of rows) {
  const priced = Number.isFinite(r.vegas) && r.vegas > 0;
  console.log(
    [
      r.name,
      r.slot,
      priced ? r.vegas.toFixed(2) : 'no market',
      r.secondary.toFixed(2),
      priced ? pct(r.secondary / r.vegas) : 'n/a',
      r.news.toFixed(2),
      r.status.toFixed(2),
      r.score == null ? 'unscored' : r.score.toFixed(2),
    ].join(' | '),
  );
}

const priced = rows.filter((r) => Number.isFinite(r.vegas) && r.vegas > 0);
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const absShare = priced.map((r) => Math.abs(r.secondary) / r.vegas);
const newsShare = priced.map((r) => Math.abs(r.news) / r.vegas);
console.log(`\npriced players: ${priced.length} of ${rows.length}`);
console.log('|secondary| / vegas      median ' + pct(quantile(absShare, 0.5)) + ' · p90 ' + pct(quantile(absShare, 0.9)) + ' · max ' + pct(Math.max(...absShare)));
console.log('|news, both lines| / vegas  median ' + pct(quantile(newsShare, 0.5)) + ' · p90 ' + pct(quantile(newsShare, 0.9)) + ' · max ' + pct(Math.max(...newsShare)));
if (priced.some((r) => r.secondaryRaw !== r.secondary)) {
  const rawShare = priced.map((r) => Math.abs(r.secondaryRaw) / r.vegas);
  console.log('without the budget      median ' + pct(quantile(rawShare, 0.5)) + ' · p90 ' + pct(quantile(rawShare, 0.9)) + ' · max ' + pct(Math.max(...rawShare)));
}
const worst = [...priced].sort((a, b) => Math.abs(b.secondary) / b.vegas - Math.abs(a.secondary) / a.vegas).slice(0, 5);
console.log('largest secondary shares:');
for (const w of worst) console.log(`  ${w.name}: vegas ${w.vegas.toFixed(2)}, secondary ${w.secondary.toFixed(2)} (${pct(w.secondary / w.vegas)}), news ${w.news.toFixed(2)}`);
const over = priced.filter((r) => Math.abs(r.secondary) > r.vegas * LIMIT + 1e-9);
console.log(`\nINVARIANT players over ${LIMIT * 100}% of vegas: ${over.length}${over.length ? ' -> ' + over.map((o) => o.name).join(', ') : ''}`);

if (over.length > 0) process.exitCode = 1;

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
