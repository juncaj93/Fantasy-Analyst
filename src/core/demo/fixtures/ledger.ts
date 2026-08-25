/**
 * What the room has actually done this season, transaction by transaction.
 *
 * ## Why this exists at all
 *
 * Demo Mode used to answer every manager-intelligence question with `null`, and
 * the reasoning was sound as far as it went: a tendency needs a sample, the live
 * feature builds one by walking a league's history, and a demo that *stated* a
 * tendency would be demonstrating a claim the product cannot make.
 *
 * That reasoning rules out stating the conclusion. It does not rule out stating
 * the history. Everything else in `fixtures/` works by writing down what a
 * provider would have said and letting the production engines reach the
 * verdict, and a manager's ledger is no different from a market line: Sleeper
 * publishes a list of transactions, this file writes one, and
 * `buildTransactionProfiles`, `buildTradeTendencies` and `summarisePrices` —
 * the same functions the nightly backfill runs — decide what it means. Nothing
 * here says anybody is aggressive, and nothing here says what a claim will cost.
 *
 * ## What is written down
 *
 * Six weeks of a twelve-team season in Sleeper's own `SleeperTransaction`
 * shape: waiver claims that won and claims that lost, free-agent adds, and two
 * trades. Each manager has a *habit* — how often they claim, how much of the
 * budget they spend when they do, which positions they chase — and the
 * transactions are generated from it, deterministically, because writing four
 * hundred rows by hand would make this file unreadable without making a single
 * scenario better.
 *
 * The habits are deliberately unlike each other, because the whole value of the
 * column is contrast: one manager claims almost every week and pays for it, one
 * has not made a claim since September, and most are somewhere in between. A
 * room where everybody behaves identically would produce a working feature that
 * says nothing.
 *
 * The spend here is the *history*. What each roster has left is a separate
 * fact, stated on the rosters themselves and read by `buildBudgetState`, and the
 * two are written to agree.
 */

import type { SleeperTransaction } from '../../sleeper/types.ts';
import { DEMO_MANAGERS, MY_ROSTER_ID, WORLD_PLAYERS } from './world.ts';

/** The weeks of transaction history this ledger covers. */
export const LEDGER_WEEKS = [1, 2, 3, 4, 5, 6];

/**
 * One manager's habit, as the two numbers a ledger actually shows.
 *
 * `claimWeeks` is which weeks they entered a claim in — a list rather than a
 * rate, so the sample is a fact rather than a rounding — and `bids` is what
 * they paid, in order, cycled if they claim more often than they have bids
 * written. `lost` marks the weeks the claim failed, which is the only window
 * anybody has onto what the rest of the room was willing to pay.
 */
interface ManagerHabit {
  rosterId: number;
  claimWeeks: number[];
  bids: number[];
  /**
   * Weeks whose claim failed rather than landed. A subset of `claimWeeks`.
   *
   * Sleeper publishes the amount on a failed claim, which is the only visible
   * evidence of what somebody *else* was willing to pay — so a ledger with no
   * failed claims in it produces a price summary that says the losing side is
   * unknown, and the demo would never show the highest-losing-bid reading.
   */
  lostWeeks?: number[];
  /** Free-agent adds — the cheap half of activity, and it costs nothing. */
  addWeeks: number[];
  /** The positions this manager chases, cycled across their adds. */
  positions: string[];
}

/**
 * The room.
 *
 * Spend across the six weeks is written to land where each roster's
 * `waiver_budget_used` says it did, so the ledger and the wallet cannot
 * disagree — a manager who is shown as having spent $88 has $88 of claims here.
 */
