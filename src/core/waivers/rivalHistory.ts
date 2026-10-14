/**
 * What each other manager has actually done on waivers, this season and in
 * the seasons before it, reduced to a few numbers per season.
 *
 * ## The data, and its honest limit
 *
 * Sleeper's documented transactions endpoint, walked along the league's
 * `previous_league_id` chain by the manager-history backfill (see
 * `docs/MANAGER_INTELLIGENCE.md`), publishes every completed claim and every
 * failed one with its bid. A failed claim is published while it is still in
 * the record; a claim cancelled before the run, or one a manager only thought
 * about, never is. So "how often he bids" counts the bids Sleeper kept, which
 * is a floor, not the whole truth.
 *
 * ## What is kept, per manager per season
 *
 * - how many contested players he bid on, out of every player anyone bid on
 *   while he was in the league (his bid rate);
 * - those bids by position;
 * - each bid as a share of the FAAB he had left at the time;
 * - of the players who scored 12 or more the week before, how many he bid on
 *   (whether he chases last week's scorers), when that week's points are known;
 * - his instant free-agent pickups against his claims (whether he adds on news
 *   rather than waiting for the run).
 *
 * One settings row per manager per season, written by the daily manager
 * derive from rows already stored. No per-player scan on a page load.
 *
 * ## The blend
 *
 * Seasons count 1, 0.6 and 0.36 from the newest back (the ledger's own
 * `SEASON_DECAY`). Alex's seed profile (`managerSeeds.ts`) is the prior: it
 * counts as {@link RIVAL_HISTORY.priorTargets} contested players for the rate
 * and {@link RIVAL_HISTORY.priorBids} bids for the size, so three seasons of a
 * manager's own record outweigh it and a newcomer starts from it.
 */

import { STYLE_PRIORS, type BidderStyle } from './managerSeeds.ts';

export const RIVAL_HISTORY = {
  /** Weight of each season back from the newest. */
  seasonDecay: 0.6,
  /** The seed's rate counts as this many contested players of evidence. */
  priorTargets: 15,
  /** The seed's bid size counts as this many bids. */
  priorBids: 4,
  /** Positional interest pulls toward the league's mix by this many bids. */
  positionPrior: 4,
  /** Bounds on positional interest, so one season's three QB bids cannot say "never". */
  interest: { min: 0.3, max: 2.5 },
  /** A player who scored this many points the week before is "last week's scorer". */
  hotPoints: 12,
  /** Bounds on the chase multiplier. */
  chase: { min: 0.6, max: 1.8 },
  /** The chase reading shrinks toward "no preference" by this many hot targets. */
  chasePrior: 4,
  /** At most this many bid shares are kept per season row. */
  maxShares: 60,
} as const;

/** The seed's bid rate on a player somebody bid on, before any history. */
export const STYLE_RATE: Readonly<Record<BidderStyle, number>> = {
  savvy: 0.25,
  slightly_savvy: 0.15,
  chaser: 0.12,
  rare: 0.03,
};

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DEF'] as const;

/** One published waiver claim, resolved to the person who made it. */
export interface HistoryClaim {
  season: string;
  week: number;
  /** Sleeper user id. */
  userId: string;
  playerId: string;
  position: string | null;
  amount: number;
  won: boolean;
  /** Sleeper voided it (roster full): it never competed. */
  voided?: boolean;
  /** When Sleeper processed it, ms. Claims processed within ten minutes are one run. */
  at: number;
  /** FAAB he had left before the run, when known. */
  remainingBefore?: number | null;
}

export interface HistoryAdd {
  season: string;
  userId: string;
  /** `free_agent` (instant) or `waiver`. */
  kind: 'free_agent' | 'waiver';
}

export interface RivalSeasonAggregate {
  v: 1;
  season: string;
  userId: string;
  /** Players anybody bid on, in runs while he was in the league. */
  targets: number;
  /** Of those, how many he bid on. */
  bids: number;
  byPosition: Partial<Record<string, number>>;
  /** The league's contested players by position, the denominator for interest. */
  leagueByPosition: Partial<Record<string, number>>;
  /** Each bid as a share of FAAB left, 0 to 1, two decimals. */
  shares: number[];
  /** Bids of $0. */
  zeroBids: number;
  /** Largest single bid, dollars. */
  maxBid: number;
  /** Last week's scorers among the targets, and how many he bid on. Null: points not known. */
  hot: { targets: number; bids: number } | null;
  /** Instant pickups and claims this season. */
  freeAgentAdds: number;
  waiverAdds: number;
  /** Waiver runs in the season so far. */
  runs: number;
}

