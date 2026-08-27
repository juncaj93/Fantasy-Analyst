/**
 * A mock draft cannot change anything, and cannot be talked into it.
 *
 * §4 asks for the refusal to happen **twice** — once in the browser and once at
 * the server — and asks that it reuse Demo Mode's mechanism rather than invent
 * a second one. So both halves are proved here, and each is *mutation-tested*:
 * an actual write is attempted against a real router with a real database, and
 * the state it would have changed is read back and required to be identical.
 *
 * "We were careful" is not a guarantee. Three ways, per the demo's own
 * precedent:
 *
 *   - **behaviourally**, by attempting every write the router exposes;
 *   - **structurally**, by reading the seam, so a future client that routed
 *     around the browser guard fails this file rather than shipping;
 *   - **by shape**, because the sources a mock board is built from contain no
 *     write method for one to be called through.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOCK_PROHIBITED,
  MockWriteBlockedError,
  isAllowedInMock,
  isMockControlPath,
} from '../src/core/draft/mockGuard.ts';
import { isAllowedInDemo } from '../src/core/demo/guard.ts';
import { assertMockAllows, enterMock, exitMock, mockRunning } from '../src/web/mock/session.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const PASSPHRASE = 'correct horse battery staple';

/** Every non-GET path the router serves, read off the router itself. */
const ROUTER_WRITES = [
  ...readFileSync(join(SRC, 'server', 'app.ts'), 'utf8').matchAll(/router\.post\('([^']+)'/g),
].map((m) => m[1]!.replace(/:[a-zA-Z]+/g, 'x'));

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: PASSPHRASE,
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

