/**
 * How each manager works the wire, measured against how his room works it.
 *
 * The waiver half of manager intelligence, and the one with the most to say.
 * A draft tendency describes twelve decisions a year; a transaction tendency
 * describes two hundred, and the sample is correspondingly less fragile. What
 * comes out is not a personality — it is six or seven rates, each one a
 * fraction with a denominator, each one shrunk toward the room.
 *
 * ## Everything is relative to the room
 *
 * A league where the median winning bid is $1 and a league where it is $28 are
 * both normal, and a manager who bids $12 is unremarkable in one and reckless
 * in the other. So no absolute number leaves this file as a tendency: shares of
 * budget rather than dollars, rates per active week rather than counts, and
 * every one of them divided by the league's own figure before it is called a
 * habit. An aggressive room should not make all twelve of its managers look
 * individually aggressive.
 *
 * ## Shrinkage is the main event
 *
 * A manager with four claims has a history, not a rate. Every measurement here
 * is pulled toward the league baseline by `n / (n + k)`, so a thin sample says
 * almost exactly what the room says and a thick one is allowed to differ. This
 * is not a safety margin bolted on at the end — it is applied at the point of
 * measurement, so `relative` is *already* the honest number and no consumer has
 * to remember to discount it.
 *
 * ## What this is not allowed to become
 *
 * It never touches what a player is worth. A rival who spends heavily makes a
 * claim more expensive and more contested; he does not make the player better.
 * `core/waivers/managerPressure.ts` owns the bounded translation into cost and
 * competition context, and the boundary is enforced there — this file produces
 * evidence and reaches nothing.
 */

import { isFinalised, type LedgerTransaction } from './ledger.ts';

export const TRANSACTION_PROFILE_VERSION = 1;

export const TXN_SHRINK = {
  /**
   * Active weeks of history below which a per-week rate is mostly the room's.
   *
   * Six is about a third of a season. At six the manager's own rate carries
   * half the weight, which is the right place for a number that will be quoted
   * as "more active than the room" — it takes most of a season to earn that
   * sentence and a bad fortnight cannot buy it.
   */
  weeks: 6,
  /**
   * Bids below which a spending habit is mostly the room's.
   *
   * Four, one more than `MIN_BIDS_FOR_TENDENCY` in `core/league/bidders.ts`,
   * and for the same reason that module gives: three bids is not a
   * distribution. The difference is that nothing here refuses to produce a
   * number below the threshold — it produces one that has been shrunk almost
   * all the way to the league's, which degrades gracefully instead of falling
   * off a cliff at the fourth bid.
   */
  bids: 4,
  /** Adds at one position below which no position-specific claim is made. */
  positionAdds: 3,
} as const;

/**
 * The furthest a manager's own history may sit from his room, either way.
 *
 * ±40%, the same bound `core/league/bidders.ts` already applies to the same
 * quantity — chosen there and matched here so that two modules describing one
 * manager's spending cannot disagree about how extreme he is allowed to look.
 * Note this bounds the *evidence*; the effect it is finally allowed to have on
 * a recommendation is bounded again, and much harder, downstream.
 */
export const MAX_RELATIVE = 0.4;

/** Roughly when in a week a transaction landed. UTC, and approximate. */
export type TransactionWindow = 'waiver' | 'midweek' | 'gameday' | 'postgame';

export interface PositionActivity {
  position: string;
  /** Players of this position he has added, by any route. */
  adds: number;
  /** Of those, ones that came through a waiver claim. */
  claims: number;
  /** His median winning bid at this position, as a share of the budget. */
  medianBidShare: number | null;
  /** His share of adds spent here, divided by the room's. Null below sample. */
  relative: number | null;
}

export interface ManagerTransactionProfile {
  userId: string;
  displayName: string | null;
  seasons: string[];
  /** Weeks of transaction history that could have described him. */
  activeWeeks: number;
  /** Every finalised transaction he took part in. The headline sample. */
  sample: number;
  /** True when the sample supports saying anything at all. */
  usable: boolean;

