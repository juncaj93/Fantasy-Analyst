/**
 * Demo Mode cannot change anything, and cannot be talked into it.
 *
 * §2 and §3 are the two promises the whole feature rests on: while a scenario
 * is active nothing may write to Sleeper, to a provider, to the database, to a
 * manager profile or to a grading ledger — and no fixture may ever be mistaken
 * for live truth. "We were careful" is not a guarantee, so both are asserted
 * three ways:
 *
 *   - **behaviourally**, by attempting every mutation the app has and checking
 *     the runtime refuses it below the UI;
 *   - **structurally**, by reading the imports, so a future endpoint that
 *     reaches for a repository or a client fails this file rather than shipping;
 *   - **by shape**, because the sources the demo satisfies contain no write
 *     method for one to be called through.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_PROHIBITED,
  DemoWriteBlockedError,
  isAllowedInDemo,
} from '../src/core/demo/guard.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const DEMO = join(SRC, 'core', 'demo');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'([^']+)'/g)) out.push(match[1]!);
  for (const match of source.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push(match[1]!);
  return out;
}

/** Comments explain the prohibitions at length, so only the code is searched. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('every mutation in the app is refused below the UI', () => {
  /**
   * The complete list of non-GET endpoints the server exposes, read off the
   * router rather than typed out here — so an endpoint added tomorrow is
   * covered by this test the day it lands.
   */
  const writes = [
    ...readFileSync(join(SRC, 'server', 'app.ts'), 'utf8').matchAll(/router\.post\('([^']+)'/g),
  ].map((m) => m[1]!.replace(/:[a-zA-Z]+/g, 'x'));

  it('finds the write endpoints it claims to be checking', () => {
    expect(writes.length).toBeGreaterThan(15);
    expect(writes).toContain('/api/drafts/x/sync');
    expect(writes).toContain('/api/players/x/my-guy');
  });

  /**
   * Which of the router's POSTs Demo Mode lets through, stated exhaustively.
   *
   * Two, and they earn it for different reasons: the comparison is a read that
   * happens to need a body, and the demo's own enter/exit change nothing but
   * whether the demo is running. Anything else appearing here is a regression,
   * which is why the list is asserted rather than filtered.
   */
  it('lets through exactly two kinds of POST, and no others', () => {
    const allowed = writes.filter((path) => isAllowedInDemo('POST', path));
    expect(allowed.sort()).toEqual(['/api/demo/enter', '/api/demo/exit', '/api/startsit/compare']);
  });

  it('refuses every write that touches anything', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('sunday-pregame')!);
    const refused = writes.filter((path) => !isAllowedInDemo('POST', path));
    expect(refused.length).toBeGreaterThan(15);
    for (const path of refused) {
      await expect(runtime.request('POST', path, {}), `POST ${path}`).rejects.toBeInstanceOf(
        DemoWriteBlockedError,
      );
    }
  });

  it('refuses methods the app does not even use', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'post']) {
      await expect(runtime.request(method, '/api/overview')).rejects.toBeInstanceOf(DemoWriteBlockedError);
    }
  });

  it('refuses an endpoint that does not exist yet, which is the point', () => {
    expect(isAllowedInDemo('POST', '/api/matchup/submit-lineup')).toBe(false);
    expect(isAllowedInDemo('POST', '/api/anything/at/all')).toBe(false);
    expect(isAllowedInDemo('GET', '/api/anything/at/all')).toBe(true);
  });

  it('serves the one POST that only reads', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('sunday-pregame')!);
    const res = await runtime.request('POST', '/api/startsit/compare', {
      leagueId: 'demo-league-2026',
      playerIds: ['p025', 'p037'],
    });
    expect(res.status).toBe(200);
  });

  it('names every prohibition §2 lists', () => {
    expect(DEMO_PROHIBITED.length).toBeGreaterThanOrEqual(11);
  });
});

