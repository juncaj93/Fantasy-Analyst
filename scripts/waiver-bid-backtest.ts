/**
 * The bid model, replayed on this season's real waiver claims.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-bid-backtest.ts <dir>
 *
 * `<dir>` holds Sleeper's public answers for the league, as
 * `scripts/probe-waiver-bid-backtest.mjs` saves them: league.json, users.json,
 * rosters.json, picks.json, schedule.json, tx<week>.json and stats<week>.json.
 *
 * For every run that awarded a player, the model is given only what was known
 * before that run: the claims of earlier runs, the seed profiles, last week's
 * fantasy points in this league's scoring, and whether he was a fresh drop the
 * room drafted early. Sleeper's trending list is not historical, so the backtest
 * runs without it. The winner is treated as "you", and the model is asked what
 * he should have bid against everybody else. The real answer is the highest
 * valid bid from anybody else in that run (Sleeper publishes losing claims).
 *
 * Read-only. Prints a table and a summary.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { adviseBid, buildRivalProfiles, BID_MODEL, type ClaimRecord } from '../src/core/waivers/bidModel.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: waiver-bid-backtest.ts <dir>');
  process.exit(1);
}
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

interface Txn {
  type: string;
  status: string;
  leg: number;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  settings: { waiver_bid?: number } | null;
  metadata: { notes?: string } | null;
}

const league = read<{ scoring_settings: Record<string, number> }>('league.json');
const users = read<{ user_id: string; display_name: string }[]>('users.json');
const rosters = read<{ roster_id: number; owner_id: string }[]>('rosters.json');
const picks = read<{ pick_no: number; player_id: string }[]>('picks.json');
const schedule = read<{ week: number; date: string }[]>('schedule.json');
const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));
const seats = rosters.map((r) => ({ rosterId: r.roster_id, name: nameOf.get(r.owner_id) ?? `Roster ${r.roster_id}` }));
const draftPick = new Map(picks.map((p) => [p.player_id, p.pick_no]));
const scoring = league.scoring_settings;

const txns: Txn[] = [];
for (let w = 1; w <= 18; w++) if (existsSync(join(dir, `tx${w}.json`))) txns.push(...read<Txn[]>(`tx${w}.json`));
const points = new Map<number, Map<string, number>>();
for (let w = 1; w <= 18; w++) {
  if (!existsSync(join(dir, `stats${w}.json`))) continue;
  const stats = read<Record<string, Record<string, number>>>(`stats${w}.json`);
  const m = new Map<string, number>();
  for (const [id, s] of Object.entries(stats)) {
    let total = 0;
    for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && scoring[k] != null) total += scoring[k]! * v;
    if (Math.abs(total) >= 0.05) m.set(id, Math.round(total * 100) / 100);
  }
  points.set(w, m);
}
/* The last day of each week's games, for "had last week's games finished". */
const weekEnd = new Map<number, string>();
for (const g of schedule) if (!weekEnd.has(g.week) || g.date > weekEnd.get(g.week)!) weekEnd.set(g.week, g.date);

/* One run a week: the preseason's daily runs and a Friday run fold into their week. */
const runKey = (leg: number) => `week ${leg}`;
const claims: (ClaimRecord & { at: number; leg: number })[] = [];
for (const t of txns) {
  if (t.type !== 'waiver' || (t.status !== 'complete' && t.status !== 'failed')) continue;
  const playerId = Object.keys(t.adds ?? {})[0];
  if (!playerId) continue;
  claims.push({
    rosterId: t.roster_ids[0]!,
    playerId,
    amount: Math.round(t.settings?.waiver_bid ?? 0),
    won: t.status === 'complete',
    voided: /too many players/i.test(t.metadata?.notes ?? ''),
    run: runKey(t.leg),
    at: t.status_updated,
    leg: t.leg,
  });
}
const drops: { playerId: string; at: number }[] = [];
/* Players somebody paid $3 or more for, and when: a fresh drop of one is a known target. */
const paidFor = claims.filter((c) => c.won && c.amount >= 3).map((c) => ({ playerId: c.playerId, at: c.at }));
for (const t of txns) {
  if (t.status !== 'complete') continue;
  for (const id of Object.keys(t.drops ?? {})) drops.push({ playerId: id, at: t.status_updated });
}

