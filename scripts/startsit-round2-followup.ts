/**
 * Start/Sit round 2, follow-up: pill counts, the tie-break on Alex's real
 * matchup, and whether Best move and the lineup rows can disagree.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round2-followup.ts <dir> [posture]
 *
 * Reads `<dir>/lineup.json` (support snapshot), `<dir>/roster.json` (the Team
 * roster response, for Sleeper's slot order) and, through the read-only D1
 * adapter, the weekly prop snapshots of the last ten days. Prints:
 *
 *  a. pills per position under the shipped thresholds, for this week's newest
 *     props and for last week's last pre-kickoff props;
 *  b. the lineup with and without the posture, every starter/bench pair
 *     inside the close-call band with their pills, and whether the tie-break
 *     fired;
 *  c. the lineup rows' change count against the Best move card.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1Http } from './lib/d1Http.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { pillFor } from '../src/core/startsit/pills.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { PILL_TIEBREAK_BAND, type Posture } from '../src/core/startsit/tiebreak.ts';
import { buildLineupVerdicts } from '../src/core/startsit/sleeperLineup.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';

const [dir, postureArg] = process.argv.slice(2);
if (!dir) throw new Error('usage: startsit-round2-followup.ts <dir> [posture]');
const posture: Posture | null = postureArg === 'underdog' || postureArg === 'favourite' ? postureArg : null;
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const snapshot = read('lineup.json');
const inputs = snapshot.decision.inputs;
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const r2 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));

/* ============================================================ a. pills */
console.log('\n################ a. PILLS, shipped thresholds ################');
/* LOCAL_SEED=1: the seeded demo database, for a dry run. The probe never sets it. */
async function localDb() {
  const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
  const { seedDemoData } = await import('../src/devserver/seed.ts');
  const { readdirSync } = await import('node:fs');
  const raw = new NodeSqliteDatabase(':memory:');
  const migrations = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) await raw.exec(readFileSync(join(migrations, f), 'utf8'));
  await seedDemoData(raw);
  return Object.assign(raw, { rowsRead: () => 0, statements: () => 0 });
}
const db = process.env.LOCAL_SEED ? await localDb() : await d1Http();
const now = Date.now();
type Snap = { id: number; event_id: string; game_start: string; fetched_at: string };
const snaps = (await db
  .prepare(`SELECT id, event_id, game_start, fetched_at FROM prop_snapshots WHERE scope = 'week' AND game_start >= ?`)
  .bind(new Date(now - 10 * 86400e3).toISOString())
  .all<Snap>()).results;
