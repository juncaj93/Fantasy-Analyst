/**
 * Round 29 accuracy: start/sit picks replayed against what happened.
 *   node --experimental-transform-types --no-warnings lineups.ts <data.json> <fromWeek> <toWeek> [partialWeek]
 * For each week: Alex's real lineup, the app's lineup (best legal lineup on
 * the ranking number, Out and Doubtful benched), and the hindsight best.
 * Then every slot where the app and Alex differ, and the toss-up calibration.
 */
import { readFileSync } from 'node:fs';
const repo = '/home/user/Fantasy-Analyst';
const { bestLineup, slotsOf } = await import(`${repo}/src/core/tradeValue/lineup.ts`);
const { buildRosterShape } = await import(`${repo}/src/core/sleeper/rosterShape.ts`);
const { rankingNumber } = await import(`${repo}/src/core/startsit/decisionPoints.ts`);
const { TOSSUP_POINTS, WIDE_TOSSUP_POINTS } = await import(`${repo}/src/core/startsit/tossup.ts`);

const D = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const FROM = Number(process.argv[3]);
const TO = Number(process.argv[4]);
const PARTIAL = process.argv[5] ? Number(process.argv[5]) : null; // a week still being played
const ME = String(D.meta.myRosterId);
const shape = buildRosterShape(D.meta.rosterPositions);
const slots = slotsOf(shape);
const pos = (id: string) => D.players[id]?.[1] ?? '';
const name = (id: string) => D.players[id]?.[0] ?? id;
const team = (id: string) => D.players[id]?.[2] ?? '';
const actual = (id: string, w: number): number | null => {
  const a = D.actual[String(w)]?.[id];
  if (a != null) return a;
  const live = D.livePoints?.[String(w)]?.[id];
  return live ?? 0;
};
/* Week W's games that had not finished when the data was gathered (partial week only). */
const unfinished = new Set<string>();
if (PARTIAL != null && D.fixtures) {
  const gathered = Date.parse(D.meta.generatedAt);
  for (const [w, t, , kick] of D.fixtures) if (w === PARTIAL && kick && Date.parse(kick) + 3.6 * 3_600_000 > gathered) unfinished.add(t);
}
const status = (id: string, w: number) => String(D.injuries?.[String(w)]?.[id] ?? '').toLowerCase();
const out = (id: string, w: number) => ['out', 'doubtful', 'ir', 'injured reserve'].includes(status(id, w));
const num = (id: string, w: number): { r: number; borrowed: boolean } | null => {
  const n = D.numbers?.[String(w)]?.[id];
  if (!n) return null;
  return { r: rankingNumber(n[0], n[1] === 'p'), borrowed: n[1] === 'p' };
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
let tot = { alex: 0, app: 0, best: 0, weeks: 0 };
const swaps: { w: number; slot: string; app: string; alex: string; gap: number; wide: boolean; diff: number }[] = [];
for (let w = FROM; w <= TO; w++) {
  const roster: string[] = D.rosters?.[String(w)]?.[ME] ?? [];
  const startersAlex: string[] = D.starters?.[String(w)]?.[ME] ?? [];
  if (roster.length === 0) { console.log(`week ${w}: no roster`); continue; }
  const skill = roster.filter((id) => ['QB', 'RB', 'WR', 'TE'].includes(pos(id)));
  const skip = (id: string) => PARTIAL === w && unfinished.has(team(id));
  /* The app's lineup on the ranking number; players with no number count as 0 (unrankable). */
  const cands = skill.map((id) => ({ id, position: pos(id), value: out(id, w) ? 0 : Math.max(0, num(id, w)?.r ?? 0) }));
  const skillSlots = slots.filter((s: any) => ['QB', 'RB', 'WR', 'TE'].some((p) => s.eligible.has(p)));
  const app = bestLineup(skillSlots, cands);
  const appIds = app.picks.filter(Boolean).map((p: any) => p.id);
  const alexIds = startersAlex.filter((id) => ['QB', 'RB', 'WR', 'TE'].includes(pos(id)));
  const best = bestLineup(skillSlots, skill.map((id) => ({ id, position: pos(id), value: Math.max(0, actual(id, w) ?? 0) })));
  const bestIds = best.picks.filter(Boolean).map((p: any) => p.id);
  const sum = (ids: string[]) => ids.reduce((s, id) => s + (actual(id, w) ?? 0), 0);
  const anyUnfinished = [...appIds, ...alexIds].some(skip);
  const a = sum(alexIds), p = sum(appIds), b = sum(bestIds);
  console.log(`week ${w}${PARTIAL === w ? ' (partial)' : ''}: Alex ${f1(a)} | app ${f1(p)} (${p - a >= 0 ? '+' : ''}${f1(p - a)}) | hindsight best ${f1(b)}${anyUnfinished ? ' [some players still to play]' : ''}`);
  if (!anyUnfinished) { tot.alex += a; tot.app += p; tot.best += b; tot.weeks += 1; }
  const onlyApp = appIds.filter((id: string) => !alexIds.includes(id));
  const onlyAlex = alexIds.filter((id) => !appIds.includes(id));
  for (const id of onlyApp) {
    /* Pair with the Alex starter at a shared position (same slot family), closest number. */
    const mate = onlyAlex.filter((x) => pos(x) === pos(id) || (['RB', 'WR', 'TE'].includes(pos(x)) && ['RB', 'WR', 'TE'].includes(pos(id))))
      .sort((x, y) => Math.abs((num(x, w)?.r ?? 0) - (num(id, w)?.r ?? 0)) - Math.abs((num(y, w)?.r ?? 0) - (num(id, w)?.r ?? 0)))[0];
    if (!mate) continue;
    onlyAlex.splice(onlyAlex.indexOf(mate), 1);
    const gap = (num(id, w)?.r ?? 0) - (out(mate, w) ? 0 : (num(mate, w)?.r ?? 0));
    const wide = !!num(id, w)?.borrowed;
    const diff = (actual(id, w) ?? 0) - (actual(mate, w) ?? 0);
    swaps.push({ w, slot: pos(id), app: id, alex: mate, gap, wide, diff });
    const toss = gap < (wide ? WIDE_TOSSUP_POINTS : TOSSUP_POINTS);
    console.log(`   app starts ${name(id)} ${f1(num(id, w)?.r ?? NaN)}${wide ? 'p' : ''} over Alex's ${name(mate)} ${f1(out(mate, w) ? 0 : num(mate, w)?.r ?? NaN)}${status(mate, w) ? ` (${status(mate, w)})` : ''}: gap ${f1(gap)}${toss ? ' toss-up' : ''}; real ${f1(actual(id, w) ?? NaN)} vs ${f1(actual(mate, w) ?? NaN)} -> ${diff > 0 ? 'app right' : diff < 0 ? 'Alex right' : 'even'}${skip(id) || skip(mate) ? ' [not finished]' : ''}`);
  }
}
console.log(`\ntotal over ${tot.weeks} complete weeks: Alex ${f1(tot.alex)}, app ${f1(tot.app)} (${tot.app - tot.alex >= 0 ? '+' : ''}${f1(tot.app - tot.alex)}), hindsight best ${f1(tot.best)}`);
const real = swaps.filter((s) => s.gap >= (s.wide ? WIDE_TOSSUP_POINTS : TOSSUP_POINTS));
const toss = swaps.filter((s) => !real.includes(s));
const score = (xs: typeof swaps) => `${xs.length} calls, app right ${xs.filter((s) => s.diff > 0).length}, Alex right ${xs.filter((s) => s.diff < 0).length}, net ${f1(xs.reduce((t, s) => t + s.diff, 0))} pts`;
console.log(`differences that clear the toss-up bar: ${score(real)}`);
console.log(`differences inside the toss-up bar: ${score(toss)}`);

/* Calibration: same position, same week, every pair of players with a number who played. */
const buckets = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 99]];
const res = buckets.map(() => ({ n: 0, win: 0, margin: 0 }));
for (let w = FROM; w <= TO; w++) {
  const nums = Object.entries(D.numbers?.[String(w)] ?? {}) as [string, [number, string]][];
  for (const P of ['QB', 'RB', 'WR', 'TE']) {
    const list = nums.filter(([id]) => pos(id) === P && !out(id, w) && (actual(id, w) ?? 0) !== 0 && !(PARTIAL === w && unfinished.has(team(id))))
      .map(([id, [n, b]]) => ({ id, r: rankingNumber(n, b === 'p'), a: actual(id, w) ?? 0 }))
      .filter((x) => x.r >= 5);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [hi, lo] = list[i]!.r >= list[j]!.r ? [list[i]!, list[j]!] : [list[j]!, list[i]!];
      const gap = hi.r - lo.r;
      const k = buckets.findIndex(([x, y]) => gap >= x! && gap < y!);
      if (k < 0) continue;
      res[k]!.n += 1;
      if (hi.a > lo.a) res[k]!.win += 1;
      res[k]!.margin += hi.a - lo.a;
    }
  }
}
console.log(`\ncalibration, weeks ${FROM} to ${TO} (same position and week, both played, number 5+):`);
buckets.forEach(([x, y], k) => console.log(`  gap ${x} to ${y === 99 ? 'up' : y}: higher number won ${res[k]!.n ? Math.round((100 * res[k]!.win) / res[k]!.n) : '-'}% of ${res[k]!.n}, average margin ${res[k]!.n ? (res[k]!.margin / res[k]!.n).toFixed(2) : '-'}`));
