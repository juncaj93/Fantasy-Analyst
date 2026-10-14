/**
 * Trades round (ideas audit + trade builder): the replays on the real stored
 * data, read-only.
 *
 *   node --experimental-transform-types --no-warnings scripts/trades-builder-replay.ts
 *
 * Needs CLOUDFLARE_API_TOKEN (and ACCOUNT_ID). Runs the app's own services
 * against production D1 through the REST API (SELECT only) and prints D1's own
 * rows_read. Sleeper is never called: the client handed over throws.
 *
 *   A. Why the Trades ideas board is empty: the funnel by filter, Alex's roster
 *      as the engine sees it, the nearest misses, the season check, and the
 *      same search with wider caps (a what-if, printed as one).
 *   B. The trade builder on Alex's real roster: all teams, then two real teams,
 *      with names, numbers and reasons, exactly as the screen would get them.
 *   C. Rows read: a Trades load (the board, the ideas and their season check),
 *      opening Build a trade, and one build.
 */

import { SleeperClient } from '../src/core/sleeper/client.ts';
import { buildRosterViews } from '../src/core/trades/rosterUtility.ts';
import { TRADE_BOUNDS } from '../src/core/trades/bilateral.ts';
import { assembleSmartTrades } from '../src/core/trades/assemble.ts';
import { applySeasonChecks } from '../src/core/trades/seasonCheck.ts';
import { topAcrossTeams, type BuilderResponse, type BuiltPackage } from '../src/core/trades/builderResponse.ts';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import { seasonChecksFor } from '../src/server/services/tradeIdeaCheck.ts';
import { TradeService } from '../src/server/services/tradeService.ts';
import { TradeValueService } from '../src/server/services/tradeValueService.ts';
import { TradeBuilderService } from '../src/server/services/tradeBuilderService.ts';
import { openRestD1, topStatements } from './lib/restD1.ts';

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}
const n = (v: number) => Math.round(v).toLocaleString('en-GB');
const sleeper = new SleeperClient({
  fetch: async (url: string) => {
    throw new Error(`this probe must not call Sleeper: ${url}`);
  },
});
const open = () => openRestD1(token!, process.env.ACCOUNT_ID);

async function section(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.log(`  (${name} failed: ${err instanceof Error ? err.message : String(err)})`);
  }
}

let leagueId: string | null = null;

/* ------------------------------------------------------------- Part A -- */

