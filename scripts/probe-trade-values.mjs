#!/usr/bin/env node
/**
 * What the trade check actually says about a real league.
 *
 * Read-only against a running deployment, through its own endpoints. Every
 * request is a GET and nothing is changed.
 *
 *   node scripts/probe-trade-values.mjs
 *   URL=http://127.0.0.1:8788 node scripts/probe-trade-values.mjs
 *   LEAGUE_ID=<id> node scripts/probe-trade-values.mjs
 *
 * It does three things:
 *
 *  1. **Replays the league's own past trades** through the model and prints
 *     what it said. Trades from this season are replayed against both rosters
 *     as they stand with the deal reversed; older ones, and any whose players
 *     have since moved, are printed as each side's bundle valued today. This
 *     looks for absurd outputs. It does not test whether the model predicts.
 *  2. **Checks a few trades that have not happened**, built from the real
 *     rosters (a like-for-like swap, a two-for-one, a quarterback swap, a bench
 *     swap and a trade between two other teams, which is the panel's view), each
 *     asked from both teams' chairs, because the answer must not depend on which
 *     team is written first.
 *  3. **Reports what a check costs the database**, measured in the Worker with
 *     `?cost=1`: statements run and rows returned.
 *
 * The checks live in `lib/tradeValueReview.mjs`, exercised against real
 * violations in `tests/probe.tradeValueReview.test.ts`. A clean run says so; a
 * dirty one names the trade and the problem, and exits non-zero.
 */

import { reviewAntisymmetry, reviewCheck, reviewReplay } from './lib/tradeValueReview.mjs';

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const LEAGUE_ID = (process.env.LEAGUE_ID ?? '').trim();

