/**
 * The demo's service boundary.
 *
 * Everything the app asks for while a scenario is active comes through
 * `DemoRuntime.request`, and that is deliberate: it is one place, below the UI,
 * where the read-only rule is enforced. A screen that forgot to disable a
 * button, a call made from a console, an endpoint a future workstream adds —
 * all of them arrive here and all of them are refused unless they are reads.
 *
 * It is also where the *shape* of the substitution lives. The runtime holds one
 * scenario's data, hands it to the production engines, and returns the same
 * envelopes the server returns. It has no database handle, no provider client
 * and no fetch: there is nothing in this object that could reach live truth
 * even if it were asked to.
 */

import { assertAllowedInDemo, DemoWriteBlockedError } from '../guard.ts';
import { loadScenarioData, type ScenarioData } from '../fixtures/index.ts';
import type { DemoScenario } from '../types.ts';
import { handleDemoRequest, type DemoResponse } from './handlers.ts';
import { buildDraftBoard } from '../../draft/boardBuilder.ts';
import { boardForClient } from '../../draft/boardWire.ts';
import { draftBoardSourcesFrom } from './sources.ts';

export type { DemoResponse } from './handlers.ts';

export class DemoRuntime {
  private constructor(
    readonly scenario: DemoScenario,
    private readonly data: ScenarioData,
  ) {}

  static async forScenario(scenario: DemoScenario): Promise<DemoRuntime> {
    if (scenario.awaiting) {
      throw new Error(
        `Demo scenario "${scenario.id}" is declared but not wired: ${scenario.awaiting.reason}`,
      );
    }
    return new DemoRuntime(scenario, await loadScenarioData(scenario));
  }

  /** The scenario's clock. Exposed so the indicator can print the as-of time. */
  get asOf(): string {
    return this.data.clock.iso();
  }

  /**
   * Serve one request.
   *
   * Throws `DemoWriteBlockedError` for anything that is not a read. Throwing
   * rather than returning a 403 body is intentional: a caller that ignores a
   * status code cannot ignore a rejected promise, and every path in the app
   * already handles a failed request.
   */
  async request(method: string, url: string, body: unknown = null): Promise<DemoResponse> {
    const parsed = new URL(url, 'https://demo.invalid');
    assertAllowedInDemo(method, parsed.pathname);
    return handleDemoRequest(this.data, {
      method,
      path: parsed.pathname,
      params: parsed.searchParams,
      body,
    });
  }

  /**
   * The board as it was before the signal went.
   *
   * Only the offline scenario needs this, and it needs it because the thing
   * being demonstrated is a *production* behaviour: the draft screen keeps a
   * capture of the last good board in local storage and falls back to it when
   * the network does not answer. To show that honestly, there has to be a real
   * capture to fall back to — so the runtime builds one, the caller stores it
   * through the same cache the live app writes, and the board request then
   * fails. Nothing is faked in between.
   *
   * Returns null for every other scenario.
   */
  async offlineCapture(): Promise<{ draftId: string; board: unknown } | null> {
    if (this.data.freshness.sleeper !== 'unavailable') return null;
    const draft = this.data.draft;
    if (!draft) return null;
    return {
      draftId: draft.id,
      // Through the wire projection, because what the live app caches is what
      // the live app was sent — see `draft/boardWire.ts`.
      board: boardForClient(await buildDraftBoard(draftBoardSourcesFrom(this.data), draft.id, { limit: 40 })),
    };
  }
}

export { DemoWriteBlockedError };