async function partA(): Promise<void> {
  console.log('\n=== A. Why the Trades ideas board is empty ===');
  const rest = await open();
  const service = new SmartTradeService(rest.db);
  const gathered = await service.gather({});
  leagueId = gathered.league?.id ?? null;
  console.log(`  league: ${gathered.league?.name ?? '?'} (${leagueId ?? '?'})`);
  const explained = await service.explain({});
  const s = explained.search;
  console.log(`  funnel: ${s.partners} partners · ${s.generated} candidates generated · ${s.scored} scored (the rest cut by the per-partner cap) · ${s.viable} passed every gate · ${s.surfaced} surfaced`);
  console.log(`  bounds: ${JSON.stringify(s.bounds)}`);
  const pricing = (explained as unknown as { pricing?: { priced: number; unpriced: number; mineUnpriced: string[]; tooThin: boolean; line: string | null } }).pricing;
  if (pricing) {
    console.log(`  pricing: ${pricing.priced} priced, ${pricing.unpriced} unpriced (too thin: ${pricing.tooThin}); yours unpriced: ${pricing.mineUnpriced.join(', ') || 'none'}`);
  }
  console.log(`  notes on the board: ${JSON.stringify(explained.notes)}`);
  if (explained.arbitrageOff) console.log(`  buy-low / sell-high: ${explained.arbitrageOff}`);

  const byReason = new Map<string, number>();
  for (const r of explained.rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  console.log('  rejections by filter:');
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(4)}  ${reason}`);
  const prunedCount = explained.rejections
    .filter((r) => r.reason === 'pruned_by_bound')
    .reduce((sum, r) => sum + (Number(/^(\d+)/.exec(r.detail)?.[1]) || 0), 0);
  console.log(`    (pruned_by_bound covers ${prunedCount} candidates in all)`);

  /* Alex's roster, as the ideas engine sees it. */
  const req = gathered.request;
  const views = buildRosterViews({
    rosters: req.rosters.map((r) => ({ key: String(r.rosterId), playerIds: r.playerIds })),
    pool: new Map(req.inputs.map((i) => [i.player.id, i] as const)),
    shape: req.shape,
    profile: req.profile,
    ...(req.published ? { published: req.published } : {}),
  });
  const mineRoster = req.rosters.find((r) => r.isMine);
  const me = mineRoster ? views.get(String(mineRoster.rosterId)) : undefined;
  if (me) {
    console.log('  your roster as the ideas engine sees it (the week\u2019s number: complete Vegas, else Sleeper\u2019s week; no number = left out):');
    for (const id of me.playerIds) {
      const name = me.nameOf.get(id) ?? id;
      const pos = me.positionOf.get(id) ?? '?';
      const value = me.valueOf.get(id);
      const state = value != null ? value.toFixed(1) : me.unpriced.has(id) ? 'no market price' : me.unscored.has(id) ? 'not scored' : '?';
      console.log(`    ${pos.padEnd(3)} ${name.padEnd(26)} ${state}${me.starterIds.has(id) ? '  (starter)' : ''}`);
    }
    console.log(`  your needs: ${[...me.needs.values()].map((nd) => `${nd.position} ${nd.level}`).join(', ')}`);
    for (const r of req.rosters.filter((x) => !x.isMine)) {
      const v = views.get(String(r.rosterId));
      if (v) console.log(`    ${(r.ownerName ?? `Roster ${r.rosterId}`).padEnd(22)} priced ${v.valueOf.size}, no market price ${v.unpriced.size}, needs ${[...v.needs.values()].filter((nd) => nd.level !== 'adequate').map((nd) => `${nd.position} ${nd.level}`).join(', ') || 'none'}`);
    }
  }

  /* The nearest misses: the best gain that fell short, the smallest value gap past the band, the smallest harm. */
  const num = (detail: string) => Number(/(-?\d+(?:\.\d+)?)\s*(?:pts|%)/.exec(detail)?.[1] ?? NaN);
  const nameOf = (id: string) => {
    for (const v of views.values()) if (v.nameOf.has(id)) return v.nameOf.get(id)!;
    return id;
  };
  const partnerName = (key: string) => req.rosters.find((r) => String(r.rosterId) === key)?.ownerName ?? key;
  const show = (reason: string, sort: (a: number, b: number) => number, limit = 5) => {
    const list = explained.rejections.filter((r) => r.reason === reason && (r.give.length > 0 || r.get.length > 0));
    if (list.length === 0) return;
    console.log(`  nearest misses, ${reason}:`);
    for (const r of [...list].sort((a, b) => sort(num(a.detail), num(b.detail))).slice(0, limit)) {
      console.log(`    ${partnerName(r.partnerKey)}: give ${r.give.map(nameOf).join(' + ') || '-'} for ${r.get.map(nameOf).join(' + ') || '-'} — ${r.detail}`);
    }
  };
  show('user_benefit_negligible', (a, b) => b - a);
  show('costs_scarce_player', (a, b) => b - a);
  show('value_gap_outside_range', (a, b) => a - b);
  show('harms_counterparty', (a, b) => a - b);
  show('no_counterparty_logic', () => 0, 3);
  show('unpriced_lineup', () => 0, 3);
  show('counterparty_has_position', () => 0, 3);
  for (const r of explained.rejections.filter((x) => x.reason === 'no_plausible_use' || x.reason === 'unpriced_players')) {
    console.log(`    ${partnerName(r.partnerKey)}: ${r.reason} — ${r.detail}`);
  }

  /* The season check on whatever surfaced. */
  const { board, inputs } = await service.buildWithInputs({ limit: 5 });
  const checks = await seasonChecksFor(rest.db, sleeper, board.league?.id, board.offers, inputs);
  const after = applySeasonChecks(board, checks);
  console.log(`  season check: ${board.offers.length} ideas in, ${after.dropped.length} left off as favouring the other team, ${after.board.offers.length} shown`);
  for (const o of after.board.offers) console.log(`    shown: give ${o.give.map((p) => p.name).join(' + ')} for ${o.get.map((p) => p.name).join(' + ')} (${o.partner.displayName}), ${o.headline}`);

  for (const o of after.board.offers) {
    console.log(`    why: ${o.reasons.slice(0, 2).join(' | ')}`);
  }

  /* The same board without Sleeper's week: complete markets only. Shows what the fallback adds. */
  const noPublished = assembleSmartTrades({ ...gathered.request, published: new Map() });
  console.log(`  without Sleeper's week (complete markets only): ${noPublished.search.generated} generated, ${noPublished.search.scored} scored, ${noPublished.search.viable} viable, ${noPublished.search.surfaced} surfaced`);
  console.log(`  Sleeper's week read for ${gathered.request.published?.size ?? 0} players`);

  /* What-if: the same search with wider caps. Printed as a what-if; nothing ships from it. */
  const saved = { ...TRADE_BOUNDS };
  const bounds = TRADE_BOUNDS as unknown as Record<string, number>;
  Object.assign(bounds, { targetsPerPartner: 12, givePerPartner: 12, scoredPerPartner: 60 });
  try {
    const wide = assembleSmartTrades(gathered.request);
    console.log(`  what-if, caps widened (targets 12, give 12, scored 60): ${wide.search.generated} generated, ${wide.search.scored} scored, ${wide.search.viable} viable, ${wide.search.surfaced} surfaced`);
    for (const o of wide.offers) {
      console.log(`    would show: give ${o.give.map((p) => p.name).join(' + ')} for ${o.get.map((p) => p.name).join(' + ')} (${o.partner.displayName}), ${o.headline}`);
      console.log(`      why: ${o.reasons.slice(0, 2).join(' | ')}`);
    }
  } finally {
    Object.assign(bounds, saved);
  }
}

