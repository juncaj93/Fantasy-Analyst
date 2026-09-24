/**
 * Requests to the odds provider, spaced to the plan's per-minute ceiling.
 *
 * The free SportsGameOdds plan allows ten requests a minute (docs/VEGAS.md,
 * measured against `/v2/account/usage`). A refresh used to fire every request
 * it planned back to back, so a pass that began with a schedule discovery — nine
 * requests in a second — had one left for the games, and the rest came back
 * `rate limited`. On 24 September 2026 that refused the Patriots game at 03:55
 * and again at 11:44, which is why Stevenson, Henderson and Maye sat on a
 * Tuesday snapshot all day.
 *
 * This is a sliding window: at most `limit` requests in any `windowMs`, waiting
 * when the next one would break it. Waiting costs a Worker wall time, not CPU,
 * but a person pressing refresh is waiting too, so the total wait per pass is
 * capped at `maxWaitMs`. A request that would need more is not sent at all —
 * {@link RequestPacer.admit} says no, and the caller treats it exactly like a
 * refusal from the provider: nothing billed, left for the next pass.
 *
 * One pacer per provider instance, and a provider is built per invocation, so
 * this paces one pass. It cannot see a probe or another deployment sharing the
 * key; a `429` from one of those is still possible, and is handled as a refusal.
 */

/** The plan's ceiling, from the account's own `rateLimits['per-minute']`. */
export const SGO_REQUESTS_PER_MINUTE = 10;

/**
 * A second past the minute, so a clock that disagrees with the provider's by a
 * few hundred milliseconds does not land the eleventh request inside its window.
 */
export const SGO_WINDOW_MS = 61_000;

/**
 * The most one pass will wait in total.
 *
 * One full window and a little over, so a pass can send twenty requests: a
 * schedule discovery (nine, on 24 September) and every game a week plans. It
 * stays well inside the Refresh Vegas workflow's `--max-time 180`, which
 * matters — a Worker answering a request its caller has abandoned may be cut
 * off mid-pass. Anything past it waits for the next pass, which is what
 * happened to all of it before.
 */
export const SGO_MAX_WAIT_MS = 75_000;

export interface PacerOptions {
  limit?: number;
  windowMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RequestPacer {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sent: number[] = [];
  private waitLeft: number;

  constructor(opts: PacerOptions = {}) {
    this.limit = opts.limit ?? SGO_REQUESTS_PER_MINUTE;
    this.windowMs = opts.windowMs ?? SGO_WINDOW_MS;
    this.waitLeft = opts.maxWaitMs ?? SGO_MAX_WAIT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Wait until one more request fits the window, and count it as sent.
   *
   * Resolves `false`, without waiting and without counting, when the wait would
   * run past what is left of this pass's allowance.
   */
  async admit(): Promise<boolean> {
    let at = this.now();
    this.forget(at);
    if (this.sent.length >= this.limit) {
      const wait = this.sent[0]! + this.windowMs - at;
      if (wait > this.waitLeft) return false;
      this.waitLeft -= wait;
      await this.sleep(wait);
      at = this.now();
      this.forget(at);
    }
    this.sent.push(at);
    return true;
  }

  private forget(at: number): void {
    while (this.sent.length > 0 && at - this.sent[0]! >= this.windowMs) this.sent.shift();
  }
}
