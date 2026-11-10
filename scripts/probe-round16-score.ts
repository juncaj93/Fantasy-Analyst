/**
 * Round 16: the rest-of-season value backtest, from a gathered file only.
 *
 *   node --experimental-transform-types --no-warnings scripts/probe-round16-score.ts docs/backtest/round16-data.json [summary.json]
 *
 * No network, no database. The file comes from `probe-round16-gather.ts`.
 *
 * For each week W from 3 to 8 it values every player as the app would have at
 * the start of week W (points from weeks 1 to W-1 only, this week's number as
 * the screens read it), and compares that value with what he really scored
 * per game played in weeks W to the last finished week. Then:
 *
 *  1. Six rules on the same players: the current 50/50 blend, projection only,
 *     season average only, projection 25% and 75%, last three games. Average
 *     miss in points per game, bias, and rank correlation, by position, for
 *     starter-level players (top 24 QB, 36 RB and WR, 12 TE under any rule).
 *  2. The noise: every difference is bootstrapped by player (2,000 draws), so
 *     a gap smaller than its 90% interval is not a real difference.
 *  3. Decisions: the waiver planner (`planWaiverTiers`) and Build a trade
 *     (`buildTradePackages`) run on each week's rebuilt rosters and values, and
 *     each "Do this", "Worth considering" and top trade is scored on what
 *     happened next (points added to Alex's best lineup, in hindsight).
 *  4. The quirks: the minus-2 for a Sleeper-only number, the 2.0 toss-up bar,
 *     the bye-cover moves, and whether quarterbacks want another weight.
 *
 * Two versions of the projection half, because neither is exactly what the
 * app had. Sleeper's projections for later weeks were not stored as they
 * stood at week W; the stored ones were fetched closer to those games, so they
 * know more than the app did ("stored later weeks", which flatters projection).
 * The other version uses this week's number alone ("this week only", which
 * handicaps projection with one matchup's noise). A conclusion that holds in
 * both is not an artefact of either.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { productionGames, restOfSeasonBlend, seasonWeights, type BlendedRate } from '../src/core/value/restOfSeason.ts';
import { planWaiverTiers, type TierCandidate, type TierMove, type TierPlayer, type TierProtection } from '../src/core/waivers/tiers.ts';
import { draftCapital } from '../src/core/waivers/tierInputs.ts';
import { weekNumbers, type AheadNumbers } from '../src/core/waivers/aheadWeeks.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { bestLineup, slotsOf } from '../src/core/tradeValue/lineup.ts';
import { tradeHorizon, type TradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { weeklyAvailability } from '../src/core/tradeValue/availability.ts';
import { replacementLevels } from '../src/core/tradeValue/evaluate.ts';
import type { PlayerRate } from '../src/core/tradeValue/rate.ts';
import { buildTradePackages } from '../src/core/trades/builder.ts';
import { rankingNumber } from '../src/core/startsit/decisionPoints.ts';
import { TOSSUP_POINTS } from '../src/core/startsit/tossup.ts';
import type { Designation } from '../src/core/injury/model.ts';

/* ------------------------------------------------------------ the file */

interface Data {
  meta: {
    season: string;
    currentWeek: number;
    lastPlayed: number;
    myRosterId: number | null;
    scoring: Record<string, number>;
    rosterPositions: string[];
    settings: Record<string, unknown>;
    projectionFetched: Record<string, { rows: number; first: string; last: string }>;
    linesWeeks: Record<string, { players: number; vegas: number }>;
    d1RowsTotal: number;
  };
  players: Record<string, [string, string, string]>;
  actual: Record<string, Record<string, number>>;
  proj: Record<string, Record<string, number>>;
  numbers: Record<string, Record<string, [number, 'm' | 'p']>>;
  played: Record<string, number[]>;
  clubs: Record<string, [number, string][]>;
  byes: Record<string, number[]>;
  injuries: Record<string, Record<string, string>>;
  rosters: Record<string, Record<string, string[]>>;
  starters: Record<string, Record<string, string[]>>;
  transactions: { week: number; type: string; at: number; adds: [string, number][]; drops: [string, number][]; bid: number | null }[];
  draftRounds: Record<string, number>;
}

const file = process.argv[2];
if (!file) throw new Error('usage: probe-round16-score.ts <round16-data.json> [summary.json]');
const D = JSON.parse(readFileSync(file, 'utf8')) as Data;
const summaryFile = process.argv[3] ?? null;

const SKILL = ['QB', 'RB', 'WR', 'TE'] as const;
const STARTERS: Record<string, number> = { QB: 24, RB: 36, WR: 36, TE: 12 };
const LAST = D.meta.lastPlayed;
const ME = D.meta.myRosterId;
const settings = D.meta.settings;
const shape = buildRosterShape(D.meta.rosterPositions);
const skillSlots = slotsOf(shape).filter((s) => SKILL.some((p) => s.eligible.has(p)));
const summary: Record<string, unknown> = {};

const posOf = (id: string): string => D.players[id]?.[1] ?? '';
const nameOf = (id: string): string => D.players[id]?.[0] ?? id;
const isSkill = (id: string): boolean => (SKILL as readonly string[]).includes(posOf(id));
const pts = (id: string, w: number): number => D.actual[String(w)]?.[id] ?? 0;
const playedSet = new Map(Object.entries(D.played).map(([id, ws]) => [id, new Set(ws)]));
const didPlay = (id: string, w: number): boolean => pts(id, w) !== 0 || (playedSet.get(id)?.has(w) ?? false);

const clubAt = (id: string, w: number): string => {
  const rows = (D.clubs[id] ?? []).filter(([week]) => week <= w).sort((a, b) => b[0] - a[0]);
  return rows[0]?.[1] ?? D.players[id]?.[2] ?? '';
};
const byeIn = (id: string, from: number, to: number): number | null => {
  const club = clubAt(id, from - 1 >= 1 ? from - 1 : from);
  const bye = (D.byes[club] ?? []).find((w) => w >= from && w <= to);
  return bye ?? null;
};
const designationAt = (id: string, w: number): Designation => {
  /* What was known at the start of week W: the last report of week W-1. */
  const s = (D.injuries[String(w - 1)]?.[id] ?? '').toLowerCase();
  if (s === 'out') return 'out';
  if (s === 'doubtful') return 'doubtful';
  if (s === 'questionable') return 'questionable';
  return 'healthy';
};

