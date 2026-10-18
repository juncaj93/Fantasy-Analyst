/**
 * "Pick up and start" round of 18 October 2026: the replay, the Vegas-only
 * test and the data cost, on whichever checkout this runs in.
 *
 *   node --experimental-transform-types --no-warnings scripts/pickup-start-report.ts <dir> <leagueId> gather <out.json>
 *   node --experimental-transform-types --no-warnings scripts/pickup-start-report.ts <dir> <leagueId> report
 *
 * `gather` runs the Team screen's two decision gatherers (`/lineup` and
 * `/waivers`) against production through the read-only D1 adapter and writes
 * the rows each read. It is all the code before the round is asked to do, so
 * it imports nothing this round added.
 *
 * `report` does the same on this checkout, then, with no further reads except
 * the evidence rows the backtest's news needs:
 *
 *  A. replays the Waivers decision at REPLAY_NOW (default Sunday 16:30 UTC, half
 *     an hour before the early games) and prints the pickup call: the best
 *     owned lineup, every scanned free agent's whole-lineup gain and margin,
 *     the best pickup per slot, McLaughlin and Concepcion by name, and the line
 *     Best move would show;
 *  C. scores the stored backtest (`backtest-inputs.json`, from
 *     `startsit-round2-build.ts`) today and with the Opponent and Recent news
 *     nudges taken out, each alone and together, against the 0.01 rule, and
 *     replays McLaughlin, McConkey and Egbuka in weeks 6 and 7 under each.
 *
 * Reads only. Nothing is written to the app or the database.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { d1Http } from './lib/d1Http.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { gatherLineupInputs, gatherWaiverInputs } from '../src/server/services/decisionInputs.ts';

const [dir, leagueId, mode, out] = process.argv.slice(2);
if (!dir || !leagueId || (mode !== 'gather' && mode !== 'report')) {
  throw new Error('usage: pickup-start-report.ts <dir> <leagueId> gather <out.json> | report');
}

/* LOCAL_SEED=1: the same code over the seeded demo database, for a dry run with no production access. */
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
const source = process.env.LOCAL_SEED ? await localDb() : await d1Http();
/*
 * Reads only. A gatherer that would write a cache row (a draft-rounds cache,
 * say) is answered as if the write succeeded and nothing is sent: this run
 * must never change production, and the read it would save is counted anyway.
 */
const isRead = (sql: string) => /^\s*(select|with)\b/i.test(sql);
const skipped: string[] = [];
const noop = (sql: string): import('../src/server/db.ts').PreparedStatement =>
  ({
    bind: () => noop(sql),
    first: async () => (skipped.push(sql.slice(0, 60)), null),
    all: async () => (skipped.push(sql.slice(0, 60)), { results: [], success: true, meta: {} }),
    run: async () => (skipped.push(sql.slice(0, 60)), { results: [], success: true, meta: {} }),
  }) as unknown as import('../src/server/db.ts').PreparedStatement;
const db = Object.assign(Object.create(source) as typeof source, {
  prepare: (sql: string) => (isRead(sql) ? source.prepare(sql) : noop(sql)),
  batch: async (list: unknown[]) => (skipped.push(`batch of ${list.length}`), []),
  rowsRead: () => source.rowsRead(),
  statements: () => source.statements(),
});
const sleeper = process.env.LOCAL_SEED
  ? new SleeperClient({ fetch: (async () => new Response('null', { status: 200 })) as typeof fetch })
  : new SleeperClient({});
const rowsOf = async <T,>(label: string, run: () => Promise<T>): Promise<{ value: T | null; rows: number; statements: number; error: string | null }> => {
  const r0 = db.rowsRead();
  const s0 = db.statements();
  try {
    const value = await run();
    return { value, rows: db.rowsRead() - r0, statements: db.statements() - s0, error: null };
  } catch (err) {
    console.log(`${label} failed: ${String(err).slice(0, 300)}`);
    return { value: null, rows: db.rowsRead() - r0, statements: db.statements() - s0, error: String(err).slice(0, 300) };
  }
};

