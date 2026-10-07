/**
 * How close the waiver wire came to the bars, on the league's real data.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-near-miss-report.ts snapshot.json
 *
 * Replays a `waiver-plan` support snapshot with no network. The plan itself is
 * the real `assembleWaiverPlan`; the near misses are worked out here with the
 * same yardstick functions the planner uses (`readYardstick`,
 * `compareOnYardstick`, `buildCutPool`), because the planner only returns the
 * players who cleared.
 *
 * Two bars, because the board asks two questions:
 *
 *  - **Starter upgrade**: beats the man the lineup starts in a slot he fits by
 *    `MEANINGFUL_UPGRADE_GAIN` (2.5) on betting lines, or 3.0 on Sleeper's
 *    projection.
 *  - **Bench add**: beats the weakest bench player who competes for his slots
 *    by the yardstick bar (0.5 on betting lines, 1.0 on Sleeper's projection),
 *    or by the starter bar when his position is already at its depth cap.
 *
 * Read-only. Prints names and numbers, nothing else.
 */

import { readFileSync } from 'node:fs';
import { assembleWaiverPlan, waiverLineup } from '../src/core/waivers/assemble.ts';
import { evaluatePlayer, type StartSitEvaluation } from '../src/core/startsit/engine.ts';
import { MEANINGFUL_UPGRADE_GAIN } from '../src/core/startsit/waivers.ts';
import { buildCutPool, compareOnYardstick, readYardstick, type YardstickReading } from '../src/core/waivers/yardstick.ts';
import { depthCap } from '../src/core/waivers/depthPolicy.ts';
import { publishedRefusal } from '../src/core/sleeper/weeklyProjections.ts';
import { snapshotDstSources } from '../src/core/support/dstSnapshot.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { rehydratePlayer } from '../src/core/support/players.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: waiver-near-miss-report.ts snapshot.json');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const inputs = snapshot.decision.inputs;
const now = new Date(Date.parse(snapshot.capturedAt));

const roster = rehydrateStartSitInputs(inputs.roster);
const candidates = rehydrateStartSitInputs(inputs.candidates);
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const published = new Map<string, number>(Object.entries((inputs.published ?? {}) as Record<string, number>));
const rosteredIds = new Set(inputs.rosteredIds as string[]);
const reserveIds = new Set<string>(inputs.reserveIds ?? []);

const decision = await assembleWaiverPlan({
  shape,
  profile,
  rosterInputs: roster,
  candidateInputs: candidates,
  rosteredIds,
  currentStarterIds: inputs.currentStarterIds,
  reserveIds: inputs.reserveIds,
  ...(inputs.preseasonPoints === undefined ? {} : { preseasonPoints: new Map(Object.entries(inputs.preseasonPoints)) }),
  ...(inputs.draftRankOf === undefined ? {} : { draftRankOf: new Map(Object.entries(inputs.draftRankOf)) }),
  ...(inputs.published === undefined ? {} : { published }),
  ...(inputs.depth === undefined ? {} : { depth: new Map(Object.entries(inputs.depth)) }),
  ...(inputs.trendingDrops === undefined ? {} : { trendingDrops: new Map(inputs.trendingDrops) }),
  ...(inputs.recentlyDropped === undefined ? {} : { recentlyDropped: new Map(Object.entries(inputs.recentlyDropped)) }),
  ...(inputs.waiverWindow == null
    ? {}
    : { waiverWindow: { rules: inputs.waiverWindow.rules, drops: new Map(Object.entries(inputs.waiverWindow.drops)) } }),
  rosters: inputs.rosters,
  players: inputs.players.map(rehydratePlayer),
  week: inputs.week,
  season: inputs.season,
  strategy: inputs.strategy == null ? null : { ...inputs.strategy, trending: new Map(inputs.strategy.trending) },
  trending: inputs.strategy == null ? undefined : new Map(inputs.strategy.trending),
  ...(inputs.seasonMarkets == null ? {} : { seasonMarkets: new Map(inputs.seasonMarkets) }),
  budgets: inputs.budgets,
  prices: inputs.prices,
  observations: inputs.observations,
  ...(inputs.history == null
    ? {}
    : {
        history: {
          profiles: new Map(inputs.history.profiles),
          baseline: inputs.history.baseline,
          week: inputs.history.week,
          finalWeek: inputs.history.finalWeek,
        },
      }),
  dstSources: inputs.dst == null ? null : snapshotDstSources(inputs.dst),
  bestBall: inputs.bestBall,
  draftComplete: inputs.draftComplete,
  playoff: inputs.playoff,
  now,
  generatedAt: inputs.generatedAt,
});

