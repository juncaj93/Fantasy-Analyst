/**
 * The engine-driven demo runtime — no longer shipped to the browser.
 *
 * Until 24 September 2026 this was Demo Mode. Demo Mode is now a placeholder
 * served from captured responses (`../placeholder/`), and nothing in `src/web`
 * can reach this module. It stays because it is the fixture harness the
 * support-snapshot tests and `npm run support:fixture` run the production
 * engines against; see docs/DEMO_MODE.md.
 *
 * What follows describes how it behaves for those callers.
 *
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
}

export { DemoWriteBlockedError };