/* ------------------------------------------------------------- Part B -- */

function printPackage(p: BuiltPackage, i: number): void {
  console.log(`    ${i + 1}. [${p.status}${p.costsNow ? ', costs you now' : ''}${p.basis === 'sleeper' ? ', mostly Sleeper' : ''}] with ${p.partner.label}: give ${p.give.map((g) => `${g.name} (${g.stat})`).join(' + ')}`);
  console.log(`       get ${p.get.map((g) => `${g.name} (${g.stat})`).join(' + ')}${p.drops.length ? `; drop ${p.drops.map((d) => `${d.name} (${d.reason})`).join(', ')}` : ''}${p.irMoves.length ? `; IR ${p.irMoves.map((d) => d.name).join(', ')}` : ''}`);
  console.log(`       you: this week ${p.alex.thisWeek}, next 3 ${p.alex.next3}, playoffs ${p.alex.playoffs}, rest of season ${p.alex.restOfSeason} (ranking ${p.alex.weighted}); them: next 3 ${p.them.next3}, rest of season ${p.them.restOfSeason}`);
  console.log(`       why for them: ${p.why} · value ${p.balance.label} (give ${p.balance.give}, get ${p.balance.get}) · ${p.statusReason} · confidence ${p.confidence}`);
  console.log(`       manager: ${p.partner.activity.line} · card phrase: ${p.needShort ?? '-'} · sheet: ${p.statusShort ?? ''} / ${(p.whyShort ?? []).join(' / ')}`);
  for (const r of p.reasons) console.log(`       - ${r}`);
  for (const c of p.caveats.slice(0, 4)) console.log(`       ~ ${c}`);
  console.log(`       pitch: ${p.pitch}`);
}

function printResult(label: string, r: BuilderResponse, cost: { statements: number; rowsRead: number; ms: number }, ms: number): void {
  console.log(`\n  ${label}: ${r.status}${r.message ? ` — ${r.message}` : ''}`);
  console.log(`    deadline: ${r.deadline?.line ?? 'none set'}; weeks: this ${r.weeks?.thisWeek}, playoffs ${r.weeks?.playoffs.join(',')}`);
  console.log(`    audit: ${JSON.stringify(r.audit)}; ${cost.statements} statements, ${n(cost.rowsRead)} rows read, ${ms} ms wall`);
  for (const note of r.notes) console.log(`    note: ${note}`);
  for (const t of r.teams) {
    console.log(`    ${t.label}: needs ${t.needs.slice(0, 3).join('; ') || 'none'}; suggested ${t.suggested.join(', ') || '-'}; ${t.activity.line}; ${t.packages.length} package(s)`);
  }
  r.packages.forEach(printPackage);
}

