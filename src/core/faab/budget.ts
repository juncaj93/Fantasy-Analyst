/**
 * What every manager in this league actually has left to spend.
 *
 * This module exists because the single most common way a FAAB tool lies is by
 * assuming the budget. `$100` is the Sleeper default, not the league's rule, and
 * a $200 league reading `$100` will call a perfectly ordinary bid reckless while
 * a $50 league reading `$100` will cheerfully recommend twice the money that
 * exists. So the budget is read from the league's own settings, and when the
 * league does not say, **this returns unknown and every consumer degrades**.
 * Nothing here invents a number to keep a card looking complete.
 *
 * Spend is read the same way: Sleeper keeps a running `waiver_budget_used` on
 * each roster's settings, which is authoritative and cheap. Transactions are
 * used only to cross-check it and to explain it, never to replace it — a
 * reconstruction from one week of transactions against a season of spending is
 * how a tool ends up confidently reporting the wrong remaining budget.
 */

import type { SleeperTransaction } from '../sleeper/types.ts';

/** Sleeper's own setting keys, in the order they are trusted. */
const BUDGET_KEYS = ['waiver_budget'] as const;
/** The waiver type Sleeper uses for FAAB bidding, as opposed to rolling priority. */
const FAAB_WAIVER_TYPE = 2;

export interface LeagueBudgetRule {
  /**
   * The season budget every roster started with, or null when the league
   * settings do not say. Null is a first-class answer.
   */
  total: number | null;
  /**
   * Whether this league bids at all. A rolling-priority or reverse-standings
   * league has no bids to advise on, and saying so is better than producing
   * dollar figures nobody can spend.
   */
  usesFaab: boolean;
  /** Why we believe the above, in one phrase, for the card's own footnote. */
  provenance: string;
}

export interface RosterBudget {
  rosterId: number;
  ownerName: string | null;
  isMine: boolean;
  /** Null whenever the league total is unknown — remaining is a subtraction. */
  remaining: number | null;
  spent: number | null;
  /** `remaining / total`, 0–1, or null. Comparable across leagues; dollars are not. */
  share: number | null;
}

export interface LeagueBudgetState {
  rule: LeagueBudgetRule;
  rosters: RosterBudget[];
  /** Notes worth surfacing — a disagreement found, a roster with no settings. */
  notes: string[];
}

/**
 * Read the league's waiver rule from Sleeper's settings blob.
 *
 * `waiver_type` distinguishes FAAB from rolling priority. A league that does not
 * publish one is treated as bidding *only* if it publishes a budget, because a
 * budget is meaningless in a priority league and its presence is the stronger
 * evidence of the two.
 */
export function readBudgetRule(leagueSettings: Record<string, unknown> | null | undefined): LeagueBudgetRule {
  const settings = leagueSettings ?? {};

  let total: number | null = null;
  for (const key of BUDGET_KEYS) {
    const raw = settings[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value > 0) {
      total = Math.round(value);
      break;
    }
  }

  const waiverTypeRaw = settings['waiver_type'];
  const waiverType =
    typeof waiverTypeRaw === 'number'
      ? waiverTypeRaw
      : typeof waiverTypeRaw === 'string' && waiverTypeRaw.trim() !== ''
        ? Number(waiverTypeRaw)
        : null;

  if (waiverType != null && Number.isFinite(waiverType)) {
    const usesFaab = waiverType === FAAB_WAIVER_TYPE;
    return {
      total: usesFaab ? total : null,
      usesFaab,
      provenance: usesFaab
        ? total != null
          ? `league settings: FAAB, $${total} per team`
          : 'league settings: FAAB, but no budget published'
        : 'league settings: waiver priority, not FAAB',
    };
  }

  if (total != null) {
    return { total, usesFaab: true, provenance: `league settings: $${total} waiver budget` };
  }
  return { total: null, usesFaab: false, provenance: 'league settings do not publish a waiver budget' };
}

/**
 * How much of the budget a roster has spent, straight from Sleeper.
 *
 * Absent is null, not zero. A roster whose settings did not come back has not
 * been proven to have spent nothing, and the difference matters: zero would
 * make him look like the richest manager in the league.
 */
