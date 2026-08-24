/**
 * How many requests one Worker invocation is allowed to make, enforced.
 *
 * Cloudflare's free plan caps a Worker invocation at **50 subrequests**. The
 * historical manager refresh this app used to run needed about sixty-six — one
 * league lookup, one roster read, eighteen transaction weeks and every
 * completed draft, three seasons deep — and it failed in production for exactly
 * that reason. The answer is not a paid plan and not a shorter history; it is a
 * budget, a checkpoint and several days.
 *
 * ## Counted at the transport, not at the call
 *
 * The obvious implementation counts logical calls — "we made twelve requests" —
 * and it is wrong in the one case that matters. `SleeperClient` retries a 5xx
 * twice, so a single `getTransactions` can be three real subrequests, and a bad
 * afternoon at Sleeper is precisely when an invocation would sail past the
 * ceiling while the logical counter read comfortably low.
 *
 * So the budget wraps `fetch` itself. Every network call is counted, retries
 * included, and the check happens *before* the call goes out — which makes the
 * limit an invariant rather than a measurement. `used` can never exceed `limit`,
 * so a test that asserts it is asserting something the code cannot violate.
 *
 * ## Exhaustion is an outcome, not a failure
 *
 * Running out of budget mid-backfill is the expected steady state of the first
 * few days, not an error. {@link BudgetExhaustedError} exists so a caller can
 * tell it apart from a Sleeper outage: the backfill catches it, leaves the
 * checkpoint where it was, and the next scheduled run picks the same unit up.
 * Anything else that throws is a real failure and is recorded as one.
 */

import type { FetchLike } from './client.ts';

/**
 * Sleeper requests one bounded batch may make.
 *
 * Twenty-four against a ceiling of fifty. The headroom is deliberate and is not
 * a rounding-up: the same invocation that advances the manager backfill also
 * syncs the player dictionary, the injury report, per-game usage, the season
 * market lines, the trending list, the current league's transactions and three
 * nflverse files — see the daily cron in `worker/index.ts` — and every one of
 * those is a subrequest against the same fifty. A budget set near the ceiling
 * would be a budget that works until the day another feed is added.
 *
 * Lowering it costs days of backfill and nothing else. Raising it past about
 * thirty would start to matter, and nothing here should want to.
 */
export const MAX_SLEEPER_SUBREQUESTS_PER_BATCH = 24;

/**
 * Thrown instead of making the request that would have gone over.
 *
 * Carries the budget's own numbers so a caller reporting "stopped early" can
 * say how early without re-reading the budget it was handed.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super(`Sleeper request budget exhausted: ${used}/${limit} used`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface BudgetSnapshot {
  limit: number;
  used: number;
  remaining: number;
  /** True once a request has actually been refused. */
  exhausted: boolean;
}

/**
 * A spend counter for one invocation's worth of Sleeper traffic.
 *
 * Deliberately not a rate limiter and deliberately not shared: one batch gets
 * one budget, it is consumed, and it is thrown away. Nothing persists it,
 * because the thing that must survive an invocation is where the work got to
 * — which is the checkpoint's job — and not how many requests it took to get
 * there.
 */
export class RequestBudget {
  private spent = 0;
  private refused = false;

  constructor(readonly limit: number = MAX_SLEEPER_SUBREQUESTS_PER_BATCH) {}

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  /** True once a request has been refused, so a caller can stop cleanly. */
  get exhausted(): boolean {
    return this.refused || this.remaining === 0;
  }

  /**
   * Whether a unit of work that will cost `cost` requests can still be started.
   *
   * Asked *before* a unit rather than before each request, because a half-done
   * unit is the thing checkpointing exists to avoid: a season's draft costs a
   * league lookup plus a picks read, and spending the first with no budget for
   * the second buys nothing and still has to be repeated.
   */
  canAfford(cost = 1): boolean {
    return !this.refused && this.remaining >= cost;
  }

  /**
   * Reserve one request, or refuse.
   *
   * The single place `used` moves. Returns nothing on success and throws
   * {@link BudgetExhaustedError} otherwise — no boolean, because a caller that
   * forgets to check a boolean makes the request anyway and the invariant this
   * class exists for is gone.
   */
  spend(): void {
    if (this.spent + 1 > this.limit) {
      this.refused = true;
      throw new BudgetExhaustedError(this.limit, this.spent);
    }
    this.spent += 1;
  }

  snapshot(): BudgetSnapshot {
    return { limit: this.limit, used: this.spent, remaining: this.remaining, exhausted: this.exhausted };
  }
}

/**
 * Wrap a transport so every call it makes is counted against a budget.
 *
 * The wrapping is what makes retries honest. `SleeperClient` calls its injected
 * `fetch` once per attempt, so a request retried twice spends three, which is
 * what actually happened on the wire and what the free-plan ceiling actually
 * counts.
 */
export function budgetedFetch(budget: RequestBudget, inner: FetchLike = (url, init) => fetch(url, init)): FetchLike {
  return (url, init) => {
    budget.spend();
    return inner(url, init);
  };
}