const lineup = waiverLineup({
  rosterInputs: roster,
  shape,
  profile,
  currentStarterIds: inputs.currentStarterIds,
  now,
  published,
});

const propsOf = new Map([...roster, ...candidates].map((i) => [i.player.id, i.props ?? []] as const));
const evalOf = new Map<string, StartSitEvaluation>();
for (const i of [...roster, ...candidates]) evalOf.set(i.player.id, evaluatePlayer(i, profile));
const readingOf = (id: string): YardstickReading => {
  const e = evalOf.get(id)!;
  return readYardstick(e, propsOf.get(id) ?? [], published.get(id));
};

const starterIds = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
const pool = buildCutPool({
  roster: roster.map((i) => readingOf(i.player.id)),
  starterIds,
  reserveIds,
  ruledOutIds: new Set(roster.filter((i) => evalOf.get(i.player.id)!.ruledOut).map((i) => i.player.id)),
  held: new Map(),
  handcuffs: new Map(),
  excludedPositions: new Set(['DEF']),
});

const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
const signed = (v: number) => (!Number.isFinite(v) ? "fills" : v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

console.log(`captured ${snapshot.capturedAt}  week ${inputs.week}  release ${snapshot.release?.gitSha ?? '?'}`);
console.log(`plan state: ${decision.claimPlan?.state ?? 'none'}  headline: ${decision.headline ?? decision.claimPlan?.headline ?? '-'}`);
console.log(`free agents in the scan: ${candidates.filter((c) => !rosteredIds.has(c.player.id)).length}`);

console.log('\nTHE LINEUP THE WIRE IS MEASURED AGAINST (slot, starter, market, Sleeper)');
for (const s of lineup.slots) {
  const r = s.playerId ? readingOf(s.playerId) : null;
  console.log(`  ${s.slot.padEnd(5)} ${(s.name ?? '(empty)').padEnd(24)} mkt ${fmt(r?.market).padStart(5)}  slp ${fmt(r?.sleeper).padStart(5)}${s.locked ? '  locked' : ''}`);
}
console.log('\nTHE CUT POOL (weakest first, non-starters)');
for (const c of pool.candidates.filter((x) => !x.starting)) {
  console.log(`  ${c.reading.name.padEnd(24)} ${c.reading.position.padEnd(3)} standing ${fmt(c.standing, 2).padStart(6)}  mkt ${fmt(c.reading.market).padStart(5)}  slp ${fmt(c.reading.sleeper).padStart(5)}`);
}

interface Miss {
  name: string;
  position: string;
  reading: YardstickReading;
  starter: { over: string; slot: string; gap: number; bar: number; basis: string } | null;
  bench: { over: string; gap: number; bar: number; basis: string } | null;
}

const unreadable = new Map<string, string[]>();
const misses: Miss[] = [];
for (const c of candidates) {
  const id = c.player.id;
  if (rosteredIds.has(id)) continue;
  const e = evalOf.get(id)!;
  const pos = e.position;
  if (pos === 'DEF') continue;
  const reading = readingOf(id);
  if (e.ruledOut || e.lock.locked) continue;
  if (reading.market == null && reading.sleeper == null) {
    const why =
      publishedRefusal(profile, pos) != null
        ? `${pos}: Sleeper's number refused for this league's scoring, no full betting market`
        : e.expectation?.points != null
          ? `${pos}: partial betting market, nothing published`
          : `${pos}: no betting market, nothing published`;
    unreadable.set(why, [...(unreadable.get(why) ?? []), e.name]);
    continue;
  }

  let starter: Miss['starter'] = null;
  for (const slot of lineup.slots) {
    if (slot.locked || !slot.accepts.includes(pos)) continue;
    if (slot.accepts.every((p) => p === 'DEF')) continue;
    if (!slot.playerId) {
      /* An empty slot has no bar: anybody readable fills it. */
      starter = { over: '(empty slot)', slot: slot.slot, gap: Infinity, bar: 0, basis: 'fill' };
      break;
    }
    const cmp = compareOnYardstick(reading, readingOf(slot.playerId));
    if (!cmp) continue;
    const bar = Math.round((MEANINGFUL_UPGRADE_GAIN + (cmp.basis === 'sleeper' ? 0.5 : 0)) * 100) / 100;
    if (!starter || cmp.gap - bar > starter.gap - starter.bar) {
      starter = { over: slot.name ?? '?', slot: slot.slot, gap: cmp.gap, bar, basis: cmp.basis };
    }
  }

  const slots = lineup.slots.filter((s) => s.accepts.includes(pos));
  const competes = (other: string) => slots.some((s) => s.accepts.includes(other));
  const cap = depthCap(pos, { shape, week: inputs.week ?? 1, playoffWeeks: inputs.playoff?.weeks ?? [] });
  const held = roster.filter((i) => {
    const ev = evalOf.get(i.player.id)!;
    return ev.position === pos && !reserveIds.has(ev.playerId) && !ev.ruledOut;
  }).length;
  const overCap = cap != null && held >= cap;
  let bench: Miss['bench'] = null;
  for (const cut of pool.candidates) {
    if (cut.starting) continue;
    if (overCap ? cut.reading.position !== pos : !competes(cut.reading.position)) continue;
    const cmp = compareOnYardstick(reading, cut.reading);
    if (!cmp) continue;
    const bar = overCap ? Math.max(cmp.bar, MEANINGFUL_UPGRADE_GAIN) : cmp.bar;
    bench = { over: cut.reading.name, gap: cmp.gap, bar, basis: cmp.basis };
    break;
  }
  misses.push({ name: e.name, position: pos, reading, starter, bench });
}

const best = (m: Miss) =>
  Math.max(m.starter ? m.starter.gap - m.starter.bar : -Infinity, m.bench ? m.bench.gap - m.bench.bar : -Infinity);
misses.sort((a, b) => best(b) - best(a) || a.name.localeCompare(b.name));

console.log('\nEVERY READABLE FREE AGENT, closest to a bar first');
console.log('  name | pos | mkt | slp | vs starter (slot, gap, bar, margin) | vs bench (who, gap, bar, margin)');
for (const m of misses) {
  const s = m.starter
    ? `${m.starter.slot} ${m.starter.over}: ${signed(m.starter.gap)} vs ${m.starter.bar.toFixed(1)} (${m.starter.basis}) = ${signed(m.starter.gap - m.starter.bar)}`
    : 'no comparison';
  const b = m.bench
    ? `${m.bench.over}: ${signed(m.bench.gap)} vs ${m.bench.bar.toFixed(1)} (${m.bench.basis}) = ${signed(m.bench.gap - m.bench.bar)}`
    : 'no comparison';
  console.log(`  ${m.name.padEnd(24)} ${m.position.padEnd(3)} ${fmt(m.reading.market).padStart(5)} ${fmt(m.reading.sleeper).padStart(5)} | ${s} | ${b}`);
}

const within = (lo: number, hi: number, pick: (m: Miss) => { gap: number; bar: number } | null) =>
  misses.filter((m) => {
    const x = pick(m);
    if (!x) return false;
    const margin = x.gap - x.bar;
    return margin >= lo && (margin < hi || hi === Infinity);
  }).length;
console.log('\nNEAR-MISS COUNTS (margin = gap minus bar; cleared is margin >= 0)');
for (const [label, pick] of [
  ['starter upgrade', (m: Miss) => m.starter],
  ['bench add', (m: Miss) => m.bench],
] as const) {
  console.log(
    `  ${label.padEnd(16)} cleared ${within(0, Infinity, pick)} · within 0.5 ${within(-0.5, 0, pick)} · within 1.0 ${within(-1, -0.5, pick)} · within 1.5 ${within(-1.5, -1, pick)} · further ${within(-Infinity, -1.5, pick)} · no comparison ${misses.filter((m) => !pick(m)).length}`,
  );
}
console.log(`\nUNREADABLE FREE AGENTS: ${[...unreadable.values()].reduce((a, v) => a + v.length, 0)}`);
for (const [why, names] of unreadable) console.log(`  ${names.length} · ${why}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`);
