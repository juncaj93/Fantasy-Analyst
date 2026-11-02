/**
 * Expert review (November 2026): print what the app recommends today, with
 * the numbers behind each call, from the JSON the probe saved. No network.
 *
 *   node scripts/expert-review-report.mjs <dir>
 *
 * Every section is guarded: a missing or failed read prints one line and the
 * rest still print.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: expert-review-report.mjs <dir>');
const load = (name) => {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const f2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2));
const f1 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
const section = (title) => console.log(`\n=== ${title} ===`);
const guard = (title, fn) => {
  try {
    fn();
  } catch (err) {
    console.log(`(${title} could not be printed: ${String(err).slice(0, 200)})`);
  }
};

const meta = load('meta') ?? {};
section('HEADER');
console.log(`sha ${meta.sha ?? '?'} · Sleeper week ${meta.sleeperWeek ?? '?'} · started ${meta.startedEt ?? '?'}`);
for (const r of meta.requests ?? []) console.log(`  ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)} ms ${String(r.bytes).padStart(8)} B  ${r.name}${r.rows != null ? `  rows returned ${r.rows}` : ''}`);

/* ------------------------------------------------------------ Start/Sit */
section('START/SIT: TEAM');
guard('Team', () => {
  const l = load('lineup');
  if (!l) return console.log('no lineup read');
  console.log(`mode ${l.mode} · suggestion ${l.modeSuggestion?.mode} auto=${l.modeSuggestion?.auto} state=${l.modeSuggestion?.state} margin=${l.modeSuggestion?.margin}`);
  console.log(`  ${l.modeSuggestion?.detail ?? ''}`);
  const cov = (s) => (s ? `${s.slotsPriced ?? '?'}/${s.slotsTotal ?? '?'} priced, coverage ${s.coverage ?? '?'}, projected ${f2(s.projected ?? s.total)}` : 'none');
  console.log(`  mine: ${cov(l.modeSuggestion?.mine)} | opponent: ${cov(l.modeSuggestion?.opponent)}`);
  console.log(`recommended ${f2(l.recommendedPoints)} · current ${f2(l.currentPoints)} · confidence ${l.confidence ?? '?'}`);
  const evalById = new Map([...(l.starters ?? []), ...(l.bench ?? []), ...(l.undecidable ?? [])].map((e) => [e.playerId, e]));
  const num = (e) => (e ? `${f2(e.decision?.points ?? e.score)} ${e.decision?.basis ?? (e.score == null ? 'none' : 'score')}${e.injury?.designation && e.injury.designation !== 'healthy' ? ` ${e.injury.designation}` : ''}${e.ruledOut ? ' OUT' : ''}` : '—');
  console.log('slots (app lineup):');
  for (const s of l.slots ?? []) {
    const e = evalById.get(s.playerId);
    console.log(`  ${String(s.slot).padEnd(5)} ${(s.name ?? '(empty)').padEnd(24)} ${String(s.position ?? '').padEnd(3)} ${num(e).padEnd(22)} ${s.alreadyStarting ? 'already starting' : 'CHANGE'}${s.locked ? ' locked' : ''}`);
  }
  console.log('bench:');
  for (const e of (l.bench ?? []).slice(0, 10)) console.log(`  ${String(e.name).padEnd(24)} ${String(e.position).padEnd(3)} ${num(e)}`);
  for (const e of l.undecidable ?? []) console.log(`  undecidable: ${e.name} ${e.position} ${e.reason ?? ''}`);
  console.log(`swaps (${(l.swaps ?? []).length}):`);
  for (const s of l.swaps ?? []) console.log(`  ${s.slot}: start ${s.inName} over ${s.outName} +${f2(s.gain)} · ${s.reason}`);
  for (const s of l.fills ?? []) console.log(`  fill ${s.slot}: ${s.inName} +${f2(s.gain)}`);
  for (const w of l.warnings ?? []) console.log(`  warning: ${w}`);
});

