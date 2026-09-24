/**
 * The placeholder demo's service boundary.
 *
 * Everything the app asks for while Demo Mode is on arrives here through
 * `request()` in `web/api.ts`, exactly as it did when the demo ran the
 * production engines. Two things have not changed and must not:
 *
 * - **Only reads pass.** `assertAllowedInDemo` refuses anything that is not a
 *   read before a route is even looked up, and the server refuses every write
 *   from a demo browser on its own (see `guard.ts` and `server/app.ts`).
 * - **Nothing here can reach live truth.** No database, no provider client,
 *   no fetch. The answers are `responses.json`, captured once from the old
 *   engine-driven demo's in-season Sunday.
 *
 * A path with no route answers 404 with a sentence the screens already know
 * how to print, which is how Draft and Trades say they are not in the demo.
 */

import { assertAllowedInDemo, DemoWriteBlockedError } from '../guard.ts';
import { positionMatchesFilter } from '../../sleeper/eligibility.ts';
import type { DemoShowcase } from './index.ts';

export interface DemoResponse {
  status: number;
  body: unknown;
}

type Responses = typeof import('./responses.json');
type Route = (request: { params: URLSearchParams; match: RegExpExecArray }, data: Responses) => DemoResponse;

const ok = (body: unknown): DemoResponse => ({ status: 200, body });
const fail = (message: string, status = 400): DemoResponse => ({ status, body: { error: message } });

const LEAGUE = '/api/leagues/[^/]+';

/**
 * The shell and the screens the placeholder shows.
 *
 * Each is a captured response served as-is. They are not recomputed, so a
 * change to a screen's wire shape can leave its demo out of date; that is the
 * accepted cost of not shipping the engines, and the fix is to re-capture.
 */
const CORE_ROUTES: [RegExp, Route][] = [
  [/^\/api\/health$/, () => ok({ ok: true, service: 'fantasy-analyst', demo: true })],
  /*
   * View only: there is nothing a passphrase would let you change in a demo,
   * and `canUnlock: false` keeps every screen from offering to.
   */
  [/^\/api\/auth\/status$/, () => ok({ unlocked: false, canUnlock: false })],
  [/^\/api\/overview$/, (_, d) => ok(d.overview)],
  [/^\/api\/leagues$/, (_, d) => ok(d.leagues)],
  [/^\/api\/setup\/status$/, (_, d) => ok(d.setupStatus)],
  [/^\/api\/data-health$/, (_, d) => ok(d.dataHealth)],
  [/^\/api\/review\/queue$/, () => ok({ evidence: [], identity: [] })],
  [/^\/api\/newsletter\/messages$/, () => ok({ messages: [] })],
  [new RegExp(`^${LEAGUE}/roster$`), (_, d) => ok(d.roster)],
  [new RegExp(`^${LEAGUE}/lineup$`), (_, d) => ok(d.lineup)],
  [new RegExp(`^${LEAGUE}/waivers$`), (_, d) => ok(d.waivers)],
  [new RegExp(`^${LEAGUE}/matchup$`), (_, d) => ok(d.matchup)],
  [/^\/api\/players$/, ({ params }, d) => ok(playerPage(d, params))],
  [
    /^\/api\/players\/([^/]+)\/detail$/,
    ({ match }, d) => {
      const detail = (d.playerDetails as Record<string, unknown>)[decodeURIComponent(match[1]!)];
      return detail ? ok(detail) : fail('This player’s card is not part of the demo.', 404);
    },
  ],
];

/**
 * Where a future round demos one new feature.
 *
 * Add `[pattern, route]` here. It is checked before `CORE_ROUTES`, so it can
 * also replace one of them. Keep what it imports small: this whole module is
 * the `demo-*.js` chunk, and that chunk is budgeted in `perf-budgets.json`.
 */
const FEATURE_ROUTES: [RegExp, Route][] = [];

export class DemoRuntime {
  private constructor(
    readonly scenario: DemoShowcase,
    private readonly data: Responses,
  ) {}

  static async forScenario(scenario: DemoShowcase): Promise<DemoRuntime> {
    const data = (await import('./responses.json')).default as Responses;
    return new DemoRuntime(scenario, data);
  }

  /** The scenario's clock. The indicator prints it. */
  get asOf(): string {
    return this.scenario.asOf;
  }

  /**
   * Serve one request.
   *
   * Throws `DemoWriteBlockedError` for anything that is not a read, rather than
   * returning a 403 body: a caller that ignores a status code cannot ignore a
   * rejected promise.
   */
  async request(method: string, url: string, _body: unknown = null): Promise<DemoResponse> {
    const parsed = new URL(url, 'https://demo.invalid');
    assertAllowedInDemo(method, parsed.pathname);
    for (const [pattern, route] of [...FEATURE_ROUTES, ...CORE_ROUTES]) {
      const match = pattern.exec(parsed.pathname);
      if (match) return route({ params: parsed.searchParams, match }, this.data);
    }
    return fail('This part of the app is not in the demo. Leave Demo Mode to use it with your league.', 404);
  }
}

/**
 * The Players list, from one captured page.
 *
 * Search and the position chips narrow it so the screen responds to them;
 * the ownership filter is not modelled, and a search that finds nothing in
 * the hundred captured names finds nothing.
 */
function playerPage(data: Responses, params: URLSearchParams) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const position = params.get('position');
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 100) || 100, 1), 200);
  const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);
  const filtered = data.players.players.filter(
    (p) => (!q || p.name.toLowerCase().includes(q)) && (!position || positionMatchesFilter(p.position, position)),
  );
  const page = filtered.slice(offset, offset + limit);
  return {
    tallyWeight: 0.5,
    rankingSource: 'Sleeper half-PPR redraft, 1QB',
    offset,
    hasMore: filtered.length > offset + page.length,
    total: filtered.length,
    ...(params.get('leagueId') ? { teams: data.players.teams } : {}),
    players: page,
  };
}

export { DemoWriteBlockedError };
