/**
 * What a mock draft refuses, and where it refuses it.
 *
 * The brief's §4 is one sentence — *nothing a mock draft does may write to, or
 * be reachable from, real league state* — and it names the mechanism: refuse
 * twice, once in the browser and once at the server, the way Demo Mode already
 * does. So this is not a new isolation mechanism. It is Demo Mode's rule,
 * imported, with a different control plane bolted to it:
 *
 *   **while a mock draft is running, nothing but a read may pass.**
 *
 * Stated as a rule about requests rather than as a list of buttons, it covers
 * the endpoint somebody adds next year, the call made from a console, the
 * screen that forgot to disable a control, and the request this app's own code
 * did not make. Nothing has to be added to a list for a new mutation to be
 * blocked; something would have to be added to an allow-list for one to be let
 * through, and there is no allow-list for writes.
 *
 * ## Why a mock needs this at all, when it stores nothing
 *
 * A rehearsal's whole state lives in the reader's browser and is posted to the
 * server to be read once and dropped — so on the intended path there is nothing
 * to refuse. That is exactly the argument Demo Mode could have made and did
 * not. The refusal is not there for the path we built; it is there for the one
 * somebody builds later, on the afternoon of a real draft, against a league
 * whose season depends on the pick stream being right.
 *
 * ## The mock's own two routes
 *
 * Both are POSTs and both are reads. `board` and `support-snapshot` are POSTs
 * for the same reason `/api/startsit/compare` is — the request carries a state
 * that does not fit in a query string — and the shared rule in
 * `core/http/readShaped.ts` is what both worlds mean by "a read".
 *
 * Neither writes anything — they build a board through `mockSources.ts`, whose
 * interface has no write on it, and return it. The path carries the draft id,
 * which is what keys a mock, so the allowance is a shape rather than a fixed
 * string.
 */

import { isReadShaped } from '../http/readShaped.ts';

/**
 * A mock's own control plane. The only non-GET paths outside a draft's own
 * that it will serve, and they change nothing but whether a mock is running.
 */
export const MOCK_CONTROL_PATHS = new Set(['/api/mock/enter', '/api/mock/exit', '/api/mock/status']);

/**
 * The mock's read-shaped POSTs, as a shape.
 *
 * A draft id sits in the middle, because a mock belongs to one `draft_id` and
 * every route into it has to name which — the same reason `draft_queue` is
 * keyed that way. Anchored at both ends so a path that merely *contains* one of
 * these cannot pass.
 */
export const MOCK_READ_ONLY_POST = /^\/api\/drafts\/[^/]+\/mock\/(board|support-snapshot)$/;

/** Everything a mock draft must not be able to do, in the user's language. */
export const MOCK_PROHIBITED = [
  'writing anything to Sleeper',
  'making a real draft pick',
  'starring, unstarring or reordering a player in the real draft queue',
  'syncing the real draft',
  'writing league or player truth to the database',
  'teaching the manager profiles anything',
  'asking a provider for anything',
] as const;

export class MockWriteBlockedError extends Error {
  readonly status = 403;
  constructor(
    readonly path: string,
    readonly method: string,
  ) {
    super(
      `A mock draft is a rehearsal: ${method} ${path} was refused. ` +
        'Nothing in a mock draft can change a real pick, a real queue, Sleeper or the database.',
    );
    this.name = 'MockWriteBlockedError';
  }
}

export function isMockControlPath(path: string): boolean {
  return MOCK_CONTROL_PATHS.has(path);
}

/**
 * May this request be served while a mock draft is running?
 *
 * `path` must already be stripped of its query string.
 */
export function isAllowedInMock(method: string, path: string): boolean {
  if (MOCK_CONTROL_PATHS.has(path)) return true;
  if (MOCK_READ_ONLY_POST.test(path)) return true;
  return isReadShaped(method, path);
}

/** Throw unless this request is allowed. The browser-side refusal. */
export function assertAllowedInMock(method: string, path: string): void {
  if (!isAllowedInMock(method, path)) throw new MockWriteBlockedError(path, method);
}