/* ------------------------------------------------------ the values */

const horizonAt = new Map<number, TradeHorizon>();
const horizon = (W: number): TradeHorizon => {
  if (!horizonAt.has(W)) horizonAt.set(W, tradeHorizon({ leagueSettings: settings, currentWeek: W }));
  return horizonAt.get(W)!;
};

/** His league points in each game he played in weeks 1 to W-1. */
function production(id: string, W: number): number[] {
  const leaguePoints = Array.from({ length: W - 1 }, (_, i) => pts(id, i + 1));
  const playedWeeks = new Set([...(playedSet.get(id) ?? [])].filter((w) => w < W));
  return productionGames({ leaguePoints, through: W - 1, playedWeeks });
}

/** What he scored per game played from week W to the last finished week. */
function outcome(id: string, W: number): { ppg: number; games: number; total: number } | null {
  const games: number[] = [];
  for (let w = W; w <= LAST; w++) if (didPlay(id, w)) games.push(pts(id, w));
  if (games.length === 0) return null;
  const total = games.reduce((a, b) => a + b, 0);
  return { ppg: total / games.length, games: games.length, total };
}

type Mode = 'stored' | 'thisWeek';

interface Valued {
  id: string;
  position: string;
  W: number;
  /** This week's number as the screens read it, and whether it is Sleeper's. */
  week: number | null;
  borrowed: boolean;
  blend: BlendedRate;
  production: number[];
  byeWeek: number | null;
}

