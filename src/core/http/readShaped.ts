/**
 * What counts as a read, stated once for everything that has to refuse a write.
 *
 * Two features in this app substitute a world under the running product and
 * then have to hold it read-only: Demo Mode, which serves fixtures, and Mock
 * Draft, which rehearses a real league. Both enforce it the same way — refused
 * in the browser, refused again at the server — and both need the same
 * underlying answer to one question: *is this request a read?*
 *
 * The answer lives here rather than in either of them. Demo Mode owned it
 * first, and while it was the only world that needed it that was the right
 * place; the moment a second world had to ask, "what is a write" became a fact
 * about this app's HTTP surface rather than a fact about demos. A read-shaped
 * POST added for one is now a read-shaped POST for both, and the two guards
 * cannot drift into disagreeing.
 *
 * Deliberately tiny and dependency-free. It is imported by the web client at
 * the seam every request passes through, so it has to cost the initial bundle
 * essentially nothing — and it must not be the thing that drags a scenario
 * runtime or a draft engine in behind it.
 */

/**
 * A read-shaped POST.
 *
 * `/api/startsit/compare` sends a list of players in a body and returns a
 * comparison. It writes nothing — it is a POST because the request does not fit
 * in a query string — and refusing it would remove Compare from every weekly
 * scenario for a reason that has nothing to do with safety.
 *
 * The list is exhaustive and short on purpose. Anything not on it, and not a
 * GET, is refused. A world with its own read-shaped POSTs names them in its own
 * guard rather than here; see `core/draft/mockGuard.ts`, whose two routes carry
 * a draft id and are therefore a shape rather than a fixed string.
 */
export const READ_ONLY_POSTS = new Set(['/api/startsit/compare']);

/**
 * Is this request a read, whatever world it arrives in?
 *
 * `path` must already be stripped of its query string.
 */
export function isReadShaped(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return true;
  return READ_ONLY_POSTS.has(path);
}
