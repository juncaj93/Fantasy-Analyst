/**
 * Time, injected rather than replaced.
 *
 * The app already has a clock convention and it is a good one: everything that
 * depends on the time takes a `now` — `resolveInjury(observations, now)`,
 * `freshnessOf(observedAt, now)`, `seasonFor(now)`, the start/sit engine's
 * `input.now`. Nothing reaches for `Date.now()` behind a caller's back.
 *
 * So Demo Mode does not install a clock. It *supplies* one, and hands it to the
 * same parameters production hands the real time to. That distinction is the
 * whole of §6:
 *
 *   - **no global monkeypatch.** `Date` is untouched. A demo page's timers,
 *     animations, and the browser's own idea of now all still work, and — much
 *     more importantly — nothing outside Demo Mode can be affected by a leak,
 *     because there is nothing to leak.
 *   - **production is real time.** `systemClock` is what every existing caller
 *     already had; it is only named now.
 *   - **demo is scenario time.** A fixed instant per scenario, which is what
 *     makes Tuesday waivers, Sunday pregame, a live slate, a completed week, a
 *     rollover and a draft day reachable without changing device time.
 */

export interface Clock {
  /** The current instant, as a `Date`. Callers must not mutate it. */
  now(): Date;
  /** The same instant, as an ISO string. */
  iso(): string;
  /** Milliseconds since the epoch. */
  ms(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
  ms: () => Date.now(),
};

/**
 * A clock stopped at one instant.
 *
 * Stopped rather than merely offset, and deliberately: §10 requires a scenario
 * to reproduce identically, and a clock that advanced would make "how stale is
 * this injury report" answer differently on a screenshot taken a minute later.
 * A scenario that wants a later moment declares a later moment — that is what
 * the progression controls are for.
 */
export function fixedClock(instant: string | Date): Clock {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error(`fixedClock: not a usable instant: ${String(instant)}`);
  const iso = new Date(ms).toISOString();
  return {
    now: () => new Date(ms),
    iso: () => iso,
    ms: () => ms,
  };
}

/**
 * An instant a given number of hours before the clock.
 *
 * Fixtures describe freshness relatively — "this injury report is nine hours
 * old" — because an absolute timestamp written beside a scenario's `asOf` is
 * two numbers that have to be kept in step by hand, and they will not be.
 */
export function hoursBefore(clock: Clock, hours: number): string {
  return new Date(clock.ms() - hours * 3_600_000).toISOString();
}

/** The same, forwards. Used for kickoffs that have not happened yet. */
export function hoursAfter(clock: Clock, hours: number): string {
  return new Date(clock.ms() + hours * 3_600_000).toISOString();
}
