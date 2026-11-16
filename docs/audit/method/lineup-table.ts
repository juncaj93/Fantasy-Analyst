/**
 * Line up one player-week across every in-season screen, from saved JSON responses.
 * No network, no database: reads a directory the probe filled and applies the same
 * display functions the web client applies (rowFigure, weekPointsOf, toFixed, round1).
 *
 *   cd /home/user/Fantasy-Analyst && node --experimental-transform-types --no-warnings \
 *     <scratchpad>/agreement/lineup-table.ts <dir> [playerId,playerId,...]
 *
 * Files read when present (names as in TRACE.md section 7):
 *   roster.json lineup.json waivers.json matchup.json pool-mine.json pool-waivers.json
 *   players-board.json players-card-<id>.json compare-<a>-<b>.json trades-check-<give>-<get>.json
 * With no id list it takes Alex's whole roster plus pickupStart and tier free agents.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rowFigure } from '/home/user/Fantasy-Analyst/src/web/rowFigure.ts';
import { weekPointsBeforeStatus, weekPointsOf } from '/home/user/Fantasy-Analyst/src/core/startsit/weekPoints.ts';

type Json = Record<string, any>;
const dir = process.argv[2];
if (!dir) throw new Error('usage: lineup-table.ts <dir> [ids]');
const read = (name: string): Json | null => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
const files = readdirSync(dir);

const roster = read('roster.json');
const lineup = read('lineup.json');
const waivers = read('waivers.json');
const matchup = read('matchup.json');
const poolMine = read('pool-mine.json');
const poolWaivers = read('pool-waivers.json');
const board = read('players-board.json');
const compares = files.filter((f) => f.startsWith('compare-')).map((f) => read(f)!);
const checks = files.filter((f) => f.startsWith('trades-check-')).map((f) => read(f)!);

const evals: Json[] = lineup ? [...(lineup.starters ?? []), ...(lineup.bench ?? []), ...(lineup.undecidable ?? [])] : [];
const evalOf = (id: string) => evals.find((e) => e.playerId === id);
const rosterRows: Json[] = roster ? [...(roster.starters ?? []), ...(roster.bench ?? [])] : [];
const mRows: Json[] = matchup?.forecast
  ? [...matchup.forecast.slots.flatMap((s: Json) => [s.mine, s.theirs]).filter(Boolean), ...matchup.forecast.bench.mine, ...matchup.forecast.bench.theirs]
  : [];
const poolRows: Json[] = [...(poolMine?.rows ?? []), ...(poolWaivers?.rows ?? [])];

const ids =
  process.argv[3]?.split(',').filter(Boolean) ??
  [
    ...new Set([
      ...rosterRows.map((r) => r.playerId),
      ...(waivers?.pickupStart?.start ? [waivers.pickupStart.start.playerId] : []),
      ...(waivers?.pickupStart?.consider ?? []).map((m: Json) => m.playerId),
      ...[...(waivers?.tiers?.doThese ?? []), ...(waivers?.tiers?.consider ?? [])].slice(0, 5).map((r: Json) => r.playerId),
    ]),
  ];

const t1 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(1));
const r1 = (v: number | null | undefined) => (v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1));
const figText = (f: ReturnType<typeof rowFigure> | null) =>
  f == null ? '?' : f.kind === 'none' ? '-' : f.kind === 'out' ? `${f.label}(${t1(f.was)})` : t1(f.points);
const weekText = (w: Json | null | undefined) => (w == null ? '?' : w.out ? 'Out' : t1(w.points));

const header = [
  'player', 'pos', 'sleeperChip', 'merged', 'basis', 'lock',
  'TeamRow', 'TeamCard', 'BestMove', 'Pool', 'Compare', 'MatchupRow', 'MatchupChip', 'MatchupCard',
  'WaiverWk0', 'PlayersCard', 'TradeRate', 'TradeRate*wk0', 'rosValue', 'P.value', 'P.overFA', 'P.injury',
];
console.log(header.join(' | '));
for (const id of ids) {
  const e = evalOf(id);
  const rr = rosterRows.find((r) => r.playerId === id);
  const pool = poolRows.find((r) => r.id === id);
  const m = mRows.find((p) => p.playerId === id);
  const card = matchup?.cards?.[id];
  const w0 = waivers?.tiers?.weekFigures?.[id]?.weeks?.[0];
  const cmp = compares.flatMap((c) => c.evaluations ?? []).find((x: Json) => x.playerId === id);
  const pc = read(`players-card-${id}.json`);
  const line = checks.flatMap((c) => [...(c.evaluation?.a?.outgoing ?? []), ...(c.evaluation?.a?.incoming ?? [])]).find((p: Json) => p.playerId === id);
  const brow = board?.rows?.find((r: Json) => r.id === id);
  const name = e?.name ?? rr?.name ?? pool?.name ?? m?.fullName ?? brow?.name ?? id;
  const cells = [
    `${name} (${id})`,
    e?.position ?? rr?.position ?? pool?.position ?? '',
    rr?.status ?? pool?.status ?? brow?.status ?? '',
    e?.injury?.designation ?? '?',
    e?.decision?.basis ?? '?',
    e?.lock?.locked ? 'locked' : '',
    figText(e ? rowFigure(weekPointsBeforeStatus(e as never), e as never) : null),
    e ? t1(e.projection) : '?',
    e ? weekText(weekPointsOf(e as never)) : '?',
    weekText(pool?.week),
    cmp ? weekText(weekPointsOf(cmp as never)) : '?',
    m ? t1(m.projectedFinal) : '?',
    m ? (m.statusFlag ?? '') : '?',
    card ? t1(card.score) : '?',
    w0 ? (w0.out ? 'Out' : w0.bye ? 'BYE' : `${t1(w0.points)}${w0.fromWeek ? `(wk${w0.fromWeek})` : ''}`) : '?',
    pc ? (pc.thisWeek?.out ? 'Out' : r1(pc.thisWeek?.points)) : '?',
    line ? t1(line.rate) : '?',
    line ? t1((line.rate ?? 0) * (line.weekly?.[0] ?? 1)) : '?',
    line ? t1(line.rosValue) : '?',
    brow ? t1(brow.value) : '?',
    brow ? t1(brow.overFreeAgent) : '?',
    brow ? (brow.injury ? `out, back wk${brow.injury.backWeek ?? '?'}` : '') : '?',
  ];
  console.log(cells.join(' | '));
}

console.log('\nPicks:');
for (const s of lineup?.swaps ?? []) console.log(`  Team swap ${s.slot}: start ${s.inName} over ${s.outName} +${s.gain}`);
for (const t of lineup?.tossUps ?? []) console.log(`  Team toss-up ${t.slot}: lean ${t.inName} over ${t.outName}${t.leanTag ? ` (${t.leanTag})` : ''}${t.waitingOnLine ? ' [No line yet]' : ''}`);
for (const f of lineup?.fills ?? []) console.log(`  Team fill ${f.slot}: ${f.inName} +${f.gain}`);
if (waivers?.pickupStart?.start) console.log(`  Pick up and start: ${waivers.pickupStart.start.name} ${waivers.pickupStart.start.points} +${waivers.pickupStart.start.gain}`);
for (const c of compares) {
  const names = (c.evaluations ?? []).map((x: Json) => x.name).join(' vs ');
  const pick = c.recommendedPlayerId ? (c.evaluations ?? []).find((x: Json) => x.playerId === c.recommendedPlayerId)?.name : null;
  console.log(`  Compare ${names} [mode ${c.mode}, slot ${c.slot?.slot ?? '-'} comparable ${c.slot?.comparable}]: ${pick ? `Start ${pick}` : c.tossUp ? `${c.tossUp.waitingOnLine ? 'No line yet' : 'Toss-up'}, lean ${c.tossUp.leanName}${c.tossUp.leanTag ? ` (${c.tossUp.leanTag})` : ''}` : 'no pick'}`);
}
for (const r of [...(waivers?.tiers?.doThese ?? []), ...(waivers?.tiers?.consider ?? [])]) console.log(`  Waivers ${r.tier}: ${r.name} +${r.gain} (${r.reasonCode})`);
