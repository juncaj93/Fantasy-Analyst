/**
 * Manager behaviour profiles, built only from what the league actually did.
 *
 * The temptation here is to write a personality engine. This is deliberately
 * not one. Every field is a count or a mean over transactions Sleeper
 * published, every field carries the sample it rests on, and a field whose
 * sample is below its threshold reports `unknown` rather than a number computed
 * from two events.
 *
 * Three rules are enforced here rather than left to callers:
 *
 * - **A manager is a Sleeper user id, never a roster id.** Roster ids are seats
 *   in one season and the seats move between seasons; joining last year's bids
 *   to this year's teams through roster ids would attribute one manager's record
 *   to another, which is worse than having no history.
 * - **A bid is a percentage of its own season's budget.** A $40 bid in a $100
 *   league and a $40 bid in a $200 league are not the same act, and a league
 *   that changed its budget would otherwise make every manager look like they
 *   suddenly halved their aggression.
 * - **The current season outranks the record when the two disagree**, provided
 *   the current season has cleared the threshold on its own. Managers change how
 *   they play; a profile that cannot notice is a profile that gets the season
 *   after a strategy change exactly wrong. The disagreement is reported rather
 *   than smoothed away.
 *
 * What comes out is a set of *small modifiers*. `aggressionModifier` is capped
 * at ±25% of an expected price. Nothing in this file may produce a
 * recommendation on its own.
 */

import type { LeagueTransaction } from './transactions.ts';
import { losingBids, winningBids } from './transactions.ts';

/** How much evidence a tendency needs before it is allowed to say anything. */
export const SAMPLE_THRESHOLDS = {
  /** Bids placed (won or lost) before an aggression number is reported. */
  bids: 4,
  /** Bids at one position before a position-specific rate is reported. */
  positionBids: 3,
  /** Weeks with any observed activity before churn is reported. */
  activeWeeks: 4,
  /** Completed trades before a trade tendency is reported. */
  trades: 2,
  /** Roster slots before a composition preference is reported. */
  rosterSlots: 8,
} as const;

/** The most a manager profile may move an expected price, either way. */
export const MAX_AGGRESSION_EFFECT = 0.25;

/**
 * One measured tendency.
 *
 * `sufficient` is not a nicety: every consumer is required to branch on it, and
 * `value` is null whenever it is false, so a caller cannot accidentally use a
 * mean of two.
 */
export interface Tendency {
  value: number | null;
  sample: number;
  threshold: number;
  sufficient: boolean;
  /** Plain-language description, always safe to show. */
  note: string;
}

function tendency(values: number[], threshold: number, describe: (mean: number, n: number) => string): Tendency {
  const sample = values.length;
  if (sample < threshold) {
    return {
      value: null,
      sample,
      threshold,
      sufficient: false,
      note: sample === 0 ? 'never observed' : `only ${sample} observation(s) — not enough to call a tendency`,
    };
  }
  const mean = values.reduce((a, b) => a + b, 0) / sample;
  return {
    value: round3(mean),
    sample,
    threshold,
    sufficient: true,
    note: describe(round3(mean), sample),
  };
}

/** A manager's seat in one season, from `league_managers`. */
export interface ManagerSeat {
  sleeperLeagueId: string;
  season: string;
  rosterId: number;
  userId: string | null;
  displayName: string | null;
  /** FAAB spent this season, as Sleeper reports it. */
  waiverBudgetUsed: number | null;
  /** That season's FAAB budget. */
  budget: number | null;
  /** The season record, when Sleeper reported one. */
  wins?: number | null;
  losses?: number | null;
  isMine: boolean;
}

/** What the app knows about a player who appeared in a transaction. */
export interface TransactionPlayerMeta {
  position: string | null;
  yearsExp: number | null;
}