/** The app's own value at the start of week W, through `restOfSeasonBlend`. */
function value(id: string, W: number, mode: Mode): Valued {
  const h = horizon(W);
  const byeWeek = byeIn(id, W, h.lastWeek);
  const n = D.numbers[String(W)]?.[id] ?? null;
  /* No number this week (a bye, nothing posted): his latest earlier week of Sleeper's projection, three back at most. */
  let thisWeek: { rate: number | null; fromThisWeek: boolean } = { rate: n ? n[0] : null, fromThisWeek: n != null };
  if (!n) {
    for (let w = W - 1; w >= Math.max(1, W - 3); w--) {
      const p = D.proj[String(w)]?.[id];
      if (p != null && p >= 1) {
        thisWeek = { rate: p, fromThisWeek: false };
        break;
      }
    }
  }
  const ahead = new Map<number, number>();
  if (mode === 'stored') {
    for (let w = W + 1; w <= W + 3; w++) {
      const p = D.proj[String(w)]?.[id];
      if (p != null) ahead.set(w, p);
    }
  }
  const prod = production(id, W);
  const { blend } = restOfSeasonBlend({ thisWeek, ahead, production: prod, weeks: h.weeks, byeWeek, floor: 1 });
  return { id, position: posOf(id), W, week: thisWeek.rate, borrowed: !n || n[1] === 'p', blend, production: prod, byeWeek };
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Every rule, on the same two halves the app uses. Null when the rule has nothing to stand on. */
const RULES = {
  current: (v: Valued) => v.blend.rate,
  projection: (v: Valued) => (v.blend.projection != null ? v.blend.projection : v.production.length >= 2 ? mean(v.production) : null),
  average: (v: Valued) => (v.production.length >= 1 ? mean(v.production) : v.blend.projection),
  proj25: (v: Valued) => shareRule(v, 0.75),
  proj75: (v: Valued) => shareRule(v, 0.25),
  last3: (v: Valued) => (v.production.length >= 1 ? mean(v.production.slice(-3)) : v.blend.projection),
} as const;
type RuleKey = keyof typeof RULES;
const RULE_KEYS = Object.keys(RULES) as RuleKey[];
const RULE_LABEL: Record<RuleKey, string> = {
  current: 'current 50/50',
  projection: 'projection only',
  average: 'season average only',
  proj25: 'projection 25%',
  proj75: 'projection 75%',
  last3: 'last 3 games',
};

/** A blend with this share from production (ramped in over the first four games, as the app does). */
function shareRule(v: Valued, productionShare: number): number | null {
  const g = v.production.length;
  const A = g > 0 ? mean(v.production) : null;
  const P = v.blend.projection;
  if (P == null) return A != null && g >= 2 ? Math.max(0, A) : null;
  const s = A == null ? 0 : productionShare * Math.min(1, g / 4);
  return Math.max(0, (1 - s) * P + s * (A ?? 0));
}

/* ----------------------------------------------------- the test rows */

interface Row {
  id: string;
  position: string;
  W: number;
  actual: number;
  games: number;
  v: Valued;
  values: Record<RuleKey, number>;
}

const weeksTested: number[] = [];
const skipped: string[] = [];
for (let W = 3; W <= 8; W++) {
  if (W > LAST) {
    skipped.push(`week ${W}: no finished week after it`);
    continue;
  }
  if (!D.numbers[String(W)] || Object.keys(D.numbers[String(W)]!).length === 0) {
    skipped.push(`week ${W}: no stored projection or betting number for that week`);
    continue;
  }
  const missingPoints = Array.from({ length: W - 1 }, (_, i) => i + 1).filter((w) => !D.actual[String(w)]);
  if (missingPoints.length > 0) {
    skipped.push(`week ${W}: league points not stored for week(s) ${missingPoints.join(', ')}`);
    continue;
  }
  weeksTested.push(W);
}

function rowsFor(mode: Mode): Row[] {
  const out: Row[] = [];
  for (const W of weeksTested) {
    const ids = new Set<string>([
      ...Object.keys(D.numbers[String(W)] ?? {}),
      ...Object.keys(D.proj[String(W)] ?? {}),
      ...Array.from({ length: W - 1 }, (_, i) => Object.keys(D.actual[String(i + 1)] ?? {})).flat(),
    ]);
    const candidates: Row[] = [];
    for (const id of ids) {
      if (!isSkill(id)) continue;
      const o = outcome(id, W);
      if (!o) continue;
      const v = value(id, W, mode);
      const values = {} as Record<RuleKey, number>;
      let ok = true;
      for (const k of RULE_KEYS) {
        const x = RULES[k](v);
        if (x == null || !Number.isFinite(x)) ok = false;
        else values[k] = x;
      }
      if (!ok) continue;
      candidates.push({ id, position: v.position, W, actual: o.ppg, games: o.games, v, values });
    }
    /* Starter level under any rule: the union of every rule's top N at each position. */
    for (const position of SKILL) {
      const list = candidates.filter((r) => r.position === position);
      const keep = new Set<string>();
      for (const k of RULE_KEYS) {
        [...list].sort((a, b) => b.values[k] - a.values[k]).slice(0, STARTERS[position]).forEach((r) => keep.add(r.id));
      }
      out.push(...list.filter((r) => keep.has(r.id)));
    }
  }
  return out;
}

/* ---------------------------------------------------------- metrics */

function spearman(xs: readonly number[], ys: readonly number[]): number {
  const rank = (v: readonly number[]) => {
    const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]!.x === order[i]!.x) j++;
      for (let k = i; k <= j; k++) r[order[k]!.i] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const mae = (rows: readonly Row[], k: RuleKey) => mean(rows.map((r) => Math.abs(r.values[k] - r.actual)));
const bias = (rows: readonly Row[], k: RuleKey) => mean(rows.map((r) => r.values[k] - r.actual));
function rankCorr(rows: readonly Row[], k: RuleKey): number {
  const groups = new Map<string, Row[]>();
  for (const r of rows) (groups.get(`${r.W}:${r.position}`) ?? groups.set(`${r.W}:${r.position}`, []).get(`${r.W}:${r.position}`)!).push(r);
  const cs: number[] = [];
  for (const g of groups.values()) if (g.length >= 5) cs.push(spearman(g.map((r) => r.values[k]), g.map((r) => r.actual)));
  return cs.length ? mean(cs) : Number.NaN;
}

/** A seeded generator, so the intervals are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DRAWS = 2000;

/** The 90% interval of a statistic, resampling whole players (a player's weeks move together). */
function bootstrap<T extends { id: string }>(rows: readonly T[], stat: (sample: T[]) => number, seed = 16): { lo: number; hi: number } {
  const byPlayer = new Map<string, T[]>();
  for (const r of rows) (byPlayer.get(r.id) ?? byPlayer.set(r.id, []).get(r.id)!).push(r);
  const groups = [...byPlayer.values()];
  const draw = rng(seed);
  const stats: number[] = [];
  for (let i = 0; i < DRAWS; i++) {
    const sample: T[] = [];
    for (let j = 0; j < groups.length; j++) sample.push(...groups[Math.floor(draw() * groups.length)]!);
    const s = stat(sample);
    if (Number.isFinite(s)) stats.push(s);
  }
  stats.sort((a, b) => a - b);
  return { lo: stats[Math.floor(stats.length * 0.05)] ?? Number.NaN, hi: stats[Math.floor(stats.length * 0.95)] ?? Number.NaN };
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const sgn = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
const heading = (t: string) => console.log(`\n## ${t}`);

/* =========================================================== report */

console.log(`Round 16 backtest. Season ${D.meta.season}; finished weeks 1 to ${LAST}; production read ${D.meta.d1RowsTotal.toLocaleString('en-US')} D1 rows.`);
heading('Data on hand');
for (let w = 1; w <= Math.max(LAST + 3, 12); w++) {
  const a = D.actual[String(w)] ? Object.keys(D.actual[String(w)]!).length : 0;
  const p = D.proj[String(w)] ? Object.keys(D.proj[String(w)]!).length : 0;
  const n = D.meta.linesWeeks[String(w)];
  const f = D.meta.projectionFetched[String(w)];
  const qbs = Object.keys(D.proj[String(w)] ?? {}).filter((id) => posOf(id) === 'QB').length;
  if (!a && !p && !n) continue;
  console.log(
    `week ${String(w).padStart(2)}: points ${String(a).padStart(4)} players | projections ${String(p).padStart(4)} (QBs ${qbs}${f ? `, fetched ${f.first.slice(0, 10)} to ${f.last.slice(0, 10)}` : ''}) | numbers ${n ? `${n.players} (${n.vegas} full Vegas)` : '-'}`,
  );
}
console.log(`weeks tested: ${weeksTested.join(', ') || 'none'}`);
for (const s of skipped) console.log(`skipped ${s}`);
summary.weeksTested = weeksTested;
summary.skipped = skipped;

const results: Record<Mode, Row[]> = { stored: rowsFor('stored'), thisWeek: rowsFor('thisWeek') };
for (const mode of ['stored', 'thisWeek'] as Mode[]) {
  const rows = results[mode];
  heading(`1. Six rules, ${mode === 'stored' ? 'stored later weeks (closest to the app; flatters projection a little)' : 'this week only (handicaps projection a little)'}`);
  const players = new Set(rows.map((r) => r.id)).size;
  console.log(`${rows.length} player-weeks, ${players} players, weeks ${weeksTested.join(', ')}; outcome = points per game played, week W to week ${LAST}`);
  console.log('rule                 | miss (pts/game) | vs current (90% range)        | bias  | rank corr');
  const table: Record<string, unknown> = {};
  for (const k of RULE_KEYS) {
    const m = mae(rows, k);
    const d = m - mae(rows, 'current');
    const ci = k === 'current' ? null : bootstrap(rows, (s) => mae(s, k) - mae(s, 'current'), 16 + RULE_KEYS.indexOf(k));
    console.log(
      `${RULE_LABEL[k].padEnd(20)} | ${f2(m).padStart(15)} | ${k === 'current' ? '                             ' : `${sgn(d).padStart(6)} (${sgn(ci!.lo)} to ${sgn(ci!.hi)})`.padEnd(29)} | ${sgn(bias(rows, k)).padStart(5)} | ${f2(rankCorr(rows, k))}`,
    );
    table[k] = { mae: m, diff: d, ci, bias: bias(rows, k), rank: rankCorr(rows, k) };
  }
  const byPos: Record<string, unknown> = {};
  console.log('\nby position: miss per rule (lowest marked *), and rank correlation of the current blend');
  for (const position of SKILL) {
    const rp = rows.filter((r) => r.position === position);
    if (rp.length === 0) continue;
    const ms = RULE_KEYS.map((k) => ({ k, m: mae(rp, k) }));
    const best = ms.reduce((a, b) => (b.m < a.m ? b : a));
    const ci = best.k === 'current' ? null : bootstrap(rp, (s) => mae(s, best.k) - mae(s, 'current'), 99);
    console.log(
      `${position} (${rp.length}): ${ms.map(({ k, m }) => `${RULE_LABEL[k]} ${f2(m)}${k === best.k ? '*' : ''}`).join(' | ')}; best vs current ${best.k === 'current' ? 'current is best' : `${sgn(best.m - mae(rp, 'current'))} (${sgn(ci!.lo)} to ${sgn(ci!.hi)})`}; rank ${f2(rankCorr(rp, 'current'))}`,
    );
    byPos[position] = { n: rp.length, mae: Object.fromEntries(ms.map(({ k, m }) => [k, m])), best: best.k, ci };
  }
  /* The share itself: production share 0 to 1 by position. */
  console.log('\nproduction share grid (0 = projection only, 0.5 = today, 1 = average only, ramped over 4 games as the app does):');
  const grid: Record<string, unknown> = {};
  for (const position of ['ALL', ...SKILL]) {
    const rp = position === 'ALL' ? rows : rows.filter((r) => r.position === position);
    if (rp.length === 0) continue;
    const at = (s: number, rr: readonly Row[]) => mean(rr.map((r) => Math.abs((shareRule(r.v, s) ?? r.values.current) - r.actual)));
    const shares = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    const ms = shares.map((s) => at(s, rp));
    const bestI = ms.indexOf(Math.min(...ms));
    const bestS = shares[bestI]!;
    const ci = bootstrap(rp, (s) => at(bestS, s) - at(0.5, s), 7);
    console.log(`${position.padEnd(3)}: ${shares.map((s, i) => `${s.toFixed(1)}:${f2(ms[i]!)}`).join(' ')} | best ${bestS.toFixed(1)}, ${sgn(ms[bestI]! - at(0.5, rp))} vs 0.5 (${sgn(ci.lo)} to ${sgn(ci.hi)})`);
    grid[position] = { shares, mae: ms, best: bestS, ci };
  }
  /* How big week-to-week noise is: the current blend's miss week by week. */
  const perWeek = weeksTested.map((W) => {
    const rw = rows.filter((r) => r.W === W);
    return { W, n: rw.length, current: rw.length ? mae(rw, 'current') : Number.NaN, best: rw.length ? Math.min(...RULE_KEYS.map((k) => mae(rw, k))) : Number.NaN };
  });
  console.log(`\nweek by week, current miss: ${perWeek.map((p) => `W${p.W} ${f2(p.current)} (n ${p.n})`).join(' | ')}`);
  summary[mode] = { rows: rows.length, players, table, byPos, grid, perWeek };
}

/* ------------------------------------------------------ 4a. minus 2 */
heading('4a. The minus-2 for a Sleeper-only number (weekly numbers, weeks 1 to last)');
{
  interface WRow {
    id: string;
    W: number;
    position: string;
    n: number;
    borrowed: boolean;
    sleeper: number | null;
    actual: number;
  }
  const wrows: WRow[] = [];
  for (let w = 1; w <= LAST; w++) {
    for (const [id, [n, basis]] of Object.entries(D.numbers[String(w)] ?? {})) {
      if (!isSkill(id) || !didPlay(id, w) || n < 3) continue;
      wrows.push({ id, W: w, position: posOf(id), n, borrowed: basis === 'p', sleeper: D.proj[String(w)]?.[id] ?? null, actual: pts(id, w) });
    }
  }
  const vegas = wrows.filter((r) => !r.borrowed);
  const sleeperOnly = wrows.filter((r) => r.borrowed);
  const both = vegas.filter((r) => r.sleeper != null);
  const avg = (rr: readonly WRow[], f: (r: WRow) => number) => (rr.length ? mean(rr.map(f)) : Number.NaN);
  console.log(`player-weeks that played, number 3+: ${vegas.length} full Vegas, ${sleeperOnly.length} Sleeper-only`);
  console.log(`full Vegas players: actual minus Vegas number ${sgn(avg(vegas, (r) => r.actual - r.n))}, miss ${f2(avg(vegas, (r) => Math.abs(r.actual - r.n)))}`);
  console.log(`same players, Sleeper's number instead (${both.length}): actual minus Sleeper ${sgn(avg(both, (r) => r.actual - r.sleeper!))}, miss ${f2(avg(both, (r) => Math.abs(r.actual - r.sleeper!)))}`);
  console.log(`Sleeper-only players: actual minus number ${sgn(avg(sleeperOnly, (r) => r.actual - r.n))}, miss ${f2(avg(sleeperOnly, (r) => Math.abs(r.actual - r.n)))}`);
  /* Like for like: Sleeper-only against Vegas at the same number, by band. */
  const bands = [
    [3, 7],
    [7, 10],
    [10, 13],
    [13, 17],
    [17, 99],
  ] as const;
  console.log('by number band, actual minus number (Vegas | Sleeper-only | gap = what the discount should be):');
  const bandOut: unknown[] = [];
  for (const [lo, hi] of bands) {
    const v = vegas.filter((r) => r.n >= lo && r.n < hi);
    const s = sleeperOnly.filter((r) => r.n >= lo && r.n < hi);
    const gap = avg(v, (r) => r.actual - r.n) - avg(s, (r) => r.actual - r.n);
    console.log(`  ${lo} to ${hi === 99 ? 'up' : hi}: ${sgn(avg(v, (r) => r.actual - r.n))} (${v.length}) | ${sgn(avg(s, (r) => r.actual - r.n))} (${s.length}) | ${sgn(gap)}`);
    bandOut.push({ lo, hi, vegas: v.length, sleeper: s.length, gap });
  }
  /* The discount that best matches the two, weighted like the bands: least squares on actual = a + b n - d [sleeper-only]. */
  const fit = (rr: readonly WRow[]) => {
    /* Solve the 3x3 normal equations. */
    const X = rr.map((r) => [1, r.n, r.borrowed ? 1 : 0]);
    const y = rr.map((r) => r.actual);
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, x) => s + x[i]! * x[j]!, 0)));
    const b = [0, 1, 2].map((i) => X.reduce((s, x, k) => s + x[i]! * y[k]!, 0));
    for (let i = 0; i < 3; i++) {
      const p = A[i]![i]!;
      if (Math.abs(p) < 1e-9) return Number.NaN;
      for (let j = i + 1; j < 3; j++) {
        const f = A[j]![i]! / p;
        for (let k = i; k < 3; k++) A[j]![k]! -= f * A[i]![k]!;
        b[j]! -= f * b[i]!;
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = b[i]!;
      for (let k = i + 1; k < 3; k++) s -= A[i]![k]! * x[k]!;
      x[i] = s / A[i]![i]!;
    }
    return -x[2]!;
  };
  const d = fit(wrows);
  const dci = bootstrap(wrows, (s) => fit(s), 5);
  console.log(`discount that best fits (same number level): ${f2(d)} points (90% range ${f2(dci.lo)} to ${f2(dci.hi)}); the app uses 2`);
  /* As a decision: a Vegas player against a Sleeper-only one at the same position and week, within 4 points. */
  const pairs: { a: WRow; b: WRow }[] = [];
  for (let w = 1; w <= LAST; w++) {
    for (const position of SKILL) {
      const v = vegas.filter((r) => r.W === w && r.position === position);
      const s = sleeperOnly.filter((r) => r.W === w && r.position === position);
      for (const a of v) for (const b of s) if (Math.abs(a.n - b.n) <= 4) pairs.push({ a, b });
    }
  }
  const pick = (disc: number) => {
    let right = 0;
    let gained = 0;
    for (const { a, b } of pairs) {
      const takeVegas = a.n >= b.n - disc;
      const chosen = takeVegas ? a : b;
      const other = takeVegas ? b : a;
      if (chosen.actual > other.actual) right++;
      gained += chosen.actual - other.actual;
    }
    return { right: right / pairs.length, gained: gained / pairs.length };
  };
  console.log(`head to head, Vegas against Sleeper-only within 4 points, same position and week (${pairs.length} pairs):`);
  const discOut: unknown[] = [];
  for (const disc of [0, 1, 2, 3, 4]) {
    const p = pick(disc);
    console.log(`  discount ${disc}: right ${pct(p.right)}, average points gained per call ${sgn(p.gained)}`);
    discOut.push({ disc, ...p });
  }
  summary.minus2 = { vegas: vegas.length, sleeperOnly: sleeperOnly.length, bands: bandOut, fit: d, fitCi: dci, pairs: pairs.length, discounts: discOut };
}

