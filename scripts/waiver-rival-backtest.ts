/**
 * The need-aware rival model against the old one, on every real waiver claim
 * this league has published: this season and the seasons before it.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-rival-backtest.ts <dir> [leagueId]
 *
 * `<dir>` holds Sleeper's public answers, saved by `probe-waiver-round2.mjs`:
 * `players.json`, and for each league in the `previous_league_id` chain
 * `league_<id>.json`, `users_<id>.json`, `rosters_<id>.json`, `picks_<id>.json`,
 * `tx_<id>_<week>.json`, plus `stats_<season>_<week>.json`. Every endpoint is
 * one Sleeper documents, except the weekly stats the app already reads for
 * last week's points.
 *
 * For each awarded claim, the winner is "you" and both models are asked what
 * he should have bid against everyone else, knowing only what was known before
 * that run:
 *
 * - **old**: this season's earlier claims, the seed profiles, last week's
 *   points, a fresh drop of a rated player (the model the screen used);
 * - **new**: each rival's record from earlier seasons and this season's
 *   earlier runs, his roster rebuilt from the draft and every completed
 *   transaction before the run, his byes for the run's week and the next (read
 *   off which defences played), and his FAAB left.
 *
 * Both aim to win three times in four, so the comparison is the rival read
 * alone. Not known historically, and so left out of both: injuries at the time
 * (Sleeper's player file is current only), Sleeper's trending list, and a
 * player's club at the time (today's club is used for byes).
 *
 * Read-only. Prints the claim table and the summary.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { adviseBid, buildRivalProfiles, BID_MODEL, type ClaimRecord, type RivalContext } from '../src/core/waivers/bidModel.ts';
import { seedFor, type BidderStyle } from '../src/core/waivers/managerSeeds.ts';
import { buildRivalSeasonAggregates, blendRivalTendency, type HistoryClaim, type HistoryAdd } from '../src/core/waivers/rivalHistory.ts';
import { positionNeed, type NeedRosterPlayer } from '../src/core/waivers/rivalNeed.ts';

const dir = process.argv[2];
const rootLeague = process.argv[3] ?? '1385016656425668608';
if (!dir) {
  console.error('usage: waiver-rival-backtest.ts <dir> [leagueId]');
  process.exit(1);
}
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const has = (name: string) => existsSync(join(dir, name));

interface Txn {
  type: string;
  status: string;
  leg: number;
  created: number;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  settings: { waiver_bid?: number } | null;
  metadata: { notes?: string } | null;
}
interface League {
  league_id: string;
  season: string;
  previous_league_id: string | null;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  settings: { waiver_budget?: number };
}

const players = read<Record<string, { full_name?: string; first_name?: string; last_name?: string; position?: string; team?: string }>>('players.json');
const positionOf = (id: string): string | null => players[id]?.position ?? (/^[A-Z]{2,3}$/.test(id) ? 'DEF' : null);
const teamOf = (id: string): string => players[id]?.team ?? (/^[A-Z]{2,3}$/.test(id) ? id : '');
const nameOf = (id: string) => players[id]?.full_name ?? (`${players[id]?.first_name ?? ''} ${players[id]?.last_name ?? ''}`.trim() || id);

/* The chain, newest first. */
const chain: League[] = [];
for (let id: string | null = rootLeague; id && id !== '0' && has(`league_${id}.json`); ) {
  const league: League = read<League>(`league_${id}.json`);
  chain.push(league);
  id = league.previous_league_id;
}
chain.reverse();
console.log(`seasons in the previous_league_id chain: ${chain.length} (${chain.map((l) => l.season).join(', ')})`);

/* Who is who: user ids across seasons, display names from the newest season. */
const currentUsers = read<{ user_id: string; display_name: string }[]>(`users_${rootLeague}.json`);
const displayName = new Map(currentUsers.map((u) => [u.user_id, u.display_name]));
const defTeams = Object.entries(players)
  .filter(([, p]) => p.position === 'DEF' && p.team)
  .map(([id]) => id);