section('START/SIT: BEST MOVE (pick up and start)');
guard('Best move', () => {
  const w = load('waivers');
  const p = w?.pickupStart;
  if (!p) return console.log('no pickupStart in the waivers read');
  console.log(`threshold ${p.threshold} · best owned lineup ${f2(p.bestOwned)}`);
  const line = (m) =>
    `${m.verdict} ${m.name} ${m.position} ${f2(m.points)} at ${m.slot} +${f2(m.gain)} · headline over: ${m.over ? `${m.over.name} (${f2(m.over.points)})` : 'nobody'} · really displaces: ${m.displaces ? `${m.displaces.name} (${f2(m.displaces.points)})` : 'nobody'} · drop ${m.drop?.name ?? (m.pickDrop?.length ? 'pick your drop' : 'none')}`;
  console.log(p.start ? `START: ${line(p.start)}` : 'START: none');
  for (const m of p.consider ?? []) console.log(`consider: ${line(m)}`);
  for (const m of (p.notNow ?? []).slice(0, 5)) console.log(`not now: ${m.name} +${f2(m.gain)} (${m.why})`);
  console.log('audit, top 8 by margin:');
  for (const a of (p.audit ?? []).slice(0, 8)) console.log(`  ${String(a.name).padEnd(24)} ${String(a.position).padEnd(3)} ${f2(a.points)} ${a.basis} gain ${f2(a.gain)} ${a.status}`);
});

section('MATCHUP');
guard('Matchup', () => {
  const m = load('matchup');
  if (!m) return console.log('no matchup read');
  const f = m.forecast ?? {};
  console.log(`week ${m.week} · found ${m.found} ${m.reason ?? ''}`);
  const side = (t) => (t ? `${t.name} actual ${f2(t.actual)} projected ${f2(t.projectedFinal)} win ${t.winProbability}` : '—');
  console.log(`mine: ${side(f.teams?.mine)} | theirs: ${side(f.teams?.theirs)} · phase ${f.phase} · degraded ${f.degraded ? f.degradedReason : 'no'}`);
  const sm = f.suggestedMode;
  console.log(`matchup's own mode read: ${sm?.mode} auto=${sm?.auto} state=${sm?.state} margin=${sm?.margin} · mine coverage ${sm?.mine?.coverage} total ${f2(sm?.mine?.total)} · theirs coverage ${sm?.opponent?.coverage} total ${f2(sm?.opponent?.total)}`);
  console.log(`  ${sm?.detail ?? ''}`);
  console.log(`decision: ${JSON.stringify(f.decision?.best ?? null).slice(0, 400)} · ${f.decision?.note ?? ''} · options ${(f.decision?.options ?? []).length}`);
  for (const i of (f.insights ?? []).slice(0, 5)) console.log(`  insight ${i.kind}: ${i.headline}${i.detail ? ` · ${i.detail}` : ''}`);
});