export interface RivalTendency {
  userId: string;
  /** His chance of bidding on a player somebody bids on, before need and the player's pull. */
  rate: number;
  /** Multiplier by position, 1 = the league's mix. */
  interest: Record<string, number>;
  /** His bids as shares of FAAB left, ascending, with the seed's typical share mixed in. */
  shares: number[];
  /** Multiplier for a player who scored big last week. */
  chase: number;
  /** Instant pickups as a share of all his adds, blended seasons. Null without adds. */
  newsShare: number | null;
  /** How many seasons of his own record went in, and how many contested players. */
  seasons: string[];
  targets: number;
  bidsSeen: number;
  /** Where the rate leans: his record, or the seed. */
  source: 'history' | 'seed';
}

/**
 * Per-manager, per-season aggregates from the published claims.
 *
 * `points(season, week)` answers what each player scored that week, when it
 * is known: only then is the chase reading kept. `seasonsByUser` says which
 * seasons each manager was in the league, so a newcomer is not counted as
 * passing on targets from before he arrived.
 */
export function buildRivalSeasonAggregates(input: {
  claims: readonly HistoryClaim[];
  adds?: readonly HistoryAdd[];
  seasonsByUser: ReadonlyMap<string, readonly string[]>;
  points?: (season: string, week: number) => ReadonlyMap<string, number> | null;
  /** League FAAB per season; shares need it when a claim carries no remaining. */
  budgetTotal: number | null;
}): RivalSeasonAggregate[] {
  const valid = input.claims.filter((c) => !c.voided);
  const out: RivalSeasonAggregate[] = [];
  const seasons = [...new Set(valid.map((c) => c.season))].sort();

  for (const season of seasons) {
    const inSeason = valid.filter((c) => c.season === season).sort((a, b) => a.at - b.at);
    const runs = groupRuns(inSeason);
    /* What each manager had left before each run, from the claims he won in earlier runs. */
    const spent = new Map<string, number>();
    const remainingAt = new Map<HistoryClaim, number>();
    for (const run of runs) {
      for (const c of run.claims) remainingAt.set(c, c.remainingBefore ?? Math.max(0, (input.budgetTotal ?? 100) - (spent.get(c.userId) ?? 0)));
      for (const c of run.claims) if (c.won) spent.set(c.userId, (spent.get(c.userId) ?? 0) + c.amount);
    }

    const leagueByPosition: Record<string, number> = {};
    const targetsByRun = runs.map((run) => {
      const players = new Map<string, HistoryClaim[]>();
      for (const c of run.claims) players.set(c.playerId, [...(players.get(c.playerId) ?? []), c]);
      return { run, players };
    });
    let totalTargets = 0;
    for (const { players } of targetsByRun) {
      for (const [, cs] of players) {
        totalTargets += 1;
        const pos = (cs[0]?.position ?? '').toUpperCase();
        if (pos) leagueByPosition[pos] = (leagueByPosition[pos] ?? 0) + 1;
      }
    }

    const users = [...input.seasonsByUser.entries()].filter(([, s]) => s.includes(season)).map(([u]) => u);
    for (const userId of new Set([...users, ...inSeason.map((c) => c.userId)])) {
      let bids = 0;
      const byPosition: Record<string, number> = {};
      const shares: number[] = [];
      let zeroBids = 0;
      let maxBid = 0;
      let hotTargets = 0;
      let hotBids = 0;
      let pointsKnown = false;
      for (const { run, players } of targetsByRun) {
        const last = input.points?.(season, run.week - 1) ?? null;
        if (last) pointsKnown = true;
        for (const [playerId, cs] of players) {
          const mine = cs.filter((c) => c.userId === userId);
          const hot = last != null && (last.get(playerId) ?? 0) >= RIVAL_HISTORY.hotPoints;
          if (hot) hotTargets += 1;
          if (mine.length === 0) continue;
          bids += 1;
          if (hot) hotBids += 1;
          const pos = (cs[0]?.position ?? '').toUpperCase();
          if (pos) byPosition[pos] = (byPosition[pos] ?? 0) + 1;
          const top = mine.reduce((a, b) => (b.amount > a.amount ? b : a));
          if (top.amount <= 0) zeroBids += 1;
          maxBid = Math.max(maxBid, top.amount);
          const left = remainingAt.get(top) ?? input.budgetTotal ?? 100;
          if (left > 0) shares.push(round2(Math.min(1, top.amount / left)));
        }
      }
      const adds = (input.adds ?? []).filter((a) => a.season === season && a.userId === userId);
      out.push({
        v: 1,
        season,
        userId,
        targets: totalTargets,
        bids,
        byPosition,
        leagueByPosition,
        shares: shares.sort((a, b) => a - b).slice(-RIVAL_HISTORY.maxShares),
        zeroBids,
        maxBid,
        hot: pointsKnown ? { targets: hotTargets, bids: hotBids } : null,
        freeAgentAdds: adds.filter((a) => a.kind === 'free_agent').length,
        waiverAdds: adds.filter((a) => a.kind === 'waiver').length,
        runs: runs.length,
      });
    }
  }
  return out;
}