/* --------------------------------------------------- 4b. toss-up bar */
heading('4b. The 2.0 toss-up bar');
{
  const buckets = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 5],
    [5, 99],
  ] as const;
  /* Weekly calls: two players at one position in one week, on ranking numbers (minus 2 applied). */
  const weekly: { gap: number; won: boolean; margin: number }[] = [];
  for (let w = 1; w <= LAST; w++) {
    for (const position of SKILL) {
      const list = Object.entries(D.numbers[String(w)] ?? {})
        .filter(([id]) => posOf(id) === position && didPlay(id, w))
        .map(([id, [n, b]]) => ({ id, r: rankingNumber(n, b === 'p'), a: pts(id, w) }))
        .filter((x) => x.r >= 5)
        .sort((x, y) => y.r - x.r)
        .slice(0, STARTERS[position]! + 12);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const gap = list[i]!.r - list[j]!.r;
          if (gap >= 6) continue;
          weekly.push({ gap, won: list[i]!.a > list[j]!.a, margin: list[i]!.a - list[j]!.a });
        }
      }
    }
  }
  console.log('weekly start/sit calls (same position, same week): how often the higher number outscored the lower');
  const wOut: unknown[] = [];
  for (const [lo, hi] of buckets) {
    const b = weekly.filter((p) => p.gap >= lo && p.gap < hi);
    if (!b.length) continue;
    console.log(`  gap ${lo} to ${hi === 99 ? 'up' : hi}: ${pct(b.filter((p) => p.won).length / b.length)} of ${b.length}, average margin ${sgn(mean(b.map((p) => p.margin)))}`);
    wOut.push({ lo, hi, n: b.length, won: b.filter((p) => p.won).length / b.length, margin: mean(b.map((p) => p.margin)) });
  }
  /* Season calls: the rest-of-season value gap the waiver bar reads. */
  const rows = results.stored;
  const season: { gap: number; won: boolean; margin: number }[] = [];
  for (const W of weeksTested) {
    for (const position of SKILL) {
      const list = rows.filter((r) => r.W === W && r.position === position).sort((a, b) => b.values.current - a.values.current);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const gap = list[i]!.values.current - list[j]!.values.current;
          if (gap >= 6) continue;
          season.push({ gap, won: list[i]!.actual > list[j]!.actual, margin: list[i]!.actual - list[j]!.actual });
        }
      }
    }
  }
  console.log('season-value calls (the bar a waiver pickup must clear to replace a starter): higher value, better points per game after?');
  const sOut: unknown[] = [];
  for (const [lo, hi] of buckets) {
    const b = season.filter((p) => p.gap >= lo && p.gap < hi);
    if (!b.length) continue;
    console.log(`  gap ${lo} to ${hi === 99 ? 'up' : hi}: ${pct(b.filter((p) => p.won).length / b.length)} of ${b.length}, average margin ${sgn(mean(b.map((p) => p.margin)))} per game`);
    sOut.push({ lo, hi, n: b.length, won: b.filter((p) => p.won).length / b.length, margin: mean(b.map((p) => p.margin)) });
  }
  console.log(`(the app's bar is ${TOSSUP_POINTS.toFixed(1)}: under it, a call is a toss-up)`);
  summary.tossup = { weekly: wOut, season: sOut };
}