/* -------------------------------------------------------------- Trades */
section('TRADES: IDEAS BOARD (as shown, with season checks)');
guard('Trades ideas', () => {
  const s = load('smart');
  const d = load('smartdiag');
  if (!s) return console.log('no smart trades read');
  console.log(`found ${s.found} · search ${JSON.stringify(s.search ? { partners: s.search.partners, generated: s.search.generated, scored: s.search.scored, viable: s.search.viable, surfaced: s.search.surfaced } : null)}`);
  console.log(`history ${JSON.stringify(s.history)}`);
  for (const n of s.notes ?? []) console.log(`  note: ${n}`);
  for (const n of s.warnings ?? []) console.log(`  warning: ${n}`);
  if (s.pricing?.line) console.log(`  pricing: ${s.pricing.line}`);
  if (s.arbitrageOff) console.log(`  arbitrage off: ${s.arbitrageOff}`);
  const checks = load('checks') ?? {};
  for (const o of s.offers ?? []) {
    console.log(`\n[${o.category}] to ${o.partner?.displayName} (roster ${o.partner?.rosterId}) · ${o.managerFit?.label} (${o.managerFit?.activity}) fit ${f2(o.managerFit?.contribution)} · score ${f2(o.score)}`);
    console.log(`  give: ${(o.give ?? []).map((p) => `${p.position} ${p.name} ${f2(p.value)}`).join(' + ')}`);
    console.log(`  get:  ${(o.get ?? []).map((p) => `${p.position} ${p.name} ${f2(p.value)}`).join(' + ')}`);
    console.log(`  fairness ${o.fairness?.band} gap ${f2(o.fairness?.gap)} (out ${f2(o.fairness?.outgoing)} in ${f2(o.fairness?.incoming)})`);
    console.log(`  you this week ${f2(o.user?.starterGain)} depth ${o.user?.depthChange} · them this week ${f2(o.counterparty?.starterGain)} depth ${o.counterparty?.depthChange} · their reasons [${(o.counterparty?.rationales ?? []).join(', ')}]`);
    console.log(`  breakdown ${JSON.stringify(o.breakdown)}`);
    console.log(`  season check: ${o.seasonCheck?.kind ?? 'none'} · ${o.seasonCheck?.headline ?? o.seasonCheck?.reason ?? ''}`);
    for (const a of o.arbitrage ?? []) console.log(`  arbitrage ${a.kind} ${a.playerId} strength ${a.strength} residual ${a.residualPerGame} exp ${a.expectedPerGame} obs ${a.observedPerGame}: ${a.headline}`);
    for (const r of o.reasons ?? []) console.log(`  reason: ${r}`);
    for (const c of o.caveats ?? []) console.log(`  caveat: ${c}`);
    const ch = checks[o.id];
    const ev = ch?.evaluation;
    if (ev) {
      console.log(`  ROS check: ${ev.status} ${ev.verdict?.kind ?? ''} gap ${f1(ev.verdict?.gap)} band ${f1(ev.verdict?.band)} · ${ev.verdict?.headline ?? ev.insufficientReason ?? ''} · confidence ${ev.confidence}`);
      for (const side of [ev.a, ev.b]) {
        if (!side) continue;
        console.log(`    ${side.label}: lineup ${f1(side.lineupChange)} depth ${f1(side.depthChange)} adj ${f1(side.adjustmentTotal)} net ${f1(side.net)}${side.mustDrop ? ` must drop ${side.mustDrop.name}` : ''}`);
        for (const p of [...(side.incoming ?? []).map((x) => ['in', x]), ...(side.outgoing ?? []).map((x) => ['out', x])]) {
          const [dirn, x] = p;
          console.log(`      ${dirn} ${x.position} ${x.name} rate ${f2(x.rate)} (${x.basis}) games ${f1(x.games)} ROS ${f1(x.rosValue)} starts ${x.startsWeeks}${x.byeInside ? ` bye wk${x.byeWeek}` : ''}${x.injuryNote ? ` · ${x.injuryNote}` : ''}`);
        }
      }
      for (const r of ev.confidenceReasons ?? []) console.log(`    confidence: ${r}`);
    } else if (ch) {
      console.log(`  ROS check: ${JSON.stringify(ch).slice(0, 200)}`);
    }
  }
  if (d) {
    const tally = {};
    for (const r of d.rejections ?? []) tally[r.reason] = (tally[r.reason] ?? 0) + 1;
    console.log(`\nrejections by reason: ${JSON.stringify(tally)}`);
    for (const reason of ['unpriced_players', 'user_benefit_negligible', 'harms_counterparty', 'costs_scarce_player', 'value_gap_outside_range', 'counterparty_has_position', 'no_plausible_use']) {
      for (const r of (d.rejections ?? []).filter((x) => x.reason === reason).slice(0, 2)) console.log(`  ${reason}: ${r.detail}`);
    }
    const reads = d.arbitrageReads ?? [];
    const byKind = {};
    for (const a of reads) byKind[`${a.kind}`] = (byKind[`${a.kind}`] ?? 0) + 1;
    console.log(`arbitrage reads: ${reads.length} ${JSON.stringify(byKind)}`);
    for (const a of reads.slice().sort((x, y) => y.strength - x.strength).slice(0, 14)) console.log(`  ${a.kind} strength ${a.strength} exp ${a.expectedPerGame} obs ${a.observedPerGame} residual ${a.residualPerGame} games ${a.games} · ${String(a.headline).slice(0, 90)}`);
  }
});