const future = new Map<string, Snap>();
const past = new Map<string, Snap>();
for (const s of snaps) {
  const upcoming = s.game_start > new Date(now).toISOString();
  if (upcoming) {
    if (!future.get(s.event_id) || future.get(s.event_id)!.fetched_at < s.fetched_at) future.set(s.event_id, s);
  } else if (s.fetched_at < s.game_start) {
    if (!past.get(s.event_id) || past.get(s.event_id)!.fetched_at < s.fetched_at) past.set(s.event_id, s);
  }
}
type Row = { snapshot_id: number; player_id: string; market: string; line: number | null; over_price: number | null; under_price: number | null; book_count: number; implied_probability: number | null };
const ids = [...future.values(), ...past.values()].map((s) => s.id);
const rows: Row[] = [];
for (let i = 0; i < ids.length; i += 80) {
  const batch = ids.slice(i, i + 80);
  rows.push(
    ...(await db
      .prepare(`SELECT snapshot_id, player_id, market, line, over_price, under_price, book_count, implied_probability FROM player_props WHERE player_id IS NOT NULL AND snapshot_id IN (${batch.map(() => '?').join(',')})`)
      .bind(...batch)
      .all<Row>()).results,
  );
}
const players = await new PlayerRepo(db).listByIds([...new Set(rows.map((r) => r.player_id))]);
const toProp = (r: Row): PlayerProp => ({
  playerId: r.player_id, sourcePlayerName: '', market: r.market as PlayerProp['market'], line: r.line,
  overPrice: r.over_price, underPrice: r.under_price, bookCount: r.book_count, consensusMethod: 'median', books: [],
  impliedProbability: r.implied_probability,
});
function countPills(label: string, set: Map<string, Snap>) {
  const counts: Record<string, Record<string, number>> = {};
  const examples: Record<string, string[]> = {};
  const snapIds = new Set([...set.values()].map((s) => s.id));
  const byPlayer = new Map<string, PlayerProp[]>();
  for (const r of rows.filter((r) => snapIds.has(r.snapshot_id))) (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)!).push(toProp(r));
  let total = 0;
  for (const [id, props] of byPlayer) {
    const p = players.get(id);
    if (!p || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    total++;
    const e = buildExpectation(p.position, props, profile);
    const pill = pillFor(p.position, props, e);
    const k = pill?.pill ?? 'none';
    (counts[p.position] ??= {})[k] = ((counts[p.position] ??= {})[k] ?? 0) + 1;
    if (pill && (examples[k] ??= []).length < 4) examples[k]!.push(`${p.fullName} (${p.position}, ${r2(e.points)}: ${pill.reason})`);
  }
  const of = (k: string) => Object.values(counts).reduce((a, m) => a + (m[k] ?? 0), 0);
  console.log(`\n${label}: ${set.size} games, ${total} priced players`);
  console.log(`  Explosive ${of('explosive')} · Steady ${of('steady')} · Wide range ${of('wide_range')} · none ${of('none')} (${total ? ((of('none') / total) * 100).toFixed(1) : '0'}% carry no pill)`);
  for (const [pos, m] of Object.entries(counts)) console.log(`    ${pos}: ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [k, list] of Object.entries(examples)) console.log(`    e.g. ${k}: ${list.join('; ')}`);
}
countPills('this week (newest props for games not yet played)', future);
countPills('last week (last props before each kickoff)', past);

/* ======================================================= b. tie-break */
console.log('\n################ b. TIE-BREAK on the real matchup ################');
console.log(`posture from the projected margin: ${posture ?? 'none (margin unknown or level)'}`);
const startSit = rehydrateStartSitInputs(inputs.startSit);
const published = new Map(Object.entries(inputs.published as Record<string, number>));
const base = { inputs: startSit, shape, profile, currentStarterIds: inputs.currentStarterIds, mode: inputs.mode, published, unknownPlayers: inputs.unknownPlayers, now: snapshot.capturedAt };
const without = assembleLineup(base);
const withPosture = assembleLineup({ ...base, posture });
const all = [...withPosture.starters, ...withPosture.bench];
const starters = new Set(withPosture.slots.map((s) => s.playerId).filter(Boolean));
console.log(`week ${snapshot.decision.context.week}, mode ${inputs.mode}`);
console.log('\nplayers (decision points, pill):');
for (const e of [...all].sort((a, b) => (b.decision?.points ?? -99) - (a.decision?.points ?? -99))) {
  console.log(`  ${(starters.has(e.playerId) ? 'START' : 'bench').padEnd(5)} ${e.name.padEnd(24)} ${e.position.padEnd(3)} ${r2(e.decision?.points)} ${e.decision?.basis ?? ''}${e.pill ? ` [${e.pill.label}: ${e.pill.reason}]` : ''}`);
}
const accepts = (slot: { accepts: string[] }, pos: string) => slot.accepts.includes(pos);
const close: string[] = [];
for (const slot of withPosture.slots) {
  const holder = all.find((e) => e.playerId === slot.playerId);
  if (!holder?.decision || holder.decision.basis !== 'market') continue;
  for (const b of all) {
    if (starters.has(b.playerId) || !b.decision || b.decision.basis !== 'market' || !accepts(slot, b.position)) continue;
    const gap = holder.decision.points - b.decision.points;
    if (Math.abs(gap) <= PILL_TIEBREAK_BAND) close.push(`  ${slot.slot}: ${holder.name} ${r2(holder.decision.points)}${holder.pill ? ` [${holder.pill.label}]` : ''} vs ${b.name} ${r2(b.decision.points)}${b.pill ? ` [${b.pill.label}]` : ''} (gap ${r2(gap)})`);
  }
}
console.log(`\nclose calls inside ${PILL_TIEBREAK_BAND} pts between a starter and an eligible bench player: ${close.length}`);
for (const c of close) console.log(c);
const fired = withPosture.swaps.filter((s) => s.tiebreak);
console.log(`\ntie-break swaps: ${fired.length}`);
for (const s of fired) console.log(`  ${s.slot}: start ${s.inName} over ${s.outName} (${r2(s.gain)}): ${s.tiebreak!.sentence}`);
const changed = JSON.stringify(without.slots.map((s) => s.playerId)) !== JSON.stringify(withPosture.slots.map((s) => s.playerId));
console.log(`lineup changed by the posture: ${changed ? 'yes' : 'no'}`);
console.log(`Best move without posture: ${without.swaps[0] ? `${without.swaps[0].inName} over ${without.swaps[0].outName}` : 'none'}; with: ${withPosture.swaps[0] ? `${withPosture.swaps[0].inName} over ${withPosture.swaps[0].outName}` : 'none'}`);
/* The same pairs through Compare, so the sheet is seen to agree with the lineup. */
const byId = new Map(startSit.map((i) => [i.player.id, i]));
let shown = 0;
for (const slot of withPosture.slots) {
  const holder = all.find((e) => e.playerId === slot.playerId);
  for (const b of all) {
    if (shown >= 3 || !holder?.decision || !b.decision || starters.has(b.playerId) || !accepts(slot, b.position)) continue;
    if (holder.decision.basis !== 'market' || b.decision.basis !== 'market') continue;
    if (Math.abs(holder.decision.points - b.decision.points) > PILL_TIEBREAK_BAND) continue;
    const cmp = compareStartSit([byId.get(holder.playerId)!, byId.get(b.playerId)!], profile, { mode: inputs.mode, published, posture });
    console.log(`  Compare ${holder.name} vs ${b.name}: start ${cmp.evaluations.find((e) => e.playerId === cmp.recommendedPlayerId)?.name} (margin ${r2(cmp.margin)})${cmp.tiebreak ? ` · ${cmp.tiebreak.sentence}` : ''}`);
    shown++;
  }
}

/* ================================================ c. card against rows */
console.log('\n################ c. BEST MOVE CARD against the lineup rows ################');
const roster = read('roster.json');
const verdicts = buildLineupVerdicts({
  rosterPositions: roster.rosterPositions ?? inputs.rules.rosterPositions ?? [],
  starterIds: (roster.starters ?? []).map((p: { playerId: string }) => p.playerId),
  ...(roster.starterSlotIds ? { starterSlotIds: roster.starterSlotIds } : {}),
  slots: withPosture.slots,
  suggestedSwaps: withPosture.swaps,
  positionOf: (id) => all.find((e) => e.playerId === id)?.position ?? null,
});
const rowChanges = verdicts.filter((r) => (r.verdict === 'swap' || r.verdict === 'fill') && !r.locked);
const cardChange = withPosture.swaps[0] ?? withPosture.fills[0] ?? null;
console.log(`rows: ${verdicts.map((r) => `${r.slot}:${r.verdict}`).join(' ')}`);
console.log(`lineup rows say ${rowChanges.length} change(s); the card says ${cardChange ? 'a change' : '"No swap clears the bar"'}`);
console.log(rowChanges.length > 0 && !cardChange ? `MISMATCH on the real roster: ${rowChanges.map((r) => `${r.slot} ${r.verdict}`).join(', ')}` : 'no mismatch on the real roster');

console.log(`\nthis script's own D1 reads: ${db.statements()} statements, ${db.rowsRead()} rows`);
