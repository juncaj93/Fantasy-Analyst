/**
 * The Vegas spending limit, and what the app is allowed to do near it.
 *
 * The free plan is measured in **entities**, and one entity is one *event*
 * returned — not one odds object, which is what the earlier notes assumed. A
 * request for a single game costs one entity whether it answers with six lines
 * or with a hundred and ninety-four; a listing costs one per event it returns.
 * All of that was measured against the live account, not read off a docs page:
 * see docs/VEGAS.md for the run.
 *
 * That makes the arithmetic small and the discipline simple. A sixteen-game
 * Sunday is sixteen entities, a roster that spans eight games is eight, and the
 * month's allowance is 2,500. The danger is no longer a single fetch blowing
 * the month — it is a loop nobody is watching: a broad listing on a daily
 * schedule, a page that refreshes on every load, a retry that never backs off.
 *
 * So this module answers one question, `canSpend`, and answers it from the
 * provider's own counter where possible. Nothing else in the app may call a
 * provider without asking first.
 */

/** What the plan allows, and how much of it this app is willing to use. */
export const BUDGET = {
  /** Entities per calendar month on the free plan. Measured, not assumed. */
  monthlyEntities: 2500,

  /**
   * Fractions of the allowance at which behaviour changes.
   *
   * The reserve is the point of the whole thing: the last fifth is kept for
   * game-day refreshes of decisions that are actually close, because that is
   * when a line is worth spending on and when running out would hurt most.
   */
  cautionAt: 0.5,
  conservationAt: 0.7,
  hardStopAt: 0.85,

  /**
   * Requests per minute the plan allows — the one limit a burst can really
   * hit, since the daily and hourly ceilings are in the hundreds of thousands.
   */
  requestsPerMinute: 10,

  /**
   * Never spend more than this in one refresh, whatever the plan says.
   *
   * Nine, not ten: one request per event, and a pass that fills the per-minute
   * allowance exactly has nothing left for a retry. A roster spans eight or
   * nine games in a normal week, so this is a ceiling the ordinary case never
   * reaches — it exists for the week the mapping goes wrong.
   */
  maxEntitiesPerRun: 9,
} as const;

export type BudgetState = 'healthy' | 'caution' | 'conservation' | 'hard_stop';

/**
 * How badly a fetch is wanted.
 *
 * The order matters: as the budget tightens, the cheapest way to stay useful is
 * to keep spending on decisions that are still open and stop spending on
 * players whose week is already decided.
 */
export type FetchPriority = 'critical' | 'normal' | 'low';

export interface BudgetLedger {
  /** Calendar month, `YYYY-MM`, in UTC. */
  month: string;
  /** Entities this app believes it has spent this month. */
  entities: number;
  /** Requests made, for the per-minute ceiling and for diagnostics. */
  requests: number;
  /**
   * The provider's own count, when it has been read.
   *
   * Authoritative when present: the app's ledger cannot see spending from a
   * probe, another deployment, or a run that crashed after the request and
   * before the write. Reading it is free — it does not move the counter.
   */
  providerEntities: number | null;
  providerReadAt: string | null;
}

export interface BudgetView {
  state: BudgetState;
  month: string;
  /** The number the decisions are made from: provider truth if known. */
  used: number;
  limit: number;
  remaining: number;
  /** Remaining above the reserve — what ordinary work may still spend. */
  spendable: number;
  fraction: number;
  /** Whose number `used` is. */
  source: 'provider' | 'ledger';
  note: string;
}