section('TRADES: BUILD A TRADE (unmarked on, every team)');
guard('Builder', () => {
  const b = load('builder') ?? {};
  for (const [rid, r] of Object.entries(b)) {
    if (!r || r.status !== 'ok') {
      console.log(`team ${rid}: ${r?.status ?? 'no read'} ${r?.message ?? ''}`);
      continue;
    }
    const team = r.teams?.[0];
    console.log(`team ${rid} ${team?.label ?? ''} (${team?.activity?.label ?? team?.activity ?? ''}) needs [${(team?.needs ?? []).join('; ')}] suggested ${(team?.suggested ?? []).length} · audit ${JSON.stringify(r.audit)}`);
    for (const p of r.packages ?? []) {
      console.log(`  ${p.status}: give ${(p.give ?? []).map((x) => `${x.position} ${x.name}`).join(' + ')} · get ${(p.get ?? []).map((x) => `${x.position} ${x.name}`).join(' + ')}${(p.drops ?? []).length ? ` · drop ${(p.drops ?? []).map((x) => x.name).join(', ')}` : ''}`);
      console.log(`    you: this week ${f1(p.alex?.thisWeek)} next3 ${f1(p.alex?.next3)} playoffs ${f1(p.alex?.playoffs)} ROS ${f1(p.alex?.restOfSeason)} weighted ${f1(p.alex?.weighted)} · them: next3 ${f1(p.them?.next3)} ROS ${f1(p.them?.restOfSeason)} weighted ${f1(p.them?.weighted)} · balance ${p.balance?.label} (${f1(p.balance?.give)} vs ${f1(p.balance?.get)}) · ${p.statusReason ?? ''} · need ${p.need ?? '—'}`);
    }
    for (const n of r.notes ?? []) console.log(`  note: ${n}`);
  }
});

section('TRADES: THE LEAGUE\'S REAL TRADES, THROUGH THE MODEL');
guard('Replay', () => {
  const r = load('replay');
  for (const t of r?.replays ?? []) {
    const ev = t.evaluation;
    console.log(`wk${t.week} ${t.mode}: ${(t.received ?? []).map((x) => `${t.rosters?.find((y) => y.rosterId === x.rosterId)?.label ?? x.rosterId} gets [${x.players.join(', ')}]`).join(' / ')}${t.faabMoved ? ` FAAB ${t.faabMoved}` : ''}`);
    console.log(`  ${ev ? `${ev.verdict?.headline ?? ev.insufficientReason ?? ev.status}` : (t.bundles ?? []).map((b) => `roster ${b.rosterId} bundle ${f1(b.total)}`).join(' · ')}`);
  }
});