async function fetchJson(path) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${URL_BASE}${path}`);
  } catch (err) {
    return { status: 0, ms: Date.now() - started, body: { error: String(err?.cause?.message ?? err?.message ?? err) } };
  }
  const text = await res.text();
  try {
    return { status: res.status, ms: Date.now() - started, body: JSON.parse(text) };
  } catch {
    return { status: res.status, ms: Date.now() - started, body: { error: text.slice(0, 200) } };
  }
}

const findings = [];
const costs = [];
const pts = (n) => (n > 0 ? `+${n.toFixed(1)}` : n < 0 ? `−${Math.abs(n).toFixed(1)}` : '0.0');

function describePlayer(p) {
  const rate = p.rate == null ? 'no rate' : `${p.rate.toFixed(1)}/g ${p.basis}`;
  const bye = p.byeInside ? `, bye wk ${p.byeWeek}` : '';
  const val = p.rosValue == null ? '' : `, ${p.rosValue} over repl.`;
  return `${p.name} (${p.position}) ${rate}, ${p.games.toFixed(1)} g, starts ${p.startsWeeks}${val}${bye}`;
}

/**
 * The working, per week: what each player is made of, when he plays, and how each
 * side's lineup moves. So a big total can be checked against the weeks it came
 * from instead of being taken on trust.
 */
function printBreakdown(ev) {
  if (!ev || ev.status !== 'ok') return;
  const weeks = ev.a.weekly?.map((w) => w.week) ?? [];
  const head = weeks.map((w) => String(w).padStart(5)).join('');
  for (const side of [ev.a, ev.b]) {
    console.log(`    ${side.isMine ? 'YOU' : side.label}, week by week`);
    console.log(`        week            ${head}`);
    for (const p of [...side.outgoing.map((x) => ['gives', x]), ...side.incoming.map((x) => ['gets', x])]) {
      const [verb, line] = p;
      const parts = line.rateParts ? `base ${line.rateParts.base.toFixed(1)} + nudges ${pts(line.rateParts.nudges)}` : 'no base (season line)';
      console.log(`        ${verb} ${line.name}: ${line.rate?.toFixed(1) ?? '?'}/g = ${parts}; ${line.designation}${line.injuryNote ? ` (${line.injuryNote})` : ''}`);
      const avail = (line.weekly ?? []).map((a) => String(a === 0 ? 'bye/out' : a === 1 ? '1' : a.toFixed(2)).padStart(5)).join('');
      console.log(`            available   ${avail}`);
      const on = new Set(line.startsOn ?? []);
      console.log(`            starts      ${weeks.map((w) => (on.has(w) ? '  yes' : '   no')).join('')}`);
    }
    const row = (label, f) => console.log(`        ${label.padEnd(15)} ${side.weekly.map((w) => String(f(w).toFixed(1)).padStart(5)).join('')}`);
    row('lineup before', (w) => w.lineupBefore);
    row('lineup after', (w) => w.lineupAfter);
    row('change', (w) => w.lineupAfter - w.lineupBefore + (w.depthAfter - w.depthBefore));
    const total = side.weekly.reduce((a, w) => a + (w.lineupAfter - w.lineupBefore), 0);
    console.log(`        lineup change summed over ${weeks.length} weeks: ${pts(total)}  (reported ${pts(side.lineupChange)})`);
  }
}

function printEvaluation(ev) {
  if (!ev) return;
  if (ev.status !== 'ok') {
    console.log(`    NO VERDICT: ${ev.insufficientReason}`);
    return;
  }
  console.log(`    ${ev.verdict.headline}  [band ±${ev.verdict.band}, confidence ${ev.confidence}]`);
  for (const side of [ev.a, ev.b]) {
    const adj = side.adjustments.map((a) => `${a.key} ${pts(a.points)}`).join(', ');
    console.log(
      `    ${side.isMine ? 'YOU' : side.label}: net ${pts(side.net)}  (lineup ${pts(side.lineupChange)}, depth ${pts(side.depthChange)}${adj ? `, prefs ${adj}` : ''})`,
    );
    for (const p of side.incoming) console.log(`        gets ${describePlayer(p)}`);
    if (side.mustDrop) console.log(`        would cut ${side.mustDrop.name}${(side.cutCount ?? 1) > 1 ? ` and ${side.cutCount - 1} more` : ''}`);
  }
  for (const r of ev.reasons) console.log(`    why: ${r}`);
  for (const r of ev.confidenceReasons) console.log(`    caution: ${r}`);
}

async function main() {
  console.log(`Trade values against ${URL_BASE}`);

  let leagueId = LEAGUE_ID;
  if (!leagueId) {
    const leagues = await fetchJson('/api/leagues');
    const selected = leagues.body?.leagues?.find((l) => l.isSelected) ?? leagues.body?.leagues?.[0];
    if (!selected) {
      console.log('No league found.');
      process.exitCode = 1;
      return;
    }
    leagueId = selected.id;
  }
  const base = `/api/leagues/${encodeURIComponent(leagueId)}/trades/check`;

  // ---------------------------------------------------------------- teams
  const teams = await fetchJson(`${base}/teams`);
  if (teams.status !== 200 || !teams.body?.found) {
    console.log(`teams: ${teams.status} ${teams.body?.reason ?? teams.body?.error ?? ''}`);
    process.exitCode = 1;
    return;
  }
  const h = teams.body.horizon;
  console.log(`\nLeague: ${teams.body.league.name}`);
  console.log(`  weeks ${h.currentWeek} to ${h.lastWeek} (${h.weeks} weeks), playoffs ${h.playoffWeeks.join(', ')}`);
  console.log(`  trade deadline: ${h.deadlineWeek == null ? 'none' : `after week ${h.deadlineWeek}${h.deadlinePassed ? ' (PASSED)' : `, ${h.weeksToDeadline} weeks left`}`}`);
  console.log(`  teams: ${teams.body.teams.map((t) => `${t.label}${t.isMine ? ' (you)' : ''} ${t.players.length}`).join(', ')}  [${teams.ms} ms]`);

  // --------------------------------------------------------------- replay
  console.log('\nPast league trades, replayed today');
  const replay = await fetchJson(`/api/diagnostics/trade-values?leagueId=${encodeURIComponent(leagueId)}&limit=12&cost=1`);
  if (replay.status !== 200) {
    console.log(`  replay: ${replay.status} ${replay.body?.error ?? ''}`);
    findings.push('replay did not answer');
  } else {
    console.log(`  ${replay.body.considered} stored trade(s) considered  [${replay.ms} ms]`);
    for (const r of replay.body.replays) {
      const got = r.received.map((x) => `${r.rosters.find((q) => q.rosterId === x.rosterId)?.label ?? x.rosterId} got ${x.players.join(' + ') || 'nothing'}`).join('; ');
      console.log(`\n  ${r.season} week ${r.week}, ${r.mode}: ${got}`);
      for (const n of r.notes) console.log(`    note: ${n}`);
      if (r.mode === 'roster_aware') printEvaluation(r.evaluation);
      else for (const b of r.bundles ?? []) console.log(`    ${r.rosters.find((q) => q.rosterId === b.rosterId)?.label ?? b.rosterId}: ${b.players.map((p) => `${p.name} ${p.rosValue ?? '?'}`).join(' + ')} = ${b.total ?? 'unvalued'}`);
    }
    for (const n of replay.body.notes ?? []) console.log(`  ${n}`);
    findings.push(...reviewReplay(replay.body));
    if (replay.body.cost) costs.push(['replay of 12 trades', replay.body.cost]);
  }

  // ------------------------------------------------------------- examples
  console.log('\nTrades that have not happened');
  const list = teams.body.teams;
  const mine = list.find((t) => t.isMine);
  const others = list.filter((t) => !t.isMine && t.players.length > 0);
  const starters = (t, pos) => t.players.filter((p) => p.position === pos && p.starter && !p.reserve);
  const bench = (t) => t.players.filter((p) => !p.starter && !p.reserve && p.position !== 'DEF');
  const first = (arr) => arr[0];

  const examples = [];
  if (mine && others[0]) {
    const a = first(starters(mine, 'WR'));
    const b = first(starters(others[0], 'WR'));
    if (a && b) examples.push(['a like-for-like swap: my first starting WR for theirs', mine, others[0], [a], [b]]);
  }
  if (mine && others[1]) {
    const a = first(starters(mine, 'RB'));
    const b = first(starters(others[1], 'RB'));
    if (a && b) examples.push(['a like-for-like swap: my first starting RB for theirs', mine, others[1], [a], [b]]);
  }
  if (mine && (others[2] ?? others[0])) {
    const partner = others[2] ?? others[0];
    const give = bench(mine).slice(0, 2);
    const get = first(starters(partner, 'WR'));
    if (give.length === 2 && get) examples.push(['a two-for-one: two of my bench players for one of their starting WRs', mine, partner, give, [get]]);
  }
  if (mine && others[0]) {
    const a = first(starters(mine, 'QB'));
    const b = first(starters(others[0], 'QB'));
    if (a && b) examples.push(['a quarterback swap', mine, others[0], [a], [b]]);
  }
  if (mine && others[0]) {
    const a = first(bench(mine));
    const b = first(bench(others[0]));
    if (a && b) examples.push(['a bench swap: nobody should win this', mine, others[0], [a], [b]]);
  }
  if (others.length >= 2) {
    const a = first(starters(others[0], 'WR'));
    const b = first(starters(others[1], 'WR'));
    if (a && b) examples.push(['the panel’s view: two other teams swap a starting WR each', others[0], others[1], [a], [b]]);
  }

  if (examples.length === 0) console.log('  No example could be built from these rosters.');

  const q = (ta, tb, give, get, cost) =>
    `${base}?a=${ta.rosterId}&b=${tb.rosterId}&give=${give.map((p) => p.playerId).join(',')}&get=${get.map((p) => p.playerId).join(',')}${cost ? '&cost=1' : ''}`;

  for (const [label, ta, tb, give, get] of examples) {
    const forward = await fetchJson(q(ta, tb, give, get, true));
    const reverse = await fetchJson(q(tb, ta, get, give, false));
    console.log(`\n  ${label}`);
    console.log(`    ${ta.label}${ta.isMine ? ' (you)' : ''} gives ${give.map((p) => p.name).join(' + ')}; ${tb.label} gives ${get.map((p) => p.name).join(' + ')}  [${forward.ms} ms]`);
    if (forward.status !== 200) {
      console.log(`    ${forward.status} ${forward.body?.error ?? ''}`);
      findings.push(`${label}: ${forward.status}`);
      continue;
    }
    printEvaluation(forward.body.evaluation);
    printBreakdown(forward.body.evaluation);
    findings.push(...reviewCheck(label, forward.body));
    findings.push(...reviewAntisymmetry(label, forward.body, reverse.body));
    if (forward.body.cost) costs.push([label, forward.body.cost]);
  }

  // ----------------------------------------------------------------- cost
  console.log('\nWhat it costs the database (measured in the Worker, rows returned)');
  for (const [label, c] of costs) {
    console.log(`  ${String(c.rowsReturned).padStart(6)} rows, ${String(c.statements).padStart(3)} statements  ${label}`);
    for (const t of (c.top ?? []).slice(0, 4)) console.log(`      ${String(t.rows).padStart(5)} rows  ${t.calls}x  ${t.sql}`);
  }
  console.log('  Rows returned is a lower bound on rows read, and the player list is served from a memo when warm.');

  // -------------------------------------------------------------- verdict
  console.log('');
  if (findings.length === 0) console.log(`All checks passed over ${examples.length} example trade(s) and the replay: nothing absurd, every answer antisymmetric.`);
  else {
    console.log(`${findings.length} problem(s):`);
    for (const f of findings) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