const HABITS: ManagerHabit[] = [
  /* Tony's Pizza: quiet, cheap, and mostly on the free-agent wire. */
  { rosterId: 1, claimWeeks: [2, 5], bids: [7, 5], addWeeks: [1, 3, 4, 6], positions: ['RB', 'WR'] },
  /* Sunday Scaries: claims most weeks and pays up. The one to worry about. */
  { rosterId: 2, claimWeeks: [1, 2, 3, 4, 5, 6], bids: [22, 14, 9, 11, 8, 7], addWeeks: [2, 5], positions: ['WR', 'RB', 'TE'] },
  /* The Nurse: a mid-sized budget spent on tight ends, of all things — and one
     claim in week four that somebody else outbid, which is the only window
     anybody has onto what the room was willing to pay. */
  { rosterId: 3, claimWeeks: [1, 3, 4, 6], bids: [19, 15, 10, 10], lostWeeks: [4], addWeeks: [2], positions: ['TE', 'TE', 'WR'] },
  /* Waiver Wire Weasels: the name is aspirational. Four dollars all season. */
  { rosterId: 4, claimWeeks: [3], bids: [8], addWeeks: [1, 2, 4, 5, 6], positions: ['RB'] },
  /* Hanna: spent almost the whole budget by week five and cannot bid now. */
  { rosterId: 5, claimWeeks: [1, 2, 4, 5], bids: [41, 26, 15, 11], addWeeks: [3], positions: ['RB', 'RB', 'WR'] },
  /* Fourth and Long: steady, unremarkable, and always in for a few dollars. */
  { rosterId: 6, claimWeeks: [2, 4, 6], bids: [12, 10, 8], addWeeks: [1, 5], positions: ['WR', 'RB'] },
  /* Marchetti: trades rather than claims, and the ledger shows both. */
  { rosterId: 7, claimWeeks: [1, 3, 5], bids: [24, 18, 13], addWeeks: [6], positions: ['RB', 'WR'] },
  /* Bex: two claims, both small. */
  { rosterId: 8, claimWeeks: [2, 6], bids: [13, 9], addWeeks: [3, 4], positions: ['WR', 'TE'] },
  /* You. Disciplined so far, which is why there is a wallet left to spend. */
  { rosterId: MY_ROSTER_ID, claimWeeks: [1, 3, 5], bids: [21, 16, 8], addWeeks: [2, 6], positions: ['WR', 'RB', 'TE'] },
  /* Turf Toe Titans: has not made a claim since the first week. */
  { rosterId: 10, claimWeeks: [1], bids: [4], addWeeks: [2, 3], positions: ['RB'] },
  /* Bye Week Blues: nearly out of money, and it went early. */
  { rosterId: 11, claimWeeks: [1, 2, 3, 4, 6], bids: [33, 27, 17, 11, 14], lostWeeks: [6], addWeeks: [5], positions: ['WR', 'RB'] },
  /* The twelfth seat: mid-table in every reading, which a room needs. */
  { rosterId: 12, claimWeeks: [2, 3, 5], bids: [18, 14, 9], addWeeks: [1, 4, 6], positions: ['TE', 'WR', 'RB'] },
];

/**
 * The Wednesday run, and what it cost the three managers who won something.
 *
 * The reader's own claim is the first line of the plan the Tuesday scenario
 * shows — same player, same price — because a demo that recommends a claim on
 * one screen and shows a different one having landed on the next is telling two
 * stories about one week.
 */
export const WEEK_SEVEN_RUN = new Map<number, { bid: number }>([
  [MY_ROSTER_ID, { bid: 27 }],
  [2, { bid: 9 }],
  [6, { bid: 17 }],
]);

/** What each roster has spent, from the ledger rather than beside it. */
export function spendByRosterId(opts: { throughWeek?: number } = {}): Map<number, number> {
  const through = opts.throughWeek ?? LEDGER_WEEKS.at(-1)!;
  const out = new Map<number, number>();
  for (const habit of HABITS) {
    let spent = 0;
    habit.claimWeeks.forEach((week, i) => {
      if (week > through) return;
      if (habit.lostWeeks?.includes(week)) return;
      spent += habit.bids[i % habit.bids.length] ?? 0;
    });
    if (through > 6) spent += WEEK_SEVEN_RUN.get(habit.rosterId)?.bid ?? 0;
    out.set(habit.rosterId, spent);
  }
  return out;
}

/**
 * The pool historical transactions move players out of.
 *
 * Deliberately the deep end of the world: a claim from week two is about
 * somebody nobody is arguing about in week seven, and using the headline
 * players would put a receiver on two rosters in the reader's own past.
 */
const HISTORY_POOL = WORLD_PLAYERS.filter((p) => /^p(1[5-9]\d|2\d\d)$/.test(p.id));

function poolFor(position: string): string[] {
  const matching = HISTORY_POOL.filter((p) => p.position === position).map((p) => p.id);
  return matching.length > 0 ? matching : HISTORY_POOL.map((p) => p.id);
}

/** The instant a week's waiver run processes, as epoch milliseconds. */
function processedAt(season: string, week: number): number {
  /* Wednesday morning of that week, on the same anchor the slate uses. */
  const weekSixWednesday = Date.UTC(2026, 9, 7, 12, 0, 0);
  const year = Number(season);
  const seasonOffset = Number.isFinite(year) ? (year - 2026) * 365 * 24 * 3_600_000 : 0;
  return weekSixWednesday + (week - 6) * 7 * 24 * 3_600_000 + seasonOffset;
}

/**
 * The season's transactions, in Sleeper's own shape.
 *
 * Everything downstream — the price summary, the bidder profiles, the trade
 * tendencies — reads these through the same code the live app reads a real
 * league's through. Nothing is pre-digested.
 */