const lineupRead = await rowsOf('lineup gather', () => gatherLineupInputs(db, sleeper, leagueId));
const waiverRead = await rowsOf('waivers gather', () => gatherWaiverInputs(db, sleeper, leagueId));
const cost = {
  lineup: { rows: lineupRead.rows, statements: lineupRead.statements, error: lineupRead.error },
  waivers: { rows: waiverRead.rows, statements: waiverRead.statements, error: waiverRead.error },
  scanned: (waiverRead.value as { pool?: { scanned: number } } | null)?.pool?.scanned ?? null,
};
if (skipped.length > 0) console.log(`writes not sent (reads only): ${[...new Set(skipped)].join(' | ')}`);
console.log(`rows read: lineup ${cost.lineup.rows} (${cost.lineup.statements} statements), waivers ${cost.waivers.rows} (${cost.waivers.statements} statements), free agents scanned ${cost.scanned}`);
if (mode === 'gather') {
  writeFileSync(out!, JSON.stringify(cost));
  process.exit(0);
}

/* ----------------------------------------------------------- this checkout only */
const { assembleLineup } = await import('../src/core/startsit/assemble.ts');
const { assembleWaiverPlan } = await import('../src/core/waivers/assemble.ts');
const { evaluatePlayer } = await import('../src/core/startsit/engine.ts');
const { decisionPoints } = await import('../src/core/startsit/decisionPoints.ts');
const { budgetAdjustments, BUDGETED_KEYS } = await import('../src/core/startsit/adjustmentBudget.ts');
const { solveLineup } = await import('../src/core/startsit/lineup.ts');
const { planPickupStart } = await import('../src/core/waivers/pickupStart.ts');
const { buildScoringProfile } = await import('../src/core/sleeper/scoring.ts');
const { rehydrateStartSitInputs } = await import('../src/core/support/inseason.ts');
const { aggregatePlayerSignal } = await import('../src/core/evidence/aggregate.ts');
const { toItem } = await import('../src/server/repos/evidence.ts');
const { boundedFreeAgentIds } = await import('../src/core/roster/freeAgents.ts');
const { draftRanks } = await import('../src/server/services/decisionInputs.ts');
const { startablePositions } = await import('../src/core/sleeper/rosterShape.ts');
type StartSitInput = import('../src/core/startsit/engine.ts').StartSitInput;
type StartSitEvaluation = import('../src/core/startsit/engine.ts').StartSitEvaluation;
type PickupPlayer = import('../src/core/waivers/pickupStart.ts').PickupPlayer;

const NOW = new Date(process.env.REPLAY_NOW || '2026-10-18T16:30:00Z');
const f2 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const lineupIn = lineupRead.value;
const waiverIn = waiverRead.value;
if (!lineupIn || !waiverIn) throw new Error('a gatherer failed; no replay');
const req = { ...waiverIn.request, now: NOW };
const published = req.published ?? new Map<string, number>();

/* ============================================================ A. THE REPLAY */
console.log(`\n################ A. REPLAY: week ${req.week}, as of ${NOW.toISOString()} ################`);
const lineup = assembleLineup({
  inputs: lineupIn.inputs,
  shape: lineupIn.shape,
  profile: lineupIn.profile,
  currentStarterIds: lineupIn.mine.starterIds,
  mode: lineupIn.mode,
  published: lineupIn.published,
  publishedRefusal: lineupIn.publishedRefusal,
  unknownPlayers: lineupIn.unknownPlayers,
  opponentExposure: lineupIn.opponentExposure,
  now: NOW,
} as Parameters<typeof assembleLineup>[0]);
const swap = lineup.swaps[0];
console.log(`Team lineup mode: ${lineupIn.mode}`);
console.log(`Best move today (roster only): ${swap ? `Start ${swap.inName} over ${swap.outName} (${swap.slot}), gain ${f2(swap.gain)}` : 'no swap'}`);
console.log('Team lineup, slot by slot (decision number, unrounded):');
const evals = new Map([...lineup.starters, ...lineup.bench, ...lineup.undecidable].map((e) => [e.playerId, e] as const));
for (const s of lineup.slots) {
  const e = s.playerId ? evals.get(s.playerId) : null;
  console.log(`  ${s.slot.padEnd(5)} ${(s.name ?? '-').padEnd(24)} ${f2(e?.decision?.points)} ${e?.decision?.basis ?? ''}${s.alreadyStarting ? '' : '  <- change'}`);
}
for (const e of lineup.bench) console.log(`  bench ${e.name.padEnd(24)} ${f2(e.decision?.points)} ${e.decision?.basis ?? ''}`);

