/**
 * Which world the app's data is coming from, and nothing else.
 *
 * ## Why this is its own module
 *
 * Demo Mode substitutes the whole data source underneath the app, and two
 * scenarios share a league id and a draft id — they are the same fixture league
 * at two different moments. So "which world is this" is part of the identity of
 * every remembered answer, in the in-memory response cache and in the offline
 * board alike. Both of those already existed, neither knew about the other, and
 * neither should have to know that a demo exists at all.
 *
 * One marker, pushed by the module that owns the fact, read by whoever needs to
 * qualify something. It imports nothing on purpose: `demo/session.ts` writes to
 * it and also writes the offline board, so anything this module imported back
 * would close a cycle.
 *
 * ## What a world change means
 *
 * It means every answer the app is holding was produced by a data source that
 * is no longer in force, and every request still in the air was launched
 * against one. The first half is why the caches clear; the second is why they
 * capture this marker when a request starts and check it again when the request
 * completes. A request may only become current truth if the world that launched
 * it is still the world that is running.
 *
 * That check cannot be replaced by clearing maps at the moment of the switch. A
 * clear only removes what has already arrived — an older request completing a
 * moment later would write straight back into the emptied cache, under a
 * path-shaped key the new world is about to ask for.
 */

/** Not a demo: the reader's own data, from the real server. */
export const LIVE_WORLD = 'live';

let world: string = LIVE_WORLD;

const listeners = new Set<(world: string) => void>();

/** The world in force right now. */
export function currentWorld(): string {
  return world;
}

/**
 * Record that the world has changed, and tell everyone holding state about it.
 *
 * Idempotent: being told the world we are already in is not a change and
 * notifies nobody, which is what lets callers announce the current world
 * freely rather than having to work out whether it moved.
 *
 * Returns whether this was in fact a change, which is only of interest to a
 * caller that wants to log it.
 */
export function noteWorld(next: string): boolean {
  if (next === world) return false;
  world = next;
  // A copy, so a listener that unsubscribes itself does not shorten the list
  // being walked.
  for (const listener of [...listeners]) listener(next);
  return true;
}

/**
 * Be told when the world changes.
 *
 * Subscribers are notified *after* the marker has moved, so a listener that
 * reads `currentWorld()` sees the new world and not the one it is replacing.
 */
export function subscribeToWorld(listener: (world: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