/** Claims processed within ten minutes of each other are one waiver run. */
function groupRuns(claims: readonly HistoryClaim[]): { week: number; claims: HistoryClaim[] }[] {
  const runs: { week: number; at: number; claims: HistoryClaim[] }[] = [];
  for (const c of claims) {
    const run = runs.find((r) => Math.abs(r.at - c.at) < 600_000);
    if (run) run.claims.push(c);
    else runs.push({ week: c.week, at: c.at, claims: [c] });
  }
  return runs;
}

/**
 * One manager's tendency, blended over his seasons and his seed.
 *
 * `currentSeason` is the newest season weighted 1; each one before it counts
 * {@link RIVAL_HISTORY.seasonDecay} as much again.
 */
export function blendRivalTendency(opts: {
  userId: string;
  style: BidderStyle;
  aggregates: readonly RivalSeasonAggregate[];
  currentSeason: string;
}): RivalTendency {
  const current = Number(opts.currentSeason);
  const mine = opts.aggregates.filter((a) => a.userId === opts.userId && Number(a.season) <= current);
  const weight = (a: RivalSeasonAggregate) => RIVAL_HISTORY.seasonDecay ** Math.max(0, current - Number(a.season));

  const prior = STYLE_RATE[opts.style];
  let wTargets = 0;
  let wBids = 0;
  for (const a of mine) {
    wTargets += weight(a) * a.targets;
    wBids += weight(a) * a.bids;
  }
  const k = RIVAL_HISTORY.priorTargets;
  const rate = (wBids + k * prior) / (wTargets + k);

  /* Positional interest: his share of bids at a position against the league's, pulled toward the league's. */
  const league: Record<string, number> = {};
  const his: Record<string, number> = {};
  let leagueTotal = 0;
  let hisTotal = 0;
  for (const a of opts.aggregates.filter((x) => Number(x.season) <= current)) {
    /* The league's mix is the same in every manager's row for a season; count it once per season. */
    if (a.userId !== opts.userId) continue;
    for (const [pos, n] of Object.entries(a.leagueByPosition)) {
      league[pos] = (league[pos] ?? 0) + weight(a) * (n ?? 0);
      leagueTotal += weight(a) * (n ?? 0);
    }
    for (const [pos, n] of Object.entries(a.byPosition)) {
      his[pos] = (his[pos] ?? 0) + weight(a) * (n ?? 0);
      hisTotal += weight(a) * (n ?? 0);
    }
  }
  const interest: Record<string, number> = {};
  for (const pos of POSITIONS) {
    const leagueShare = leagueTotal > 0 ? (league[pos] ?? 0) / leagueTotal : 0;
    if (leagueShare <= 0) {
      interest[pos] = 1;
      continue;
    }
    const m = RIVAL_HISTORY.positionPrior;
    const share = ((his[pos] ?? 0) + m * leagueShare) / (hisTotal + m);
    interest[pos] = round2(clamp(share / leagueShare, RIVAL_HISTORY.interest.min, RIVAL_HISTORY.interest.max));
  }

  /* Bid size, as shares of FAAB left, newest seasons repeated more often. */
  const shares: number[] = [];
  for (const a of mine) {
    const copies = Math.max(1, Math.round(weight(a) * 3));
    for (let i = 0; i < copies; i++) shares.push(...a.shares);
  }
  const seedShare = STYLE_PRIORS[opts.style].typicalBid / 100;
  for (let i = 0; i < RIVAL_HISTORY.priorBids; i++) shares.push(seedShare);
  shares.sort((a, b) => a - b);

  /*
   * Chase: how much more he bids on last week's scorers than on everyone,
   * against how much more the whole league does. The league's own lean is
   * already in the player's pull (last week's points), so only his lean beyond
   * it counts here.
   */
  let hotT = 0;
  let hotB = 0;
  for (const a of mine) {
    if (!a.hot) continue;
    hotT += weight(a) * a.hot.targets;
    hotB += weight(a) * a.hot.bids;
  }
  let leagueHotT = 0;
  let leagueHotB = 0;
  let leagueT = 0;
  let leagueB = 0;
  for (const a of opts.aggregates) {
    if (!a.hot || Number(a.season) > current) continue;
    const w = weight(a);
    leagueHotT += w * a.hot.targets;
    leagueHotB += w * a.hot.bids;
    leagueT += w * a.targets;
    leagueB += w * a.bids;
  }
  const leagueLean = leagueHotT > 0 && leagueB > 0 ? leagueHotB / leagueHotT / (leagueB / leagueT) : 1;
  const c = RIVAL_HISTORY.chasePrior;
  const hotRate = (hotB + c * rate * leagueLean) / (hotT + c);
  const chase = round2(clamp(rate > 0 && leagueLean > 0 ? hotRate / rate / leagueLean : 1, RIVAL_HISTORY.chase.min, RIVAL_HISTORY.chase.max));

  let fa = 0;
  let all = 0;
  for (const a of mine) {
    fa += weight(a) * a.freeAgentAdds;
    all += weight(a) * (a.freeAgentAdds + a.waiverAdds);
  }

  return {
    userId: opts.userId,
    rate: round3(rate),
    interest,
    shares,
    chase,
    newsShare: all > 0 ? round2(fa / all) : null,
    seasons: [...new Set(mine.map((a) => a.season))].sort(),
    targets: Math.round(wTargets),
    bidsSeen: mine.reduce((s, a) => s + a.bids, 0),
    source: wTargets >= k ? 'history' : 'seed',
  };
}

