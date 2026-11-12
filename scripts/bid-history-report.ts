/**
 * This league's waiver bid history, reduced to the small table the bid rule
 * reads (`src/core/faab/leagueBidHistory.ts`), plus the backtest of that rule
 * against Alex's own claims. Round 20, 11 November 2026.
 *
 *   SLEEPER_LEAGUE_ID=<id> node --experimental-transform-types --no-warnings \
 *     scripts/bid-history-report.ts [--cache <dir>] [--write]
 *
 * Reads Sleeper's documented endpoints only: the league and its
 * `previous_league_id` chain, each season's rosters, transactions and
 * matchups by week, and the player list once (for positions). One call at a
 * time with a pause between, and every answer cached in `--cache` so a re-run
 * asks again for nothing. The league id is a secret (this repository is
 * public), so it is read from the environment and never written down.
 *
 * `--write` rewrites the summary file. Nothing here touches the database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { smartBid } from '../src/core/faab/smartBid.ts';
import type { BidHistorySummary, PriceRow } from '../src/core/faab/leagueBidHistory.ts';

const args = process.argv.slice(2);
const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1]! : fs.mkdtempSync('/tmp/bid-history-');
const write = args.includes('--write');
const root = process.env.SLEEPER_LEAGUE_ID;
if (!root) {
  console.error('Set SLEEPER_LEAGUE_ID.');
  process.exit(1);
}

let calls = 0;
async function get<T>(p: string): Promise<T> {
  const file = path.join(cacheDir, `${p.replace(/\//g, '_')}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  await new Promise((r) => setTimeout(r, 350));
  calls++;
  const res = await fetch(`https://api.sleeper.app/v1/${p}`);
  if (!res.ok) throw new Error(`${p}: ${res.status}`);
  const json = (await res.json()) as T;
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

interface League { season: string; status: string; previous_league_id?: string | null; settings?: { waiver_budget?: number } }
interface Roster { roster_id: number; owner_id: string; settings: { waiver_budget_used?: number } }
interface Txn { type: string; status: string; leg: number; status_updated: number; roster_ids: number[]; adds?: Record<string, number> | null; settings?: { waiver_bid?: number } | null; metadata?: { notes?: string } | null }
interface Matchup { roster_id: number; points?: number; starters?: string[]; players?: string[]; players_points?: Record<string, number> }

/** One player somebody won in one run, with every bid on him. */
interface Target {
  season: string;
  week: number;
  playerId: string;
  name: string;
  position: string;
  bidders: number;
  win: number;
  winner: number;
  /** The highest bid by anybody else; null when nobody else bid. */
  second: number | null;
  alexBid: number | null;
  alexWon: boolean;
  /** Weeks the winner started him, the rest of the season, and the points he scored in them. */
  startedWeeks: number;
  startedPoints: number;
  /** At least two weeks of games after the claim are on record, so his tier is known. */
  tierKnown: boolean;
}

const SEASON_WEIGHT = [1, 0.6, 0.36];