/* ------------------------------------------- 3. decisions: waivers */

const allRostered = (w: number): Set<string> => new Set(Object.values(D.rosters[String(w)] ?? {}).flat());
const myRoster = (w: number): string[] => (ME == null ? [] : (D.rosters[String(w)]?.[String(ME)] ?? []));
const draftRounds = new Map(Object.entries(D.draftRounds));
const alexAdded = new Map<string, number>();
for (const t of D.transactions) for (const [id, roster] of t.adds) if (roster === ME && !alexAdded.has(id)) alexAdded.set(id, t.week);

/** Alex's best lineup in week w, in hindsight, from these players' real points. */
const lineupPoints = (ids: readonly string[], w: number): number =>
  bestLineup(
    skillSlots,
    ids.filter(isSkill).map((id) => ({ id, position: posOf(id), value: pts(id, w) })),
  ).total;
const lineupGain = (before: readonly string[], after: readonly string[], W: number): number => {
  let gain = 0;
  for (let w = W; w <= LAST; w++) gain += lineupPoints(after, w) - lineupPoints(before, w);
  return gain;
};

/** What the trade model and the waiver planner read for a player at week W. */
function playerRate(id: string, W: number, reserve: ReadonlySet<string>): PlayerRate {
  const h = horizon(W);
  const v = value(id, W, 'stored');
  const designation = designationAt(id, W);
  const rate = v.blend.rate;
  const availability = weeklyAvailability({ designation, onReserve: reserve.has(id), weeks: h.weeks, byeWeek: v.byeWeek, rate });
  return {
    playerId: id,
    name: nameOf(id),
    position: posOf(id),
    team: clubAt(id, W - 1),
    rate,
    basis: v.borrowed ? 'published' : 'market',
    weekRate: v.week,
    blend: v.blend,
    rateNote: null,
    designation,
    games: availability.games,
    weekly: availability.weekly,
    injuryNote: availability.note,
    byeWeek: v.byeWeek,
    byeKnown: true,
    byeInside: availability.byeInside,
    onReserve: reserve.has(id),
  };
}