describe('the demo cannot reach live truth even by accident', () => {
  const files = filesUnder(DEMO);

  it('finds the modules it claims to be checking', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('imports nothing from the server, and no provider client', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('/server/') || specifier.includes('server/db')) {
          offenders.push(`${file} imports ${specifier}`);
        }
        if (specifier.includes('sleeper/client') || specifier.includes('vegas/oddsApiProvider') ||
            specifier.includes('vegas/sportsGameOddsProvider')) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders, 'Demo Mode must not be able to reach a database or a provider').toEqual([]);
  });

  it('contains no network call and no persistence of its own', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB']) {
        if (code.includes(forbidden)) offenders.push(`${file} uses ${forbidden}`);
      }
    }
    expect(offenders, 'fixtures live in memory and nowhere else').toEqual([]);
  });

  it('the source interface it satisfies has no write on it', () => {
    const board = readFileSync(join(SRC, 'core', 'draft', 'boardBuilder.ts'), 'utf8');
    /*
     * Brace-matched rather than sliced to the next comment: the declaration
     * after this interface has been renamed once already, and a slice that
     * silently ran to the end of the file would still pass while checking
     * something else entirely.
     */
    const start = board.indexOf('export interface DraftBoardSources {');
    expect(start, 'DraftBoardSources is declared').toBeGreaterThan(-1);
    let depth = 0;
    let end = board.indexOf('{', start);
    for (let i = end; i < board.length; i++) {
      if (board[i] === '{') depth++;
      else if (board[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const iface = board.slice(start, end + 1);
    expect(iface).toContain('injuryStates');
    expect(iface.length).toBeLessThan(4000);
    for (const forbidden of ['upsert', 'insert', 'save', 'set', 'delete', 'write', 'select']) {
      expect(iface.toLowerCase(), `DraftBoardSources must not offer "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('no production module imports a demo fixture', () => {
    const offenders: string[] = [];
    for (const dir of ['core', 'server', 'worker', 'devserver']) {
      for (const file of filesUnder(join(SRC, dir))) {
        if (file.includes(`${join('core', 'demo')}`)) continue;
        for (const specifier of importsOf(file)) {
          if (specifier.includes('demo/fixtures') || specifier.includes('demo/runtime')) {
            offenders.push(`${file} imports ${specifier}`);
          }
        }
      }
    }
    expect(offenders, 'fixture data must never be reachable from a live code path').toEqual([]);
  });
});

describe('a scenario reproduces identically for the same fixture version', () => {
  /**
   * Determinism, asserted over the whole payload rather than over a chosen
   * number.
   *
   * The board runs a Monte Carlo simulation for `Next%`, so this is not a
   * formality: it passes because that simulation is seeded from the draft state
   * (see `core/draft/nextpick/rng.ts`) and because the scenario's clock is
   * fixed, not because nothing random happens.
   */
  const paths = [
    '/api/overview',
    '/api/leagues',
    '/api/drafts/demo-draft-2026/board?limit=40',
    '/api/players?q=&limit=40',
    '/api/setup/status',
  ];

  /**
   * Two fields on the board describe *how* the answer was produced rather than
   * what it is: how long the simulation took, and whether it came out of the
   * memoisation cache. Both are diagnostics read by the probe, neither is on
   * screen, and both are legitimately allowed to differ between two runs of an
   * identical board. Everything else — every probability, every driver, every
   * score — must not.
   */
  const stable = (body: unknown): string =>
    JSON.stringify(body, (key, value) => (key === 'elapsedMs' || key === 'cached' ? null : value));

  it('returns byte-identical payloads across separate runtimes', async () => {
    for (const id of ['draft-mid', 'draft-late']) {
      const a = await DemoRuntime.forScenario(findScenario(id)!);
      const b = await DemoRuntime.forScenario(findScenario(id)!);
      for (const path of paths) {
        const first = await a.request('GET', path);
        const second = await b.request('GET', path);
        expect(stable(second.body), `${id} ${path}`).toEqual(stable(first.body));
      }
    }
  });

  it('the simulated survival percentages are identical, not merely close', async () => {
    const a = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const b = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const survival = async (runtime: DemoRuntime) =>
      ((await runtime.request('GET', '/api/drafts/demo-draft-2026/board?limit=40')).body as {
        recommendations: { playerId: string; survivalProbability: number | null }[];
      }).recommendations.map((r) => [r.playerId, r.survivalProbability]);
    expect(await survival(b)).toEqual(await survival(a));
  });

  it('is stable across repeated requests to one runtime', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('waivers-tuesday-active')!);
    const path = '/api/leagues/demo-league-2026/waivers';
    const first = JSON.stringify((await runtime.request('GET', path)).body);
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify((await runtime.request('GET', path)).body)).toEqual(first);
    }
  });

  it('does not move when the wall clock does', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('sunday-pregame')!);
    const before = JSON.stringify((await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = JSON.stringify((await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body);
    expect(after).toEqual(before);
  });

  it('measures everything from the scenario clock, not the device clock', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('sunday-pregame')!);
    expect(runtime.asOf).toBe('2026-10-11T15:40:00.000Z');
    const lineup = (await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body as {
      slots: { locked: boolean }[];
    };
    // Twenty minutes before kickoff: nothing has locked yet.
    expect(lineup.slots.every((s) => !s.locked)).toBe(true);

    const later = await DemoRuntime.forScenario(findScenario('late-injury-pivot')!);
    expect(later.asOf).toBe('2026-10-11T16:52:00.000Z');
    const after = (await later.request('GET', '/api/leagues/demo-league-2026/lineup')).body as {
      slots: { locked: boolean }[];
    };
    expect(after.slots.some((s) => s.locked)).toBe(true);
  });
});
