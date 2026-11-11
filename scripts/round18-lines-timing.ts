/**
 * Round 18: when do a game's lines first show up, by game day?
 *
 *   node --experimental-transform-types --no-warnings scripts/round18-lines-timing.ts
 *
 * Read-only (production D1 through `scripts/lib/d1Http.ts`, which refuses
 * anything that is not a SELECT). The odds clock asks about a game at fixed
 * checkpoints before kickoff (48, 24, 6, 3, 1.5 and 0.5 hours,
 * `KICKOFF_CHECKPOINT_HOURS`), so "first seen" is the first checkpoint that
 * came back with lines, not the minute the books posted them. Older weeks
 * keep only each game's final copy (`trimOldRows.ts`), so only the games still
 * holding several copies say anything about timing; the rest are counted and
 * left out.
 *
 * Game days, by kickoff in Eastern time: Thursday, Sunday early (before
 * 3:00 PM), Sunday late (3:00 PM to 7:00 PM), Sunday night, Monday, and other
 * (Friday, Saturday, abroad).
 */

import { d1Http } from './lib/d1Http.ts';

const db = await d1Http();
const season = process.env.SEASON || String(new Date().getUTCFullYear());

type Snap = { id: number; event_id: string; game_start: string; fetched_at: string; total: number | null; props: number };
const snaps = (
  await db
    .prepare(
      `SELECT ps.id, ps.event_id, ps.game_start, ps.fetched_at,
              json_extract(ps.raw_json, '$.gameLines.total') AS total,
              (SELECT COUNT(*) FROM player_props pp WHERE pp.snapshot_id = ps.id) AS props
         FROM prop_snapshots ps
        WHERE ps.scope = 'week' AND ps.game_start >= ?`,
    )
    .bind(`${season}-08-25`)
    .all<Snap>()
).results;

const eastern = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
};
const gameDay = (kickoff: string): string => {
  const { day, hour } = eastern(kickoff);
  if (day === 'Thu') return 'Thursday';
  if (day === 'Mon') return 'Monday';
  if (day === 'Sun') return hour < 15 ? 'Sunday early' : hour < 19 ? 'Sunday late' : 'Sunday night';
  return 'Other (Fri, Sat, abroad)';
};
const fmtE = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

const byEvent = new Map<string, Snap[]>();
for (const s of snaps) (byEvent.get(s.event_id) ?? byEvent.set(s.event_id, []).get(s.event_id)!).push(s);

interface Game { day: string; kickoff: string; copies: number; earliest: number; propsAt: number | null; totalAt: number | null; emptyBefore: number }
const games: Game[] = [];
let finalOnly = 0;
for (const list of byEvent.values()) {
  const pre = list.filter((s) => s.fetched_at < s.game_start).sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
  if (pre.length === 0) continue;
  const kickoff = pre[0]!.game_start;
  const hoursBefore = (s: Snap) => (Date.parse(kickoff) - Date.parse(s.fetched_at)) / 3_600_000;
  if (pre.length < 2) {
    finalOnly++;
    continue;
  }
  const firstProps = pre.find((s) => Number(s.props) > 0);
  const firstTotal = pre.find((s) => s.total != null);
  games.push({
    day: gameDay(kickoff),
    kickoff,
    copies: pre.length,
    earliest: hoursBefore(pre[0]!),
    propsAt: firstProps ? hoursBefore(firstProps) : null,
    totalAt: firstTotal ? hoursBefore(firstTotal) : null,
    emptyBefore: firstProps ? pre.filter((s) => s.fetched_at < firstProps.fetched_at && Number(s.props) === 0).length : pre.length,
  });
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const h = (x: number | null) => (x == null ? '-' : `${x.toFixed(1)}h`);

console.log(`games with several pre-kickoff copies: ${games.length}; games with only a final copy (trimmed, no timing): ${finalOnly}`);
console.log('game day | games | earliest copy (median) | player lines first seen, hours before kickoff (median, range) | game total first seen (median) | games whose first copy had no player lines');
for (const day of ['Thursday', 'Sunday early', 'Sunday late', 'Sunday night', 'Monday', 'Other (Fri, Sat, abroad)']) {
  const g = games.filter((x) => x.day === day);
  if (g.length === 0) {
    console.log(`${day} | 0`);
    continue;
  }
  const props = g.map((x) => x.propsAt).filter((x): x is number => x != null);
  const totals = g.map((x) => x.totalAt).filter((x): x is number => x != null);
  console.log(
    `${day} | ${g.length} | ${h(median(g.map((x) => x.earliest)))} | ${h(median(props))} (${h(props.length ? Math.min(...props) : null)} to ${h(props.length ? Math.max(...props) : null)}; never ${g.length - props.length}) | ${h(median(totals))} | ${g.filter((x) => x.emptyBefore > 0).length}`,
  );
}
console.log('\nper game (kickoff Eastern | copies | first copy | player lines first | total first):');
for (const g of games.sort((a, b) => a.kickoff.localeCompare(b.kickoff))) {
  console.log(`  ${fmtE(g.kickoff)} ${g.day} | ${g.copies} | ${h(g.earliest)} | ${h(g.propsAt)} | ${h(g.totalAt)}`);
}
console.log(`\nlines timing rows read: ${db.rowsRead()}`);
