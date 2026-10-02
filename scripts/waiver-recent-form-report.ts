/**
 * The waiver decision a support snapshot produces, printed plainly.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-recent-form-report.ts snapshot.json
 *
 * Runs the real `assembleWaiverPlan` over the snapshot's own inputs, with no
 * network, and prints what the 7-day round cares about: who is on the bench
 * with what 7-day and 30-day tally, who the plan drops, the claims in order,
 * and the board's order. Run it once against the code before the round and
 * once against the code after, on the same file, and the two outputs are the
 * before and the after on the league's real data.
 *
 * The 7-day item count printed is `last7Count`, the real one. `last7.items` is
 * zero on every stored-summary read by design (the draft board depends on it),
 * so it says nothing about how many items the week holds. A snapshot captured
 * before `last7Count` existed says "count not carried".
 *
 * Reads only the fields both versions of the engine have, so it works on
 * either checkout.
 */

import { readFileSync } from 'node:fs';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import { snapshotDstSources } from '../src/core/support/dstSnapshot.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { rehydratePlayer } from '../src/core/support/players.ts';

/** The 7-day item count below which the week says nothing. Mirrors `RECENT_FORM.minItems`. */
const MIN_ITEMS = 2;

const file = process.argv[2];
if (!file) {
  console.error('usage: waiver-recent-form-report.ts snapshot.json');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const inputs = snapshot.decision.inputs;

const roster = rehydrateStartSitInputs(inputs.roster);
const candidates = rehydrateStartSitInputs(inputs.candidates);
const { shape, profile } = rehydrateLeagueRules(inputs.rules);

const decision = await assembleWaiverPlan({
  shape,
  profile,
  rosterInputs: roster,
  candidateInputs: candidates,
  rosteredIds: new Set(inputs.rosteredIds as string[]),
  currentStarterIds: inputs.currentStarterIds,
  reserveIds: inputs.reserveIds,
  ...(inputs.preseasonPoints === undefined ? {} : { preseasonPoints: new Map(Object.entries(inputs.preseasonPoints)) }),
  ...(inputs.draftRankOf === undefined ? {} : { draftRankOf: new Map(Object.entries(inputs.draftRankOf)) }),
  ...(inputs.published === undefined ? {} : { published: new Map(Object.entries(inputs.published)) }),
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
  now: new Date(Date.parse(snapshot.capturedAt)),
  generatedAt: inputs.generatedAt,
});

type Tally = {
  last7: { net: number; items: number };
  last7Count?: number;
  last30: { net: number; items: number };
};

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
const tally = (s: Tally | null | undefined) =>
  s
    ? `7d ${sign(s.last7.net)} (${s.last7Count ?? s.last7.items} items${s.last7Count === undefined ? ', count not carried' : ''}) | 30d ${sign(s.last30.net)} (${s.last30.items} items)`
    : 'no tally';
const published: Record<string, number> = inputs.published ?? {};
const starters = new Set<string>(inputs.currentStarterIds);

console.log(`captured ${snapshot.capturedAt}  week ${inputs.week}  release ${snapshot.release?.gitSha ?? '?'}`);
console.log(`\nYOUR NON-STARTERS (name, position, Sleeper projection, tallies)`);
for (const r of roster.filter((i) => !starters.has(i.player.id))) {
  console.log(
    `  ${r.player.fullName.padEnd(22)} ${String(r.player.position).padEnd(3)} proj ${String(published[r.player.id] ?? '-').padStart(5)}  ${tally(r.signal)}`,
  );
}

console.log(`\nTHE PLAN (${decision.claimPlan?.state ?? 'none'})`);
for (const g of decision.claimPlan?.groups ?? []) {
  const note = (g as { formNote?: string | null }).formNote;
  console.log(`  ${g.headline}${note ? `  [${note}]` : ''}`);
  for (const c of (decision.claimPlan?.claims ?? []).filter((x) => x.group === g.index)) {
    console.log(`    ${c.rank}. ${c.headline}${c.detail ? `  -- ${c.detail}` : ''}`);
  }
}

const byId = new Map(candidates.map((c) => [c.player.id, c]));
console.log(`\nTHE BOARD, in the order the screen draws it (name, projection, 7d | 30d, the card's one line)`);
const board = buildWaiverBoard({ ...decision, faab: { bids: decision.bids }, pickup: decision.pickup } as never);
for (const row of board.rows.filter((r) => r.dst == null && r.strength.level !== 'unknown')) {
  console.log(
    `  ${row.strength.label.padEnd(12)} ${row.name.padEnd(22)} proj ${String(published[row.playerId] ?? '-').padStart(5)}  ${tally(byId.get(row.playerId)?.signal)}  cut ${row.cut?.name ?? '-'}${row.notes[0] ? `  "${row.notes[0]}"` : ''}`,
  );
}

/*
 * The census the round is judged on: how many players have a week the engine is
 * allowed to read at all. A count at or above the minimum with an identical plan
 * would mean something other than thin data is holding the signal back.
 */
const everyone = [
  ...roster.map((i) => ({ who: i.player.fullName, side: 'roster', signal: i.signal as Tally | null })),
  ...candidates.map((i) => ({ who: i.player.fullName, side: 'wire', signal: i.signal as Tally | null })),
];
const carried = everyone.filter((p) => p.signal && p.signal.last7Count !== undefined);
const readable = carried.filter((p) => (p.signal!.last7Count ?? 0) >= MIN_ITEMS);
console.log(`\nCENSUS OF 7-DAY ITEM COUNTS (minimum to be read: ${MIN_ITEMS})`);
console.log(`  players in the snapshot: ${everyone.length}  with a tally: ${everyone.filter((p) => p.signal).length}`);
console.log(`  carrying the real count (last7Count): ${carried.length}`);
console.log(`  at or above the minimum: ${readable.length}`);
for (const p of readable) {
  console.log(`    ${p.side.padEnd(6)} ${p.who.padEnd(22)} ${tally(p.signal)}`);
}
const histogram = new Map<number, number>();
for (const p of carried) histogram.set(p.signal!.last7Count!, (histogram.get(p.signal!.last7Count!) ?? 0) + 1);
console.log(
  `  histogram (count: players): ${[...histogram.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(', ') || '(none carried)'}`,
);