interface SeasonData {
  league: League;
  rosterOwner: Map<number, string>;
  txns: Txn[];
  picks: { player_id: string; roster_id: number; pick_no: number }[];
  points: Map<number, Map<string, number>>;
  byes: Map<number, Set<string>>;
  starters: Record<string, number>;
}

const seasons: SeasonData[] = chain.map((league) => {
  const id = league.league_id;
  const rosters = read<{ roster_id: number; owner_id: string }[]>(`rosters_${id}.json`);
  const txns: Txn[] = [];
  for (let w = 1; w <= 18; w++) if (has(`tx_${id}_${w}.json`)) txns.push(...read<Txn[]>(`tx_${id}_${w}.json`));
  txns.sort((a, b) => a.status_updated - b.status_updated);
  const points = new Map<number, Map<string, number>>();
  const byes = new Map<number, Set<string>>();
  for (let w = 1; w <= 18; w++) {
    const file = `stats_${league.season}_${w}.json`;
    if (!has(file)) continue;
    const stats = read<Record<string, Record<string, number>>>(file);
    const m = new Map<string, number>();
    for (const [pid, s] of Object.entries(stats)) {
      let total = 0;
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && league.scoring_settings[k] != null) total += league.scoring_settings[k]! * v;
      if (Math.abs(total) >= 0.05) m.set(pid, Math.round(total * 100) / 100);
    }
    points.set(w, m);
    byes.set(w, new Set(defTeams.filter((t) => !stats[t]?.['gp'])));
  }
  const starters: Record<string, number> = {};
  for (const slot of league.roster_positions) if (['QB', 'RB', 'WR', 'TE', 'DEF'].includes(slot)) starters[slot] = (starters[slot] ?? 0) + 1;
  return {
    league,
    rosterOwner: new Map(rosters.map((r) => [r.roster_id, r.owner_id])),
    txns,
    picks: has(`picks_${id}.json`) ? read(`picks_${id}.json`) : [],
    points,
    byes,
    starters,
  };
});

/* Every claim in the chain, resolved to users, for the history aggregates. */
const allClaims: (HistoryClaim & { rosterId: number })[] = [];
const allAdds: HistoryAdd[] = [];
const seasonsByUser = new Map<string, string[]>();
for (const s of seasons) {
  for (const [, user] of s.rosterOwner) if (user) seasonsByUser.set(user, [...(seasonsByUser.get(user) ?? []), s.league.season]);
  for (const t of s.txns) {
    if (t.status === 'complete' && (t.type === 'free_agent' || t.type === 'waiver')) {
      const user = s.rosterOwner.get(t.roster_ids[0]!);
      if (user) allAdds.push({ season: s.league.season, userId: user, kind: t.type });
    }
    if (t.type !== 'waiver' || (t.status !== 'complete' && t.status !== 'failed')) continue;
    const pid = Object.keys(t.adds ?? {})[0];
    const user = s.rosterOwner.get(t.roster_ids[0]!);
    if (!pid || !user) continue;
    allClaims.push({
      season: s.league.season,
      week: t.leg,
      userId: user,
      rosterId: t.roster_ids[0]!,
      playerId: pid,
      position: positionOf(pid),
      amount: Math.round(t.settings?.waiver_bid ?? 0),
      won: t.status === 'complete',
      voided: /too many players/i.test(t.metadata?.notes ?? ''),
      at: t.status_updated,
    });
  }
}

const styleOf = (userId: string): BidderStyle => seedFor(displayName.get(userId) ?? null)?.style ?? 'chaser';

interface Totals {
  claims: number;
  oldHits: number;
  newHits: number;
  oldRivals: number;
  newRivals: number;
  actualRivals: number;
  paid: number;
  oldPaid: number;
  newPaid: number;
  overpaid: number;
  /** Claims where a real rival bid, and whether the model's top three named one. */
  contested: number;
  oldNamed: number;
  newNamed: number;
}
const blank = (): Totals => ({
  claims: 0, oldHits: 0, newHits: 0, oldRivals: 0, newRivals: 0, actualRivals: 0, paid: 0, oldPaid: 0, newPaid: 0, overpaid: 0,
  contested: 0, oldNamed: 0, newNamed: 0,
});
const bySeason = new Map<string, Totals>();
const lines: string[] = [];
const partsLog: Record<string, number | null>[] = [];

