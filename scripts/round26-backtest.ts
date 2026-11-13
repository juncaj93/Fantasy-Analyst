/**
 * Round 26 backtest: would the Opportunity finder and the look-ahead have
 * picked well this season?
 *
 * Reads only `docs/backtest/round16-data.json` (weeks 1 to 9 of this season,
 * captured from production on 10 November 2026 by `probe-round16-backtest.mjs`):
 * league points by week, clubs by week, the injury report by week, every
 * roster by week, byes and Sleeper's weekly projections. No database read.
 *
 * A. Opportunity. Every long absence of a starter this season: a QB, RB, WR
 *    or TE who met the starter bar over his last four games, then missed at
 *    least three straight games (or the rest of the stored weeks). The saved
 *    file has no IR flag, so the replay marks him IR on the week he first
 *    missed, which is what Sleeper showed by the waiver run that week. Plus
 *    every club change in the file (a trade). The real function
 *    (`findOpportunities`) runs on what was known then: points through the
 *    week before, the rosters of that week. A lead is good when he finished
 *    top 20 at his position in that week or the next.
 *
 * B. Look-ahead. Alex's roster each week from 3 to 8, the real hole and cover
 *    functions on Sleeper's projections for the next three weeks, byes from
 *    the schedule. A cover is good when it outscored the player Alex would
 *    otherwise have started in that slot that week.
 *
 *   node --experimental-transform-types --no-warnings scripts/round26-backtest.ts
 */

import { readFileSync } from 'node:fs';
import { findOpportunities, OPPORTUNITY, type OpportunityPlayer } from '../src/core/waivers/opportunity.ts';
import { coverPickups, rosterHoles, type AheadCandidate, type AheadPlayer } from '../src/core/waivers/lookAhead.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { bestLineup, slotsOf } from '../src/core/tradeValue/lineup.ts';

type Data = {
  meta: { myRosterId: number; rosterPositions: string[]; lastPlayed: number };
  players: Record<string, [string, string, string]>;
  actual: Record<string, Record<string, number>>;
  proj: Record<string, Record<string, number>>;
  clubs: Record<string, [number, string][]>;
  byes: Record<string, number[]>;
  injuries: Record<string, Record<string, string>>;
  rosters: Record<string, Record<string, string[]>>;
};

const d = JSON.parse(readFileSync(new URL('../docs/backtest/round16-data.json', import.meta.url), 'utf8')) as Data;
const LAST = d.meta.lastPlayed; // 9
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const pts = (id: string, w: number) => d.actual[String(w)]?.[id] ?? 0;
const pos = (id: string) => d.players[id]?.[1] ?? '';
const name = (id: string) => d.players[id]?.[0] ?? id;
const clubAt = (id: string, w: number): string => {
  const list = d.clubs[id] ?? [];
  let club = d.players[id]?.[2] ?? '';
  for (const [week, team] of list) if (week <= w) club = team;
  /* A player with no row before w: his first known club. */
  if (list.length > 0 && list[0]![0] > w) club = list[0]![1];
  return club;
};
const onBye = (team: string, w: number) => (d.byes[team] ?? []).includes(w);
const rosteredAt = (w: number) => new Set(Object.values(d.rosters[String(Math.min(w, 10))] ?? {}).flat());

/** Rank of a score at a position in one week, 1 best. */
function rankAt(id: string, w: number): number {
  const p = pos(id);
  const mine = pts(id, w);
  if (mine === 0) return 999;
  return Object.entries(d.actual[String(w)] ?? {}).filter(([o, v]) => pos(o) === p && v > mine).length + 1;
}

// ------------------------------------------------------------ A. Opportunity

interface Case { id: string; week: number; cause: 'season' | 'traded'; from?: string }
const cases: Case[] = [];
const recent4 = (id: string, through: number) => {
  const g: number[] = [];
  for (let w = through; w >= 1 && g.length < 4; w--) if (pts(id, w) !== 0) g.push(pts(id, w));
  return { ppg: g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0, games: g.length };
};
for (const id of Object.keys(d.players)) {
  if (!SKILL.has(pos(id))) continue;
  for (let w = 3; w <= LAST; w++) {
    const before = recent4(id, w - 1);
    if (before.games < OPPORTUNITY.minGames || before.ppg < (OPPORTUNITY.starterPoints[pos(id)] ?? 99)) continue;
    if (pts(id, w - 1) === 0 && pts(id, w - 2) === 0) continue;
    const club = clubAt(id, w - 1);
    if (onBye(club, w)) continue;
    /* Missed w and the next two games of his club (or every stored week after). */
    let missed = 0;
    let span = 0;
    for (let x = w; x <= LAST && span < 3; x++) {
      if (onBye(club, x)) continue;
      span++;
      if (pts(id, x) === 0) missed++;
    }
    if (span > 0 && missed === span && (span >= 3 || w + span - 1 >= LAST)) {
      cases.push({ id, week: w, cause: 'season' });
      break;
    }
  }
  const list = d.clubs[id] ?? [];
  for (let i = 1; i < list.length; i++) {
    if (list[i]![1] !== list[i - 1]![1]) cases.push({ id, week: list[i]![0], cause: 'traded', from: list[i - 1]![1] });
  }
}

