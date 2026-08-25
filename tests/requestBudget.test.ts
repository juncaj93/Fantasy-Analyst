/**
 * The budget primitive, at the level where its guarantees are actually made.
 *
 * Everything the cron promises rests on three properties of this class, and
 * each of them is a property rather than a behaviour — something the code
 * cannot violate rather than something it happens not to do:
 *
 *   1. `used` can never exceed `limit`, because the check happens *before* the
 *      request rather than after it;
 *   2. a retry costs what a retry costs, because the counter wraps `fetch` and
 *      not the method above it;
 *   3. an allowance is a cap on a shared pool and never a second charge against
 *      it — the double-counting bug that made an invocation report 48/48 having
 *      sent 38.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExhaustedError,
  budgetedFetch,
  CLOUDFLARE_FREE_SUBREQUEST_CEILING,
  MAX_CRON_SUBREQUESTS,
  REDIRECTING_FETCH_COST,
  RequestBudget,
} from '../src/core/sleeper/budget.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';

describe('the request budget counts what goes out', () => {
  it('spends, reports and refuses at exactly the limit', () => {
    const budget = new RequestBudget(3);
    expect(budget.remaining).toBe(3);

    budget.spend();
    budget.spend();
    expect(budget.used).toBe(2);
    expect(budget.remaining).toBe(1);
    expect(budget.exhausted).toBe(false);

    // The third is allowed. The limit is a limit, not a target to stay under.
    budget.spend();
    expect(budget.used).toBe(3);
    expect(budget.exhausted).toBe(true);

    expect(() => budget.spend()).toThrow(BudgetExhaustedError);
    // And the refusal did not move the counter, so `used` is still the truth.
    expect(budget.used).toBe(3);
  });

  it('refuses before the request rather than after it', async () => {
    const budget = new RequestBudget(2);
    const inner = vi.fn(async () => new Response('{}', { status: 200 }));
    const fetchImpl = budgetedFetch(budget, inner);

    await fetchImpl('https://example.test/1');
    await fetchImpl('https://example.test/2');
    // Thrown rather than rejected: the check is synchronous and happens before
    // a promise exists, which is what "before the request" means literally.
    expect(() => fetchImpl('https://example.test/3')).toThrow(BudgetExhaustedError);

    // Two calls, not three: the refused one never reached the transport, which
    // is the difference between a budget and a report.
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('charges a retried call once per attempt', async () => {
    const budget = new RequestBudget(10);
    const client = new SleeperClient({
      retries: 2,
      fetch: budgetedFetch(budget, async () => new Response('boom', { status: 500 })),
    });

    await expect(client.getState()).rejects.toThrow();

    // One logical call, three subrequests. A counter above `get` would say one,
    // and an invocation trusting it would go over on a bad afternoon.
    expect(budget.used).toBe(3);
  });

  it('charges a redirecting host what the redirect really costs', async () => {
    const budget = new RequestBudget(10);
    const inner = vi.fn(async () => new Response(null, { status: 304 }));
    const fetchImpl = budgetedFetch(budget, inner, { cost: REDIRECTING_FETCH_COST });

    await fetchImpl('https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv');

    // One call, two subrequests: `fetch` follows the 302 to the signed asset
    // URL itself, and a 304 does not escape it — the redirect is issued before
    // the validator is considered.
    expect(budget.used).toBe(REDIRECTING_FETCH_COST);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('refuses a costly call it cannot pay for in full', async () => {
    const budget = new RequestBudget(3);
    budget.spend();
    budget.spend();
    const inner = vi.fn(async () => new Response('{}', { status: 200 }));
    const fetchImpl = budgetedFetch(budget, inner, { cost: 2 });

    // One unit left and the call costs two. Spending the unit would put the
    // invocation over the moment `fetch` followed the redirect.
    expect(() => fetchImpl('https://github.test/x')).toThrow(BudgetExhaustedError);
    expect(inner).not.toHaveBeenCalled();
    expect(budget.used).toBe(2);
  });
});

describe('an allowance caps a share of the pool without charging it', () => {
  it('is clamped to what is left', () => {
    const budget = new RequestBudget(48);
    for (let i = 0; i < 40; i++) budget.spend();

    // Asked for twenty-four, given eight, because eight is what exists.
    expect(budget.allowance(24).limit).toBe(8);
  });

  it('is zero when nothing is left, and a zero allowance is exhausted', () => {
    const budget = new RequestBudget(2);
    budget.spend();
    budget.spend();

    const allowance = budget.allowance(24);
    expect(allowance.limit).toBe(0);
    expect(allowance.remaining).toBe(0);
    expect(allowance.exhausted).toBe(true);
    expect(allowance.canAfford(1)).toBe(false);

    /*
     * Which is the whole of "skipped, not failed". A subsystem handed this asks
     * whether it can afford a unit, is told no, and stops — no request, no
     * throw, and a checkpoint left exactly where it was for tomorrow.
     */
  });

  it('does not spend the budget it was drawn from', () => {
    const budget = new RequestBudget(48);
    const allowance = budget.allowance(10);

    allowance.spend();
    allowance.spend();

    expect(allowance.used).toBe(2);
    /*
     * Zero, and this is the bug the method's doc is about. The subsystem runs
     * on the shared metered transport, so the invocation is charged there —
     * once. An allowance that also charged it would count every request twice
     * and stop work that had room, which reads exactly like going over.
     */
    expect(budget.used).toBe(0);
  });
});

describe('the ceiling the numbers are set against', () => {
  it('leaves headroom under the free plan', () => {
    expect(CLOUDFLARE_FREE_SUBREQUEST_CEILING).toBe(50);
    expect(MAX_CRON_SUBREQUESTS).toBeLessThan(CLOUDFLARE_FREE_SUBREQUEST_CEILING);
    /*
     * The gap is not decoration. Nothing can count a subrequest it does not
     * initiate, so it covers the one class of mistake the design cannot rule
     * out: a step added to the cron later that fetches without being handed the
     * budget. Two is enough for one such call, redirect included.
     */
    expect(CLOUDFLARE_FREE_SUBREQUEST_CEILING - MAX_CRON_SUBREQUESTS).toBeGreaterThanOrEqual(REDIRECTING_FETCH_COST);
  });
});