const runs = [...new Set(claims.map((c) => c.run))].sort();
/* Names from Sleeper's player dictionary, when it was saved beside the rest. */
const dictionary = existsSync(join(dir, 'players.json'))
  ? read<Record<string, { first_name?: string; last_name?: string }>>('players.json')
  : {};
const playerName = (id: string) => {
  const p = dictionary[id];
  return p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || id : id;
};
const rows: string[] = [];
let hits = 0;
let misses = 0;
let predictedRivals = 0;
let actualRivals = 0;
let overpaid = 0;
let paid = 0;
let modelPaid = 0;
const detail: { hit: boolean; line: string }[] = [];

for (const run of runs) {
  const winners = claims.filter((c) => c.run === run && c.won);
  for (const win of winners) {
    /* Each claim on its own clock: a Friday run is not the Wednesday run. */
    const at = win.at;
    const before = claims.filter((c) => c.at < at);
    /* The contest is the claims Sleeper processed in the same minute. */
    const inRun = claims.filter((c) => Math.abs(c.at - at) < 60_000);
    const leg = win.leg;
    const runDate = new Date(at).toISOString().slice(0, 10);
    const pointsWeek = (weekEnd.get(leg) ?? '9999') < runDate ? leg : leg - 1;
    const lastWeekPoints = pointsWeek >= 1 ? (points.get(pointsWeek)?.get(win.playerId) ?? 0) : null;
    const rated =
      (draftPick.get(win.playerId) ?? 999) <= 100 || paidFor.some((p) => p.playerId === win.playerId && p.at < at);
    const freshDrop = rated && drops.some((d) => d.playerId === win.playerId && d.at < at && at - d.at <= 3 * 86_400_000);

    const { profiles, targetsPerRun, validClaims } = buildRivalProfiles({
      seats: seats.map((s) => ({ ...s, isMine: s.rosterId === win.rosterId })),
      claims: before,
    });
    const advice = adviseBid({
      signals: { lastWeekPoints, trendHeat: null, trendRank: null, roleRising: false, freshDrop },
      profiles,
      targetsPerRun,
      validClaims,
      remaining: 100,
    });
    const rivalBids = new Map<number, number>();
    for (const c of inRun) {
      if (c.playerId !== win.playerId || c.rosterId === win.rosterId || c.voided) continue;
      rivalBids.set(c.rosterId, Math.max(rivalBids.get(c.rosterId) ?? 0, c.amount));
    }
    const top = rivalBids.size > 0 ? Math.max(...rivalBids.values()) : null;
    const hit = top == null ? true : advice.recommended > top;
    if (hit) hits++;
    else misses++;
    predictedRivals += advice.expectedRivals;
    actualRivals += rivalBids.size;
    paid += win.amount;
    const needed = top == null ? BID_MODEL.minBid : top + 1;
    overpaid += Math.max(0, win.amount - needed);
    modelPaid += advice.recommended;
    const winner = seats.find((s) => s.rosterId === win.rosterId)?.name ?? '?';
    const rivalsText =
      rivalBids.size === 0
        ? 'none'
        : [...rivalBids.entries()].map(([r, b]) => `${seats.find((s) => s.rosterId === r)?.name ?? r} $${b}`).join(', ');
    const line =
      `${run}  wk${leg}  ${playerName(win.playerId).padEnd(22)} last wk ${lastWeekPoints == null ? '  -  ' : lastWeekPoints.toFixed(1).padStart(5)}${freshDrop ? ' fresh-drop' : ''}` +
      `  | won by ${winner} $${win.amount}  | rivals: ${rivalsText}` +
      `  | model: $${advice.recommended} (likely $${advice.low}-${advice.high}), ${advice.expectedRivals.toFixed(2)} rivals expected` +
      `  | ${hit ? 'HIT' : 'MISS'}`;
    detail.push({ hit, line });
  }
}

for (const d of detail) rows.push(d.line);
console.log(rows.join('\n'));
console.log('');
console.log(`awarded claims replayed: ${hits + misses}`);
console.log(`model bid would have won: ${hits}; would have lost: ${misses}`);
console.log(`rival bidders: predicted ${predictedRivals.toFixed(1)} in all, actual ${actualRivals}`);
console.log(`winners paid $${paid} in all; $${overpaid} of it above what was needed to win`);
console.log(`the model's bids total $${modelPaid}`);