  /** Waiver claims per active week, shrunk toward the room. */
  claimsPerWeek: number;
  /** Free-agent adds per active week, shrunk toward the room. */
  addsPerWeek: number;
  /** Adds plus drops per active week. The churn reading. */
  churnPerWeek: number;
  /** Activity divided by the room's. 1 means typical. Bounded. */
  activityRelative: number;

  /** Winning bids on record, won and lost. The FAAB sample. */
  bidSample: number;
  /** Median winning bid as a share of the season budget. Null without FAAB. */
  medianBidShare: number | null;
  /** The 75th percentile of the same. What a splurge looks like for him. */
  upperBidShare: number | null;
  /** His median share divided by the room's, shrunk and bounded. Null without FAAB. */
  spendRelative: number | null;
  /** Share of his bids that were at least twice the room's median. */
  bigBidRate: number | null;
  /**
   * Share of his measured spending that happened in the season's first third.
   *
   * The budget-conservation reading. High means he commits early and will be
   * short later; low means he is holding money that is still available to spend
   * against you in week 11.
   */
  earlySpendShare: number | null;

  byPosition: PositionActivity[];
  /** Share of his transactions in each window. Empty when timestamps are absent. */
  timing: { window: TransactionWindow; share: number }[];

  /**
   * In [0,1]. How much of the *rate* readings are his own rather than the room's.
   *
   * Driven by active weeks, because that is a rate's denominator: a manager
   * observed across fourteen weeks has a well-measured claims-per-week whether
   * the answer is four or zero.
   */
  confidence: number;
  /**
   * The same thing for the *spending* readings, and a separate number on purpose.
   *
   * Its denominator is bids, not weeks, and the two come apart constantly — a
   * manager can be observed for a whole season and place two claims. Weighting
   * `spendRelative` by {@link ManagerTransactionProfile.confidence} would give
   * his two bids the same say as another manager's forty, which is exactly the
   * mistake the shrinkage exists to prevent.
   */
  spendConfidence: number;
  /** Developer-facing sentences. Never user copy. */
  notes: string[];
}

export interface LeagueTransactionBaseline {
  seasons: string[];
  /** Managers the baseline was computed over. */
  managers: number;
  /** Weeks of transaction history read, summed across seasons. */
  weeksRead: number;
  /** The room's median claims per manager per active week. */
  claimsPerWeek: number;
  addsPerWeek: number;
  churnPerWeek: number;
  /** True when any bid amount was ever published in this league. */
  usesFaab: boolean;
  /** The room's median winning bid as a share of the budget. */
  medianBidShare: number | null;
  /** Winning bids behind that median. */
  bidSample: number;
  /** Share of all adds spent at each position, room-wide. */
  positionShare: { position: string; share: number }[];
  /** Total finalised transactions the baseline rests on. */
  sample: number;
}

export interface TransactionProfileInput {
  /** Every finalised-or-not transaction in the ledger, already user-resolved. */
  transactions: readonly LedgerTransaction[];
  /** Active weeks of transaction history, per season. */
  weeksBySeason: ReadonlyMap<string, number>;
  /** Which seasons each user was in the league for. */
  seasonsByUser: ReadonlyMap<string, string[]>;
  /** The league's FAAB budget, for turning dollars into shares. */
  budgetTotal: number | null;
  /** Player id -> position, for the position-specific reading. */
  positionOf: (playerId: string) => string | null;
  displayNames?: ReadonlyMap<string, string | null>;
  /** The last week a claim can still buy a regular-season game. */
  finalWeek?: number;
}

/**
 * What the room does, so a manager can be described against it.
 *
 * Computed over exactly the transactions the managers are measured against, for
 * the same reason `managerTendencies.ts` computes its room median over the same
 * picks: a manager who is "more active than the room" must not be more active
 * than a differently-scoped room.
 */