const assembly = await assembleWaiverPlan(req);
const plan = assembly.pickupStart;
console.log(`\nfree agents scanned: ${req.candidateInputs.length} (draft order slice + in-window drops + this week's published extras)`);
const slice = new Set(boundedFreeAgentIds(waiverIn.players, { rosteredIds: req.rosteredIds, startable: startablePositions(req.shape), ranks: await draftRanks(db) }));
const nameOf = new Map([...req.rosterInputs, ...req.candidateInputs].map((i) => [i.player.id, i.player.fullName] as const));
const find = (part: string) => [...req.candidateInputs, ...req.rosterInputs].find((i) => i.player.fullName.toLowerCase().includes(part));
for (const who of ['mclaughlin', 'concepcion']) {
  const i = find(who);
  console.log(`  ${who}: ${i ? `${i.player.fullName} (${i.player.position} ${i.player.team}) ${req.rosteredIds.has(i.player.id) ? 'ROSTERED' : slice.has(i.player.id) ? 'in the draft-order slice' : 'reached only by the published-week extras'}` : 'NOT in the scan'}`);
}
if (!plan) {
  console.log('pickupStart: null (the decision could not be made)');
} else {
  console.log(`\nbest lineup the roster can already make: ${plan.bestOwned.toFixed(2)} points`);
  console.log(`  ${plan.bestOwnedSlots.map((s) => `${s.slot} ${nameOf.get(s.playerId) ?? s.playerId}`).join(', ')}`);
  console.log(`threshold ${plan.threshold} (PICKUP_START.gain), tie tolerance ${plan.tieTolerance}`);
  console.log('\nevery scanned free agent at a starting position, by margin (gain = with him - without; margin = with him forced in - without):');
  console.log('  player                     pos  number  basis      gain     margin   status');
  for (const a of plan.audit.filter((x) => x.margin != null).slice(0, 25)) {
    console.log(`  ${a.name.padEnd(26)} ${a.position.padEnd(4)} ${f2(a.points).padStart(6)}  ${String(a.basis).padEnd(9)} ${f2(a.gain).padStart(7)}  ${f2(a.margin).padStart(7)}   ${a.status}`);
  }
  const statuses = new Map<string, number>();
  for (const a of plan.audit) statuses.set(a.status, (statuses.get(a.status) ?? 0) + 1);
  console.log(`  by status: ${[...statuses].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const who of ['mclaughlin', 'concepcion']) {
    const a = plan.audit.find((x) => x.name.toLowerCase().includes(who));
    console.log(`  ${who}: ${a ? `${a.name} ${a.position} number ${f2(a.points)} basis ${a.basis}, gain ${f2(a.gain)}, margin ${f2(a.margin)}, status ${a.status}` : 'no audit row'}`);
  }
  console.log('\nbest pickup per slot (highest margin among free agents the slot accepts):');
  const slotSpecs = [...Object.keys(req.shape.starters).map((k) => ({ slot: k, accepts: [k] })), ...req.shape.flex.map((f) => ({ slot: f.slot, accepts: f.positions }))];
  for (const s of slotSpecs) {
    const best = plan.audit.filter((a) => a.margin != null && s.accepts.includes(a.position)).sort((x, y) => (y.margin ?? 0) - (x.margin ?? 0))[0];
    console.log(`  ${s.slot.padEnd(5)} ${best ? `${best.name} ${best.position} ${f2(best.points)}: gain ${f2(best.gain)}, margin ${f2(best.margin)} (${best.status})` : 'none priced'}`);
  }
  console.log(`\nnot now (would clear the bar, on a clock or playing): ${plan.notNow.map((n) => `${n.name} +${f2(n.gain)} (${n.why})`).join('; ') || 'none'}`);
  const s = plan.start;
  console.log(
    `\nBEST MOVE WOULD SAY: ${
      s
        ? `Pick up and start ${s.name}${s.over ? ` over ${s.over.name}` : ''} · ${s.points.toFixed(1)}${s.over?.points != null ? ` vs ${s.over.points.toFixed(1)}` : ''} projected` +
          ` · gain ${f2(s.gain)}${s.starterOut ? ' · chip Starter out' : ''}${s.drop ? ` · chip drop ${s.drop.name}` : ''}`
        : swap
          ? `(no pickup clears ${plan.threshold}) Start ${swap.inName} over ${swap.outName}`
          : '(no pickup clears the bar) as today'
    }`,
  );
  console.log(`ties (Worth considering, sheet line): ${plan.consider.map((c) => `${c.name} margin ${f2(c.margin)} ties ${c.displaces?.name ?? '-'}`).join('; ') || 'none'}`);
}
const tiers = assembly.tiers;
console.log(`\nWaivers tiers: Do this ${(tiers?.doThese ?? []).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);
console.log(`               Worth considering ${(tiers?.consider ?? []).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);

/* ================================================ C. VEGAS-ONLY, REPORT ONLY */
console.log('\n################ C. VEGAS-ONLY TEST (report only, nothing changed) ################');
const OPPONENT = ['matchup_role'];
const NEWS = ['news_recent', 'news_raw'];
const VARIANTS: { label: string; remove: string[] }[] = [
  { label: 'today (live score)', remove: [] },
  { label: 'no Opponent nudge', remove: OPPONENT },
  { label: 'no Recent news nudge', remove: NEWS },
  { label: 'Vegas-only (neither)', remove: [...OPPONENT, ...NEWS] },
];
const MARKET_KEYS = new Set(['vegas', 'uncertainty']);
const ROSTER_KEYS = new Set(['replacement_risk']);

/**
 * The score with some nudges taken out, the budget re-applied to the rest,
 * as `decisionPoints` builds it (no roster charge). With nothing removed it
 * must equal `decisionPoints`; the report checks that.
 */
function variantPoints(e: StartSitEvaluation, pub: ReadonlyMap<string, number>, remove: readonly string[]): number | null {
  const d = decisionPoints(e, pub);
  if (d == null || d.basis === 'unpriced' || d.basis === 'partial') return null;
  const live = e.components.filter((c) => !c.unknown && !remove.includes(c.key) && !ROSTER_KEYS.has(c.key));
  if (d.basis === 'market') {
    const base = live.filter((c) => c.key === 'vegas').reduce((a, c) => a + c.value, 0);
    const budgeted = budgetAdjustments(live.filter((c) => BUDGETED_KEYS.includes(c.key)).map((c) => ({ key: c.key, value: c.preBudgetValue ?? c.value })), base);
    const rest = live.filter((c) => c.key !== 'vegas' && !BUDGETED_KEYS.includes(c.key)).reduce((a, c) => a + c.value, 0);
    return base + [...budgeted.values()].reduce((a, v) => a + v, 0) + rest;
  }
  const base = d.base;
  const nonMarket = live.filter((c) => !MARKET_KEYS.has(c.key));
  const budgeted = budgetAdjustments(nonMarket.filter((c) => BUDGETED_KEYS.includes(c.key)).map((c) => ({ key: c.key, value: c.preBudgetValue ?? c.value })), base);
  const rest = nonMarket.filter((c) => !BUDGETED_KEYS.includes(c.key)).reduce((a, c) => a + c.value, 0);
  return base + [...budgeted.values()].reduce((a, v) => a + v, 0) + rest;
}

/* --- the backtest, with each player's news as it stood before his game */
const bt = JSON.parse(readFileSync(join(dir, 'backtest-inputs.json'), 'utf8'));
const profile = buildScoringProfile(bt.scoring, bt.rosterPositions);
const weekInputs = new Map<number, StartSitInput[]>();
for (const [w, bundle] of Object.entries(bt.bundles)) weekInputs.set(Number(w), rehydrateStartSitInputs(bundle as never));
type Item = { week: number; idx: number; playerId: string; name: string; position: string; actual: number };
const items: Item[] = bt.items;
const ids = [...new Set(items.map((i) => i.playerId))];
const evidenceRows: Record<string, unknown>[] = [];
const r0 = db.rowsRead();
for (let i = 0; i < ids.length; i += 80) {
  const batch = ids.slice(i, i + 80);
  const res = await db
    .prepare(
      `SELECT * FROM evidence_items WHERE player_id IN (${batch.map(() => '?').join(',')}) AND review_status IN ('auto_applied','accepted','corrected')`,
    )
    .bind(...batch)
    .all<Record<string, unknown>>();
  evidenceRows.push(...res.results);
}
console.log(`backtest news: ${evidenceRows.length} evidence rows for ${ids.length} players (${db.rowsRead() - r0} rows read)`);
const itemsBy = new Map<string, ReturnType<typeof toItem>[]>();
for (const row of evidenceRows) {
  const item = toItem(row as never);
  const pid = item.userOverride?.playerId ?? item.playerId;
  if (!pid) continue;
  (itemsBy.get(pid) ?? itemsBy.set(pid, []).get(pid)!).push(item);
}
const withNews = (input: StartSitInput): StartSitInput => {
  const at = String(input.now ?? input.kickoff ?? '');
  const before = (itemsBy.get(input.player.id) ?? []).filter((x) => {
    const t = Date.parse(x.sourceDate ?? '');
    return Number.isFinite(t) && t <= Date.parse(at);
  });
  return before.length === 0 ? input : { ...input, signal: aggregatePlayerSignal(input.player.id, before, { now: at }) };
};
const scored = items.map((i) => {
  const input = withNews(weekInputs.get(i.week)![i.idx]!);
  const e = evaluatePlayer(input, profile);
  const bare = evaluatePlayer(weekInputs.get(i.week)![i.idx]!, profile);
  return { i, e, complete: e.expectation.coverage === 1, bare: bare.score, hasNews: input.signal != null };
});
console.log(`weeks ${bt.weeks.join(', ')}; ${items.length} priced player-weeks with a game played; ${scored.filter((s) => s.complete).length} with every market priced; ${new Set(items.map((i) => i.playerId)).size} players; ${scored.filter((s) => s.hasNews).length} player-weeks had news before kickoff`);
const nudged = (key: string) => scored.filter((s) => s.e.components.some((c) => c.key === key && !c.unknown && Math.abs(c.value) >= 0.005)).length;
console.log(`player-weeks the nudge moved: Opponent ${nudged('matchup_role')}, Recent news ${nudged('news_recent')}, lifetime news ${nudged('news_raw')}`);
const empty = new Map<string, number>();
let maxCheck = 0;
for (const s of scored) {
  const a = variantPoints(s.e, empty, []);
  const d = decisionPoints(s.e, empty);
  if (a != null && d != null) maxCheck = Math.max(maxCheck, Math.abs(a - d.points));
}
console.log(`check: the no-change variant reproduces the live number to within ${maxCheck.toFixed(4)}`);

function measure(set: typeof scored, remove: string[]) {
  const rows = set.map((s) => ({ s, v: variantPoints(s.e, empty, remove) })).filter((r): r is { s: (typeof scored)[number]; v: number } => r.v != null);
  const err = rows.map((r) => r.v - r.s.i.actual);
  let right = 0;
  let total = 0;
  for (const w of bt.weeks as number[]) {
    const wk = rows.filter((r) => r.s.i.week === w);
    for (let a = 0; a < wk.length; a++)
      for (let b = a + 1; b < wk.length; b++) {
        const x = wk[a]!;
        const y = wk[b]!;
        const g = (p: string) => (p === 'QB' ? 'QB' : 'FLEX');
        if (g(x.s.i.position) !== g(y.s.i.position) || x.v === y.v || x.s.i.actual === y.s.i.actual) continue;
        total++;
        if ((x.v > y.v) === (x.s.i.actual > y.s.i.actual)) right++;
      }
  }
  return { n: rows.length, mae: err.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, err.length), bias: err.reduce((a, e) => a + e, 0) / Math.max(1, err.length), pair: right / Math.max(1, total) };
}
for (const [label, set] of [
  ['every market priced (the gate set)', scored.filter((s) => s.complete)],
  ['every priced player-week', scored],
] as const) {
  console.log(`\n${label}:`);
  const todayM = measure(set, []);
  for (const v of VARIANTS) {
    const m = measure(set, v.remove);
    const delta = m.mae - todayM.mae;
    console.log(
      `  ${v.label.padEnd(24)} n ${String(m.n).padStart(4)}  average miss ${m.mae.toFixed(3)}  bias ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(2)}  higher-scored won ${(m.pair * 100).toFixed(1)}%` +
        (v.remove.length ? `  change ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} -> ${delta <= 0.01 ? 'passes (not worse by more than 0.01)' : 'fails (worse by more than 0.01)'}` : ''),
    );
  }
}
const bareSet = scored.filter((s) => s.complete && s.bare != null);
console.log(
  `\nfor reference, the gate set scored with no news at all (how the 4.840 was measured): average miss ${(bareSet.reduce((a, s) => a + Math.abs((s.bare ?? 0) - s.i.actual), 0) / Math.max(1, bareSet.length)).toFixed(3)}`,
);

/* --- McLaughlin, McConkey, Egbuka: weeks 6 and 7 */
const THREE = ['jaleel mclaughlin', 'ladd mcconkey', 'emeka egbuka'];
console.log('\nweek 6 (stored props before kickoff, news as of then):');
for (const v of VARIANTS) {
  const rows = THREE.map((n) => {
    const s = scored.find((x) => x.i.week === 6 && x.i.name.toLowerCase() === n);
    return { n, v: s ? variantPoints(s.e, empty, v.remove) : null, actual: s?.i.actual ?? null };
  });
  const ranked = rows.filter((r) => r.v != null).sort((a, b) => b.v! - a.v!);
  console.log(
    `  ${v.label.padEnd(24)} ${rows.map((r) => `${r.n.split(' ')[1]} ${f2(r.v)} (rank ${r.v == null ? '-' : ranked.indexOf(r) + 1}${r.actual != null ? `, scored ${r.actual.toFixed(2)}` : ''})`).join('  ')}  -> starts ${ranked[0]?.n ?? '-'}`,
  );
}
console.log(`  not priced in week 6: ${THREE.filter((n) => !scored.some((x) => x.i.week === 6 && x.i.name.toLowerCase() === n)).join(', ') || 'none'}`);

console.log(`\nweek ${req.week} (live inputs, as of ${NOW.toISOString()}), Alex's roster plus the scanned wire:`);
const everyone = [...req.rosterInputs, ...req.candidateInputs];
const evaluated = new Map(everyone.map((i) => [i.player.id, evaluatePlayer({ ...i, now: NOW }, req.profile)] as const));
const reserved = new Set(req.reserveIds);
for (const v of VARIANTS) {
  const player = (i: StartSitInput): PickupPlayer => {
    const e = evaluated.get(i.player.id)!;
    const d = decisionPoints(e, published);
    return {
      playerId: e.playerId,
      name: e.name,
      position: e.position,
      team: e.team,
      points: variantPoints(e, published, v.remove),
      basis: d?.basis ?? 'none',
      ruledOut: e.ruledOut,
      locked: e.lock.locked,
      designation: e.injury.designation ?? null,
      onReserve: reserved.has(e.playerId),
    };
  };
  const roster = req.rosterInputs.map(player);
  const wire = req.candidateInputs.map(player);
  const rows = THREE.map((n) => [...roster, ...wire].find((p) => p.name.toLowerCase() === n) ?? null);
  const ranked = rows.filter((r): r is PickupPlayer => r?.points != null).sort((a, b) => b.points! - a.points!);
  const result = planPickupStart({
    shape: req.shape,
    roster,
    candidates: wire,
    currentStarterIds: req.currentStarterIds,
    pickup: Object.fromEntries(wire.map((p) => [p.playerId, assembly.pickup[p.playerId] ?? { state: 'free', reason: null, until: null }])),
    openSpots: 1,
  });
  const solvable = (p: PickupPlayer) => ({ playerId: p.playerId, name: p.name, position: p.position, points: p.points ?? 0, borrowed: p.basis !== 'market' });
  const ownedPlus = solveLineup(
    [...roster, ...wire.filter((p) => p.name.toLowerCase() === THREE[0])].filter((p) => p.points != null && !p.ruledOut && !p.onReserve).map(solvable),
    req.shape,
  );
  console.log(
    `  ${v.label.padEnd(24)} ${THREE.map((n, k) => `${n.split(' ')[1]} ${f2(rows[k]?.points)} (rank ${rows[k]?.points == null ? '-' : ranked.indexOf(rows[k]!) + 1})`).join('  ')}` +
      `\n  ${''.padEnd(24)} starts (roster + McLaughlin): ${THREE.filter((n) => [...ownedPlus.starterIds].some((id) => nameOf.get(id)?.toLowerCase() === n)).join(', ') || 'none of the three'}` +
      `; pickup call: ${result.start ? `Pick up and start ${result.start.name} (+${f2(result.start.gain)})` : 'none'}${result.consider.length ? `; ties ${result.consider.map((c) => `${c.name} ${f2(c.margin)}`).join(', ')}` : ''}`,
  );
}

if (existsSync(join(dir, 'cost-before.json'))) {
  const before = JSON.parse(readFileSync(join(dir, 'cost-before.json'), 'utf8'));
  console.log('\n################ DATA COST: D1 rows read per Team load (lineup + waivers gatherers) ################');
  console.log(`before: lineup ${before.lineup.rows}, waivers ${before.waivers.rows}, total ${before.lineup.rows + before.waivers.rows} (scanned ${before.scanned})`);
  console.log(`after:  lineup ${cost.lineup.rows}, waivers ${cost.waivers.rows}, total ${cost.lineup.rows + cost.waivers.rows} (scanned ${cost.scanned})`);
  console.log('(the /roster read is the same code on both and is not counted)');
}
