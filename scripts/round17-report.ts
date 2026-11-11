/**
 * Round 17: Alex's real Team lineup, Waivers and Trades free-agent levels,
 * rebuilt from production's database on whichever code this runs on.
 *
 *   LEAGUE_ID=<id> node --experimental-transform-types --no-warnings scripts/round17-report.ts
 *
 * `probe-round17.mjs` runs it on the code before the round (b123d70) and on
 * this checkout, against the same data minutes apart, and prints every line
 * that differs. It uses only exports both codes have.
 *
 * Reads only: a statement that is not a SELECT is answered as if it had run
 * and is never sent. Sleeper is never called. LOCAL_SEED=1 runs it over the
 * seeded demo database instead, for a dry run with no production access.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { gatherLineupInputs, gatherWaiverInputs } from '../src/server/services/decisionInputs.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { currentSlotsOf } from '../src/core/startsit/sleeperLineup.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';
import { TradeValueService } from '../src/server/services/tradeValueService.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
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
const pts = (n: number | null | undefined) => (n == null ? '?' : (Math.round(n * 10) / 10).toFixed(1));
const line = (s: string) => console.log(s);

/* ------------------------------------------------------------------- Team -- */

line('### Team: the lineup and every lean');
{
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
  const nm = new Map<string, string>();
  const pos = new Map<string, string>();
  for (const e of [...d.starters, ...d.bench, ...d.undecidable]) {
    nm.set(e.playerId, e.name ?? e.playerId);
    pos.set(e.playerId, String(e.position ?? '?'));
  }
  const who = (id: string | null | undefined) => (id ? `${nm.get(id) ?? id} (${pos.get(id) ?? '?'})` : '-');
  const ptsOf = (e: { decision?: { points?: number | null } | null }) => pts(e.decision?.points ?? null);
  line(`mode ${d.mode}`);
  line('Recommended lineup:');
  for (const s of d.slots) {
    const ev = d.starters.find((e) => e.playerId === s.playerId);
    line(`  ${String(s.slot).padEnd(5)} ${who(s.playerId)}${ev ? ` ${ptsOf(ev)}` : ''}`);
  }
  line('Bench:');
  for (const e of d.bench) line(`  ${who(e.playerId)} ${ptsOf(e)}`);
  line(`Changes from Sleeper's lineup: ${d.swaps.map((s) => `${s.slot}: ${s.inName} over ${s.outName} (+${pts(s.gain)})`).join('; ') || 'none'}`);
  line(`Fills: ${d.fills.map((f) => `${(f as { slot?: string }).slot ?? ''} ${(f as { inName?: string }).inName ?? ''}`.trim()).join('; ') || 'none'}`);
  line(
    `Toss-ups (a lean, no change): ${
      (d.tossUps ?? []).map((t) => `${t.slot}: leans ${t.inName} over ${t.outName} (${t.gain >= 0 ? '+' : ''}${pts(t.gain)}${t.leanTag ? `, ${t.leanTag}` : ''})`).join('; ') || 'none'
    }`,
  );
}

/* ------------------------------------------------------- Team and Waivers -- */

line('### Team Best move pickup and Waivers');
const gathered = await gatherWaiverInputs(db, sleeper, leagueId);
/* One clock for both runs (the probe passes it), so a kickoff between them cannot read as a difference. */
const now = process.env.REPORT_NOW ? new Date(process.env.REPORT_NOW) : new Date();
const plan = await assembleWaiverPlan({ ...gathered.request, now });
const names = new Map(gathered.players.map((p) => [p.id, p.fullName] as const));
const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? id) : '-');
const pickup = plan.pickupStart;
line(`week ${gathered.request.week}, clock ${now.toISOString()}`);
line(
  pickup?.start
    ? `Team Best move pickup: ${pickup.start.name} over ${pickup.start.displaces?.name ?? 'an empty slot'} (+${pts(pickup.start.gain)})`
    : 'Team Best move pickup: none',
);
line(
  `Ties this week (Team sheet and Waivers Worth considering): ${
    (pickup?.consider ?? []).map((m) => `${m.name} ties ${m.displaces?.name ?? 'the lineup'}`).join('; ') || 'none'
  }`,
);
const hidden = (pickup?.audit ?? []).filter((a) => String(a.status) === 'worse_over_season');
if (hidden.length > 0) line(`Ties hidden as worse over the season: ${hidden.map((a) => `${a.name} (${a.position})`).join('; ')}`);
const tiers = plan.tiers;
const row = (r: { name: string; position: string; gain?: number; drop?: { name: string } | null; reason?: string; needsSpot?: unknown[] }) =>
  `${r.name} ${r.position} ${r.gain == null ? '' : `+${pts(r.gain)} `}${r.drop ? `drop ${r.drop.name}` : r.needsSpot ? 'needs a drop' : 'no drop'}${r.reason ? ` · ${r.reason}` : ''}`;
for (const [label, list] of [
  ['Waivers Do this', tiers?.doThese ?? []],
  ['Waivers Worth considering', tiers?.consider ?? []],
  ['Waivers Watch', tiers?.watch ?? []],
] as const) {
  line(`${label}:`);
  if ((list as unknown[]).length === 0) line('  (none)');
  for (const r of list as never[]) line(`  ${row(r)}`);
}
const extra = tiers as unknown as { upsideStash?: { name: string } | null; block?: { name: string } | null } | null;
if (extra?.upsideStash) line(`Waivers upside stash: ${extra.upsideStash.name}`);
if (extra?.block) line(`Waivers block: ${extra.block.name}`);
line(`free agents scanned: ${gathered.request.candidateInputs.length}`);

/* ------------------------------------------------------------------ Trades -- */

line('');
line('### Trades: the free agents behind "a free agent at X pts"');
const rosters = await new LeagueRepo(db).listRosters(leagueId);
const mine = rosters.find((r) => r.isMine);
const other = rosters.find((r) => !r.isMine && r.playerIds.length > 0);
if (!mine || !other) {
  line('(no two rosters to check a trade between)');
} else {
  const benchOf = (r: typeof mine) => r.playerIds.filter((id) => !r.starterIds.includes(id) && !(r.reserveIds ?? []).includes(id));
  const give = benchOf(mine)[0] ?? mine.playerIds[0]!;
  const get = benchOf(other)[0] ?? other.playerIds[0]!;
  const check = await new TradeValueService(db, sleeper).check(leagueId, { a: mine.rosterId, b: other.rosterId, aSends: [give], bSends: [get] });
  const replacement = (check as unknown as { evaluation?: { replacement?: { position: string; rate: number; names: string[] }[] } }).evaluation?.replacement ?? [];
  line(`(a 1-for-1 check, ${nameOf(give)} for ${nameOf(get)}, read only for its replacement levels)`);
  for (const r of [...replacement].sort((a, b) => a.position.localeCompare(b.position))) {
    line(`  ${r.position.padEnd(3)} ${pts(r.rate)}  ${r.names.join(', ')}`);
  }
}

line('');
line(`report rows read: ${source.rowsRead()}`);
