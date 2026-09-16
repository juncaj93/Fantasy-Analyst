/**
 * Which player does each "→ Start X instead" actually sit under?
 *
 * Reported from the live screen: `→ Start RJ Harvey instead · 7.2` printed on
 * Bijan Robinson's row. `buildLineupVerdicts` pairs Sleeper's Nth slot of a
 * label with the app's Nth slot of the same label, positionally, and the two
 * orders are not the same order. This dumps both halves side by side so the
 * mismatch can be read rather than argued about.
 *
 * Reads only.
 */

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

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0];
console.log(`league ${league.id}\n`);

const [roster, lineup] = await Promise.all([
  get(`/api/leagues/${league.id}/roster`),
  get(`/api/leagues/${league.id}/lineup`),
]);

const nameOf = new Map();
for (const group of ['starters', 'bench', 'players', 'reserve']) {
  for (const p of roster.json?.[group] ?? []) nameOf.set(p.playerId, p.name ?? p.fullName ?? p.playerId);
}
for (const s of lineup.json?.slots ?? []) if (s.playerId) nameOf.set(s.playerId, s.name ?? s.playerId);
for (const b of lineup.json?.bench ?? []) nameOf.set(b.playerId, b.name ?? b.playerId);
const who = (id) => (id == null ? '(empty)' : (nameOf.get(id) ?? id));

console.log('rosterPositions:', JSON.stringify(roster.json?.rosterPositions ?? null));
console.log('starterSlotIds :', JSON.stringify((roster.json?.starterSlotIds ?? []).map(who)));
console.log('');

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

console.log('\n--- swaps the optimiser stands behind ---');
for (const s of lineup.json?.swaps ?? []) {
  console.log(`  out ${String(who(s.outPlayerId)).padEnd(22)} in ${String(who(s.inPlayerId)).padEnd(22)} gain=${s.gain}`);
}
if ((lineup.json?.swaps ?? []).length === 0) console.log('  (none)');

console.log('\n--- what the screen pairs, label by label, exactly as it does now ---');
const remaining = new Map();
for (const slot of lineup.json?.slots ?? []) {
  const key = String(slot.slot).toUpperCase();
  if (remaining.has(key)) remaining.get(key).push(slot);
  else remaining.set(key, [slot]);
}
const suggested = new Set((lineup.json?.swaps ?? []).map((s) => s.inPlayerId));
labels.forEach((label, i) => {
  const rec = remaining.get(label)?.shift() ?? null;
  const cur = slotIds[i] ?? null;
  let verdict = 'keep';
  if (cur == null && rec?.playerId == null) verdict = 'empty';
  else if (cur == null) verdict = 'fill';
  else if (rec?.playerId == null) verdict = 'no_pick';
  else if (cur === rec.playerId) verdict = 'keep';
  else if (!suggested.has(rec.playerId)) verdict = 'keep';
  else verdict = 'swap';
  const line = `  ${label.padEnd(6)} row shows ${String(who(cur)).padEnd(22)} verdict=${verdict.padEnd(8)}`;
  console.log(verdict === 'swap' ? `${line} → Start ${who(rec.playerId)} instead` : line);
});