/* The upside stash's bar (`upsideStash.ts`): would he start in Alex's best lineup at that number? Alex's players at Sleeper's number that week, else his last four games. */
const shapeA = buildRosterShape(d.meta.rosterPositions);
const slotsA = slotsOf(shapeA).filter((s) => [...s.eligible].some((p) => p !== 'DEF' && p !== 'K'));
function startsForAlex(id: string, estimate: number, week: number): boolean {
  const mine = (d.rosters[String(week)]?.[String(d.meta.myRosterId)] ?? []).filter((x) => SKILL.has(pos(x)));
  const pool = mine.map((x) => ({ id: x, position: pos(x), value: d.proj[String(week)]?.[x] ?? recent4(x, week - 1).ppg }));
  return bestLineup(slotsA, [...pool, { id, position: pos(id), value: estimate }]).picks.some((p) => p?.id === id);
}
const shownWeek = new Map<number, { estimate: number; line: string; good: boolean; full: boolean }>();
let shownAll = 0;
let shownGood = 0;
const shownLines: string[] = [];

const lines: string[] = [];
let tried = 0;
let leadsAll = 0;
let goodAll = 0;
const topPicks: { week: number; lead: string; good: boolean }[] = [];
const byWeek = new Map<number, Case[]>();
for (const c of cases) byWeek.set(c.week, [...(byWeek.get(c.week) ?? []), c]);
for (const [week, list] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
  const through = week - 1;
  const players: OpportunityPlayer[] = Object.keys(d.players).map((id) => ({
    id,
    fullName: name(id),
    team: clubAt(id, through),
    position: pos(id),
    active: true,
  }));
  const seasonPoints = new Map(Object.keys(d.players).map((id) => [id, Array.from({ length: through }, (_, i) => pts(id, i + 1))] as const));
  const notes = new Map<string, { status: string | null; bodyPart: string | null; notes: string | null }>();
  const moved = new Map<string, { from: string; to: string; week: number }>();
  /* That week's injury report, as the live screen reads it: an Out or Doubtful backup inherits nothing. */
  for (const [id, status] of Object.entries(d.injuries[String(week)] ?? {})) notes.set(id, { status, bodyPart: null, notes: null });
  for (const c of list) {
    if (c.cause === 'season') notes.set(c.id, { status: 'IR', bodyPart: null, notes: null });
    else {
      moved.set(c.id, { from: c.from!, to: clubAt(c.id, week), week });
      /* He plays for the new club from this week. */
      players.find((p) => p.id === c.id)!.team = clubAt(c.id, week);
    }
  }
  const leads = findOpportunities({
    week,
    players,
    rosteredIds: rosteredAt(week),
    depthOrder: new Map(),
    injuryNotes: notes,
    seasonPoints,
    through,
    moved,
    onBye,
  }).filter((l) => list.some((c) => c.id === l.vacancy.playerId));
  tried += list.length;
  for (const c of list) {
    const mine = leads.filter((l) => l.vacancy.playerId === c.id);
    const desc = `${name(c.id)} (${pos(c.id)}, ${c.cause === 'season' ? 'out for good' : `traded from ${c.from}`}, week ${week})`;
    if (mine.length === 0) {
      lines.push(`  wk ${week} ${desc}: no free-agent lead`);
      continue;
    }
    for (const l of mine) {
      const ranks = [rankAt(l.playerId, week), rankAt(l.playerId, week + 1)];
      const good = ranks.some((r) => r <= 20);
      leadsAll++;
      if (good) goodAll++;
      if (startsForAlex(l.playerId, l.estimate, week)) {
        shownAll++;
        if (good) shownGood++;
        const best = shownWeek.get(week);
        if (!best || l.estimate > best.estimate) shownWeek.set(week, { estimate: l.estimate, line: `wk ${week} ${l.name} (${l.reason})`, good, full: week + 1 <= LAST });
        shownLines.push(`  wk ${week}: ${l.name} (${l.reason}) est ${l.estimate}, rank ${ranks.map((r) => (r === 999 ? '-' : r)).join(' / ')} -> ${good ? 'GOOD' : 'miss'}`);
      }
      lines.push(
        `  wk ${week} ${desc}: ${l.name} est ${l.estimate} (own ${l.own}, ${l.basis}), scored ${pts(l.playerId, week)} / ${pts(l.playerId, week + 1)}, rank ${ranks.map((r) => (r === 999 ? '-' : r)).join(' / ')} -> ${good ? 'GOOD' : 'miss'}`,
      );
    }
  }
  const top = leads[0];
  if (top) topPicks.push({ week, lead: `${top.name} for ${top.vacancy.name}`, good: [rankAt(top.playerId, week), rankAt(top.playerId, week + 1)].some((r) => r <= 20) });
}