async function main() {
  const chain: { id: string; league: League }[] = [];
  for (let id: string | null | undefined = root; id && id !== '0'; ) {
    const league: League = await get<League>(`league/${id}`);
    chain.push({ id, league });
    id = league.previous_league_id;
  }
  const players = await playersSlim();
  const current = chain[0]!;
  const currentRosters = await get<Roster[]>(`league/${current.id}/rosters`);
  const alexOwner = currentRosters.find((r) => r.roster_id === 1)?.owner_id;

  const targets: Target[] = [];
  let claimCount = 0;
  const weeksBySeason: Record<string, number> = {};
  for (const { id, league } of chain) {
    const live = league.status === 'in_season';
    const rosters = await get<Roster[]>(`league/${id}/rosters`);
    const alex = rosters.find((r) => r.owner_id === alexOwner)?.roster_id ?? null;
    /* This season: claims through next week's run, games through this week, played weeks only. */
    const week = live ? await currentWeek() : 17;
    const lastTxnWeek = live ? Math.min(18, week + 1) : 18;
    const matchups = new Map<number, Map<number, Matchup>>();
    for (let w = 1; w <= week; w++) {
      const m = await get<Matchup[]>(`league/${id}/matchups/${w}`);
      if (m.some((x) => (x.points ?? 0) > 0)) matchups.set(w, new Map(m.map((x) => [x.roster_id, x])));
    }
    const lastGames = Math.max(0, ...matchups.keys());
    weeksBySeason[league.season] = live ? lastGames : 17;

    const claims: { week: number; at: number; roster: number; playerId: string; bid: number; won: boolean }[] = [];
    for (let w = 1; w <= lastTxnWeek; w++) {
      for (const t of await get<Txn[]>(`league/${id}/transactions/${w}`)) {
        if (t.type !== 'waiver') continue;
        claimCount++;
        const playerId = Object.keys(t.adds ?? {})[0];
        /* A claim Sleeper voided for a full roster never competed. */
        if (!playerId || (t.metadata?.notes ?? '').includes('too many players')) continue;
        claims.push({ week: t.leg, at: t.status_updated, roster: t.roster_ids[0]!, playerId, bid: t.settings?.waiver_bid ?? 0, won: t.status === 'complete' });
      }
    }
    claims.sort((a, b) => a.at - b.at);
    /* Claims processed within ten minutes of each other, in the same week, are one run. */
    const runs: (typeof claims)[] = [];
    for (const c of claims) {
      const last = runs[runs.length - 1];
      if (last && c.at - last[last.length - 1]!.at < 600_000 && last[0]!.week === c.week) last.push(c);
      else runs.push([c]);
    }
    for (const run of runs) {
      const byPlayer = new Map<string, typeof claims>();
      for (const c of run) byPlayer.set(c.playerId, [...(byPlayer.get(c.playerId) ?? []), c]);
      for (const [playerId, cs] of byPlayer) {
        const winner = cs.find((c) => c.won);
        if (!winner) continue;
        const per = new Map<number, number>();
        for (const c of cs) per.set(c.roster, Math.max(per.get(c.roster) ?? 0, c.bid));
        const others = [...per].filter(([r]) => r !== winner.roster).map(([, b]) => b);
        const week = run[0]!.week;
        let startedWeeks = 0;
        let startedPoints = 0;
        for (let w = week; w <= lastGames; w++) {
          const m = matchups.get(w)?.get(winner.roster);
          if (m?.starters?.includes(playerId)) {
            startedWeeks++;
            startedPoints += m.players_points?.[playerId] ?? 0;
          }
        }
        const meta = players[playerId];
        targets.push({
          season: league.season,
          week,
          playerId,
          name: meta?.[0] ?? playerId,
          position: /^\d+$/.test(playerId) ? (meta?.[1] ?? '?') : 'DEF',
          bidders: per.size,
          win: winner.bid,
          winner: winner.roster,
          second: others.length > 0 ? Math.max(...others) : null,
          alexBid: alex != null && per.has(alex) ? per.get(alex)! : null,
          alexWon: winner.roster === alex,
          startedWeeks,
          startedPoints: Math.round(startedPoints * 10) / 10,
          tierKnown: lastGames - week + 1 >= 2,
        });
      }
    }
  }

  const seasons = chain.map((c) => c.league.season);
  const weightOf = (season: string, only?: readonly string[]) =>
    only ? 1 : (SEASON_WEIGHT[seasons.indexOf(season)] ?? 0.2);
  const summary = summarise(targets, seasons, weightOf, claimCount, weeksBySeason);

  report(targets, summary, currentRosters);
  backtest(targets, seasons);
  console.log(`\nSleeper calls this run: ${calls} (cache: ${cacheDir})`);
  if (write) {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/core/faab/leagueBidHistory.ts');
    fs.writeFileSync(file, renderSummary(summary));
    console.log(`Wrote ${file}`);
  }
}

async function currentWeek(): Promise<number> {
  const state = await get<{ leg: number; week: number }>('state/nfl');
  return state.leg ?? state.week;
}

async function playersSlim(): Promise<Record<string, [string, string | null]>> {
  const slim = path.join(cacheDir, 'players_slim.json');
  if (fs.existsSync(slim)) return JSON.parse(fs.readFileSync(slim, 'utf8'));
  const all = await get<Record<string, { full_name?: string; first_name?: string; last_name?: string; position?: string }>>('players/nfl');
  const out: Record<string, [string, string | null]> = {};
  for (const [id, p] of Object.entries(all)) out[id] = [p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(), p.position ?? null];
  fs.writeFileSync(slim, JSON.stringify(out));
  fs.rmSync(path.join(cacheDir, 'players_nfl.json'), { force: true });
  return out;
}