export function demoTransactions(season: string, opts: { throughWeek?: number } = {}): SleeperTransaction[] {
  const out: SleeperTransaction[] = [];
  const through = opts.throughWeek ?? LEDGER_WEEKS.at(-1)!;
  let sequence = 0;
  const nextId = () => `demo-txn-${String(++sequence).padStart(4, '0')}`;

  for (const habit of HABITS) {
    const weeks = [...habit.claimWeeks, ...(through > 6 ? (WEEK_SEVEN_RUN.get(habit.rosterId) ? [7] : []) : [])];
    weeks.forEach((week, i) => {
      if (week > through) return;
      const position = habit.positions[i % habit.positions.length]!;
      const candidates = poolFor(position);
      const added = candidates[(habit.rosterId * 3 + i * 5) % candidates.length]!;
      const droppedPool = poolFor(habit.positions[(i + 1) % habit.positions.length]!);
      const dropped = droppedPool[(habit.rosterId * 7 + i * 3 + 11) % droppedPool.length]!;
      const failed = habit.lostWeeks?.includes(week) ?? false;
      out.push({
        transaction_id: nextId(),
        type: 'waiver',
        status: failed ? 'failed' : 'complete',
        created: processedAt(season, week),
        leg: week,
        roster_ids: [habit.rosterId],
        /* A failed claim adds nobody, which is the whole difference. */
        adds: failed ? {} : { [added]: habit.rosterId },
        drops: failed || added === dropped ? {} : { [dropped]: habit.rosterId },
        settings: { waiver_bid: week === 7 ? (WEEK_SEVEN_RUN.get(habit.rosterId)?.bid ?? 0) : (habit.bids[i % habit.bids.length] ?? 0) },
        creator: `owner-${habit.rosterId}`,
      });
    });

    habit.addWeeks.forEach((week, i) => {
      if (week > through) return;
      const position = habit.positions[(i + 1) % habit.positions.length]!;
      const candidates = poolFor(position);
      const added = candidates[(habit.rosterId * 5 + i * 7 + 3) % candidates.length]!;
      out.push({
        transaction_id: nextId(),
        type: 'free_agent',
        status: 'complete',
        created: processedAt(season, week) + 36 * 3_600_000,
        leg: week,
        roster_ids: [habit.rosterId],
        adds: { [added]: habit.rosterId },
        drops: {},
        settings: {},
        creator: `owner-${habit.rosterId}`,
      });
    });
  }

  /*
   * Two trades, because one is an anecdote.
   *
   * They are what gives `buildTradeTendencies` anything to read, and they are
   * between named managers on purpose: the trade screen's partner context is
   * about a person, and a room where every trade involved a different pair
   * would produce twelve managers each with a sample of one.
   */
  out.push(
    tradeBetween({
      id: nextId(),
      season,
      week: 3,
      a: { rosterId: 7, gives: ['p163'], gets: ['p171'] },
      b: { rosterId: 2, gives: ['p171'], gets: ['p163'] },
    }),
    tradeBetween({
      id: nextId(),
      season,
      week: 5,
      a: { rosterId: 7, gives: ['p185'], gets: ['p192'] },
      b: { rosterId: 12, gives: ['p192'], gets: ['p185'] },
    }),
  );

  return out;
}

function tradeBetween(opts: {
  id: string;
  season: string;
  week: number;
  a: { rosterId: number; gives: string[]; gets: string[] };
  b: { rosterId: number; gives: string[]; gets: string[] };
}): SleeperTransaction {
  const adds: Record<string, number> = {};
  const drops: Record<string, number> = {};
  for (const playerId of opts.a.gets) adds[playerId] = opts.a.rosterId;
  for (const playerId of opts.a.gives) drops[playerId] = opts.a.rosterId;
  for (const playerId of opts.b.gets) adds[playerId] = opts.b.rosterId;
  for (const playerId of opts.b.gives) drops[playerId] = opts.b.rosterId;
  return {
    transaction_id: opts.id,
    type: 'trade',
    status: 'complete',
    created: processedAt(opts.season, opts.week) + 60 * 3_600_000,
    leg: opts.week,
    roster_ids: [opts.a.rosterId, opts.b.rosterId],
    adds,
    drops,
    settings: {},
    creator: `owner-${opts.a.rosterId}`,
  };
}

/** Sleeper's own roster-to-user map, which every ledger read is keyed on. */
export function userByRoster(): Map<number, string> {
  return new Map(DEMO_MANAGERS.map((m) => [m.rosterId, `owner-${m.rosterId}`]));
}

/** Display names, by user id, for the profiles that print one. */
export function displayNames(): Map<string, string | null> {
  return new Map(DEMO_MANAGERS.map((m) => [`owner-${m.rosterId}`, m.name]));
}