export interface ManagerProfileInput {
  seats: ManagerSeat[];
  transactions: LeagueTransaction[];
  /** Sleeper player id → position / experience. Missing is tolerated. */
  playerMeta: Map<string, TransactionPlayerMeta>;
  /** The season being played now, so "current" can be told from "historical". */
  currentSeason: string;
  /** Current rosters, for composition preferences. */
  rosters?: { rosterId: number; playerIds: string[] }[];
}

export interface ManagerProfile {
  userId: string;
  displayName: string;
  isMine: boolean;
  /** Current-season seat, when the manager still has one. */
  rosterId: number | null;
  seasons: string[];
  /** Dollars left this season, or null when either half is unknown. */
  remainingFaab: number | null;
  budget: number | null;

  /** Mean bid as a share of that season's budget, across bids placed. */
  aggression: Tendency;
  /** The largest single bid observed, as a share of budget. */
  topBid: Tendency;
  /** Mean bid share by position, for positions that cleared their threshold. */
  bidByPosition: Record<string, Tendency>;
  /** Winning claims ÷ claims placed. Low means they are routinely outbid. */
  winRate: Tendency;
  /** Adds per active week — how much they churn the back of the roster. */
  churn: Tendency;
  /** Completed trades per season. */
  tradesPerSeason: Tendency;
  /** Share of their completed trades that they filed. */
  initiates: Tendency;
  /** Share of FAAB dollars spent on QB and TE. */
  qbTeSpend: Tendency;
  /** Share of adds who were in their first two seasons. */
  rookieLean: Tendency;
  /** Share of the current roster that is a running back. */
  rbDepth: Tendency;

  /**
   * Set when this season's behaviour clears its own threshold and points the
   * other way from the record. When true, `aggression` already reflects this
   * season — the flag exists so the explanation can say so.
   */
  contradictsHistory: boolean;
  /** One line per tendency worth stating. Safe to show verbatim. */
  summary: string[];
}

interface BidObservation {
  season: string;
  share: number;
  dollars: number;
  position: string | null;
  won: boolean;
}

/**
 * Build one profile per manager who has a seat in the league.
 *
 * Managers with no seat in any supplied season are not invented: a user who
 * left the league is not somebody the user can trade with or be outbid by.
 */
