/**
 * A simple, free limit on the heavy public reads (Round 34).
 *
 * Every GET is public. The heavy ones (the Waivers build, the Players board,
 * trade offers and sweeps, support snapshots, diagnostics) cost 100 to 700 ms
 * of CPU each, and on the free plan Cloudflare cuts every request off at 10 ms
 * once that burst allowance is spent. A stuck tab or a crawler looping on one
 * of them would make Alex's own cheap reads (a player card, Data health) fail
 * for as long as it ran, and would spend the day's database reads.
 *
 * So each address may make {@link HEAVY_READS_PER_MINUTE} heavy reads a minute
 * per Worker instance. A person tapping a phone never gets near it (opening
 * Team, Waivers, Players and Trades is four), and a logged-in phone is never
 * limited at all: the session is checked only once an address is over the
 * limit, so a normal request pays nothing for it. In-memory and per instance:
 * no binding, no storage, no paid service. It is a brake on runaway loops, not
 * a security boundary.
 */

export const HEAVY_READS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_TRACKED = 2_000;

/** The heavy public reads. Team's lineup and Matchup stay out, so normal use is never touched. */
const HEAVY: readonly RegExp[] = [
  /^\/api\/leagues\/[^/]+\/waivers$/,
  /^\/api\/leagues\/[^/]+\/support-snapshot$/,
  /^\/api\/leagues\/[^/]+\/trades\/(build|check|ladder)$/,
  /^\/api\/players\/season$/,
  /^\/api\/trades(\/smart|\/offers|\/screens\/offers)?$/,
  /^\/api\/diagnostics\//,
];

export function isHeavyRead(method: string, pathname: string): boolean {
  return method === 'GET' && HEAVY.some((re) => re.test(pathname));
}

/** A fixed one-minute window per address, kept in memory. */
export class HeavyReadLimiter {
  private readonly seen = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit = HEAVY_READS_PER_MINUTE) {}

  /** Counts this read and says whether it is inside the limit. */
  allow(key: string, now: number): boolean {
    const entry = this.seen.get(key);
    if (!entry || now - entry.start >= WINDOW_MS) {
      if (this.seen.size >= MAX_TRACKED) this.prune(now);
      this.seen.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.seen) if (now - entry.start >= WINDOW_MS) this.seen.delete(key);
    if (this.seen.size >= MAX_TRACKED) this.seen.clear();
  }
}

export function tooManyHeavyReads(): Response {
  return new Response(JSON.stringify({ error: 'Too many requests right now. Try again in a minute.' }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' },
  });
}