/** Both models' read of one player in one run, for a given "you" (null: nobody). */
function modelsAt(s: SeasonData, at: number, leg: number, playerId: string, mine: number | null) {
  const season = s.league.season;
  const budget = s.league.settings.waiver_budget ?? 100;
  const before = allClaims.filter((c) => c.at < at - 60_000);
  const seats = [...s.rosterOwner.entries()].map(([rosterId, user]) => ({ rosterId, user, name: displayName.get(user) ?? `Roster ${rosterId}` }));

  /* Rosters and FAAB just before the run. */
  const rosters = new Map<number, Set<string>>();
  for (const p of s.picks) rosters.set(p.roster_id, (rosters.get(p.roster_id) ?? new Set()).add(p.player_id));
  const spent = new Map<number, number>();
  for (const t of s.txns) {
    if (t.status_updated >= at - 60_000) break;
    if (t.status !== 'complete') continue;
    for (const [pid, r] of Object.entries(t.drops ?? {})) rosters.get(r)?.delete(pid);
    for (const [pid, r] of Object.entries(t.adds ?? {})) (rosters.get(r) ?? rosters.set(r, new Set()).get(r)!).add(pid);
    if (t.type === 'waiver') spent.set(t.roster_ids[0]!, (spent.get(t.roster_ids[0]!) ?? 0) + (t.settings?.waiver_bid ?? 0));
  }

  const draftPick = new Map(s.picks.map((p) => [p.player_id, p.pick_no]));
  const lastWeek = s.points.get(leg - 1)?.get(playerId) ?? (leg > 1 ? 0 : null);
  const rated = (draftPick.get(playerId) ?? 999) <= 100 || before.some((c) => c.won && c.amount >= 3 && c.playerId === playerId && c.season === season);
  const freshDrop =
    rated && s.txns.some((t) => t.status === 'complete' && t.drops && playerId in t.drops && t.status_updated < at && at - t.status_updated <= 3 * 86_400_000);
  const signals = { lastWeekPoints: lastWeek, trendHeat: null, trendRank: null, roleRising: false, freshDrop };

  /* Old model: this season's earlier claims only. */
  const oldClaims: ClaimRecord[] = before
    .filter((c) => c.season === season)
    .map((c) => ({ rosterId: c.rosterId, playerId: c.playerId, amount: c.amount, won: c.won, voided: c.voided ?? false, run: `week ${c.week}` }));
  const { profiles, targetsPerRun, validClaims } = buildRivalProfiles({
    seats: seats.map((x) => ({ rosterId: x.rosterId, name: x.name, isMine: x.rosterId === mine, style: styleOf(x.user) })),
    claims: oldClaims,
  });
  const old = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 100 });

  /* New model: history to date, need from the rebuilt roster, FAAB left. */
  const aggregates = buildRivalSeasonAggregates({
    claims: before,
    adds: allAdds.filter((a) => Number(a.season) < Number(season)),
    seasonsByUser,
    points: (sn, w) => seasons.find((x) => x.league.season === sn)?.points.get(w) ?? null,
    budgetTotal: budget,
  });
  const position = positionOf(playerId);
  const rivals = new Map<number, RivalContext>();
  for (const seat of seats) {
    if (seat.rosterId === mine) continue;
    const roster: NeedRosterPlayer[] = [...(rosters.get(seat.rosterId) ?? [])].map((pid) => ({
      playerId: pid,
      name: nameOf(pid),
      position: positionOf(pid) ?? '',
      team: teamOf(pid),
      status: null,
    }));
    const need = position
      ? positionNeed({ starters: s.starters, weeks: [leg, leg + 1], roster, onBye: (team, week) => (s.byes.has(week) ? s.byes.get(week)!.has(team) : null) }, position)
      : null;
    rivals.set(seat.rosterId, {
      tendency: blendRivalTendency({ userId: seat.user, style: styleOf(seat.user), aggregates, currentSeason: season }),
      need,
      remaining: Math.max(0, budget - (spent.get(seat.rosterId) ?? 0)),
    });
  }
  const fresh = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining: 100, rivals, position, posture: 'do_this' });
  return { old, fresh, seats, position };
}