export function buildManagerProfiles(input: ManagerProfileInput): ManagerProfile[] {
  const budgetBySeason = new Map<string, number>();
  const seatsByLeagueRoster = new Map<string, ManagerSeat>();
  for (const seat of input.seats) {
    if (seat.budget != null && seat.budget > 0) budgetBySeason.set(seat.season, seat.budget);
    seatsByLeagueRoster.set(`${seat.sleeperLeagueId}:${seat.rosterId}`, seat);
  }

  const byUser = new Map<string, ManagerSeat[]>();
  for (const seat of input.seats) {
    if (!seat.userId) continue;
    const list = byUser.get(seat.userId) ?? [];
    list.push(seat);
    byUser.set(seat.userId, list);
  }

  const rosterById = new Map((input.rosters ?? []).map((r) => [r.rosterId, r.playerIds]));

  /*
   * Attribute every transaction to a manager through the seat table.
   *
   * A transaction that cannot be attributed — a roster with no recorded owner,
   * a league-season whose seats were never synced — is dropped rather than
   * assigned to whoever holds that roster id now.
   */
  const bids = new Map<string, BidObservation[]>();
  const addsByUser = new Map<string, { season: string; week: number; position: string | null; yearsExp: number | null }[]>();
  const tradesByUser = new Map<string, { season: string; filed: boolean }[]>();
  const activeWeeks = new Map<string, Set<string>>();

  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };

  const ownerOf = (t: LeagueTransaction, rosterId: number): ManagerSeat | null =>
    seatsByLeagueRoster.get(`${t.sleeperLeagueId}:${rosterId}`) ?? null;

  for (const t of input.transactions) {
    if (t.type === 'trade') {
      for (const rosterId of t.rosterIds) {
        const seat = ownerOf(t, rosterId);
        if (!seat?.userId || t.status !== 'complete') continue;
        push(tradesByUser, seat.userId, { season: t.season, filed: t.creatorUserId === seat.userId });
        if (!activeWeeks.has(seat.userId)) activeWeeks.set(seat.userId, new Set());
        activeWeeks.get(seat.userId)!.add(`${t.season}:${t.week}`);
      }
      continue;
    }

    const rosterId = t.adds[0]?.rosterId ?? t.rosterIds[0];
    if (rosterId == null) continue;
    const seat = ownerOf(t, rosterId);
    if (!seat?.userId) continue;
    const userId = seat.userId;

    if (!activeWeeks.has(userId)) activeWeeks.set(userId, new Set());
    activeWeeks.get(userId)!.add(`${t.season}:${t.week}`);

    const primary = t.adds[0];
    const meta = primary ? input.playerMeta.get(primary.sleeperPlayerId) : undefined;

    if (t.status === 'complete') {
      for (const add of t.adds) {
        const addMeta = input.playerMeta.get(add.sleeperPlayerId);
        push(addsByUser, userId, {
          season: t.season,
          week: t.week,
          position: addMeta?.position ?? null,
          yearsExp: addMeta?.yearsExp ?? null,
        });
      }
    }

    if (t.type === 'waiver' && t.waiverBid != null) {
      const budget = budgetBySeason.get(t.season) ?? null;
      // A bid with no known budget behind it has no comparable magnitude, so it
      // counts towards activity and towards nothing else.
      if (budget && budget > 0) {
        push(bids, userId, {
          season: t.season,
          share: t.waiverBid / budget,
          dollars: t.waiverBid,
          position: meta?.position ?? null,
          won: t.status === 'complete',
        });
      }
    }
  }

  const profiles: ManagerProfile[] = [];
  for (const [userId, seats] of byUser) {
    const ordered = [...seats].sort((a, b) => a.season.localeCompare(b.season));
    const current = ordered.find((s) => s.season === input.currentSeason) ?? ordered[ordered.length - 1]!;
    const observed = bids.get(userId) ?? [];
    const adds = addsByUser.get(userId) ?? [];
    const trades = tradesByUser.get(userId) ?? [];
    const weeks = activeWeeks.get(userId)?.size ?? 0;

    const { aggression, contradicts } = aggressionOf(observed, input.currentSeason);

    const seasons = [...new Set(ordered.map((s) => s.season))];
    const budget = current.budget ?? null;
    const remainingFaab =
      budget != null && current.waiverBudgetUsed != null ? Math.max(0, budget - current.waiverBudgetUsed) : null;

    const rosterPlayers = current.season === input.currentSeason ? (rosterById.get(current.rosterId) ?? []) : [];
    const rosterPositions = rosterPlayers
      .map((id) => input.playerMeta.get(id)?.position ?? null)
      .filter((p): p is string => p != null);

    const profile: ManagerProfile = {
      userId,
      displayName: current.displayName ?? `Roster ${current.rosterId}`,
      isMine: ordered.some((s) => s.isMine && s.season === input.currentSeason),
      rosterId: current.season === input.currentSeason ? current.rosterId : null,
      seasons,
      remainingFaab,
      budget,
      aggression,
      topBid: tendency(
        observed.length >= SAMPLE_THRESHOLDS.bids ? [Math.max(...observed.map((b) => b.share))] : [],
        1,
        (v) => `has gone as high as ${pct(v)} of budget on one player`,
      ),
      bidByPosition: bidsByPosition(observed),
      winRate: tendency(
        observed.map((b) => (b.won ? 1 : 0)),
        SAMPLE_THRESHOLDS.bids,
        (v, n) => `wins ${pct(v)} of the claims they place (${n})`,
      ),
      churn: tendency(
        weeks >= SAMPLE_THRESHOLDS.activeWeeks ? [adds.length / weeks] : [],
        1,
        (v) => `adds about ${v.toFixed(1)} player(s) in an active week`,
      ),
      tradesPerSeason: tendency(
        trades.length >= SAMPLE_THRESHOLDS.trades ? [trades.length / Math.max(1, seasons.length)] : [],
        1,
        (v) => `completes about ${v.toFixed(1)} trade(s) a season`,
      ),
      initiates: tendency(
        trades.length >= SAMPLE_THRESHOLDS.trades ? trades.map((t) => (t.filed ? 1 : 0)) : [],
        SAMPLE_THRESHOLDS.trades,
        (v) => `files ${pct(v)} of the trades they complete`,
      ),
      qbTeSpend: qbTeSpendOf(observed),
      rookieLean: tendency(
        adds.filter((a) => a.yearsExp != null).map((a) => ((a.yearsExp ?? 9) <= 1 ? 1 : 0)),
        SAMPLE_THRESHOLDS.bids,
        (v) => `${pct(v)} of their adds are first- or second-year players`,
      ),
      rbDepth: tendency(
        rosterPositions.length >= SAMPLE_THRESHOLDS.rosterSlots
          ? rosterPositions.map((p) => (p === 'RB' ? 1 : 0))
          : [],
        SAMPLE_THRESHOLDS.rosterSlots,
        (v) => `carries ${pct(v)} of their roster at running back`,
      ),
      contradictsHistory: contradicts,
      summary: [],
    };

    profile.summary = summarize(profile);
    profiles.push(profile);
  }

  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Aggression, weighted towards what they are doing now.
 *
 * The current season is doubled rather than made absolute: one aggressive week
 * in September should tilt the estimate, not erase three years of restraint.
 * When the current season has enough bids of its own *and* lands on the other
 * side of the historical mean by more than a fifth of a budget, it is reported
 * alone and the contradiction is flagged — at that point the record is
 * describing a manager who no longer exists.
 */