function request(path: string, opts: { method?: string; cookies?: string[]; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookies?.length) headers['cookie'] = opts.cookies.join('; ');
  return new Request(`https://app.test${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
}

describe('the rule: while a mock is running, nothing but a read may pass', () => {
  it('finds the write endpoints it claims to be checking', () => {
    expect(ROUTER_WRITES.length).toBeGreaterThan(15);
    expect(ROUTER_WRITES).toContain('/api/drafts/x/sync');
    expect(ROUTER_WRITES).toContain('/api/players/x/my-guy');
  });

  /**
   * Which of the router's POSTs a mock lets through, stated exhaustively.
   *
   * Five, and they earn it for three reasons. The mock's own enter and exit
   * change nothing but whether a rehearsal is running; its board and its
   * snapshot are reads that need a body; and `startsit/compare` is the
   * read-shaped POST both worlds already agree about. Anything else appearing
   * in this list is a regression, which is why it is asserted rather than
   * filtered.
   */
  it('lets through exactly five POSTs, and no others', () => {
    const allowed = ROUTER_WRITES.filter((path) => isAllowedInMock('POST', path));
    expect(allowed.sort()).toEqual([
      '/api/drafts/x/mock/board',
      '/api/drafts/x/mock/support-snapshot',
      '/api/mock/enter',
      '/api/mock/exit',
      '/api/startsit/compare',
    ]);
  });

  it('refuses every other write the router has', () => {
    const refused = ROUTER_WRITES.filter((path) => !isAllowedInMock('POST', path));
    expect(refused.length).toBeGreaterThan(20);
    expect(refused).toContain('/api/drafts/x/sync');
    expect(refused).toContain('/api/drafts/x/queue');
  });

  it('refuses an endpoint that does not exist yet, which is the point', () => {
    expect(isAllowedInMock('POST', '/api/drafts/x/make-the-pick')).toBe(false);
    expect(isAllowedInMock('POST', '/api/anything/at/all')).toBe(false);
    expect(isAllowedInMock('GET', '/api/anything/at/all')).toBe(true);
  });

  it('refuses the verbs the app does not even use', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isAllowedInMock(method, '/api/players/1001/my-guy'), method).toBe(false);
    }
  });

  it('refuses a path that merely looks like one of the mock’s own', () => {
    for (const path of [
      '/api/drafts/x/mock/board/evil',
      '/evil/api/drafts/x/mock/board',
      '/api/drafts/x/mock/sync',
      '/api/drafts/x/y/mock/board',
    ]) {
      expect(isAllowedInMock('POST', path), path).toBe(false);
    }
  });

  it('shares one definition of a read with Demo Mode rather than keeping a second', () => {
    /*
     * The read-shaped POST list moved to `core/http/readShaped.ts` when this
     * became the second world that has to refuse a write. Both guards must
     * still agree about it — a rule that drifted would mean Compare working in
     * one and refused in the other, for no reason anybody could state.
     */
    expect(isAllowedInMock('POST', '/api/startsit/compare')).toBe(true);
    expect(isAllowedInDemo('POST', '/api/startsit/compare')).toBe(true);
  });

  it('keeps the two control planes apart', () => {
    expect(isMockControlPath('/api/mock/exit')).toBe(true);
    expect(isMockControlPath('/api/demo/exit')).toBe(false);
    expect(isAllowedInDemo('POST', '/api/mock/enter'), 'a demo is not a rehearsal').toBe(false);
  });

  it('names what it prohibits, in the user’s language', () => {
    expect(MOCK_PROHIBITED.length).toBeGreaterThanOrEqual(6);
    expect(MOCK_PROHIBITED.join(' ')).toContain('Sleeper');
  });
});

describe('the first refusal: the browser', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(async () => {
    await exitMock();
    vi.unstubAllGlobals();
  });

  it('is a no-op when nobody is rehearsing', () => {
    expect(mockRunning()).toBeNull();
    expect(() => assertMockAllows('POST', '/api/drafts/dr/sync')).not.toThrow();
  });

  it('refuses every write once a rehearsal starts', async () => {
    await enterMock('dr-a');
    expect(mockRunning()).toBe('dr-a');
    for (const path of ['/api/drafts/dr/sync', '/api/drafts/dr/queue', '/api/players/1/my-guy']) {
      expect(() => assertMockAllows('POST', path), path).toThrow(MockWriteBlockedError);
    }
  });

  it('lets the reads and the mock’s own two routes through', async () => {
    await enterMock('dr-a');
    for (const [method, path] of [
      ['GET', '/api/drafts/dr/board?limit=40'],
      ['POST', '/api/drafts/dr/mock/board'],
      ['POST', '/api/drafts/dr/mock/support-snapshot'],
      ['POST', '/api/mock/exit'],
    ] as const) {
      expect(() => assertMockAllows(method, path), `${method} ${path}`).not.toThrow();
    }
  });

  it('ignores the query string when it applies the rule', async () => {
    await enterMock('dr-a');
    expect(() => assertMockAllows('POST', '/api/drafts/dr/mock/board?limit=40')).not.toThrow();
    expect(() => assertMockAllows('POST', '/api/drafts/dr/sync?x=1')).toThrow(MockWriteBlockedError);
  });

  it('lets go the moment the rehearsal ends', async () => {
    await enterMock('dr-a');
    await exitMock();
    expect(mockRunning()).toBeNull();
    expect(() => assertMockAllows('POST', '/api/drafts/dr/sync')).not.toThrow();
  });

  it('tells the server, so the second refusal is armed too', async () => {
    await enterMock('dr-a');
    expect(fetch).toHaveBeenCalledWith('/api/mock/enter', expect.objectContaining({ method: 'POST' }));
    await exitMock();
    expect(fetch).toHaveBeenCalledWith('/api/mock/exit', expect.objectContaining({ method: 'POST' }));
  });

  it('still refuses when the server could not be told', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await enterMock('dr-a');
    expect(() => assertMockAllows('POST', '/api/drafts/dr/sync')).toThrow(MockWriteBlockedError);
  });

  it('is consulted at the one seam every request goes through', () => {
    /*
     * Structural, and it is the check that matters most in this file.
     *
     * The behavioural tests above prove the guard refuses; this proves nothing
     * can get past it, by asserting that the refusal sits in `request()` — the
     * single function `api.get` and `api.post` both call — rather than in a
     * screen somebody could forget to update.
     */
    const api = readFileSync(join(SRC, 'web', 'api.ts'), 'utf8');
    const start = api.indexOf('async function request<T>');
    expect(start, 'the seam is where it has always been').toBeGreaterThan(-1);
    const body = api.slice(start, api.indexOf('\n}', start));
    expect(body).toContain('assertMockAllows(method, path)');
    expect(body.indexOf('assertMockAllows')).toBeLessThan(body.indexOf('fetch('));
  });
});

describe('the second refusal: the server', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let mockCookie: string;
  let sessionCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();

    const login = await app(request('/api/auth/login', { method: 'POST', body: { passphrase: PASSPHRASE } }), env);
    sessionCookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const enter = await app(request('/api/mock/enter', { method: 'POST' }), env);
    expect(enter.status).toBe(200);
    mockCookie = enter.headers.get('set-cookie')!.split(';')[0]!;
    expect(mockCookie).toBe('fa_mock=1');
  });

  it('reports whether a request is rehearsing', async () => {
    const on = await app(request('/api/mock/status', { cookies: [mockCookie] }), env);
    expect(await on.json()).toEqual({ mock: true });
    const off = await app(request('/api/mock/status'), env);
    expect(await off.json()).toEqual({ mock: false });
  });

  it('still serves every read, because reading is the whole point', async () => {
    for (const path of ['/api/overview', '/api/leagues', '/api/players', '/api/setup/status']) {
      const res = await app(request(path, { cookies: [mockCookie] }), env);
      expect(res.status, path).toBe(200);
    }
  });

  /**
   * The one that matters: **an unlocked session is not permission to mutate the
   * real draft while rehearsing it.** The guard runs before the passphrase
   * check, so a valid session makes no difference.
   */
  it('refuses every write, even with a valid session', async () => {
    const writes = [
      '/api/drafts/demo-draft/sync',
      '/api/drafts/demo-draft/queue',
      '/api/drafts/demo-draft/queue/reorder',
      '/api/players/1001/my-guy',
      '/api/leagues/demo-league/sync',
      '/api/sleeper/sync-players',
      '/api/adp/import',
      '/api/newsletter/ingest',
      '/api/vegas/refresh',
    ];
    for (const path of writes) {
      const res = await app(request(path, { method: 'POST', cookies: [mockCookie, sessionCookie], body: {} }), env);
      expect(res.status, `POST ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('A mock draft is running');
    }
  });

  it('changes nothing in the database while it refuses', async () => {
    const myGuy = async () => {
      const body = (await (await app(request('/api/players/1001'), env)).json()) as { myGuy: { level: number } };
      return body.myGuy.level;
    };
    const queue = async () => {
      const res = await app(request('/api/drafts/demo-draft/queue', { cookies: [sessionCookie] }), env);
      return ((await res.json()) as { order: string[] }).order;
    };
    const picks = async () => {
      const res = await app(request('/api/drafts/demo-draft/board?limit=1', { cookies: [sessionCookie] }), env);
      return ((await res.json()) as { picksMade: number }).picksMade;
    };

    const before = { myGuy: await myGuy(), queue: await queue(), picks: await picks() };

    await app(
      request('/api/players/1001/my-guy', { method: 'POST', cookies: [mockCookie, sessionCookie], body: { level: 3 } }),
      env,
    );
    await app(
      request('/api/drafts/demo-draft/queue', {
        method: 'POST',
        cookies: [mockCookie, sessionCookie],
        body: { playerId: '1003', queued: true },
      }),
      env,
    );
    await app(request('/api/drafts/demo-draft/sync', { method: 'POST', cookies: [mockCookie, sessionCookie] }), env);

    expect({ myGuy: await myGuy(), queue: await queue(), picks: await picks() }).toEqual(before);
  });

  it('lets go the moment the rehearsal is left, and the same write then succeeds', async () => {
    const exit = await app(request('/api/mock/exit', { method: 'POST', cookies: [mockCookie] }), env);
    expect(exit.status).toBe(200);
    expect(exit.headers.get('set-cookie')).toContain('Max-Age=0');

    const res = await app(
      request('/api/players/1001/my-guy', { method: 'POST', cookies: [sessionCookie], body: { level: 2 } }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('can always be left, even with no passphrase configured at all', async () => {
    const lockedDown = { ...env, APP_PASSPHRASE: undefined, SESSION_SECRET: undefined } as AppEnv;
    const res = await app(request('/api/mock/exit', { method: 'POST', cookies: [mockCookie] }), lockedDown);
    expect(res.status).toBe(200);
  });

  it('is session-scoped: the cookie outlives no browser', async () => {
    const enter = await app(request('/api/mock/enter', { method: 'POST' }), env);
    expect(enter.headers.get('set-cookie')).not.toContain('Max-Age=');
  });

  it('does not make a demo read-only by accident, or the reverse', async () => {
    const demo = await app(request('/api/demo/status', { cookies: [mockCookie] }), env);
    expect(await demo.json()).toEqual({ demo: false });
  });
});

describe('a mock cannot reach live truth even by accident', () => {
  const files = ['mockManager.ts', 'mockDraft.ts', 'mockSources.ts', 'mockBoard.ts', 'mockGuard.ts'].map((f) =>
    join(SRC, 'core', 'draft', f),
  );

  const codeOf = (file: string) =>
    readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('imports nothing from the server, and no provider client', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'([^']+)'/g)) {
        const specifier = match[1]!;
        if (specifier.includes('/server/') || specifier.includes('server/db')) {
          offenders.push(`${file} imports ${specifier}`);
        }
        if (specifier.includes('sleeper/client') || specifier.includes('vegas/')) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders, 'a rehearsal must not be able to reach a database or a provider').toEqual([]);
  });

  it('contains no network call, no clock and no persistence of its own', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB', 'Math.random']) {
        if (code.includes(forbidden)) offenders.push(`${file} uses ${forbidden}`);
      }
    }
    expect(offenders, 'a mock is pure: its state and its clock are handed to it').toEqual([]);
  });

  it('the source interface it substitutes has no write on it', () => {
    const board = readFileSync(join(SRC, 'core', 'draft', 'boardBuilder.ts'), 'utf8');
    const start = board.indexOf('export interface DraftBoardSources {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = board.indexOf('{', start);
    for (let i = end; i < board.length; i++) {
      if (board[i] === '{') depth++;
      else if (board[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const declaration = board.slice(start, end);
    for (const write of ['save', 'insert', 'upsert', 'delete', 'update', 'set(', 'write']) {
      expect(declaration.toLowerCase(), `DraftBoardSources must have no ${write}`).not.toContain(write);
    }
  });

  it('substitutes exactly one source method, and only for its own draft', () => {
    const code = codeOf(join(SRC, 'core', 'draft', 'mockSources.ts'));
    /*
     * The whole design in one assertion: a mock is a different pick stream and
     * nothing else. A second overridden method here would mean the rehearsal
     * had started serving different evidence, a different market or a different
     * player dictionary — at which point it stops being a rehearsal of this
     * league.
     */
    expect(code).toContain('listPicks: async (id: string) =>');
    expect(code).toContain("id === state.draftId");
    expect(code.match(/^\s+\w+: async \(/gm)?.length ?? 0).toBe(1);
  });
});