/** What it took to win him: one dollar over the next-highest bid, or $0 with nobody else. */
const priceToWin = (t: Target) => (t.second == null ? 0 : t.second + 1);
const tierOf = (t: Target): 'starter' | 'depth' => (t.startedWeeks >= 2 ? 'starter' : 'depth');

function weightedQuantile(values: { v: number; w: number }[], p: number): number {
  const xs = [...values].sort((a, b) => a.v - b.v);
  const total = xs.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of xs) {
    acc += x.w;
    if (acc >= p * total - 1e-9) return x.v;
  }
  return xs[xs.length - 1]?.v ?? 0;
}

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DEF'];

function priceTable(rows: Target[], weightOf: (season: string) => number): Record<string, PriceRow> {
  const out: Record<string, PriceRow> = {};
  for (const pos of [...POSITIONS, 'ALL']) {
    const mine = rows.filter((t) => pos === 'ALL' || t.position === pos);
    const contested = mine.filter((t) => t.second != null).map((t) => ({ v: priceToWin(t), w: weightOf(t.season) }));
    if (mine.length === 0) continue;
    out[pos] = {
      claims: mine.length,
      contested: contested.length,
      p50: contested.length ? weightedQuantile(contested, 0.5) : 1,
      p75: contested.length ? weightedQuantile(contested, 0.75) : 1,
      paidMedian: median(mine.filter((t) => t.second != null).map((t) => t.win)),
      won: wonAt(contested),
    };
  }
  return out;
}

/** `[dollars, share]` at each step: the weighted share of contested players that many dollars would have won. */
function wonAt(values: { v: number; w: number }[]): [number, number][] {
  const total = values.reduce((s, x) => s + x.w, 0);
  if (total === 0) return [[1, 1]];
  const out: [number, number][] = [];
  for (const v of [...new Set(values.map((x) => x.v))].sort((a, b) => a - b)) {
    const share = values.filter((x) => x.v <= v).reduce((s, x) => s + x.w, 0) / total;
    out.push([v, Math.round(share * 100) / 100]);
  }
  return out;
}