/* The fair check: every manager, every player anybody bid on, nobody playing "you". */
interface Calibration { pairs: number; actual: number; oldSum: number; newSum: number; oldBrier: number; newBrier: number; oldLog: number; newLog: number }
const calibration = new Map<string, Calibration>();
const buckets = new Map<string, { n: number; p: number; y: number }>();

for (const s of seasons) {
  const season = s.league.season;
  const T = blank();
  bySeason.set(season, T);
  const seasonClaims = allClaims.filter((c) => c.season === season);
  const C: Calibration = { pairs: 0, actual: 0, oldSum: 0, newSum: 0, oldBrier: 0, newBrier: 0, oldLog: 0, newLog: 0 };
  calibration.set(season, C);

  /* Pass 1: every contested player in every run. */
  const runs: { at: number; leg: number; players: Map<string, Set<number>> }[] = [];
  for (const c of seasonClaims.filter((x) => !x.voided).sort((a, b) => a.at - b.at)) {
    let run = runs.find((r) => Math.abs(r.at - c.at) < 600_000);
    if (!run) runs.push((run = { at: c.at, leg: c.week, players: new Map() }));
    run.players.set(c.playerId, (run.players.get(c.playerId) ?? new Set()).add(c.rosterId));
  }
  for (const run of runs) {
    for (const [playerId, bidders] of run.players) {
      const { old, fresh } = modelsAt(s, run.at, run.leg, playerId, null);
      for (const r of fresh.rivals) {
        const y = bidders.has(r.rosterId) ? 1 : 0;
        const po = old.rivals.find((x) => x.rosterId === r.rosterId)?.chance ?? 0;
        const pn = r.chance;
        C.pairs += 1;
        C.actual += y;
        C.oldSum += po;
        C.newSum += pn;
        C.oldBrier += (po - y) ** 2;
        C.newBrier += (pn - y) ** 2;
        C.oldLog += -Math.log(Math.max(0.01, y ? po : 1 - po));
        C.newLog += -Math.log(Math.max(0.01, y ? pn : 1 - pn));
        const b = pn < 0.05 ? '<5%' : pn < 0.1 ? '5-10%' : pn < 0.2 ? '10-20%' : pn < 0.35 ? '20-35%' : '35%+';
        const k = buckets.get(b) ?? { n: 0, p: 0, y: 0 };
        k.n += 1;
        k.p += pn;
        k.y += y;
        buckets.set(b, k);
        if (process.env.PARTS && r.parts) partsLog.push({ ...r.parts, y, chance: pn });
      }
    }
  }

  /* Pass 2: each awarded claim, the winner as "you", as the old backtest did. */
  for (const win of seasonClaims.filter((c) => c.won && !c.voided)) {
    const { old, fresh, seats, position } = modelsAt(s, win.at, win.week, win.playerId, win.rosterId);
    const inRun = seasonClaims.filter((c) => Math.abs(c.at - win.at) < 60_000);
    const rivalBids = new Map<number, number>();
    for (const c of inRun) {
      if (c.playerId !== win.playerId || c.rosterId === win.rosterId || c.voided) continue;
      rivalBids.set(c.rosterId, Math.max(rivalBids.get(c.rosterId) ?? 0, c.amount));
    }
    const top = rivalBids.size > 0 ? Math.max(...rivalBids.values()) : null;
    const oldHit = top == null || old.recommended > top;
    const newHit = top == null || fresh.recommended > top;
    T.claims += 1;
    T.oldHits += oldHit ? 1 : 0;
    T.newHits += newHit ? 1 : 0;
    T.oldRivals += old.expectedRivals;
    T.newRivals += fresh.expectedRivals;
    T.actualRivals += rivalBids.size;
    T.paid += win.amount;
    T.oldPaid += old.recommended;
    T.newPaid += fresh.recommended;
    T.overpaid += Math.max(0, win.amount - (top == null ? BID_MODEL.minBid : top + 1));
    if (rivalBids.size > 0) {
      T.contested += 1;
      const named = (list: { rosterId: number }[]) => list.slice(0, 3).some((r) => rivalBids.has(r.rosterId));
      T.oldNamed += named(old.rivals) ? 1 : 0;
      T.newNamed += named(fresh.rivals) ? 1 : 0;
    }
    const seatName = (r: number) => seats.find((x) => x.rosterId === r)?.name ?? `Roster ${r}`;
    lines.push(
      `${season} wk${String(win.week).padStart(2)} ${position ?? '?'} ${nameOf(win.playerId).slice(0, 22).padEnd(22)}` +
        ` | won by ${seatName(win.rosterId)} $${win.amount}` +
        ` | rivals: ${rivalBids.size === 0 ? 'none' : [...rivalBids].map(([r, b]) => `${seatName(r)} $${b}`).join(', ')}` +
        ` | old $${old.recommended} ${oldHit ? 'HIT ' : 'MISS'}` +
        ` | new $${fresh.recommended} ${newHit ? 'HIT ' : 'MISS'} top ${fresh.rivals.slice(0, 2).map((r) => `${r.name} ${Math.round(r.chance * 100)}% (${r.why})`).join(', ')}`,
    );
  }
}

