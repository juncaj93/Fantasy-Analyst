/**
 * The replay half of `probe-trade-pricing.mjs`.
 *
 * Reads a Trades support snapshot captured from production, and answers three
 * questions with *this checkout's* engine rather than a reimplementation of it:
 *
 *   1. Which rostered players have a market expectation, and which are being
 *      valued on the bounded nudges alone?
 *   2. Where does an unpriced player outrank a priced one on the value the
 *      trade engine reads?
 *   3. What does the search do with them — how many offers, how many
 *      rejections, and how many of the "values are N% apart" rejections have an
 *      unpriced player on one side?
 *
 * TypeScript because it imports the shipped modules directly. No network.
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { evaluatePlayer } from '../../src/core/startsit/engine.ts';
import { marketProjection } from '../../src/core/startsit/projection.ts';
import { assembleSmartTrades } from '../../src/core/trades/assemble.ts';
import type { ArbitrageRead } from '../../src/core/trades/arbitrage.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../../src/core/support/inseason.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: tradePricingReplay.ts <snapshot.json>');
const raw = readFileSync(file, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snapshot = JSON.parse(raw) as any;
const inputs = snapshot.decision?.inputs;
if (!inputs?.pool) throw new Error('not a trade-offer snapshot');

/*
 * The live buy-low / sell-high reads, when the probe could fetch them. The
 * snapshot does not carry them, so without this file the replay runs with the
 * arbitrage lane empty and says so.
 */
const readsFile = process.argv[3];
const reads: ArbitrageRead[] = readsFile ? (JSON.parse(readFileSync(readsFile, 'utf8')) as ArbitrageRead[]) : [];
const arbitrage = new Map(reads.map((r) => [r.playerId, r]));

const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const pool = rehydrateStartSitInputs(inputs.pool);

const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));

interface Row {
  id: string;
  name: string;
  position: string;
  score: number | null;
  market: number | null;
  confidence: string;
}
const rows = new Map<string, Row>();
for (const input of pool) {
  const e = evaluatePlayer(input, profile);
  rows.set(input.player.id, {
    id: input.player.id,
    name: e.name,
    position: e.position,
    score: e.score,
    market: marketProjection(e),
    confidence: e.confidence,
  });
}

console.log(`\n--- snapshot: ${pool.length} rostered players, captured ${snapshot.capturedAt ?? snapshot.release?.capturedAt ?? '?'} ---`);
const byPos = new Map<string, { priced: number; unpriced: number; unscored: number }>();
for (const r of rows.values()) {
  const b = byPos.get(r.position) ?? { priced: 0, unpriced: 0, unscored: 0 };
  if (r.score == null) b.unscored++;
  else if (r.market == null) b.unpriced++;
  else b.priced++;
  byPos.set(r.position, b);
}
console.log('  pos   priced  unpriced(score from nudges only)  unscored');
for (const [pos, b] of [...byPos].sort()) {
  console.log(`  ${pos.padEnd(5)} ${String(b.priced).padStart(6)}  ${String(b.unpriced).padStart(8)}                          ${String(b.unscored).padStart(4)}`);
}

// ------------------------------------------------------------- my roster --
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mine = inputs.rosters.find((r: any) => r.isMine);
if (mine) {
  console.log(`\n--- my roster, ordered by the value the trade engine reads (score) ---`);
  console.log('  ' + ['player', 'pos', 'score', 'market', 'conf', ''].map((h, i) => h.padEnd([26, 5, 8, 8, 7, 0][i]!)).join(''));
  const list = (mine.playerIds as string[])
    .map((id) => rows.get(id))
    .filter((r): r is Row => r != null)
    .sort((a, b) => (b.score ?? -99) - (a.score ?? -99));
  for (const r of list) {
    const flag = r.score == null ? 'UNSCORED' : r.market == null ? 'UNPRICED — score is nudges only' : '';
    console.log(
      '  ' +
        [r.name.slice(0, 25), r.position, fmt(r.score), fmt(r.market), r.confidence, flag]
          .map((c, i) => String(c).padEnd([26, 5, 8, 8, 7, 0][i]!))
          .join(''),
    );
  }
}