export function buildLeagueTransactionBaseline(input: TransactionProfileInput): LeagueTransactionBaseline {
  const finalised = input.transactions.filter((t) => isFinalised(t.status));
  const seasons = [...new Set(finalised.map((t) => t.season))].sort();
  const weeksRead = [...input.weeksBySeason.values()].reduce((a, w) => a + w, 0);
  const managers = new Set<string>();
  for (const txn of finalised) for (const userId of txn.userIds) managers.add(userId);

  let claims = 0;
  let adds = 0;
  let churn = 0;
  const bidShares: number[] = [];
  const positionAdds = new Map<string, number>();
  let totalAdds = 0;
  let sawAnyBid = false;

  for (const txn of finalised) {
    const perManager = Math.max(1, txn.userIds.length);
    if (txn.type === 'waiver') claims += perManager;
    if (txn.type === 'free_agent') adds += perManager;
    for (const list of txn.addsByUser.values()) churn += list.length;
    for (const list of txn.dropsByUser.values()) churn += list.length;

    if (txn.waiverBid != null) {
      sawAnyBid = true;
      if (input.budgetTotal && input.budgetTotal > 0) bidShares.push(txn.waiverBid / input.budgetTotal);
    }

    /*
     * Position mix over *adds only*.
     *
     * A trade moves players in both directions and says nothing about which
     * position the wire is short of; counting it here would let one three-for-
     * three deal outweigh a month of waiver activity.
     */
    if (txn.type === 'waiver' || txn.type === 'free_agent') {
      for (const list of txn.addsByUser.values()) {
        for (const playerId of list) {
          const position = input.positionOf(playerId);
          if (!position) continue;
          positionAdds.set(position, (positionAdds.get(position) ?? 0) + 1);
          totalAdds += 1;
        }
      }
    }
  }

  /*
   * Per manager per week, not per league per week.
   *
   * The figure a manager's own rate is divided by has to be on his scale, or a
   * twelve-team league makes every individual look a twelfth as active as the
   * room and the ratio stops meaning anything.
   */
  const managerWeeks = Math.max(1, weeksRead * Math.max(1, managers.size));

  return {
    seasons,
    managers: managers.size,
    weeksRead,
    claimsPerWeek: round3(claims / managerWeeks),
    addsPerWeek: round3(adds / managerWeeks),
    churnPerWeek: round3(churn / managerWeeks),
    usesFaab: sawAnyBid,
    medianBidShare: bidShares.length > 0 ? round3(median(bidShares.sort((a, b) => a - b))) : null,
    bidSample: bidShares.length,
    positionShare: [...positionAdds.entries()]
      .map(([position, count]) => ({ position, share: round3(totalAdds > 0 ? count / totalAdds : 0) }))
      .sort((a, b) => b.share - a.share),
    sample: finalised.length,
  };
}

/** Nothing known. A new manager, an unmapped identity, an empty ledger. */
export function neutralTransactionProfile(
  userId: string,
  displayName: string | null = null,
): ManagerTransactionProfile {
  return {
    userId,
    displayName,
    seasons: [],
    activeWeeks: 0,
    sample: 0,
    usable: false,
    claimsPerWeek: 0,
    addsPerWeek: 0,
    churnPerWeek: 0,
    activityRelative: 1,
    bidSample: 0,
    medianBidShare: null,
    upperBidShare: null,
    spendRelative: null,
    bigBidRate: null,
    earlySpendShare: null,
    byPosition: [],
    timing: [],
    confidence: 0,
    spendConfidence: 0,
    notes: ['no transaction history on record'],
  };
}

/**
 * Every manager's transaction profile, in one pass over the ledger.
 *
 * One pass and one baseline rather than a baseline per manager: computing the
 * room inside a per-manager loop would measure each of them against a room that
 * included himself to a different degree, which is the mistake that makes the
 * most active manager in a small league look average.
 */
