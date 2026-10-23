/**
 * The "numbers agree" round, replayed from live support snapshots (23 October 2026).
 *
 *   node --experimental-transform-types --no-warnings scripts/numbers-agree-report.ts <dir>
 *
 * Reads `<dir>/lineup.json`, `matchup.json` and `waiver-plan.json` (support
 * snapshots) and rebuilds, on whichever code it runs on, each screen's own
 * output from the same inputs:
 *
 *  1. every player's number on Team (the row), Matchup (the card), Waivers
 *     (this week's sheet figure), Trades (this week's rate times share) and
 *     Compare (the card), unrounded, for Alex's roster and the top 30 free
 *     agents the waiver plan scanned;
 *  2. Team's lineup by slot, its swaps (Best move), Matchup's decision and
 *     win probability, and the waiver plan's "Do this" and pick-up-and-start;
 *  3. D4: the slot Compare resolves for each TE and WR pair opened from WR;
 *  4. D5: the projected margin, the posture, and every starter/bench pair
 *     inside 0.6 points with what Compare says about it;
 *  5. D6: the starters' kickoffs and every starter/bench pair within 0.05.
 *
 * Uses only exports the code before the round (41058f5) also has, so
 * `probe-numbers-agree.mjs` can run it on both and diff the two.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { compareStartSit, evaluatePlayer, type StartSitEvaluation, type StartSitInput } from '../src/core/startsit/engine.ts';
import { weekPointsBeforeStatus, weekPointsOf } from '../src/core/startsit/weekPoints.ts';
import { rowFigure } from '../src/web/rowFigure.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { readSnapshot } from '../src/core/support/dispatch.ts';
import { buildMatchupResponse } from '../src/core/matchup/build.ts';
import { snapshotMatchupSources } from '../src/core/support/matchupSnapshot.ts';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';
import { buildPlayerRate } from '../src/core/tradeValue/rate.ts';
import { resolveComparisonSlot } from '../src/core/sleeper/eligibility.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: numbers-agree-report.ts <dir>');
const read = (name: string): any => {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return null;
  }
};
const fmt = (v: number | null | undefined) => (v == null ? '-' : String(Math.round(v * 10000) / 10000));
const section = (title: string) => console.log(`\n######## ${title}`);
async function guarded(title: string, run: () => Promise<void> | void): Promise<void> {
  section(title);
  try {
    await run();
  } catch (err) {
    console.log(`(failed on this code: ${String(err instanceof Error ? err.message : err).slice(0, 300)})`);
  }
}

const lineupRaw = read('lineup.json');
const matchupRaw = read('matchup.json');
const waiverRaw = read('waiver-plan.json');

type Row = { name: string; status: string; team?: number | null; matchup?: number | null; waivers?: number | null; trades?: number | null; compare?: number | null; basis?: string };
const rows = new Map<string, Row>();
const row = (id: string, name: string, status = '') => {
  let r = rows.get(id);
  if (!r) rows.set(id, (r = { name, status }));
  return r;
};

let lineupEvals: StartSitEvaluation[] = [];
let lineupInputs: StartSitInput[] = [];
let published = new Map<string, number>();
let profile: ReturnType<typeof rehydrateLeagueRules>['profile'] | null = null;
let shape: ReturnType<typeof rehydrateLeagueRules>['shape'] | null = null;
let mode: any = 'balanced';
let week = 0;

await guarded('TEAM (lineup snapshot, rebuilt)', () => {
  if (!lineupRaw) return console.log('no lineup snapshot');
  const inputs = lineupRaw.decision.inputs;
  week = lineupRaw.decision?.context?.week ?? lineupRaw.decision?.request?.week ?? 0;
  ({ shape, profile } = rehydrateLeagueRules(inputs.rules));
  lineupInputs = rehydrateStartSitInputs(inputs.startSit);
  published = new Map(Object.entries(inputs.published as Record<string, number>));
  mode = inputs.mode;
  console.log(`captured ${lineupRaw.capturedAt}; mode ${inputs.mode}; posture recorded ${inputs.posture ?? 'none'}`);
  const lineup = assembleLineup({
    inputs: lineupInputs,
    shape: shape!,
    profile: profile!,
    currentStarterIds: inputs.currentStarterIds,
    mode: inputs.mode,
    published,
    unknownPlayers: inputs.unknownPlayers,
    now: lineupRaw.capturedAt,
    ...(inputs.posture ? ({ posture: inputs.posture } as Record<string, unknown>) : {}),
  } as Parameters<typeof assembleLineup>[0]);
  lineupEvals = [...lineup.starters, ...lineup.bench, ...lineup.undecidable] as StartSitEvaluation[];
  for (const e of lineupEvals) {
    const f = rowFigure(weekPointsBeforeStatus(e as never), e as never);
    const r = row(e.playerId, e.name, e.statusFlag?.split('·')[0]?.trim() ?? '');
    r.team = f.kind === 'plain' || f.kind === 'risk' ? f.points : f.kind === 'out' ? 0 : null;
    r.basis = (e as { decision?: { basis?: string } }).decision?.basis ?? 'none';
  }
  console.log('lineup:');
  for (const s of lineup.slots) console.log(`  ${s.slot}: ${s.name ?? '(empty)'}`);
  console.log(`Best move / swaps (${lineup.swaps.length}):`);
  for (const s of lineup.swaps) console.log(`  ${s.slot}: start ${s.inName} over ${s.outName} +${fmt(s.gain)} (${s.reason})`);
  for (const f of lineup.fills) console.log(`  ${f.slot}: fill with ${f.inName} +${fmt(f.gain)}`);
  console.log('starters and their kickoffs (D6):');
  for (const s of lineup.slots) {
    const e = lineupEvals.find((x) => x.playerId === s.playerId);
    console.log(`  ${s.slot}: ${s.name ?? '-'} ${e?.lock?.kickoff ?? '?'}${e?.lock?.locked ? ' (locked)' : ''}`);
  }
});

await guarded('MATCHUP (matchup snapshot, rebuilt)', async () => {
  if (!matchupRaw) return console.log('no matchup snapshot');
  const snapshot = readSnapshot(matchupRaw) as any;
  const { request, output } = snapshot.decision;
  const replayed: any = await buildMatchupResponse(snapshotMatchupSources(snapshot), request.leagueId, {
    week: request.week,
    ...(output.forecast?.seed === undefined ? {} : { seed: output.forecast.seed }),
  } as never);
  const f = replayed.forecast;
  if (!f) return console.log('no forecast');
  console.log(`win probability (mine): ${fmt(f.teams?.mine?.winProbability)}; projected ${fmt(f.teams?.mine?.projectedFinal)} vs ${fmt(f.teams?.theirs?.projectedFinal)}`);
  console.log(`decision: best ${f.decision?.best ? `${f.decision.best.inName} over ${f.decision.best.outName} at ${f.decision.best.slot} +${fmt(f.decision.best.gain)}` : 'none'}; on projection ${f.decision?.onProjection ? `${f.decision.onProjection.inName} over ${f.decision.onProjection.outName}` : 'none'}`);
  const mine = [...(f.slots ?? []).map((s: any) => s.mine).filter(Boolean), ...(f.bench?.mine ?? [])];
  for (const p of mine) {
    const r = row(p.playerId, p.name ?? p.playerId);
    r.matchup = p.projectedFinal ?? null;
    if (p.statusFlag) r.status = r.status || p.statusFlag;
  }
  console.log(`status marks: ${mine.filter((p: any) => p.statusFlag).map((p: any) => `${p.name} ${p.statusFlag}`).join(', ') || 'none'}`);
});

let candidateInputs: StartSitInput[] = [];
await guarded('WAIVERS (waiver-plan snapshot, rebuilt)', async () => {
  if (!waiverRaw) return console.log('no waiver-plan snapshot');
  const snapshot = readSnapshot(waiverRaw) as any;
  const rebuilt = waiverRequestFromSnapshot(snapshot);
  candidateInputs = rebuilt.candidates;
  const plan: any = await assembleWaiverPlan(rebuilt.request);
  const figures = plan.tiers?.weekFigures ?? {};
  for (const [id, f] of Object.entries<any>(figures)) {
    const w = f.weeks?.[0];
    const r = row(id, f.name);
    r.waivers = w == null ? null : w.out ? 0 : w.points;
  }
  const doThis = plan.tiers?.doThis;
  console.log(`Do this: ${doThis ? `${doThis.name} (${doThis.reason}) gain ${fmt(doThis.gain)}` : 'none'}`);
  console.log(`do these: ${(plan.tiers?.doThese ?? []).map((m: any) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);
  console.log(`consider: ${(plan.tiers?.consider ?? []).slice(0, 8).map((m: any) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);
  console.log(`pick up and start: ${JSON.stringify(plan.pickupStart?.moves?.map((m: any) => [m.name, m.verdict, m.gain]) ?? null)}`);
  /* The top 30 free agents by this week's number, through the same rates the planner used. */
  const evals = candidateInputs.map((i) => evaluatePlayer(i, rebuilt.request.profile));
  const weeks = Array.from({ length: Math.max(1, 18 - (week || 7)) }, (_, k) => (week || 7) + k);
  const pub = rebuilt.request.published ?? new Map();
  const rated = evals
    .map((e) => ({ e, rate: buildPlayerRate({ evaluation: e, published: pub, seasonLine: null, weeks, byeWeek: null, byeKnown: false }) }))
    .filter((x) => x.rate.rate != null)
    .sort((a, b) => (b.rate.rate ?? 0) * (b.rate.weekly[0] ?? 1) - (a.rate.rate ?? 0) * (a.rate.weekly[0] ?? 1))
    .slice(0, 30);
  for (const { e, rate } of rated) {
    const r = row(e.playerId, e.name, `FA ${e.statusFlag?.split('·')[0]?.trim() ?? ''}`.trim());
    r.trades = Math.round((rate.rate ?? 0) * (rate.weekly[0] ?? 1) * 10000) / 10000;
  }
  const faIds = rated.map((x) => x.e.playerId);
  const byId = new Map(candidateInputs.map((i) => [i.player.id, i]));
  for (let k = 0; k < faIds.length; k += 8) {
    const cmp = compareStartSit(faIds.slice(k, k + 8).map((id) => byId.get(id)!), rebuilt.request.profile, { published: pub });
    for (const e of cmp.evaluations) row(e.playerId, e.name).compare = weekPointsOf(e as never).points;
  }
});

