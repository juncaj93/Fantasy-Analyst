/**
 * Round 18: Alex's real Team lineup, Best move and the Compare sheet that Best
 * move opens, rebuilt from production's database on whichever code this runs
 * on.
 *
 *   LEAGUE_ID=<id> node --experimental-transform-types --no-warnings scripts/round18-report.ts
 *
 * `probe-round18.mjs` runs it on the code before the round and on this
 * checkout, against the same data minutes apart, and prints every line that
 * differs. It uses only exports both codes have; the Round 18 fields
 * (`waitingOnLine`, `onBye`) are read when present.
 *
 * Reads only: a statement that is not a SELECT is answered as if it had run
 * and is never sent. Sleeper is never called. LOCAL_SEED=1 runs it over the
 * seeded demo database instead, for a dry run with no production access.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { gatherLineupInputs } from '../src/server/services/decisionInputs.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { currentSlotsOf } from '../src/core/startsit/sleeperLineup.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import type { Database, PreparedStatement } from '../src/server/db.ts';

async function localDb(): Promise<Database & { rowsRead(): number }> {
  const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
  const { seedDemoData } = await import('../src/devserver/seed.ts');
  const raw = new NodeSqliteDatabase(':memory:');
  const dir = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await raw.exec(readFileSync(join(dir, f), 'utf8'));
  await seedDemoData(raw);
  return Object.assign(raw, { rowsRead: () => 0 });
}

const source = process.env.LOCAL_SEED ? await localDb() : await (await import('./lib/d1Http.ts')).d1Http();
const isRead = (sql: string) => /^\s*(select|with)\b/i.test(sql);
const noop = (): PreparedStatement =>
  ({
    bind: () => noop(),
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
  }) as unknown as PreparedStatement;
const db: Database = {
  prepare: (sql: string) => (isRead(sql) ? source.prepare(sql) : noop()),
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
};
const sleeper = new SleeperClient({
  fetch: (async (url: string) => {
    throw new Error(`this report never calls Sleeper: ${url}`);
  }) as never,
});

const leagueId =
  process.env.LEAGUE_ID ||
  String((await source.prepare('SELECT id FROM leagues WHERE is_selected = 1 LIMIT 1').first<{ id: string }>())?.id ?? '');
if (!leagueId) throw new Error('no league: set LEAGUE_ID');
const pts = (n: number | null | undefined) => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));
const line = (s: string) => console.log(s);
const now = process.env.REPORT_NOW ? new Date(process.env.REPORT_NOW) : new Date();

type Ev = {
  playerId: string;
  name: string;
  position: string;
  team?: string | null;
  ruledOut?: boolean;
  statusFlag?: string | null;
  onBye?: boolean;
  onReserve?: boolean;
  decision?: { points: number; basis: string } | null;
  lock?: { locked: boolean; kickoff: string | null };
};

const g = await gatherLineupInputs(db, sleeper, leagueId);
const d = assembleLineup({
  inputs: g.inputs,
  shape: g.shape,
  profile: g.profile,
  currentStarterIds: g.mine.starterIds,
  currentSlotOf: currentSlotsOf(g.league.rosterPositions, g.mine.starterSlotIds),
  mode: g.mode,
  published: g.published,
  publishedRefusal: g.publishedRefusal,
  unknownPlayers: g.unknownPlayers,
});
const all = [...d.starters, ...d.bench, ...d.undecidable] as unknown as Ev[];
const byId = new Map(all.map((e) => [e.playerId, e] as const));
const basisWord = (b: string | undefined) => (b === 'market' ? 'Vegas' : b === 'published' ? 'no line' : b === 'partial' ? 'part line' : 'no number');
const who = (id: string | null | undefined) => {
  if (!id) return '-';
  const e = byId.get(id);
  if (!e) return id;
  const status = e.ruledOut ? ' OUT' : e.statusFlag ? ` ${e.statusFlag.split('·')[0]!.trim()}` : '';
  return `${e.name} (${e.position} ${e.team ?? ''}${status}) ${pts(e.decision?.points)} [${basisWord(e.decision?.basis)}${e.onBye ? ', BYE' : ''}]`;
};

line(`### Team, week ${g.nflState?.week ?? '?'}, mode ${d.mode}, clock ${now.toISOString()}`);
line('Lineup (Sleeper slots, with any change applied):');
for (const s of d.slots) line(`  ${String(s.slot).padEnd(5)} ${who(s.playerId)}`);
line('Bench:');
for (const e of d.bench) line(`  ${who(e.playerId)}`);
line(`Changes: ${d.swaps.map((s) => `${s.slot}: start ${s.inName} over ${s.outName} (+${pts(s.gain)})`).join('; ') || 'none'}`);
line(`Fills: ${(d.fills ?? []).map((f) => `${f.slot} ${f.inName}`).join('; ') || 'none'}`);
const tossUps = (d.tossUps ?? []) as unknown as { slot: string; inPlayerId: string; inName: string; outPlayerId: string; outName: string; gain: number; leanTag?: string; waitingOnLine?: boolean }[];
line(
  `Toss-ups: ${
    tossUps.map((t) => `${t.slot}: ${t.waitingOnLine ? 'No line yet' : 'Toss-up'}, lean ${t.inName} over ${t.outName} (${pts(t.gain)}${t.leanTag ? `, ${t.leanTag}` : ''})`).join('; ') || 'none'
  }`,
);
const risks = (d.lateSwapRisks ?? []) as unknown as { name: string; detail: string; starting?: boolean }[];
line(`Notes under Best move: ${risks.filter((r) => r.starting !== false).map((r) => `${r.name}: ${r.detail}`).join(' | ') || 'none'}`);

/* What Best move's headline is, in the card's order: fill, swap, toss-up. */
const [best] = d.swaps;
const [fill] = d.fills ?? [];
const [toss] = tossUps;
const headline =
  fill && (!best || fill.gain >= best.gain)
    ? `Start ${fill.inName} at ${fill.slot} (empty slot)`
    : best
      ? `Start ${best.inName} over ${best.outName} at ${best.slot}, ${pts(byId.get(best.inPlayerId)?.decision?.points)} vs ${pts(byId.get(best.outPlayerId)?.decision?.points)}`
      : toss
        ? `${toss.waitingOnLine ? 'No line yet' : 'Toss-up'}: lean ${toss.inName} over ${toss.outName} at ${toss.slot}`
        : 'No change';