export function buildTransactionProfiles(
  input: TransactionProfileInput,
  baseline: LeagueTransactionBaseline = buildLeagueTransactionBaseline(input),
): Map<string, ManagerTransactionProfile> {
  const finalised = input.transactions.filter((t) => isFinalised(t.status));
  const out = new Map<string, ManagerTransactionProfile>();

  const byUser = new Map<string, LedgerTransaction[]>();
  for (const txn of finalised) {
    for (const userId of txn.userIds) {
      const list = byUser.get(userId);
      if (list) list.push(txn);
      else byUser.set(userId, [txn]);
    }
  }

  for (const [userId, mine] of byUser) {
    out.set(
      userId,
      profileFor({
        userId,
        mine,
        input,
        baseline,
        displayName: input.displayNames?.get(userId) ?? null,
      }),
    );
  }

  return out;
}

function profileFor(args: {
  userId: string;
  mine: LedgerTransaction[];
  input: TransactionProfileInput;
  baseline: LeagueTransactionBaseline;
  displayName: string | null;
}): ManagerTransactionProfile {
  const { userId, mine, input, baseline, displayName } = args;

  const seasons = [...new Set(mine.map((t) => t.season))].sort();
  /*
   * The denominator: weeks of history that could have described *him*.
   *
   * Summed over the seasons he was actually in the league for, not over every
   * season the ledger holds. A manager who joined this year must not be divided
   * by three years of weeks and reported as a third as active as he is.
   */
  const hisSeasons = input.seasonsByUser.get(userId) ?? seasons;
  let activeWeeks = 0;
  for (const season of hisSeasons) activeWeeks += input.weeksBySeason.get(season) ?? 0;
  activeWeeks = Math.max(activeWeeks, seasons.length > 0 ? 1 : 0);

  const claims = mine.filter((t) => t.type === 'waiver').length;
  const adds = mine.filter((t) => t.type === 'free_agent').length;
  let churnEvents = 0;
  for (const txn of mine) {
    churnEvents += (txn.addsByUser.get(userId) ?? []).length;
    churnEvents += (txn.dropsByUser.get(userId) ?? []).length;
  }

  const weight = activeWeeks > 0 ? activeWeeks / (activeWeeks + TXN_SHRINK.weeks) : 0;
  const rate = (count: number, roomRate: number): number =>
    round3(shrink(activeWeeks > 0 ? count / activeWeeks : roomRate, roomRate, weight));

  const claimsPerWeek = rate(claims, baseline.claimsPerWeek);
  const addsPerWeek = rate(adds, baseline.addsPerWeek);
  const churnPerWeek = rate(churnEvents, baseline.churnPerWeek);

  const roomActivity = baseline.claimsPerWeek + baseline.addsPerWeek;
  const activityRelative =
    roomActivity > 0 ? boundedRelative((claimsPerWeek + addsPerWeek) / roomActivity) : 1;

  // ------------------------------------------------------------------ FAAB --
  const bids = mine
    .filter((t) => t.type === 'waiver' && t.waiverBid != null)
    .map((t) => ({ amount: t.waiverBid!, week: t.week, txn: t }));
  const budgetTotal = input.budgetTotal;
  const shares = budgetTotal && budgetTotal > 0 ? bids.map((b) => b.amount / budgetTotal).sort((a, b) => a - b) : [];

  const bidWeight = shares.length > 0 ? shares.length / (shares.length + TXN_SHRINK.bids) : 0;
  const rawMedianShare = shares.length > 0 ? median(shares) : null;
  const medianBidShare =
    rawMedianShare != null && baseline.medianBidShare != null
      ? round3(shrink(rawMedianShare, baseline.medianBidShare, bidWeight))
      : rawMedianShare != null
        ? round3(rawMedianShare)
        : null;
  const upperBidShare = shares.length > 0 ? round3(percentile(shares, 0.75)) : null;
  const spendRelative =
    medianBidShare != null && baseline.medianBidShare != null && baseline.medianBidShare > 0
      ? boundedRelative(medianBidShare / baseline.medianBidShare)
      : null;

  /*
   * How often he goes big, as a rate rather than as a maximum.
   *
   * The maximum is the number people reach for and it is the wrong one: every
   * manager has one panic bid, and a profile built on the largest thing anybody
   * ever did describes twelve identical managers. "Twice the room's median" is
   * an event that happens repeatedly to somebody who bids that way and once to
   * everybody else.
   */
  const bigBidRate =
    shares.length > 0 && baseline.medianBidShare != null && baseline.medianBidShare > 0
      ? round3(shares.filter((s) => s >= 2 * baseline.medianBidShare!).length / shares.length)
      : null;

  /*
   * When the money went out.
   *
   * The first third of the fantasy regular season against the rest. A manager
   * who commits early has less to spend against you in November whatever his
   * median bid says, and a manager who holds it is a live threat all season —
   * which is the part of a wallet a remaining-balance column cannot show,
   * because the balance only tells you about the money that is already gone.
   */
  const finalWeek = input.finalWeek ?? 14;
  const earlyCutoff = Math.max(1, Math.round(finalWeek / 3));
  const spent = bids.reduce((sum, b) => sum + b.amount, 0);
  const earlySpendShare =
    spent > 0
      ? round3(bids.filter((b) => b.week > 0 && b.week <= earlyCutoff).reduce((sum, b) => sum + b.amount, 0) / spent)
      : null;

  // -------------------------------------------------------------- positions --
  const byPosition = positionActivity({ userId, mine, input, baseline });

  // ----------------------------------------------------------------- timing --
  const timing = timingWindows(mine);

  const sample = mine.length;
  /*
   * Usable is a floor on the *denominator*, not on enthusiasm.
   *
   * Four active weeks and six transactions is the point at which a rate stops
   * being one busy afternoon. Below it every number above is still computed —
   * they are almost entirely the room's by then — but nothing downstream is
   * permitted to quote them as this manager's habit.
   */
  const usable = activeWeeks >= 4 && sample >= 6;
  const confidence = round3(Math.min(weight, 1));

  return {
    userId,
    displayName,
    seasons,
    activeWeeks,
    sample,
    usable,
    claimsPerWeek,
    addsPerWeek,
    churnPerWeek,
    activityRelative,
    bidSample: bids.length,
    medianBidShare,
    upperBidShare,
    spendRelative,
    bigBidRate,
    earlySpendShare,
    byPosition,
    timing,
    confidence,
    spendConfidence: round3(bidWeight),
    notes: notesFor({ sample, activeWeeks, usable, activityRelative, spendRelative, bigBidRate, byPosition }),
  };
}