// ------------------------------------------------ league-wide inversions --
const priced = [...rows.values()].filter((r) => r.market != null && r.score != null);
const unpriced = [...rows.values()].filter((r) => r.market == null && r.score != null && r.position !== 'DEF');
const inversions: string[] = [];
for (const u of unpriced) {
  const beaten = priced.filter((p) => p.position !== 'DEF' && (p.score ?? 0) < (u.score ?? 0) && (p.market ?? 0) >= 8);
  if (beaten.length > 0) {
    const best = beaten.sort((a, b) => (b.market ?? 0) - (a.market ?? 0))[0]!;
    inversions.push(`${u.name} (${u.position}, unpriced, score ${fmt(u.score)}) outranks ${best.name} (${best.position}, market ${fmt(best.market)}, score ${fmt(best.score)}) + ${beaten.length - 1} more priced at 8+`);
  }
}
console.log(`\n--- unpriced skill players outranking a priced 8+ pt player: ${inversions.length} ---`);
for (const line of inversions.slice(0, 12)) console.log(`  ${line}`);

const defs = [...rows.values()].filter((r) => r.position === 'DEF' && r.score != null);
if (mine && defs.length) {
  const myIds = new Set(mine.playerIds as string[]);
  for (const d of defs.filter((d) => myIds.has(d.id))) {
    const below = [...rows.values()].filter((r) => myIds.has(r.id) && r.position !== 'DEF' && r.score != null && r.score < (d.score ?? 0));
    console.log(`  my DEF ${d.name}: score ${fmt(d.score)}, market ${fmt(d.market)} — above ${below.length} of my skill players`);
  }
}

// ------------------------------------------------------ the search itself --
const result = assembleSmartTrades({
  leagueSettings: inputs.leagueSettings,
  shape,
  profile,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rosters: inputs.rosters.map((r: any) => ({ rosterId: r.rosterId, ownerId: r.ownerId, ownerName: r.ownerName, playerIds: r.playerIds, isMine: r.isMine })),
  inputs: pool,
  history: {
    measured: inputs.history.measured,
    tendencies: new Map(inputs.history.tendencies),
    seasonsByUser: new Map(inputs.history.seasonsByUser),
    seasonsComplete: inputs.history.seasonsComplete,
    profiles: inputs.history.profiles,
    complete: inputs.history.complete,
    leagueRate: inputs.history.leagueRate,
  },
  limit: inputs.limit ?? undefined,
  arbitrage,
});

console.log(`\n--- this checkout's engine on the snapshot (${arbitrage.size} arbitrage read(s) supplied) ---`);
for (const r of reads) {
  const row = rows.get(r.playerId);
  if (row) console.log(`  read: ${r.kind} ${r.strength.toFixed(2)} ${row.name} (${row.position}) ${row.market == null ? 'UNPRICED this week' : `market ${fmt(row.market)}`}`);
}
console.log(`  search: ${JSON.stringify({ ...result.search, bounds: undefined })}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pricing = (result as any).pricing;
if (pricing) console.log(`  pricing: ${JSON.stringify(pricing)}`);
for (const offer of result.offers) {
  const side = (ps: { name: string; position: string; value: number }[]) => ps.map((p) => `${p.name} (${p.position} ${fmt(p.value)})`).join(' + ');
  console.log(`  [${offer.category}] GIVE ${side(offer.give)}  →  GET ${side(offer.get)}  @ ${offer.partner.displayName}`);
}
for (const note of result.notes) console.log(`  note: ${note}`);

const reasons = new Map<string, number>();
for (const r of result.rejections) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
console.log(`  rejections (${result.rejections.length}):`);
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${reason}`);

const gapRejections = result.rejections.filter((r) => r.reason === 'value_gap_outside_range');
const touchesUnpriced = gapRejections.filter((r) => [...r.give, ...r.get].some((id) => rows.get(id)?.market == null));
console.log(`  value-gap rejections with an unpriced player on either side: ${touchesUnpriced.length} of ${gapRejections.length}`);
for (const r of touchesUnpriced.slice(0, 6)) {
  const who = (ids: string[]) => ids.map((id) => `${rows.get(id)?.name ?? id}${rows.get(id)?.market == null ? '*' : ''} ${fmt(rows.get(id)?.score)}`).join(' + ');
  console.log(`    ${who(r.give)} → ${who(r.get)}: ${r.detail}   (* = unpriced)`);
}

/*
 * The snapshot itself, compressed, so the same live state can be replayed
 * offline against a working tree. Aliased and redacted by the capture, and
 * printed last so it never pushes the readable part out of a log tail.
 */
{
  if (reads.length > 0) console.log(`\nREADS ${JSON.stringify(reads)}`);
  const packed = gzipSync(raw).toString('base64');
  console.log(`\n--- snapshot.json.gz base64 (${packed.length} chars) ---`);
  for (let i = 0; i < packed.length; i += 4000) console.log(`SNAP ${packed.slice(i, i + 4000)}`);
  console.log('--- end snapshot ---');
}