export function readSpend(roster: { settings?: Record<string, unknown> | null }): number | null {
  const raw = roster.settings?.['waiver_budget_used'];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * FAAB spent on waiver claims, reconstructed from transactions.
 *
 * Only ever used to *check* Sleeper's own counter — see the module note. A
 * successful waiver claim carries its winning bid in `settings.waiver_bid`; a
 * failed one does not cost anything and is excluded here even though it carries
 * a bid too.
 */
export function spendFromTransactions(transactions: SleeperTransaction[], rosterId: number): number {
  let total = 0;
  for (const txn of transactions) {
    if (txn.type !== 'waiver' || txn.status !== 'complete') continue;
    if (!(txn.roster_ids ?? []).includes(rosterId)) continue;
    const bid = txn.settings?.['waiver_bid'];
    if (typeof bid === 'number' && Number.isFinite(bid) && bid > 0) total += Math.round(bid);
  }
  return total;
}

/**
 * The whole league's budget position.
 *
 * `transactions`, when supplied, buys one thing: a note when the reconstruction
 * and Sleeper's counter disagree. It never overrides the counter. A trade that
 * moved FAAB is exactly the case where a naive reconstruction is wrong and
 * Sleeper is right, which is the point.
 */
export function buildBudgetState(opts: {
  leagueSettings: Record<string, unknown> | null | undefined;
  rosters: {
    rosterId: number;
    ownerName: string | null;
    isMine: boolean;
    settings?: Record<string, unknown> | null;
  }[];
  transactions?: SleeperTransaction[];
}): LeagueBudgetState {
  const rule = readBudgetRule(opts.leagueSettings);
  const notes: string[] = [];

  const rosters: RosterBudget[] = opts.rosters.map((r) => {
    const spent = readSpend({ settings: r.settings ?? null });
    const remaining = rule.total != null && spent != null ? Math.max(0, rule.total - spent) : null;
    return {
      rosterId: r.rosterId,
      ownerName: r.ownerName,
      isMine: r.isMine,
      remaining,
      spent,
      share: remaining != null && rule.total ? round3(remaining / rule.total) : null,
    };
  });

  if (!rule.usesFaab) {
    notes.push('This league does not use FAAB bidding, so no bid advice is given.');
  } else if (rule.total == null) {
    notes.push('Sleeper does not publish this league’s waiver budget, so dollar advice is withheld.');
  }

  const missing = rosters.filter((r) => r.spent == null).length;
  if (rule.usesFaab && missing > 0) {
    notes.push(`${missing} roster(s) report no waiver spend, and are counted as unknown rather than as unspent.`);
  }

  if (opts.transactions && opts.transactions.length > 0 && rule.usesFaab) {
    for (const roster of rosters) {
      if (roster.spent == null) continue;
      const reconstructed = spendFromTransactions(opts.transactions, roster.rosterId);
      /*
       * Only a reconstruction that exceeds the counter is worth a word.
       *
       * Falling short is the normal case and means nothing: the transaction
       * window handed in covers some weeks, and the counter covers the season.
       * Exceeding it cannot be explained that way, so it is reported.
       */
      if (reconstructed > roster.spent) {
        notes.push(
          `Roster ${roster.rosterId}: claims in the weeks read total $${reconstructed}, above Sleeper’s recorded $${roster.spent}. Sleeper’s figure is used.`,
        );
      }
    }
  }

  return { rule, rosters, notes };
}

/** My own budget line, or null when I am not in this league or it is unknown. */
export function myBudget(state: LeagueBudgetState): RosterBudget | null {
  return state.rosters.find((r) => r.isMine) ?? null;
}

/**
 * How many managers I would still out-money at a given spend.
 *
 * The comparison the opportunity-cost card is built on, and it deliberately
 * counts only rosters whose remaining budget is actually known: a roster with no
 * figure is neither above nor below me, and pretending otherwise would put a
 * confident "still above 6/10" on top of four guesses.
 */
export function standingAfterSpend(
  state: LeagueBudgetState,
  spend: number,
): { above: number; comparable: number; below: string[] } | null {
  const mine = myBudget(state);
  if (mine?.remaining == null) return null;
  const after = mine.remaining - spend;
  const others = state.rosters.filter((r) => !r.isMine && r.remaining != null);
  const above = others.filter((r) => after > (r.remaining as number)).length;
  const below = others
    .filter((r) => after < (r.remaining as number))
    .sort((a, b) => (b.remaining as number) - (a.remaining as number))
    .map((r) => r.ownerName ?? `Roster ${r.rosterId}`);
  return { above, comparable: others.length, below };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