function positionActivity(args: {
  userId: string;
  mine: LedgerTransaction[];
  input: TransactionProfileInput;
  baseline: LeagueTransactionBaseline;
}): PositionActivity[] {
  const { userId, mine, input, baseline } = args;
  const adds = new Map<string, number>();
  const claims = new Map<string, number>();
  const bidShares = new Map<string, number[]>();
  let total = 0;

  for (const txn of mine) {
    if (txn.type !== 'waiver' && txn.type !== 'free_agent') continue;
    for (const playerId of txn.addsByUser.get(userId) ?? []) {
      const position = input.positionOf(playerId);
      if (!position) continue;
      adds.set(position, (adds.get(position) ?? 0) + 1);
      total += 1;
      if (txn.type === 'waiver') claims.set(position, (claims.get(position) ?? 0) + 1);
      if (txn.waiverBid != null && input.budgetTotal && input.budgetTotal > 0) {
        const list = bidShares.get(position);
        const share = txn.waiverBid / input.budgetTotal;
        if (list) list.push(share);
        else bidShares.set(position, [share]);
      }
    }
  }

  const roomShare = new Map(baseline.positionShare.map((p) => [p.position, p.share]));

  return [...adds.entries()]
    .map(([position, count]) => {
      const shares = (bidShares.get(position) ?? []).sort((a, b) => a - b);
      const mine = total > 0 ? count / total : 0;
      const room = roomShare.get(position) ?? 0;
      return {
        position,
        adds: count,
        claims: claims.get(position) ?? 0,
        medianBidShare: shares.length > 0 ? round3(median(shares)) : null,
        /*
         * Below the sample floor the position claim is withheld entirely rather
         * than shrunk. A per-position rate has a tenth of the sample the
         * headline rate does, and "he chases running backs" off two adds is the
         * exact sentence this system must never produce.
         */
        relative:
          count >= TXN_SHRINK.positionAdds && room > 0 ? boundedRelative(mine / room) : null,
      };
    })
    .sort((a, b) => b.adds - a.adds);
}

