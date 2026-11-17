/**
 * Round 35: the last good answer for the screens' first reads, kept across
 * launches (UI_REVAMP only).
 *
 * `sessionCache.ts` already serves a revisited tab from memory and refreshes
 * behind it. Memory is gone on every launch, so the first screen of the day
 * waited for the status read, then the league list, then its own reads, with
 * nothing to show for two to four seconds on a phone. This keeps the answer to
 * a handful of reads in the phone's storage, so a launch paints what the app
 * last knew in its first frame and the server's answer replaces it a round trip
 * later, through the same `onFresh` a revisit already uses.
 *
 * - Only reads whose screen takes `onFresh` (so a newer answer always lands),
 *   only the paths below, only the live league (never a demo), only while the
 *   switch is on, and only for twelve hours. Anything older is not shown.
 * - It stores what the server said, byte for byte. Nothing here computes,
 *   so no number can differ from the server's; it can only be older, for one
 *   round trip, and it is replaced as soon as the server answers.
 * - No server cost: the screen asks the server exactly as before.
 */

const PREFIX = 'fa.swr:';
/** Older than this is not shown at all: last night's lineup is not a lineup. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** A single answer bigger than this is not worth a phone's storage. */
const MAX_CHARS = 400_000;

/** The screens' first reads: the shell, Team, Matchup, Waivers, Trades and Players. */
const KEPT = [
  /^\/api\/(overview|leagues|auth\/status)$/,
  /^\/api\/leagues\/[^/?]+\/(roster|lineup|matchup|waivers)$/,
  /^\/api\/trades\/screens\/(offers|teams)$/,
  /* Round 36: Setup's one read. */
  /^\/api\/setup\/status$/,
  /* Compare's first list: My team, every position, nothing typed. */
  /^\/api\/leagues\/[^/?]+\/compare-pool\?tab=mine&position=ALL&q=(&mode=\w+)?$/,
  /^\/api\/players\/season(\?leagueId=[^&]+)?$/,
];

let enabled = false;

export function setPersistence(next: boolean): void {
  enabled = next;
  if (!next) clearPersisted();
}

export function persistenceOn(): boolean {
  return enabled;
}

export function isKept(path: string): boolean {
  return KEPT.some((re) => re.test(path));
}

interface Kept {
  at: number;
  body: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The kept answer, serialised, or null when there is none worth showing. */
export function readPersisted(path: string, world: string, now = Date.now()): { value: unknown; serialised: string; at: number } | null {
  if (!enabled || world !== 'live' || !isKept(path)) return null;
  try {
    const raw = storage()?.getItem(PREFIX + path);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Kept;
    if (typeof kept.at !== 'number' || typeof kept.body !== 'string' || now - kept.at > MAX_AGE_MS || kept.at > now) return null;
    return { value: JSON.parse(kept.body) as unknown, serialised: kept.body, at: kept.at };
  } catch {
    return null;
  }
}

export function writePersisted(path: string, world: string, serialised: string, now = Date.now()): void {
  if (!enabled || world !== 'live' || !isKept(path) || serialised.length > MAX_CHARS) return;
  const store = storage();
  if (!store) return;
  const value = JSON.stringify({ at: now, body: serialised } satisfies Kept);
  try {
    store.setItem(PREFIX + path, value);
  } catch {
    /* Full: drop what this module kept and try once more. */
    clearPersisted();
    try {
      store.setItem(PREFIX + path, value);
    } catch {
      /* not kept this time */
    }
  }
}

export function clearPersisted(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