await guarded('TRADES and COMPARE for the roster', () => {
  if (!profile || lineupInputs.length === 0) return console.log('no lineup inputs');
  const weeks = Array.from({ length: Math.max(1, 18 - (week || 7)) }, (_, k) => (week || 7) + k);
  for (const input of lineupInputs) {
    const e = evaluatePlayer({ ...input, mode: input.mode ?? 'balanced' }, profile);
    const rate = buildPlayerRate({ evaluation: e, published, seasonLine: null, weeks, byeWeek: null, byeKnown: false });
    row(e.playerId, e.name).trades = rate.rate == null ? null : Math.round(rate.rate * (rate.weekly[0] ?? 1) * 10000) / 10000;
  }
  const cmp = compareStartSit(lineupInputs, profile, { published, mode: 'balanced' });
  for (const e of cmp.evaluations) row(e.playerId, e.name).compare = weekPointsOf(e as never).points;
});

section('NUMBERS BY SCREEN (unrounded; - is no number)');
console.log('player | status | basis | Team | Matchup card | Waivers | Trades | Compare | agree');
for (const [id, r] of [...rows.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const shown = [r.team, r.matchup, r.waivers, r.trades, r.compare].filter((v): v is number => v != null);
  const agree = shown.length < 2 ? '' : Math.max(...shown) - Math.min(...shown) < 0.011 ? 'yes' : 'NO';
  console.log(`${r.name} (${id}) | ${r.status} | ${r.basis ?? ''} | ${fmt(r.team)} | ${fmt(r.matchup)} | ${fmt(r.waivers)} | ${fmt(r.trades)} | ${fmt(r.compare)} | ${agree}`);
}

await guarded('D4: Compare slot for TE and WR pairs opened from a WR row', () => {
  if (!shape) return;
  const tes = lineupEvals.filter((e) => e.position === 'TE');
  const wrs = lineupEvals.filter((e) => e.position === 'WR');
  for (const te of tes.slice(0, 2)) {
    for (const wr of wrs.slice(0, 3)) {
      const s = resolveComparisonSlot([te.position, wr.position], shape, 'WR');
      console.log(`  ${te.name} (TE) vs ${wr.name} (WR), opened from WR: slot ${s.slot ?? 'none'}, comparable ${s.comparable}`);
    }
  }
  const q = resolveComparisonSlot(['QB', 'RB'], shape, 'QB');
  console.log(`  QB vs RB opened from QB: slot ${q.slot ?? 'none'}, comparable ${q.comparable}`);
});

await guarded('D5: close calls (0.6 pts) and what Compare says', () => {
  if (!profile || !shape) return;
  const byId = new Map(lineupInputs.map((i) => [i.player.id, i]));
  const week = (e: StartSitEvaluation) => {
    const d = (e as { decision?: { points: number; basis: string } }).decision;
    return d && (d.basis === 'market' || d.basis === 'published') ? d.points : null;
  };
  const starters = lineupEvals.filter((e) => (lineupRaw?.decision?.inputs?.currentStarterIds ?? []).includes(e.playerId));
  const bench = lineupEvals.filter((e) => !starters.includes(e));
  let n = 0;
  for (const s of starters) {
    for (const b of bench) {
      const a = week(s);
      const c = week(b);
      if (a == null || c == null || Math.abs(a - c) > 0.6) continue;
      const slot = resolveComparisonSlot([s.position, b.position], shape, null);
      if (!slot.comparable) continue;
      const cmp: any = compareStartSit([byId.get(s.playerId)!, byId.get(b.playerId)!], profile, { published, mode: 'balanced' });
      console.log(`  ${s.name} ${fmt(a)} [${s.pill?.pill ?? '-'}] vs ${b.name} ${fmt(c)} [${b.pill?.pill ?? '-'}]: ${cmp.tie ? cmp.tie.line : `start ${cmp.evaluations.find((e: any) => e.playerId === cmp.recommendedPlayerId)?.name ?? 'none'}`}${cmp.tiebreak ? ` · ${cmp.tiebreak.sentence}` : ''}`);
      n++;
    }
  }
  if (n === 0) console.log('  no starter/bench pair inside 0.6 points this week');
});

await guarded('D6: starter/bench pairs within 0.05 pts', () => {
  const week = (e: StartSitEvaluation) => (e as { decision?: { points: number } }).decision?.points ?? null;
  let n = 0;
  for (const a of lineupEvals) {
    for (const b of lineupEvals) {
      if (a.playerId >= b.playerId) continue;
      const x = week(a);
      const y = week(b);
      if (x == null || y == null || Math.abs(x - y) > 0.05) continue;
      console.log(`  ${a.name} ${fmt(x)} ${a.lock?.kickoff ?? '?'} and ${b.name} ${fmt(y)} ${b.lock?.kickoff ?? '?'}`);
      n++;
    }
  }
  if (n === 0) console.log('  none: no two players within 0.05 this week');
});
