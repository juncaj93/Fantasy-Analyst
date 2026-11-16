/** Round 29 freshness: odds look ages at decision moments, and how far numbers moved by kickoff.
 *  node ... freshness.ts <gather.json> */
import { readFileSync } from 'node:fs';
const G = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const h = (ms: number) => (ms / 3_600_000).toFixed(1);
const et = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const slotOf = (iso: string) => {
  const d = new Date(iso);
  const wd = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const hr = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return wd === 'Sun' ? (hr < 15 ? 'Sun 1 PM' : hr < 19 ? 'Sun 4 PM' : 'Sun night') : wd === 'Mon' ? 'Mon night' : wd === 'Thu' ? 'Thu night' : `${wd}`;
};
for (const w of [8, 9, 10, 11]) {
  const games = (G.lookTimes ?? []).filter((g: any) => g.week === w);
  if (!games.length) continue;
  const moments: Record<string, string> = G.meta.moments?.[w] ?? {};
  console.log(`\nweek ${w}: ${games.length} games`);
  const bySlot = new Map<string, any[]>();
  for (const g of games) (bySlot.get(slotOf(g.gameStart)) ?? bySlot.set(slotOf(g.gameStart), []).get(slotOf(g.gameStart))!).push(g);
  for (const [slot, list] of bySlot) {
    const ages: Record<string, number[]> = {};
    const counts: number[] = [];
    const lastGap: number[] = [];
    for (const g of list) {
      const kick = Date.parse(g.gameStart);
      const times = (g.looks as [string, string][]).map(([t]) => Date.parse(t)).sort((a, b) => a - b);
      counts.push(times.filter((t) => t < kick).length);
      const pre = times.filter((t) => t < kick);
      if (pre.length) lastGap.push(kick - pre[pre.length - 1]!);
      for (const [label, at] of [...Object.entries(moments), ['kickoff-15m', new Date(kick - 15 * 60_000).toISOString()]]) {
        const t = Date.parse(at as string);
        if (t >= kick) continue;
        const before = times.filter((x) => x <= t);
        (ages[label] ??= []).push(before.length ? t - before[before.length - 1]! : NaN);
      }
    }
    const med = (xs: number[]) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : NaN; };
    const none = (xs: number[]) => xs.filter((x) => !Number.isFinite(x)).length;
    console.log(`  ${slot.padEnd(10)} ${String(list.length).padStart(2)} games, looks before kickoff: median ${med(counts)} (min ${Math.min(...counts)}, max ${Math.max(...counts)}); last look before kickoff median ${h(med(lastGap))} h`);
    for (const [label, xs] of Object.entries(ages)) console.log(`    age of the newest look at ${label.padEnd(11)}: median ${h(med(xs))} h${none(xs) ? `, ${none(xs)} games with no look yet` : ''}`);
  }
  /* Look times for one game of each slot, to show the clock. */
  for (const [slot, list] of bySlot) {
    const g = list[0];
    const kick = Date.parse(g.gameStart);
    console.log(`    e.g. ${slot} ${g.teams.join(' at ')}: looks at ${(g.looks as [string, string][]).map(([t, k]) => `${h(kick - Date.parse(t))}h${k === 'f' ? '(full)' : ''}`).reverse().join(', ')} before kickoff`);
  }
}
/* How far the number moved from each moment to kickoff (players with a number at both). */
console.log('\nhow far this week\'s number moved by kickoff (same player, number 5+):');
for (const w of Object.keys(G.numbersAsOf ?? {})) {
  const kick = G.numbers?.[w] ?? {};
  for (const [label, m] of Object.entries<any>(G.numbersAsOf[w])) {
    const diffs: number[] = [];
    let flips = 0, priced = 0;
    for (const [id, [v, b]] of Object.entries<any>(m)) {
      const k = kick[id];
      if (!k || k[0] < 5) continue;
      diffs.push(Math.abs(k[0] - v));
      if (b !== k[1]) flips += 1;
      if (k[1] === 'm') priced += 1;
    }
    diffs.sort((a, b) => a - b);
    const q = (p: number) => (diffs.length ? diffs[Math.floor(p * (diffs.length - 1))]!.toFixed(2) : '-');
    console.log(`  week ${w} ${label.padEnd(8)}: ${diffs.length} players, median move ${q(0.5)}, 90th ${q(0.9)}, over 2 points ${diffs.filter((d) => d >= 2).length}; basis changed (Sleeper to Vegas or back) ${flips}`);
  }
}
