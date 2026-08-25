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
 *
 * ## One budget for the whole invocation
 *
 * This started as the manager backfill's own counter and that was half a fix.
 * Cloudflare counts subrequests per *invocation*, not per subsystem, so a
 * bounded batch inside an unbounded cron proves nothing: the 09:00 tick also
 * syncs the player dictionary, the injury report, per-game usage, the season
 * market, the schedule, the trending list, the calibration ledger, the
 * published projections and three nflverse files, and every one of those is a
 * subrequest against the same fifty. The batch was budgeted; the invocation was
 * not, and a bad afternoon at Sleeper could still put the whole tick past the
 * ceiling with the batch's own counter reading a comfortable 24/24.
 *
 * So {@link MAX_CRON_SUBREQUESTS} is the real ceiling, one budget covers the
 * whole 09:00 branch of `worker/index.ts`, and every subsystem on it spends the
 * same one — the Sleeper client through {@link SleeperClient.withFetch}, every
 * conditional-GET feed through its injected `fetch`, the Vegas provider through
 * its own. What the manager backfill gets is a {@link RequestBudget.allowance}
 * against that budget: a cap on how much of the pool it may take, while the
 * pool itself is counted once, at the transport, for every subsystem alike.
 */

import type { FetchLike } from './client.ts';

/**
 * The most Sleeper requests one bounded batch may make.
 *
 * Two jobs now, and they were the same job when this was the only bound that
 * existed:
 *
 *   - on the daily cron it is the **upper** bound on an allowance that is
 *     otherwise whatever the tick has left. A quiet morning leaves more than
 *     twenty-four unspent and the batch still takes twenty-four, because a
 *     batch four times the usual size on an arbitrary Tuesday is a surprise
 *     nobody asked for and the work converges over days either way;
 *   - on `POST /api/leagues/:id/managers/refresh`, where a person is hurrying
 *     the backfill along, it is the whole bound. That invocation makes no other
 *     external calls, so twenty-four against a ceiling of fifty is honest on
 *     its own.
 *
 * The headroom it used to represent is now {@link MAX_CRON_SUBREQUESTS}'s job,
 * which is the change that matters: this number stopped being the thing keeping
 * the invocation under fifty on the day the tick around it grew past it.
 *
 * Lowering it costs days of backfill and nothing else. Raising it past about
 * thirty would start to matter, and nothing here should want to.
 */
export const MAX_SLEEPER_SUBREQUESTS_PER_BATCH = 24;

/**
 * Every external subrequest the daily 09:00 invocation may make, all in.
 *
 * Cloudflare's free plan allows fifty per invocation and answers the fifty-first
 * with an error, so this is the ceiling itself rather than a target — and the
 * budget is set two below it. The two are not superstition. Nothing here can
 * see a subrequest it does not initiate, and there are two kinds it would miss:
 * a redirect hop taken inside a `fetch` this code called once (see
 * {@link REDIRECTING_FETCH_COST}, which handles the redirects we know about),
 * and any future step added to the cron that fetches without being handed the
 * budget. Two units is what stands between the second of those and an outage.
 */
export const MAX_CRON_SUBREQUESTS = 48;

/**
 * The hard limit the budget exists to stay under. Documentation, and the number
 * the worst-case test asserts against.
 */
export const CLOUDFLARE_FREE_SUBREQUEST_CEILING = 50;

/**
 * What one attempt against a redirecting host actually costs on the wire.
 *
 * Every nflverse file this app reads is a GitHub release asset, and
 * `github.com/nflverse/nflverse-data/releases/download/...` answers **302** with
 * a signed `release-assets.githubusercontent.com` URL. `fetch` follows that hop
 * itself, so one call this code makes is two subrequests Cloudflare counts, and
 * a wrapper around `fetch` sees one. It is the same undercount the logical-call
 * counter had, one layer down, and it is worth exactly as much: seven
 * nflverse-family reads on the daily tick are fourteen subrequests, not seven,
 * which is most of the headroom this lane was written to protect.
 *
 * A conditional request does not escape it — the 302 is issued before the
 * validator is ever considered, so a 304 costs two as well.
 *
 * Sleeper does not redirect and is charged one.
 */
export const REDIRECTING_FETCH_COST = 2;

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
 * A spend counter for one invocation's worth of external traffic.
 *
 * Deliberately not a rate limiter: one invocation gets one budget, it is
 * consumed, and it is thrown away. Nothing persists it, because the thing that
 * must survive an invocation is where the work got to — which is the
 * checkpoint's job — and not how many requests it took to get there.
 *
 * Shared, now, across every subsystem on the tick rather than owned by one of
 * them: one budget, one metered transport, and every external call on the tick
 * goes through it. A subsystem that needs a bound of its own takes an
 * {@link allowance} — a cap on how much of the shared pool it may use, and
 * deliberately not a second charge against it.
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
  spend(units = 1): void {
    const cost = Math.max(1, Math.floor(units));
    if (this.spent + cost > this.limit) {
      this.refused = true;
      throw new BudgetExhaustedError(this.limit, this.spent);
    }
    this.spent += cost;
  }

  /**
   * A second budget for a subsystem that needs a cap of its own, clamped to
   * what this one has left.
   *
   * `allowance(24)` on a budget with six remaining is a budget of six, not a
   * promise that cannot be kept — so a planner asking it how much work to plan
   * gets an answer the invocation can actually pay for.
   *
   * **It does not charge this budget, and it must not be given a transport this
   * budget already meters.** That combination is the trap, and it is an easy one
   * to walk into: the subsystem's own wrapper spends the allowance, the wrapper
   * underneath spends the invocation, and one request on the wire is charged
   * twice — an invocation that reports 48/48 having sent 38 stops work it had
   * budget for, which is a quieter failure than going over and a harder one to
   * see. The rule is one charging point per request: the shared transport counts
   * the wire, and this counts how much of it one subsystem may use.
   */
  allowance(limit: number): RequestBudget {
    return new RequestBudget(Math.max(0, Math.min(Math.floor(limit), this.remaining)));
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
export function budgetedFetch(
  budget: RequestBudget,
  inner: FetchLike = (url, init) => fetch(url, init),
  opts: { cost?: number } = {},
): FetchLike {
  const cost = Math.max(1, Math.floor(opts.cost ?? 1));
  return (url, init) => {
    budget.spend(cost);
    return inner(url, init);
  };
}