function aggressionOf(observed: BidObservation[], currentSeason: string): { aggression: Tendency; contradicts: boolean } {
  const currentBids = observed.filter((b) => b.season === currentSeason);
  const historic = observed.filter((b) => b.season !== currentSeason);

  if (currentBids.length >= SAMPLE_THRESHOLDS.bids && historic.length >= SAMPLE_THRESHOLDS.bids) {
    const now = mean(currentBids.map((b) => b.share));
    const before = mean(historic.map((b) => b.share));
    if (Math.abs(now - before) >= 0.2) {
      return {
        aggression: {
          value: round3(now),
          sample: currentBids.length,
          threshold: SAMPLE_THRESHOLDS.bids,
          sufficient: true,
          note: `bids ${pct(now)} of budget this season, against ${pct(before)} historically — this season is used`,
        },
        contradicts: true,
      };
    }
  }

  /*
   * The threshold counts observations, not weighted copies.
   *
   * Recency weighting is done by repeating this season's bids in the array the
   * mean is taken over — which would also double the length of that array, and
   * three bids would silently clear a threshold of four. So the sample test is
   * made against `observed` and only the mean is taken over the weighted copy.
   * Getting this backwards is how a sample-size rule quietly stops existing.
   */
  if (observed.length < SAMPLE_THRESHOLDS.bids) {
    return {
      aggression: tendency(
        observed.map((b) => b.share),
        SAMPLE_THRESHOLDS.bids,
        () => '',
      ),
      contradicts: false,
    };
  }

  const weighted: number[] = [];
  for (const b of observed) {
    weighted.push(b.share);
    if (b.season === currentSeason) weighted.push(b.share);
  }
  const value = round3(mean(weighted));
  return {
    aggression: {
      value,
      sample: observed.length,
      threshold: SAMPLE_THRESHOLDS.bids,
      sufficient: true,
      note: `bids about ${pct(value)} of budget (${observed.length} observations)`,
    },
    contradicts: false,
  };
}

