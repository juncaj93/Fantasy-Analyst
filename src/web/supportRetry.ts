/**
 * The support snapshot, tried again when Cloudflare cut it off for CPU.
 *
 * ## Why (Round 15, from the Worker's own logs)
 *
 * Every failed download on record (waiver plan on 3 November, defense plan and
 * trade offer on 8 November) was Cloudflare's 503 page with the outcome
 * `exceededCpu` after 10 to 14 ms of CPU. The same downloads succeed in 300
 * to 800 ms of CPU when nothing heavy ran just before them. On this plan a
 * request may run past 10 ms on a short burst allowance, and a heavy request
 * one or two seconds earlier (the probe and the November review both fired
 * them back to back) leaves nothing for the next one, so it is stopped at
 * 10 ms. Nothing in the snapshot is wrong; it asked too soon.
 *
 * So a 503 here is waited out and asked again, twice at most. Anything else
 * (a 4xx, a refusal to redact, no league) fails at once, as before.
 */

import { ApiError } from './apiResponse.ts';

/** Seconds of quiet before each retry: enough for the allowance to come back. */
export const SNAPSHOT_RETRY_DELAYS_MS: readonly number[] = [3_000, 8_000];

export function isCpuCutOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

export async function withCpuRetry<T>(
  run: () => Promise<T>,
  opts: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number) => void } = {},
): Promise<T> {
  const delays = opts.delays ?? SNAPSHOT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isCpuCutOff(err) || attempt >= delays.length) throw err;
      opts.onRetry?.(attempt + 1);
      await sleep(delays[attempt]!);
    }
  }
}