console.log(lines.join('\n'));
console.log('');
const all = blank();
for (const [season, T] of bySeason) {
  for (const k of Object.keys(all) as (keyof Totals)[]) all[k] += T[k];
  report(season, T);
}
report('all seasons', all);

console.log('');
console.log('== who bids: every manager on every player anybody bid on (nobody plays "you") ==');
const sum: Calibration = { pairs: 0, actual: 0, oldSum: 0, newSum: 0, oldBrier: 0, newBrier: 0, oldLog: 0, newLog: 0 };
for (const [season, C] of calibration) {
  for (const k of Object.keys(sum) as (keyof Calibration)[]) sum[k] += C[k];
  calibrationLine(season, C);
}
calibrationLine('all seasons', sum);
console.log('  new model, by predicted chance: ' + ['<5%', '5-10%', '10-20%', '20-35%', '35%+'].map((b) => { const k = buckets.get(b); return k ? `${b} said ${(100 * k.p / k.n).toFixed(0)}%, was ${(100 * k.y / k.n).toFixed(0)}% (${k.n})` : `${b} none`; }).join('; '));

function calibrationLine(label: string, C: Calibration) {
  if (C.pairs === 0) return;
  const per = (x: number) => (x / C.pairs).toFixed(3);
  console.log(`  ${label}: ${C.pairs} manager-player pairs, ${C.actual} bids; expected bids old ${C.oldSum.toFixed(0)}, new ${C.newSum.toFixed(0)}; Brier old ${per(C.oldBrier)} new ${per(C.newBrier)}; log loss old ${per(C.oldLog)} new ${per(C.newLog)} (lower is better)`);
}
if (process.env.PARTS) {
  const mean = (k: string) => (partsLog.reduce((s, p) => s + Number(p[k] ?? 0), 0) / partsLog.length).toFixed(3);
  console.log('mean parts:', ['rate', 'interest', 'need', 'pull', 'chase', 'chance', 'y'].map((k) => `${k} ${mean(k)}`).join(' '));
}

function report(label: string, T: Totals) {
  if (T.claims === 0) return;
  console.log(`== ${label}: ${T.claims} awarded claims ==`);
  console.log(`  winning bid at 3 in 4: old ${T.oldHits}/${T.claims}, new ${T.newHits}/${T.claims}`);
  console.log(`  rival bidders: actual ${T.actualRivals}; predicted old ${T.oldRivals.toFixed(1)}, new ${T.newRivals.toFixed(1)}`);
  console.log(`  dollars: winners paid $${T.paid} ($${T.overpaid} above what was needed); old model $${T.oldPaid}, new model $${T.newPaid}`);
  console.log(`  contested claims where the top three named a real rival: old ${T.oldNamed}/${T.contested}, new ${T.newNamed}/${T.contested}`);
}