/* ------------------------------------------------------------- Waivers */
section('WAIVERS');
guard('Waivers', () => {
  const w = load('waivers');
  if (!w) return console.log('no waivers read');
  const t = w.tiers ?? {};
  console.log(`headline ${JSON.stringify(w.headline)?.slice(0, 200)} · window ${JSON.stringify(t.window)} · thresholds ${JSON.stringify(t.thresholds)}`);
  console.log(`faab mine ${JSON.stringify(w.faab?.mine)} · prices ${JSON.stringify(w.faab?.prices)?.slice(0, 300)}`);
  const rows = [...(t.doThese ?? []), ...(t.consider ?? []), ...(t.watch ?? [])];
  console.log(`rows: do ${(t.doThese ?? []).length}, consider ${(t.consider ?? []).length}, watch ${(t.watch ?? []).length}`);
  for (const r of rows) {
    console.log(`\n[${r.tier}] ${r.name} ${r.position} ${r.team} · ${r.reasonCode}: ${r.reason}`);
    console.log(`  gain ${f2(r.gain)} (lineup ${f2(r.lineupGain)}, insurance ${f2(r.insurance)}) rate ${f2(r.rate)} · weeks ${(r.weekNumbers ?? []).map((x) => `w${x.week} ${f2(x.points)} ${x.source}`).join(', ')}`);
    console.log(`  byWeek ${(r.byWeek ?? []).map((x) => `w${x.week} ${f2(x.change)}`).join(', ')} · prefs ${JSON.stringify(r.prefs)}`);
    console.log(`  drop ${r.drop ? `${r.drop.name} score ${f2(r.drop.score)} ${r.drop.reason ?? ''}${r.drop.viaReserve ? ' (to IR)' : ''}` : 'none'} · dropCost ${f2(r.dropCost)} · alternatives ${(r.alternatives ?? []).join(', ')}`);
    if (r.bid) console.log(`  bid ${r.bid.kind} $${r.bid.recommended} ($${r.bid.low}-$${r.bid.high}) ceiling ${r.bid.ceiling} posture ${r.bid.posture} · ${r.bid.reason} · rivals ${(r.bid.likely ?? []).map((x) => `${x.name} ${x.chance}`).join(', ')}`);
  }
  console.log('\nweek figures with a bye or out flag:');
  for (const [id, wf] of Object.entries(t.weekFigures ?? {})) {
    const flagged = (wf.weeks ?? []).filter((x) => x.bye || x.out);
    if (flagged.length) console.log(`  ${wf.name} ${wf.position} ${wf.team}: ${(wf.weeks ?? []).map((x) => `w${x.week} ${f2(x.points)} ${x.source}${x.bye ? ' BYE' : ''}${x.out ? ' OUT' : ''}`).join(', ')}`);
  }
  console.log('lowest drop scores:');
  for (const d of (t.dropScores ?? []).slice().sort((a, b) => a.score - b.score).slice(0, 8)) console.log(`  ${String(d.name).padEnd(24)} ${f2(d.score)} ${d.protectedAs ?? ''}`);
  const cp = w.claimPlan;
  console.log(`claim plan: ${cp?.state} · ${cp?.headline ?? ''} · groups ${(cp?.groups ?? []).length}`);
  for (const g of cp?.groups ?? []) console.log(`  group ${g.index}: ${g.headline}`);
});

/* ------------------------------------------------------------ Backtest */
section('START/SIT BACKTEST, WEEKS 1-8 (offense only, today\'s engine)');
guard('Backtest', () => {
  const b = load('backtest');
  if (!b) return console.log('no backtest');
  const tot = { actual: 0, app: 0, floor: 0, ceiling: 0, best: 0, n: 0 };
  let won = 0, lost = 0, swapNet = 0, swaps = 0;
  for (const w of b.weeks ?? []) {
    console.log(`wk${w.week}: you ${f2(w.actual)} · app ${f2(w.app)} (${w.app - w.actual >= 0 ? '+' : ''}${f2(w.app - w.actual)}) · floor ${f2(w.floor)} · ceiling ${f2(w.ceiling)} · best ${f2(w.best)} · numbers: ${w.priced} Vegas, ${w.publishedOnly} Sleeper, ${w.noNumber} none`);
    if (w.appOnly?.length) console.log(`  app starts: ${w.appOnly.map((p) => `${p.name} ${p.pts} (${p.basis})`).join(', ')}`);
    if (w.alexOnly?.length) console.log(`  you started: ${w.alexOnly.map((p) => `${p.name} ${p.pts} (${p.basis})`).join(', ')}`);
    for (const s of w.swaps ?? []) {
      swaps += 1;
      swapNet += s.inPts - s.outPts;
      if (s.inPts > s.outPts) won += 1;
      else if (s.inPts < s.outPts) lost += 1;
      console.log(`  swap: ${s.in} ${s.inPts} over ${s.out} ${s.outPts} (projected +${f2(s.gain)})`);
    }
    if (w.week <= Number(process.env.COMPLETE_WEEKS ?? 8)) {
      tot.actual += w.actual; tot.app += w.app; tot.floor += w.floor; tot.ceiling += w.ceiling; tot.best += w.best; tot.n += 1;
    }
  }
  console.log(`TOTAL ${tot.n} weeks: you ${f2(tot.actual)} · app ${f2(tot.app)} (${f2(tot.app - tot.actual)}) · floor ${f2(tot.floor)} · ceiling ${f2(tot.ceiling)} · best ${f2(tot.best)}`);
  console.log(`app swaps: ${swaps}, right ${won}, wrong ${lost}, net ${f2(swapNet)} pts`);
  console.log(`backtest D1: ${JSON.stringify(b.cost)}`);
});
