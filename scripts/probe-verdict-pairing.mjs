/**
 * Which player does each "→ Start X instead" actually sit under?
 *
 * Reported from the live screen: `→ Start RJ Harvey instead · 7.2` printed on a
 * row belonging to somebody else. `buildLineupVerdicts` paired Sleeper's Nth
 * slot of a label with the app's Nth slot of the same label, and the two orders
 * are not the same order.
 *
 * **This asks the real function, not a copy of it.** An earlier version of this
 * script reimplemented the pairing inline to demonstrate the defect, which made
 * it useless for confirming the fix: it printed the old answer whatever was
 * deployed. It now imports `buildLineupVerdicts` from the checked-out revision
 * and runs it over live production data, and prints the served `gitSha` beside
 * the result so the two can be read together — the source under test and the
 * source the worker was built from.
 *
 * Reads only.
 */

import { buildLineupVerdicts } from '../src/core/startsit/sleeperLineup.ts';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

const health = await get('/api/health');
const sha = health.json?.gitSha ?? health.json?.release?.gitSha ?? '(none)';
console.log(`asking ${APP}`);
console.log(`/api/health -> ${health.status}  gitSha=${sha}\n`);

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0];

const [roster, lineup] = await Promise.all([
  get(`/api/leagues/${league.id}/roster`),
  get(`/api/leagues/${league.id}/lineup`),
]);

const nameOf = new Map();
const positionOfMap = new Map();
for (const group of ['starters', 'bench', 'players', 'reserve']) {
  for (const p of roster.json?.[group] ?? []) {
    nameOf.set(p.playerId, p.name ?? p.fullName ?? p.playerId);
    if (p.position) positionOfMap.set(p.playerId, p.position);
  }
}
for (const s of [...(lineup.json?.slots ?? []), ...(lineup.json?.bench ?? [])]) {
  if (s.playerId) nameOf.set(s.playerId, s.name ?? s.playerId);
}
const who = (id) => (id == null ? '(empty)' : (nameOf.get(id) ?? id));

console.log("--- Sleeper's lineup, in Sleeper's slot order ---");
const labels = (roster.json?.rosterPositions ?? [])
  .map((p) => String(p ?? '').toUpperCase())
  .filter((p) => p && !['BN', 'IR', 'TAXI'].includes(p));
const slotIds = roster.json?.starterSlotIds ?? [];
labels.forEach((label, i) => console.log(`  ${String(i).padStart(2)} ${label.padEnd(6)} ${who(slotIds[i] ?? null)}`));

console.log("\n--- the app's recommended slots, in the app's order ---");
(lineup.json?.slots ?? []).forEach((s, i) =>
  console.log(
    `  ${String(i).padStart(2)} ${String(s.slot).padEnd(6)} ${String(who(s.playerId)).padEnd(22)} proj=${s.projection ?? '—'}`,
  ),
);

const swaps = lineup.json?.swaps ?? [];
console.log('\n--- swaps the optimiser stands behind ---');
for (const s of swaps) {
  console.log(`  out ${String(who(s.outPlayerId)).padEnd(22)} in ${String(who(s.inPlayerId)).padEnd(22)} gain=${s.gain}`);
}
if (swaps.length === 0) console.log('  (none)');

/* The screen's own call, with the screen's own arguments. */
const rows = buildLineupVerdicts({
  rosterPositions: roster.json?.rosterPositions ?? [],
  starterIds: (roster.json?.starters ?? []).map((p) => p.playerId),
  ...(roster.json?.starterSlotIds ? { starterSlotIds: roster.json.starterSlotIds } : {}),
  slots: lineup.json?.slots ?? [],
  suggestedSwaps: swaps,
  positionOf: (id) => positionOfMap.get(id) ?? null,
});

console.log('\n--- what the rows say, from buildLineupVerdicts itself ---');
for (const row of rows) {
  const line = `  ${row.slot.padEnd(6)} row shows ${String(who(row.currentPlayerId)).padEnd(22)} proj=${String(row.projection ?? '—').padEnd(7)} verdict=${row.verdict.padEnd(8)}`;
  console.log(row.verdict === 'swap' ? `${line} → Start ${who(row.recommendedPlayerId)} instead` : line);
}

/*
 * The two properties the report was about, checked rather than eyeballed.
 *
 *   1. A swap is offered on the row of the man it replaces.
 *   2. A kept row carries its own man's projection.
 */
console.log('\n--- the two properties, checked ---');
const outOf = new Map(swaps.map((s) => [s.inPlayerId, s.outPlayerId]));
const projectionOf = new Map((lineup.json?.slots ?? []).map((s) => [s.playerId, s.projection]));
let bad = 0;
for (const row of rows) {
  if (row.verdict === 'swap') {
    const expected = outOf.get(row.recommendedPlayerId);
    const ok = expected === row.currentPlayerId;
    if (!ok) bad += 1;
    console.log(
      `  ${ok ? 'OK  ' : 'FAIL'} swap ${who(row.recommendedPlayerId)} is offered on ${who(row.currentPlayerId)}'s row; the optimiser replaces ${who(expected ?? null)}`,
    );
  } else if (row.verdict === 'keep' && row.currentPlayerId) {
    const mine = projectionOf.get(row.currentPlayerId) ?? null;
    const ok = row.projection === mine;
    if (!ok) bad += 1;
    if (!ok) console.log(`  FAIL ${who(row.currentPlayerId)}'s row prints ${row.projection}, his own figure is ${mine}`);
  }
}
console.log(bad === 0 ? '  every kept row carries its own man’s figure' : `  ${bad} row(s) wrong`);