console.log('A. OPPORTUNITY');
console.log(`  cases tried: ${tried} (${cases.filter((c) => c.cause === 'season').length} long absences, ${cases.filter((c) => c.cause === 'traded').length} trades)`);
console.log(lines.join('\n'));
console.log(`  leads: ${leadsAll}, good (top 20 at the position in that week or the next): ${goodAll}`);
console.log(`  top pick each week: ${topPicks.map((t) => `wk ${t.week} ${t.lead} ${t.good ? 'GOOD' : 'miss'}`).join('; ')}`);
console.log(`  top picks good: ${topPicks.filter((t) => t.good).length} of ${topPicks.length}`);
console.log(`  shown to Alex (would start in his best lineup, the stash bar):`);
console.log(shownLines.join('\n') || '  none');
console.log(`  leads passing the bar: ${shownAll}, good: ${shownGood}`);
const picks = [...shownWeek.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
console.log(`  the one stash shown each week (best lead passing the bar):`);
for (const p of picks) console.log(`    ${p.line} -> ${p.good ? 'GOOD' : 'miss'}${p.full ? '' : ' (only one week to judge)'}`);
console.log(`  shown picks good: ${picks.filter((p) => p.good).length} of ${picks.length}`);

// ------------------------------------------------------------ B. Look-ahead

const shape = buildRosterShape(d.meta.rosterPositions);
const excluded = new Set(['DEF', 'K']);
const slots = slotsOf(shape).filter((s) => [...s.eligible].some((p) => !excluded.has(p)));
let covers = 0;
let coversGood = 0;
let holesSeen = 0;
const bLines: string[] = [];
for (let w = 3; w <= 8; w++) {
  const weeks = [w, w + 1, w + 2].filter((x) => x <= 10);
  const mine = d.rosters[String(w)]?.[String(d.meta.myRosterId)] ?? [];
  const status = (id: string, x: number) => (x === w ? d.injuries[String(w)]?.[id] : undefined);
  const asPlayer = (id: string): AheadPlayer => {
    const club = clubAt(id, w - 1);
    const bye = (d.byes[club] ?? []).find((b) => weeks.includes(b)) ?? null;
    return {
      playerId: id,
      name: name(id),
      position: pos(id),
      team: club,
      rate: d.proj[String(w)]?.[id] ?? null,
      weekly: weeks.map((x) => (onBye(club, x) ? 0 : ['Out', 'Doubtful'].includes(status(id, x) ?? '') ? 0 : 1)),
      weekValues: weeks.map((x) => d.proj[String(x)]?.[id] ?? null),
      byeWeek: bye,
    };
  };
  const roster = mine.filter((id) => SKILL.has(pos(id))).map(asPlayer);
  const taken = rosteredAt(w);
  const candidates: AheadCandidate[] = Object.keys(d.players)
    .filter((id) => SKILL.has(pos(id)) && !taken.has(id))
    .map((id) => ({ ...asPlayer(id), free: false }));
  const holes = rosterHoles({ shape, roster, weeks, excludedPositions: excluded });
  holesSeen += holes.length;
  const picked = coverPickups({
    shape,
    roster,
    weeks,
    excludedPositions: excluded,
    candidates,
    leadWeeks: 1,
    taken: new Set(),
    covered: new Set(),
    room: [{ kind: 'open' }, { kind: 'open' }],
    spendable: 28,
    usesFaab: true,
  });
  for (const c of picked) {
    covers++;
    /* What Alex would have started in that slot that week: the actual best lineup without the cover. */
    const k = weeks.indexOf(c.week);
    const actualOf = (p: AheadPlayer) => ({ id: p.playerId, position: p.position, value: (p.weekly[k] ?? 1) * pts(p.playerId, c.week) });
    const before = bestLineup(slots, roster.map(actualOf)).total;
    const after = bestLineup(slots, [...roster.map(actualOf), actualOf(asPlayer(c.playerId))]).total;
    const good = after - before > 0;
    if (good) coversGood++;
    bLines.push(`  wk ${w}: ${c.name} (${c.reason}), bid ${c.bid.kind === 'claim' ? `$${c.bid.high}` : c.bid.kind}; scored ${pts(c.playerId, c.week)}, lineup +${(after - before).toFixed(1)} -> ${good ? 'GOOD' : 'miss'}`);
  }
  for (const h of holes) bLines.push(`    hole wk ${h.week} ${h.position} (${h.cause}${h.missing ? `, ${h.missing.name}` : ''}), loss ${h.loss}`);
}
console.log('\nB. LOOK-AHEAD (Alex, weeks 3 to 8)');
console.log(bLines.join('\n'));
console.log(`  holes found: ${holesSeen}; covers recommended: ${covers}; good: ${coversGood}`);