/** Which of Alex's players sat in his IR slots: over the active limit, the ones marked Out. */
function reserveOf(roster: readonly string[], W: number): Set<string> {
  const active = shape.totalStarters + shape.benchSlots;
  const extra = roster.length - active;
  if (extra <= 0) return new Set();
  const out = roster
    .filter(isSkill)
    .sort((a, b) => Number(designationAt(b, W) === 'out') - Number(designationAt(a, W) === 'out') || (value(a, W, 'stored').blend.rate ?? 0) - (value(b, W, 'stored').blend.rate ?? 0));
  return new Set(out.slice(0, extra));
}

interface DecisionOutcome {
  W: number;
  kind: string;
  add: string;
  drop: string | null;
  reason: string;
  gain: number;
  lineup: number;
  raw: number;
  took: boolean;
}

const waiverOutcomes: DecisionOutcome[] = [];
const byeOutcomes: { W: number; add: string; holeWeek: number | null; addPoints: number | null; reason: string }[] = [];
if (ME == null) {
  console.log('\nAlex’s roster is not marked in the database: the waiver and trade replays are skipped.');
} else {
  heading('3a. The waiver planner, replayed week by week');
  for (const W of weeksTested) {
    const h = horizon(W);
    const roster = myRoster(W - 1).filter((id) => isSkill(id));
    const rostered = allRostered(W - 1);
    const reserve = reserveOf(myRoster(W - 1), W);
    const near = [W, W + 1, W + 2].filter((w) => w <= h.lastWeek);
    const seasonWeeks = h.weeks;
    const sw = seasonWeights({ weeks: seasonWeeks, playoffWeeks: h.playoffWeeks });
    const windowSum = 1 + 1 + 0.5;
    const ahead: AheadNumbers = {
      sleeper: new Map(
        [W + 1, W + 2].map((w) => [w, new Map(Object.entries(D.proj[String(w)] ?? {}))] as const),
      ),
    };
    /* A rostered player with no number stays on the roster, unvalued (the planner never guesses one); a free agent with none is left out. */
    const tier = (id: string, rostered = false): TierPlayer | null => {
      const n = D.numbers[String(W)]?.[id] ?? null;
      const v = value(id, W, 'stored');
      const rate = n ? n[0] : v.week;
      if (rate == null && !rostered) return null;
      const designation = designationAt(id, W);
      const avail = weeklyAvailability({ designation, onReserve: reserve.has(id), weeks: seasonWeeks, byeWeek: v.byeWeek, rate });
      const numbers = weekNumbers({ playerId: id, rate, weeks: near, currentWeek: W, ahead, byeWeek: v.byeWeek });
      const tail = seasonWeeks.slice(near.length);
      const seasonRate = v.blend.rate ?? rate;
      return {
        playerId: id,
        name: nameOf(id),
        position: posOf(id),
        team: clubAt(id, W - 1),
        rate,
        seasonRate,
        weekly: avail.weekly,
        weekValues: [...numbers.map((x) => x.points), ...tail.map(() => seasonRate)],
        weekSources: [...numbers.map((x) => x.source), ...tail.map((w) => (w === v.byeWeek ? ('bye' as const) : ('season' as const)))],
        weekBorrowed: [...numbers.map((x) => (x.source === 'sleeper' ? true : x.source === 'bye' ? false : v.borrowed)), ...tail.map(() => false)],
        weekFrom: [...numbers.map(() => null), ...tail.map(() => null)],
        rateBorrowed: v.borrowed,
        designation,
        byeWeek: v.byeWeek,
        onReserve: reserve.has(id),
      };
    };
    const rosterTiers = roster.map((id) => tier(id, true)).filter((t): t is TierPlayer => t != null);
    const freeIds = new Set<string>([...Object.keys(D.numbers[String(W)] ?? {}), ...Object.keys(D.proj[String(W - 1)] ?? {})]);
    const candidates: TierCandidate[] = [...freeIds]
      .filter((id) => isSkill(id) && !rostered.has(id))
      .map((id) => tier(id))
      .filter((t): t is TierPlayer => t != null)
      .map((t) => ({ ...t, planExcluded: null, instant: false }));
    const top3 = (list: readonly { position: string; value: number; designation: string }[]) => {
      const out = new Map<string, number>();
      for (const position of SKILL) {
        const vals = list
          .filter((x) => x.position === position && x.designation !== 'out' && x.designation !== 'doubtful')
          .map((x) => x.value)
          .sort((a, b) => b - a)
          .slice(0, 3);
        if (vals.length) out.set(position, mean(vals));
      }
      return out;
    };
    const protections = new Map<string, TierProtection>();
    for (const [id, note] of draftCapital(rosterTiers, draftRounds, undefined, W)) protections.set(id, { kind: 'draft_capital', note });
    const reserveCount = [...reserve].length;
    const plan = planWaiverTiers({
      shape,
      weeks: seasonWeeks,
      weights: sw,
      leadWeeks: 2,
      roster: rosterTiers,
      candidates,
      openSpots: Math.max(0, shape.totalStarters + shape.benchSlots - (myRoster(W - 1).length - reserveCount)),
      openReserve: Math.max(0, Number(settings.reserve_slots ?? shape.irSlots) - reserveCount),
      protections,
      excludedPositions: new Set(['DEF', 'K']),
      replacement: top3(candidates.map((c) => ({ position: c.position, value: c.rate ?? 0, designation: c.designation }))),
      season: {
        near: near.length,
        replacement: top3(candidates.map((c) => ({ position: c.position, value: c.seasonRate ?? c.rate ?? 0, designation: c.designation }))),
        scale: Math.round((sw.reduce((a, b) => a + b, 0) / windowSum) * 1000) / 1000,
      },
    });
    const moves: { kind: string; m: TierMove }[] = [
      ...plan.doThese.map((m) => ({ kind: 'Do this', m })),
      ...plan.consider.map((m) => ({ kind: 'Worth considering', m })),
    ];
    if (moves.length === 0) console.log(`week ${W}: no "Do this" or "Worth considering" move (closest: ${plan.watch[0] ? `${plan.watch[0].name} ${f1(plan.watch[0].gain)}` : 'none'})`);
    for (const { kind, m } of moves) {
      const before = myRoster(W - 1);
      const after = [...before.filter((id) => id !== m.drop?.playerId), m.playerId];
      const lg = lineupGain(before, after, W);
      const raw = (outcome(m.playerId, W)?.total ?? 0) - (m.drop && !m.drop.viaReserve ? (outcome(m.drop.playerId, W)?.total ?? 0) : 0);
      const took = alexAdded.has(m.playerId) && (alexAdded.get(m.playerId) ?? 0) >= W - 1;
      waiverOutcomes.push({ W, kind, add: m.playerId, drop: m.drop?.playerId ?? null, reason: m.reasonCode, gain: m.gain, lineup: lg, raw, took });
      console.log(
        `week ${W} ${kind}: add ${m.name} (${m.position})${m.drop ? `${m.drop.viaReserve ? ', move to IR ' : ' for '}${m.drop.name}` : ' (open spot)'}; model gain ${f1(m.gain)} [${m.reasonCode}] -> real: lineup ${sgn(lg)} pts over weeks ${W} to ${LAST}, raw points ${sgn(raw)}${took ? '; Alex made this add' : ''}`,
      );
      if (m.reasonCode === 'hole_bye' || m.reasonCode === 'bye_depth') {
        const holeWeek = m.byWeek.find((x) => x.change > 0)?.week ?? null;
        byeOutcomes.push({ W, add: m.playerId, holeWeek, addPoints: holeWeek != null && holeWeek <= LAST ? pts(m.playerId, holeWeek) : null, reason: m.reasonCode });
      }
    }
  }
  const paid = waiverOutcomes.filter((o) => o.lineup > 0);
  const flat = waiverOutcomes.filter((o) => o.lineup === 0);
  console.log(
    `\nwaiver moves: ${waiverOutcomes.length}; added lineup points (hindsight best lineup) in ${paid.length}, none in ${flat.length}, lost in ${waiverOutcomes.length - paid.length - flat.length}; average lineup gain ${waiverOutcomes.length ? sgn(mean(waiverOutcomes.map((o) => o.lineup))) : '-'}, average raw points over the drop ${waiverOutcomes.length ? sgn(mean(waiverOutcomes.map((o) => o.raw))) : '-'}`,
  );
  for (const kind of ['Do this', 'Worth considering']) {
    const k = waiverOutcomes.filter((o) => o.kind === kind);
    if (k.length) console.log(`  ${kind}: ${k.length} moves, ${k.filter((o) => o.lineup > 0).length} paid off, average lineup gain ${sgn(mean(k.map((o) => o.lineup)))}, raw ${sgn(mean(k.map((o) => o.raw)))}`);
  }
  if (byeOutcomes.length) {
    console.log('bye-cover moves: the pickup’s real points in the week he was added to cover');
    for (const b of byeOutcomes) console.log(`  week ${b.W}: ${nameOf(b.add)}, hole week ${b.holeWeek ?? '?'}: ${b.addPoints == null ? 'not played yet' : f1(b.addPoints)} pts`);
  }
  summary.waivers = { moves: waiverOutcomes.map((o) => ({ ...o, addName: nameOf(o.add), dropName: o.drop ? nameOf(o.drop) : null })), bye: byeOutcomes.map((b) => ({ ...b, addName: nameOf(b.add) })) };

  /* ------------------------------------------- 3b. decisions: trades */
  heading('3b. Build a trade (all teams, nothing marked), replayed week by week');
  const tradeOutcomes: DecisionOutcome[] = [];
  /* Trades each roster had made before week W (Sleeper's transactions); earlier seasons unknown here. */
  const tradesBefore = (rid: number, W: number) =>
    D.transactions.filter((t) => t.type === 'trade' && t.week < W && t.adds.some(([, r]) => r === rid)).length;
  for (const W of weeksTested) {
    const h = horizon(W);
    if (h.deadlinePassed) continue;
    const rostered = allRostered(W - 1);
    const rosterIds = Object.keys(D.rosters[String(W - 1)] ?? {}).map(Number);
    const teams = rosterIds.map((rid) => {
      const ids = (D.rosters[String(W - 1)]?.[String(rid)] ?? []).filter(isSkill);
      const reserve = reserveOf(D.rosters[String(W - 1)]?.[String(rid)] ?? [], W);
      return {
        rosterId: rid,
        label: rid === ME ? 'Alex' : `Roster ${rid}`,
        roster: ids.map((id) => playerRate(id, W, reserve)),
        starterIds: (D.starters[String(W - 1)]?.[String(rid)] ?? []).filter(isSkill),
        activity: { thisSeason: tradesBefore(rid, W), earlier: null, line: '' },
        reserveIds: [...reserve],
      };
    });
    const me = teams.find((t) => t.rosterId === ME);
    if (!me) continue;
    const freeIds = [...new Set([...Object.keys(D.numbers[String(W)] ?? {}), ...Object.keys(D.proj[String(W - 1)] ?? {})])].filter((id) => isSkill(id) && !rostered.has(id));
    const replacement = replacementLevels(freeIds.map((id) => playerRate(id, W, new Set())));
    const protections = new Map<string, string>();
    for (const [id, note] of draftCapital(me.roster.map((p) => ({ playerId: p.playerId, designation: p.designation })), draftRounds, undefined, W)) protections.set(id, note);
    const eliteRbs = new Set(me.roster.filter((p) => p.position === 'RB' && ((p.rate ?? 0) >= 12 || (draftRounds.get(p.playerId) ?? 99) <= 2)).map((p) => p.playerId));
    const result = buildTradePackages({
      horizon: h,
      shape,
      replacement,
      rosterLimit: shape.totalStarters + shape.benchSlots + Math.max(shape.irSlots, Number(settings.reserve_slots ?? 0)),
      reserveSlots: Math.max(shape.irSlots, Number(settings.reserve_slots ?? 0)),
      me,
      teams: teams.filter((t) => t.rosterId !== ME),
      sell: [],
      want: new Map(),
      team: 'all',
      considerUnmarked: true,
      eliteRbs,
      protections,
    });
    if (result.packages.length === 0)
      console.log(`week ${W}: no trade shown (${result.message ?? 'nothing cleared both lineups'}; built ${result.audit.generated}, checked ${result.audit.evaluated}, hidden ${JSON.stringify(result.audit.hidden)})`);
    for (const p of result.packages.slice(0, 3)) {
      const give = p.give.map((x) => x.playerId);
      const get = p.get.map((x) => x.playerId);
      const drops = p.drops.map((x) => x.playerId);
      const before = myRoster(W - 1);
      /* A spot a 2 for 1 frees is filled with the best free agent then, by the model's own season value. */
      const freed = Math.max(0, give.length + drops.length - get.length);
      const fill = freeIds
        .map((id) => ({ id, v: value(id, W, 'stored').blend.rate ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, freed)
        .map((x) => x.id);
      const after = [...before.filter((id) => !give.includes(id) && !drops.includes(id)), ...get, ...fill];
      const lg = lineupGain(before, after, W);
      const raw = get.reduce((s, id) => s + (outcome(id, W)?.total ?? 0), 0) - give.reduce((s, id) => s + (outcome(id, W)?.total ?? 0), 0);
      tradeOutcomes.push({ W, kind: p.status, add: get.join('+'), drop: give.join('+'), reason: p.need ?? '', gain: p.alex.restOfSeason, lineup: lg, raw, took: false });
      console.log(
        `week ${W} [${p.status}] give ${give.map(nameOf).join(' + ')} for ${get.map(nameOf).join(' + ')} (${p.partner.label})${drops.length ? `, cut ${drops.map(nameOf).join(', ')}` : ''}${fill.length ? `, then add ${fill.map(nameOf).join(', ')}` : ''}; model: +${f1(p.alex.restOfSeason)} season lineup pts -> real: lineup ${sgn(lg)} over weeks ${W} to ${LAST}, raw ${sgn(raw)}`,
      );
    }
  }
  const tpaid = tradeOutcomes.filter((o) => o.lineup > 0);
  console.log(`\ntop trade ideas: ${tradeOutcomes.length}; paid off (Alex's hindsight lineup better) ${tpaid.length}; average lineup gain ${tradeOutcomes.length ? sgn(mean(tradeOutcomes.map((o) => o.lineup))) : '-'}`);
  summary.trades = tradeOutcomes.map((o) => ({ ...o, getNames: o.add.split('+').map(nameOf), giveNames: (o.drop ?? '').split('+').filter(Boolean).map(nameOf) }));
}

/* -------------------------------------------------- 4c. by position */
heading('4c. Quarterbacks (one-QB league) against the others');
{
  const rows = results.stored;
  for (const position of SKILL) {
    const rp = rows.filter((r) => r.position === position);
    if (!rp.length) continue;
    console.log(
      `${position}: average real ${f1(mean(rp.map((r) => r.actual)))} pts/game; current miss ${f2(mae(rp, 'current'))}, bias ${sgn(bias(rp, 'current'))}; projection-only bias ${sgn(bias(rp, 'projection'))}, average-only bias ${sgn(bias(rp, 'average'))}`,
    );
  }
}

if (summaryFile) writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