/** A seed-only tendency, for a manager with no stored history. */
export function seedTendency(userId: string, style: BidderStyle): RivalTendency {
  return blendRivalTendency({ userId, style, aggregates: [], currentSeason: '0' });
}

/**
 * Claims and adds from stored Sleeper transactions, resolved to people
 * through each season's own roster map (a roster id means a different person
 * in a different season).
 */
export function historyFromTransactions(
  rows: readonly {
    season: string;
    transaction: {
      type?: string;
      status?: string;
      leg?: number | null;
      created?: number | null;
      status_updated?: number | null;
      roster_ids?: number[] | null;
      adds?: Record<string, number> | null;
      settings?: Record<string, number> | null;
      metadata?: Record<string, unknown> | null;
    };
  }[],
  userOf: (season: string, rosterId: number) => string | null,
  positionOf: (playerId: string) => string | null,
): { claims: HistoryClaim[]; adds: HistoryAdd[] } {
  const claims: HistoryClaim[] = [];
  const adds: HistoryAdd[] = [];
  for (const { season, transaction: t } of rows) {
    const rosterId = Number(t.roster_ids?.[0]);
    const userId = Number.isFinite(rosterId) ? userOf(season, rosterId) : null;
    if (!userId) continue;
    if (t.status === 'complete' && (t.type === 'free_agent' || t.type === 'waiver')) adds.push({ season, userId, kind: t.type });
    if (t.type !== 'waiver' || (t.status !== 'complete' && t.status !== 'failed')) continue;
    const playerId = Object.keys(t.adds ?? {})[0];
    if (!playerId) continue;
    claims.push({
      season,
      week: Number(t.leg ?? 0),
      userId,
      playerId,
      position: positionOf(playerId) ?? (/^[A-Z]{2,3}$/.test(playerId) ? 'DEF' : null),
      amount: Math.round(Number(t.settings?.['waiver_bid'] ?? 0)),
      won: t.status === 'complete',
      voided: /too many players/i.test(String(t.metadata?.['notes'] ?? '')),
      at: Number(t.status_updated ?? t.created ?? 0),
    });
  }
  return { claims, adds };
}

/** When the rival rows were last written for a league: one row, read to skip the work. */
export function rivalHistoryMarkerKey(leagueId: string): string {
  return `waivers.rivalHistory.${leagueId}.writtenAt`;
}

/** The settings key for one manager's season. */
export function rivalHistoryKey(leagueId: string, season: string, userId: string): string {
  return `waivers.rivalHistory.${leagueId}.${season}.${userId}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
