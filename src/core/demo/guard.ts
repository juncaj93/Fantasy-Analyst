/**
 * What Demo Mode refuses, and where it refuses it.
 *
 * §2 asks for two independent refusals: the controls are disabled in the UI
 * *and* the same attempt is refused again below the UI. This module is the
 * second one. It is deliberately not a list of buttons — a button is a thing
 * somebody can forget to disable — but a rule about requests:
 *
 *   **while a scenario is active, nothing but a read may pass.**
 *
 * Stated that way, the refusal covers endpoints that do not exist yet, calls
 * made from a console, a screen that was missed, and anything a future
 * workstream adds. Nothing has to be added to a list for a new mutation to be
 * blocked; something would have to be added to an allow-list for one to be let
 * through, and there is no allow-list for writes.
 *
 * The one exception is Demo Mode's own controls, which are POSTs because
 * entering and leaving demo is an action rather than a page. They are named
 * below, and none of them touches league or player truth.
 */

/**
 * Demo's own control plane. These are the only non-GET paths it will serve, and
 * they change nothing but whether the demo is running.
 */
export const DEMO_CONTROL_PATHS = new Set(['/api/demo/enter', '/api/demo/exit', '/api/demo/status']);

/**
 * A read-shaped POST.
 *
 * `/api/startsit/compare` sends a list of players in a body and returns a
 * comparison. It writes nothing — it is a POST because the request does not fit
 * in a query string — and refusing it would remove Compare from every weekly
 * scenario for a reason that has nothing to do with safety.
 *
 * The list is exhaustive and short on purpose. Anything not on it, and not a
 * GET, is refused.
 */
export const DEMO_READ_ONLY_POSTS = new Set(['/api/startsit/compare']);

/** Everything Demo Mode must not be able to do, in the user's language. */
export const DEMO_PROHIBITED = [
  'writing anything to Sleeper',
  'submitting a lineup',
  'making a draft pick',
  'adding or dropping a player',
  'submitting a waiver claim or a FAAB bid',
  'proposing or accepting a trade',
  'asking a provider for anything',
  'writing league or player truth to the database',
  'teaching the manager profiles anything',
  'writing to the grading ledger',
  'running a scheduled job',
] as const;

export class DemoWriteBlockedError extends Error {
  readonly status = 403;
  constructor(
    readonly path: string,
    readonly method: string,
  ) {
    super(
      `Demo Mode is read-only: ${method} ${path} was refused. Nothing in a demo can change a lineup, a pick, a claim, a bid, a trade, a provider or the database.`,
    );
    this.name = 'DemoWriteBlockedError';
  }
}

export function isDemoControlPath(path: string): boolean {
  return DEMO_CONTROL_PATHS.has(path);
}

/**
 * May this request be served while a scenario is active?
 *
 * `path` must already be stripped of its query string.
 */
export function isAllowedInDemo(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return true;
  if (DEMO_CONTROL_PATHS.has(path)) return true;
  return DEMO_READ_ONLY_POSTS.has(path);
}

/** Throw unless this request is allowed. The service-boundary refusal. */
export function assertAllowedInDemo(method: string, path: string): void {
  if (!isAllowedInDemo(method, path)) throw new DemoWriteBlockedError(path, method);
}