line(`Best move: ${headline}`);

/* The Compare sheet Best move opens, on the same two players. */
const pair = best ? [best.inPlayerId, best.outPlayerId] : toss ? [toss.inPlayerId, toss.outPlayerId] : null;
if (pair) {
  const inputs = g.inputs.filter((i) => pair.includes(i.player.id));
  const c = compareStartSit(inputs, g.profile, { published: g.published, mode: g.mode, now } as never) as unknown as {
    recommendedPlayerId: string | null;
    tossUp?: { leanName: string; otherName: string; waitingOnLine?: boolean } | null;
  };
  const nm = (id: string | null) => (id ? (byId.get(id)?.name ?? id) : '-');
  line(
    `Compare (${pair.map((id) => byId.get(id)?.name ?? id).join(' vs ')}): ${
      c.recommendedPlayerId
        ? `Start ${nm(c.recommendedPlayerId)}`
        : c.tossUp
          ? `${c.tossUp.waitingOnLine ? 'No line yet' : 'Toss-up'}, lean ${c.tossUp.leanName}`
          : 'no call'
    }`,
  );
} else {
  line('Compare: (no Best move pair)');
}
line(`priced starters: ${d.slots.filter((s) => byId.get(s.playerId ?? '')?.decision?.basis === 'market').length}/${d.slots.length}`);
line('');
line(`report rows read: ${source.rowsRead()}`);
