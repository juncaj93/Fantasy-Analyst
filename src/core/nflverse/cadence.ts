/**
 * Which nflverse feed, if any, a five-minute tick should refresh.
 *
 * The three feeds used to ride the 09:00 tick, one after another, on top of
 * everything else that tick does. Parsing them is the most CPU-hungry work in
 * the app — measured against the real 2026 files, the depth chart's ranged read
 * costs about 27ms, the roster 23ms and the snap counts 10ms — and from
 * 19 September the 09:00 invocation began ending `exceededCpu` in the snap step,
 * after the depth chart and before `finish()`. Tail captured it on 23 September:
 * last line `nflverse-depth ... rows=567`, outcome `exceededCpu`. Everything the
 * tick did before that landed; the run record and the manager backfill after it
 * never did.
 *
 * Cloudflare counts CPU per invocation, so the fix is to stop stacking them.
 * Each feed gets a five-minute tick of its own, in dependency order — the roster
 * first, because the snap join reads the crosswalk it writes — so no invocation
 * parses more than one file. No cron trigger is spent on it: the five-minute
 * clock already fires in these windows.
 *
 * Twice a day. The morning pass is the one that matters (the depth chart is
 * republished at about 06:00 UTC); the evening pass is a floor under a morning
 * tick that did not fire, and costs a conditional request answered 304 when
 * nothing moved.
 */

export type NflverseFeed = 'roster' | 'depth' | 'snaps';

/** Hours (UTC) whose :30–:44 carry the three feeds. */
export const NFLVERSE_HOURS: readonly number[] = [9, 21];

/** Minute windows within those hours, one feed each, in dependency order. */
const WINDOWS: readonly { from: number; feed: NflverseFeed }[] = [
  { from: 30, feed: 'roster' },
  { from: 35, feed: 'depth' },
  { from: 40, feed: 'snaps' },
];

/**
 * The feed owed by the tick scheduled at `scheduledTime`, or null.
 *
 * Keyed on the *scheduled* time rather than the clock, so a tick the runtime
 * delivers a minute late still lands in the window it was scheduled for, and
 * each window is exactly one five-minute tick wide.
 */
export function nflverseFeedDue(scheduledTime: number | undefined): NflverseFeed | null {
  if (scheduledTime == null || !Number.isFinite(scheduledTime)) return null;
  const at = new Date(scheduledTime);
  if (!NFLVERSE_HOURS.includes(at.getUTCHours())) return null;
  const minute = at.getUTCMinutes();
  const hit = WINDOWS.find((w) => minute >= w.from && minute < w.from + 5);
  return hit ? hit.feed : null;
}