function bidsByPosition(observed: BidObservation[]): Record<string, Tendency> {
  const out: Record<string, Tendency> = {};
  const groups = new Map<string, number[]>();
  for (const b of observed) {
    if (!b.position) continue;
    const list = groups.get(b.position) ?? [];
    list.push(b.share);
    groups.set(b.position, list);
  }
  for (const [position, shares] of groups) {
    const t = tendency(shares, SAMPLE_THRESHOLDS.positionBids, (v, n) => `${pct(v)} of budget on a ${position} (${n})`);
    if (t.sufficient) out[position] = t;
  }
  return out;
}

/**
 * Share of FAAB dollars spent at quarterback and tight end.
 *
 * Dollars rather than claims, because the question this answers is "will they
 * outbid me for this quarterback", and a manager who makes twenty $1 claims at
 * receiver and one $40 claim at quarterback is a quarterback spender.
 */
function qbTeSpendOf(observed: BidObservation[]): Tendency {
  const won = observed.filter((b) => b.won && b.position != null);
  const total = won.reduce((a, b) => a + b.dollars, 0);
  if (won.length < SAMPLE_THRESHOLDS.bids || total <= 0) {
    return {
      value: null,
      sample: won.length,
      threshold: SAMPLE_THRESHOLDS.bids,
      sufficient: false,
      note: won.length === 0 ? 'has never won a priced claim' : 'too few priced claims to split by position',
    };
  }
  const premium = won.filter((b) => b.position === 'QB' || b.position === 'TE').reduce((a, b) => a + b.dollars, 0);
  const share = premium / total;
  return {
    value: round3(share),
    sample: won.length,
    threshold: SAMPLE_THRESHOLDS.bids,
    sufficient: true,
    note: `${pct(share)} of the FAAB they have spent went on a QB or TE`,
  };
}

/**
 * The bounded modifier a price model is allowed to apply for this manager.
 *
 * Returns a multiplier centred on 1. An unmeasured manager returns exactly 1 —
 * no evidence means no effect, not a league-average nudge, which would be an
 * opinion dressed as arithmetic.
 */
export function aggressionModifier(profile: ManagerProfile, leagueMeanShare: number): number {
  if (!profile.aggression.sufficient || profile.aggression.value == null || leagueMeanShare <= 0) return 1;
  const ratio = profile.aggression.value / leagueMeanShare;
  return clamp(ratio, 1 - MAX_AGGRESSION_EFFECT, 1 + MAX_AGGRESSION_EFFECT);
}

/** The league's own mean bid share, which is what a manager is compared against. */
export function leagueMeanBidShare(transactions: LeagueTransaction[], budgetBySeason: Map<string, number>): number | null {
  const shares: number[] = [];
  for (const t of [...winningBids(transactions), ...losingBids(transactions)]) {
    const budget = budgetBySeason.get(t.season);
    if (budget && budget > 0) shares.push((t.waiverBid ?? 0) / budget);
  }
  return shares.length > 0 ? round3(mean(shares)) : null;
}

function summarize(p: ManagerProfile): string[] {
  const lines: string[] = [];
  if (p.aggression.sufficient) lines.push(p.aggression.note);
  if (p.contradictsHistory) lines.push('their bidding this season does not match previous seasons');
  if (p.winRate.sufficient && p.winRate.value != null && p.winRate.value < 0.4) {
    lines.push('routinely outbid — they place claims more often than they win them');
  }
  if (p.qbTeSpend.sufficient) lines.push(p.qbTeSpend.note);
  if (p.churn.sufficient) lines.push(p.churn.note);
  if (p.tradesPerSeason.sufficient) lines.push(p.tradesPerSeason.note);
  else lines.push('no trade history to speak of');
  if (p.rbDepth.sufficient && p.rbDepth.value != null && p.rbDepth.value >= 0.4) {
    lines.push('hoards running backs');
  }
  if (p.remainingFaab != null && p.budget != null) {
    lines.push(`$${p.remainingFaab} of $${p.budget} FAAB left`);
  }
  return lines;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