function summarise(
  targets: Target[],
  seasons: string[],
  weightOf: (season: string) => number,
  claims: number,
  weeks: Record<string, number>,
): BidHistorySummary {
  const known = targets.filter((t) => t.tierKnown);
  /* Price per point: what a paid pickup ($3 or more) cost per point he scored in the weeks he started, complete seasons only. */
  const complete = targets.filter((t) => t.season !== seasons[0] && t.win >= 3 && t.startedPoints > 0);
  const pricePerPoint = Math.round(median(complete.map((t) => t.win / t.startedPoints)) * 100) / 100;
  return {
    generated: new Date().toISOString().slice(0, 10),
    seasons: [...seasons].reverse(),
    weeks,
    claims,
    playersWon: targets.length,
    contested: targets.filter((t) => t.second != null).length,
    wonAtZeroOrOne: Math.round((targets.filter((t) => t.win <= 1).length / targets.length) * 100) / 100,
    pricePerPoint,
    minContested: 8,
    starter: priceTable(known.filter((t) => tierOf(t) === 'starter'), weightOf),
    depth: priceTable(known.filter((t) => tierOf(t) === 'depth'), weightOf),
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function report(targets: Target[], s: BidHistorySummary, rosters: Roster[]) {
  console.log(`Seasons ${s.seasons.join(', ')}; weeks ${JSON.stringify(s.weeks)}; ${s.claims} claims, ${s.playersWon} players won, ${s.contested} contested.`);
  console.log(`Won at $0 or $1: ${Math.round(s.wonAtZeroOrOne * 100)}%. Price per point: $${s.pricePerPoint}.`);
  for (const tier of ['starter', 'depth'] as const) {
    for (const [pos, r] of Object.entries(s[tier])) {
      console.log(`${tier.padEnd(8)}${pos.padEnd(4)} claims ${String(r.claims).padStart(3)}  contested ${String(r.contested).padStart(3)}  wins it: half the time $${r.p50}, 3 in 4 $${r.p75}  (winners paid $${r.paidMedian})`);
    }
  }
  for (const [label, lo, hi] of [['weeks 1-4', 1, 4], ['weeks 5-8', 5, 8], ['weeks 9-13', 9, 13], ['weeks 14-17', 14, 18]] as const) {
    const rows = targets.filter((t) => t.week >= lo && t.week <= hi);
    const c = rows.filter((t) => t.second != null);
    console.log(`${label}: ${rows.length} won, typical $${median(rows.map((t) => t.win))}, $0-1 ${Math.round((rows.filter((t) => t.win <= 1).length / Math.max(1, rows.length)) * 100)}%, contested price to win $${median(c.map(priceToWin))}`);
  }
  const contested = targets.filter((t) => t.second != null);
  const far = contested.filter((t) => t.win - t.second! >= 5);
  console.log(`Top bid $5+ over second: ${far.length} of ${contested.length} contested. Dollars paid over second+1: $${contested.reduce((a, t) => a + Math.max(0, t.win - t.second! - 1), 0)}.`);
  const left = rosters.map((r) => ({ roster: r.roster_id, left: 100 - (r.settings.waiver_budget_used ?? 0) }));
  console.log(`FAAB left now: ${left.map((l) => `#${l.roster} $${l.left}`).join(', ')}`);
  for (const price of [1, 5, 10, 20, 28, 48]) {
    console.log(`  rivals who can bid $${price} or more: ${left.filter((l) => l.roster !== 1 && l.left >= price).length} of ${left.length - 1}`);
  }
}

/**
 * The rule against the past, season by season, with that season left out of
 * the table it reads.
 *
 * - **Alex's claims.** His bid is the old number. A bid of $3 or more is a
 *   player he meant to start, so the new rule bids the league's "Do this"
 *   price for the position; under $3 it is a stash, $1. No gain or rival read
 *   exists for past weeks, so the value cap and the "nobody else" $0 are not
 *   applied: they would only lower the new number.
 * - **Every contested starter.** Had the new "Do this" price been bid on each
 *   starter-level player somebody else also wanted, how often it beats every
 *   other bid, and what it costs against what the winner paid.
 */
function backtest(targets: Target[], seasons: string[]) {
  console.log('\nBacktest (each season priced from the other seasons only)');
  const all = { n: 0, wins: 0, newCost: 0, paid: 0 };
  for (const season of seasons) {
    const others = targets.filter((t) => t.season !== season && t.tierKnown);
    const table: BidHistorySummary = {
      generated: '', seasons: [], weeks: {}, claims: 0, playersWon: 0, contested: 0, wonAtZeroOrOne: 0,
      pricePerPoint: 1, minContested: 8,
      starter: priceTable(others.filter((t) => tierOf(t) === 'starter'), () => 1),
      depth: priceTable(others.filter((t) => tierOf(t) === 'depth'), () => 1),
    };
    const newBid = (t: Target, starter: boolean) =>
      smartBid({ kind: starter ? 'do_this' : 'stash', position: t.position, gain: null, expectedRivals: null, spendable: null, history: table }).bid;

    const mine = targets.filter((t) => t.season === season && t.alexBid != null);
    let kept = 0, lostNow = 0, gained = 0, saved = 0, extra = 0, won = 0;
    const starters = { oldWon: 0, oldSpent: 0, newWon: 0, newSpent: 0 };
    const lines: string[] = [];
    for (const t of mine) {
      const old = t.alexBid!;
      const nb = newBid(t, old >= 3);
      const otherBest = t.alexWon ? t.second : t.win;
      const newWins = otherBest == null ? true : nb > otherBest;
      if (t.alexWon) {
        won++;
        if (newWins) {
          kept++;
          saved += Math.max(0, old - nb);
          extra += Math.max(0, nb - old);
        } else lostNow++;
      } else if (newWins) {
        gained++;
        extra += nb;
      }
      if (old >= 3) {
        if (t.alexWon) (starters.oldWon++, (starters.oldSpent += old));
        if (newWins) (starters.newWon++, (starters.newSpent += nb));
        lines.push(`  wk ${String(t.week).padStart(2)} ${t.position.padEnd(3)} ${t.name.padEnd(24)} old $${old} ${t.alexWon ? 'won ' : 'lost'}  new $${nb} ${newWins ? 'wins ' : 'loses'} (${t.alexWon ? (t.second == null ? 'nobody else bid' : `next bid $${t.second}`) : `winner paid $${t.win}`})`);
      }
    }
    console.log(`${season} Alex: ${mine.length} claims, ${won} won. New rule keeps ${kept}, loses ${lostNow}, adds ${gained}. Saved $${saved} on kept wins; $${extra} more where it bids higher (mostly $1 stashes he bid $0 on).`);
    console.log(`${season} players he meant to start (bid $3+): old won ${starters.oldWon} for $${starters.oldSpent}; new wins ${starters.newWon} for $${starters.newSpent}.`);
    for (const l of lines) console.log(l);

    const contested = targets.filter((t) => t.season === season && t.tierKnown && tierOf(t) === 'starter' && t.second != null);
    let wins = 0, newCost = 0, paid = 0;
    for (const t of contested) {
      const nb = newBid(t, true);
      if (nb > t.second!) {
        wins++;
        newCost += nb;
        paid += t.win;
      }
    }
    all.n += contested.length;
    all.wins += wins;
    all.newCost += newCost;
    all.paid += paid;
    console.log(`${season} every contested starter: the new price wins ${wins} of ${contested.length}; on those it costs $${newCost} where the winners paid $${paid}.`);
  }
  console.log(`All seasons, contested starters: wins ${all.wins} of ${all.n} (${Math.round((all.wins / Math.max(1, all.n)) * 100)}%), $${all.newCost} against $${all.paid} paid.`);
}

function renderSummary(s: BidHistorySummary): string {
  const row = (r: PriceRow) =>
    `{ claims: ${r.claims}, contested: ${r.contested}, p50: ${r.p50}, p75: ${r.p75}, paidMedian: ${r.paidMedian}, won: ${JSON.stringify(r.won)} }`;
  const table = (t: Record<string, PriceRow>) =>
    `{\n${Object.entries(t).map(([k, r]) => `    ${k}: ${row(r)},`).join('\n')}\n  }`;
  return `/**
 * This league's waiver bid history, reduced to what the bid rule reads
 * (\`smartBid.ts\`). Written by \`scripts/bid-history-report.ts --write\` from
 * Sleeper's documented endpoints; re-run it to refresh. No database rows: the
 * screen reads this file.
 *
 * - **p50 / p75**: of the players somebody else also bid on, the bid that would
 *   have beaten every other bid (the next-highest bid plus $1), half the time
 *   and three times in four. Seasons weigh 1, 0.6 and 0.36 from the newest.
 * - **Starter**: the winner started him in two or more weeks after the claim.
 *   Depth: fewer. Claims too recent to tell are left out of both.
 * - **won**: \`[dollars, share]\`: of those contested players, the share that
 *   many dollars would have won (weighted the same way). The bid rule reads it.
 * - **paidMedian**: what the winners actually paid for those contested players.
 * - **pricePerPoint**: the median dollars a paid pickup ($3 or more) cost per
 *   point he scored in the weeks he started, complete seasons only.
 * - A position with fewer than \`minContested\` contested claims uses ALL.
 */

export interface PriceRow {
  claims: number;
  contested: number;
  p50: number;
  p75: number;
  paidMedian: number;
  /** \`[dollars, share]\`, ascending: the share of contested players that many dollars would have won. */
  won: [number, number][];
}

export interface BidHistorySummary {
  generated: string;
  seasons: string[];
  /** Weeks of each season read. */
  weeks: Record<string, number>;
  /** Every waiver claim read, won, lost or voided. */
  claims: number;
  playersWon: number;
  /** Players won where somebody else also bid. */
  contested: number;
  /** Share of players won for $0 or $1. */
  wonAtZeroOrOne: number;
  pricePerPoint: number;
  minContested: number;
  starter: Record<string, PriceRow>;
  depth: Record<string, PriceRow>;
}

export const LEAGUE_BID_HISTORY: BidHistorySummary = {
  generated: '${s.generated}',
  seasons: ${JSON.stringify(s.seasons)},
  weeks: ${JSON.stringify(s.weeks).replace(/"(\d+)":/g, "'$1': ")},
  claims: ${s.claims},
  playersWon: ${s.playersWon},
  contested: ${s.contested},
  wonAtZeroOrOne: ${s.wonAtZeroOrOne},
  pricePerPoint: ${s.pricePerPoint},
  minContested: ${s.minContested},
  starter: ${table(s.starter)},
  depth: ${table(s.depth)},
};
`;
}

await main();