export function monthOf(now: Date | number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function emptyLedger(month = monthOf()): BudgetLedger {
  return { month, entities: 0, requests: 0, providerEntities: null, providerReadAt: null };
}

/** Where the month stands, and what that means. */
export function budgetView(ledger: BudgetLedger, limit: number = BUDGET.monthlyEntities): BudgetView {
  /*
   * The provider's counter wins when it is higher.
   *
   * It is authoritative — but it is also a snapshot, and requests made since it
   * was read are only in our ledger. Taking the larger of the two is the one
   * combination that cannot under-report, which is the only direction that
   * matters when the consequence is an overage.
   */
  const ledgerSaid = ledger.entities;
  const providerSaid = ledger.providerEntities;
  const used = providerSaid == null ? ledgerSaid : Math.max(providerSaid, ledgerSaid);
  const source: BudgetView['source'] = providerSaid != null && providerSaid >= ledgerSaid ? 'provider' : 'ledger';

  const fraction = limit > 0 ? used / limit : 1;
  const state: BudgetState =
    fraction >= BUDGET.hardStopAt
      ? 'hard_stop'
      : fraction >= BUDGET.conservationAt
        ? 'conservation'
        : fraction >= BUDGET.cautionAt
          ? 'caution'
          : 'healthy';

  const remaining = Math.max(0, limit - used);
  const spendable = Math.max(0, Math.floor(limit * BUDGET.hardStopAt) - used);

  return {
    state,
    month: ledger.month,
    used,
    limit,
    remaining,
    spendable,
    fraction: Math.round(fraction * 1000) / 1000,
    source,
    note: NOTES[state],
  };
}

const NOTES: Record<BudgetState, string> = {
  healthy: 'normal targeted refreshes',
  caution: 'low-priority refreshes are being skipped to protect the month',
  conservation: 'only close or uncertain decisions are being refreshed',
  hard_stop: 'into the reserve: nothing but close game-day decisions, and nothing at all once the allowance is gone',
};

/**
 * What each state is still willing to pay for.
 *
 * `hard_stop` is the reserve, not zero: the last fifth of the allowance exists
 * for the Questionable receiver an hour before kickoff, which is the fetch
 * worth arriving at the end of the month with. Zero comes later and is
 * absolute — see the exhaustion check in `canSpend`, which no priority passes.
 */
const ALLOWED: Record<BudgetState, FetchPriority[]> = {
  healthy: ['critical', 'normal', 'low'],
  caution: ['critical', 'normal'],
  conservation: ['critical'],
  hard_stop: ['critical'],
};

export interface SpendDecision {
  allowed: boolean;
  /** How many entities may actually be spent — never more than asked for. */
  entities: number;
  reason: string;
}

/**
 * May this fetch happen, and how much of it?
 *
 * Returns a smaller allowance rather than refusing outright where it can: eight
 * of the roster's games refreshed is better than none, and the plan is ordered
 * by priority so the first eight are the ones worth having.
 */
export function canSpend(
  view: BudgetView,
  request: { entities: number; priority: FetchPriority },
): SpendDecision {
  if (request.entities <= 0) return { allowed: false, entities: 0, reason: 'nothing to fetch' };

  /*
   * The one refusal with no exception.
   *
   * Everything above this line is policy and can be argued with; this is the
   * free plan's own ceiling. Past it the next request is a paid one, and no
   * Vegas data is better than accidental paid usage.
   */
  if (view.remaining <= 0) {
    return {
      allowed: false,
      entities: 0,
      reason: `monthly allowance exhausted (${view.used} of ${view.limit}); serving cached lines only`,
    };
  }

  if (!ALLOWED[view.state].includes(request.priority)) {
    return {
      allowed: false,
      entities: 0,
      reason:
        view.state === 'hard_stop'
          ? `budget hard stop: ${view.used} of ${view.limit} entities used this month`
          : `${request.priority} work is paused at ${Math.round(view.fraction * 100)}% of the monthly allowance`,
    };
  }

  /*
   * Critical work may dip into the reserve; nothing else may.
   *
   * That is what the reserve is for — a Questionable receiver an hour before
   * kickoff is the fetch worth arriving late in the month with.
   */
  const ceiling = request.priority === 'critical' ? view.remaining : view.spendable;
  const capped = Math.min(request.entities, ceiling, BUDGET.maxEntitiesPerRun);

  if (capped <= 0) {
    return {
      allowed: false,
      entities: 0,
      reason: `no budget left for ${request.priority} work (${view.used} of ${view.limit} used)`,
    };
  }
  if (capped < request.entities) {
    return {
      allowed: true,
      entities: capped,
      reason: `trimmed to ${capped} of ${request.entities} to stay inside the monthly allowance`,
    };
  }
  return { allowed: true, entities: capped, reason: `${view.state}: ${capped} entities` };
}

/**
 * The provider's rate-limit payload, reduced to the two numbers we act on.
 *
 * Shape-tolerant on purpose: this is the one place a vendor's JSON is read for
 * accounting, and a renamed field must degrade to "unknown" rather than to a
 * confident zero that would make the app think it had spent nothing.
 */
export function readProviderUsage(payload: unknown): { entities: number | null; limit: number | null } {
  const month = (payload as { rateLimits?: Record<string, Record<string, unknown>> })?.rateLimits?.['per-month'];
  if (!month) return { entities: null, limit: null };
  const entities = Number(month['current-entities']);
  const limit = Number(month['max-entities']);
  return {
    entities: Number.isFinite(entities) ? entities : null,
    limit: Number.isFinite(limit) ? limit : null,
  };
}