async function partB(): Promise<void> {
  console.log('\n=== B. The trade builder on Alex’s real roster ===');
  if (!leagueId) {
    console.log('  no league resolved in part A');
    return;
  }
  const rest = await open();
  const values = new TradeValueService(rest.db, sleeper);
  const teams = await values.teams(leagueId);
  const mine = teams.teams?.find((t) => t.isMine);
  if (!mine) {
    console.log('  no roster marked as yours');
    return;
  }
  console.log(`  your roster: ${mine.players.map((p) => `${p.name} (${p.position}${p.reserve ? ', IR' : ''})`).join(', ')}`);

  /*
   * Alex has marked nothing yet (marks live on his phone). The replay uses
   * "Also consider unmarked players", which offers his most spare players and
   * never his elite backs: the closest thing to his first tap.
   */
  const builder = new TradeBuilderService(rest.db, sleeper);
  const others = (teams.teams ?? []).filter((t) => !t.isMine && t.players.length > 0);

  /*
   * All teams as the screen now runs it: one request per team (sweep=1), each
   * on its own database handle so the rows are that request's alone. CPU is
   * this process's own time for the request: an upper-bound stand-in for the
   * Worker's, since it includes the REST round trips' JSON handling.
   */
  console.log('\n  All teams, one request per team (nothing marked, "also consider unmarked" on):');
  const all: BuiltPackage[] = [];
  let worst = { ms: 0, cpu: 0, rows: 0, team: '' };
  let totalRows = 0;
  for (const t of others) {
    const one = await open();
    const m = one.mark();
    const started = Date.now();
    const cpu0 = process.cpuUsage();
    const r = await new TradeBuilderService(one.db, sleeper).build(leagueId, { sell: [], want: new Map(), team: t.rosterId, considerUnmarked: true, sweep: true });
    const cpu = process.cpuUsage(cpu0);
    const cost = one.since(m);
    const ms = Date.now() - started;
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
    totalRows += cost.rowsRead;
    if (cpuMs > worst.cpu) worst = { ms, cpu: cpuMs, rows: cost.rowsRead, team: t.label };
    console.log(`    ${t.label.padEnd(18)} ${String(r.packages.length).padStart(2)} pkg  ${String(cost.statements).padStart(3)} statements  ${n(cost.rowsRead).padStart(6)} rows  ${String(ms).padStart(5)} ms wall  ${String(cpuMs).padStart(4)} ms CPU`);
    all.push(...r.packages);
  }
  console.log(`    worst request: ${worst.team}, ${worst.cpu} ms CPU, ${worst.ms} ms wall, ${n(worst.rows)} rows; whole sweep ${n(totalRows)} rows`);
  const top = topAcrossTeams(all);
  console.log(`  the screen's top ${top.length} across all teams:`);
  top.forEach(printPackage);

  const picked = [...new Set(top.map((p) => p.partner.rosterId))].slice(0, 2);
  for (const rosterId of picked) {
    const m = rest.mark();
    const t = Date.now();
    const one = await builder.build(leagueId, { sell: [], want: new Map(), team: rosterId, considerUnmarked: true });
    printResult(`One team: ${one.teams[0]?.label ?? rosterId}`, one, rest.since(m), Date.now() - t);
  }
}

/* ------------------------------------------------------------- Part C -- */

async function partC(): Promise<void> {
  console.log('\n=== C. D1 rows read ===');
  const a = await open();
  let m = a.mark();
  await new TradeService(a.db).build({ limit: 60 });
  const board = a.since(m);
  m = a.mark();
  const { board: smart, inputs } = await new SmartTradeService(a.db).buildWithInputs({ limit: 5 });
  const ideas = a.since(m);
  m = a.mark();
  await seasonChecksFor(a.db, sleeper, smart.league?.id, smart.offers, inputs);
  const check = a.since(m);
  const load = board.rowsRead + ideas.rowsRead + check.rowsRead;
  console.log(`  a Trades load, before and after this round (the builder adds nothing until it is opened):`);
  console.log(`    /api/trades        ${board.statements} statements, ${n(board.rowsRead)} rows`);
  console.log(`    /api/trades/smart  ${ideas.statements + check.statements} statements, ${n(ideas.rowsRead + check.rowsRead)} rows (ideas ${n(ideas.rowsRead)}, season check ${n(check.rowsRead)})`);
  console.log(`    total              ${n(load)} rows`);

  if (!leagueId) return;
  const b = await open();
  m = b.mark();
  await new TradeValueService(b.db, sleeper).teams(leagueId);
  const fold = b.since(m);
  console.log(`  opening Build a trade (the rosters): ${fold.statements} statements, ${n(fold.rowsRead)} rows`);
  console.log('  where a Trades load spends its rows (top statements):');
  for (const line of topStatements(a.log, 6)) console.log('    ' + line);
}

console.log('Trades round replay (read-only, REST D1, no Sleeper calls)');
await section('part A', partA);
await section('part B', partB);
await section('part C', partC);