/**
 * Which part of the week his moves land in.
 *
 * Days in UTC, and the labels are approximations rather than claims about a
 * league's own waiver clock — Sleeper publishes an epoch and not a schedule, so
 * a Tuesday-night run in New York is a Wednesday here. That is good enough for
 * what this is used for, which is urgency: a manager whose activity is almost
 * all in the waiver window plans, and one whose activity is on Sunday is
 * reacting to inactives. Neither reading needs the hour to be right.
 *
 * Empty when no transaction carries a timestamp, which is honest rather than
 * defaulted — an absent window must not read as a balanced one.
 */
export function timingWindows(
  transactions: readonly LedgerTransaction[],
): { window: TransactionWindow; share: number }[] {
  const stamped = transactions.filter((t) => t.createdAtMs != null && t.createdAtMs > 0);
  if (stamped.length === 0) return [];

  const counts = new Map<TransactionWindow, number>();
  for (const txn of stamped) {
    const window = windowOf(new Date(txn.createdAtMs!).getUTCDay());
    counts.set(window, (counts.get(window) ?? 0) + 1);
  }

  return (['waiver', 'midweek', 'gameday', 'postgame'] as const)
    .map((window) => ({ window, share: round3((counts.get(window) ?? 0) / stamped.length) }))
    .filter((entry) => entry.share > 0);
}

function windowOf(utcDay: number): TransactionWindow {
  // 0 Sunday .. 6 Saturday.
  if (utcDay === 2 || utcDay === 3) return 'waiver';
  if (utcDay === 4 || utcDay === 5) return 'midweek';
  if (utcDay === 0 || utcDay === 6) return 'gameday';
  return 'postgame';
}

function notesFor(p: {
  sample: number;
  activeWeeks: number;
  usable: boolean;
  activityRelative: number;
  spendRelative: number | null;
  bigBidRate: number | null;
  byPosition: PositionActivity[];
}): string[] {
  if (!p.usable) {
    return [`${p.sample} transaction(s) across ${p.activeWeeks} active week(s) — below the minimum to describe a habit`];
  }
  const notes: string[] = [];
  if (p.activityRelative >= 1.15) notes.push(`active on the wire (${p.activityRelative}x the room)`);
  if (p.activityRelative <= 0.85) notes.push(`quiet on the wire (${p.activityRelative}x the room)`);
  if (p.spendRelative != null && p.spendRelative >= 1.15) notes.push(`bids above the room (${p.spendRelative}x)`);
  if (p.spendRelative != null && p.spendRelative <= 0.85) notes.push(`bids below the room (${p.spendRelative}x)`);
  if (p.bigBidRate != null && p.bigBidRate >= 0.25) notes.push(`${Math.round(p.bigBidRate * 100)}% of his bids are double the room's median`);
  for (const position of p.byPosition.slice(0, 2)) {
    if (position.relative != null && position.relative >= 1.2) {
      notes.push(`spends a larger share of his adds on ${position.position} (${position.relative}x, ${position.adds} adds)`);
    }
  }
  return notes.length > 0 ? notes : ['history is usable and sits close to the room on every reading'];
}

/** `n / (n + k)` applied: `weight` toward the observation, the rest to the room. */
function shrink(observed: number, room: number, weight: number): number {
  if (!Number.isFinite(observed)) return room;
  return weight * observed + (1 - weight) * room;
}

/** A ratio, clamped to the band a manager is allowed to differ from his room by. */
function boundedRelative(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return round3(Math.min(1 + MAX_RELATIVE, Math.max(1 - MAX_RELATIVE, ratio)));
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Nearest-rank, like `core/faab/bids.ts`: every value is a real bid. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
