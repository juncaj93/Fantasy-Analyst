/**
 * API integration tests: the real router, auth middleware and services over a
 * real SQLite database.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

function makeEnv(db: NodeSqliteDatabase, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    ...overrides,
  };
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://app.test${path}`, { headers: cookie ? { cookie } : undefined });
}

function post(path: string, body?: unknown, cookie?: string): Request {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function login(env: AppEnv, app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app(post('/api/auth/login', { passphrase: 'correct horse battery staple' }), env);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return setCookie.split(';')[0]!;
}

describe('auth', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
  });

  it('serves health without a session', async () => {
    expect((await app(get('/api/health'), env)).status).toBe(200);
  });

  it('allows reads without a session — fantasy data is public', async () => {
    expect((await app(get('/api/overview'), env)).status).toBe(200);
    expect((await app(get('/api/players'), env)).status).toBe(200);
    expect((await app(get('/api/review/queue'), env)).status).toBe(200);
  });

  it('rejects writes without a session', async () => {
    for (const path of ['/api/sleeper/sync-players', '/api/adp/import', '/api/newsletter/ingest']) {
      const res = await app(post(path, {}), env);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: string }).error).toContain('Unlock in Setup');
    }
  });

  it('accepts writes once unlocked', async () => {
    const cookie = await login(env, app);
    // 400 (bad input) proves it got past the lock; 401 would mean it did not.
    const res = await app(post('/api/adp/import', {}, cookie), env);
    expect(res.status).toBe(400);
  });

  it('rejects a wrong passphrase', async () => {
    const res = await app(post('/api/auth/login', { passphrase: 'nope' }), env);
    expect(res.status).toBe(401);
  });

  it('issues an HttpOnly, Secure, SameSite session cookie', async () => {
    const res = await app(post('/api/auth/login', { passphrase: 'correct horse battery staple' }), env);
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('accepts a valid session on protected routes', async () => {
    const cookie = await login(env, app);
    expect((await app(get('/api/overview', cookie), env)).status).toBe(200);
  });

  it('rejects a tampered session cookie on writes', async () => {
    const cookie = await login(env, app);
    const tampered = `${cookie.split('.')[0]}.deadbeef`;
    expect((await app(post('/api/sleeper/sync-players', {}, tampered), env)).status).toBe(401);
  });

  it('is read-only, not wide open, when no passphrase is configured', async () => {
    const open = makeEnv(db, { APP_PASSPHRASE: undefined, SESSION_SECRET: undefined });
    // Reads still work...
    expect((await app(get('/api/overview'), open)).status).toBe(200);
    // ...but nothing can be changed by a stranger who finds the URL.
    const write = await app(post('/api/sleeper/sync-players', {}), open);
    expect(write.status).toBe(503);
    expect(((await write.json()) as { error: string }).error).toContain('read-only');
    expect((await app(post('/api/auth/login', { passphrase: 'x' }), open)).status).toBe(503);
  });

  it('derives a session key from the passphrase when none is supplied', async () => {
    const derived = makeEnv(db, { SESSION_SECRET: undefined });
    const cookie = await login(derived, app);
    expect((await app(post('/api/adp/import', {}, cookie), derived)).status).toBe(400);
  });

  it('reports lock state without requiring a session', async () => {
    const body = (await (await app(get('/api/auth/status'), env)).json()) as {
      unlocked: boolean;
      canUnlock: boolean;
    };
    expect(body.unlocked).toBe(false);
    expect(body.canUnlock).toBe(true);
  });

  it('never exposes secrets in a response body', async () => {
    const cookie = await login(env, app);
    const body = await (await app(get('/api/overview', cookie), env)).text();
    expect(body).not.toContain('correct horse battery staple');
    expect(body).not.toContain('test-secret-value');
  });

  it('has no endpoint that writes back to Sleeper', async () => {
    // Guard against ever adding an auto-draft / lineup-change route.
    const cookie = await login(env, app);
    for (const path of ['/api/drafts/demo-draft/pick', '/api/lineup/set', '/api/drafts/demo-draft/autodraft']) {
      expect((await app(post(path, {}, cookie), env)).status).toBe(404);
    }
  });
});

describe('API with seeded data', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let cookie: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
    cookie = await login(env, app);
  });

  const json = async <T,>(req: Request): Promise<T> => (await app(req, env)).json() as Promise<T>;

  it('reports an overview of every subsystem', async () => {
    const body = await json<Record<string, unknown>>(get('/api/overview', cookie));
    expect(body['players']).toBeGreaterThan(0);
    expect((body['selectedLeague'] as { name: string }).name).toBe('Demo Dynasty');
    expect(body['adpSnapshot']).toBeTruthy();
  });

  it('lists leagues with a derived scoring label', async () => {
    const body = await json<{ leagues: { name: string; scoringLabel: string; isSelected: boolean }[] }>(get('/api/leagues', cookie));
    expect(body.leagues[0]?.scoringLabel).toBe('Half PPR');
    expect(body.leagues[0]?.isSelected).toBe(true);
  });

  it('builds an explained draft board', async () => {
    const board = await json<{
      currentPick: number;
      recommendations: { name: string; reasons: string[]; components: { key: string }[]; adp: number | null }[];
      adpSnapshot: unknown;
      myRoster: unknown[];
    }>(get('/api/drafts/demo-draft/board', cookie));

    expect(board.currentPick).toBe(3); // two picks already made
    expect(board.recommendations.length).toBeGreaterThan(0);
    expect(board.adpSnapshot).toBeTruthy();
    for (const rec of board.recommendations) {
      expect(rec.reasons.length).toBeGreaterThan(0);
      expect(rec.components.length).toBeGreaterThan(4);
    }
  });

  it('excludes already-drafted players from the board', async () => {
    const board = await json<{ recommendations: { name: string }[] }>(get('/api/drafts/demo-draft/board', cookie));
    const names = board.recommendations.map((r) => r.name);
    expect(names).not.toContain('Marcus Vance'); // pick 1
    expect(names).not.toContain('Devin Okafor'); // pick 2
  });

  it('filters the board by position', async () => {
    const board = await json<{ recommendations: { position: string }[] }>(
      get('/api/drafts/demo-draft/board?position=WR', cookie),
    );
    expect(board.recommendations.every((r) => r.position === 'WR')).toBe(true);
  });

  it('returns the roster split into starters and bench', async () => {
    const body = await json<{ starters: unknown[]; bench: unknown[]; found: boolean }>(
      get('/api/leagues/demo-league/roster', cookie),
    );
    expect(body.found).toBe(true);
    expect(body.starters).toHaveLength(2);
    expect(body.bench.length).toBeGreaterThan(0);
  });

  it('never republishes newsletter bodies through the public message log', async () => {
    // Bodies are retained server-side so rules can be re-run, but reads on this
    // site are public and the newsletter is someone else's work.
    const body = await json<{ messages: Record<string, unknown>[] }>(get('/api/newsletter/messages'));
    for (const message of body.messages) {
      expect(message).not.toHaveProperty('bodyHtml');
      expect(message).not.toHaveProperty('bodyText');
      expect(JSON.stringify(message)).not.toContain('<p>');
    }
  });

  /**
   * The point of teaching the app a nickname is that it stops being a question.
   * "JSN" that has to be answered every week is not resolved, it is deferred.
   */
  it('remembers a nickname so the same name matches next time', async () => {
    const found = await json<{ players: { id: string; name: string }[] }>(
      get('/api/players?q=Vance', cookie),
    );
    const player = found.players[0]!;

    const saved = await json<{ aliases: string[] }>(
      post(`/api/players/${player.id}/aliases`, { alias: 'MV' }, cookie),
    );
    expect(saved.aliases).toContain('MV');

    // The nickname now resolves through the ordinary identity path.
    const ingested = await json<{ evidenceInserted: number }>(
      post(
        '/api/newsletter/ingest',
        {
          messageId: 'alias-check-1',
          from: 'editor@demo.newsletter',
          subject: 'Camp',
          date: new Date().toISOString(),
          html: '<p>MV was named the starter.</p>',
          force: true,
        },
        cookie,
      ),
    );
    expect(ingested.evidenceInserted).toBeGreaterThan(0);
  });

  it('refuses a nickname that already belongs to someone else', async () => {
    const vance = (await json<{ players: { id: string }[] }>(get('/api/players?q=Vance', cookie)))
      .players[0]!;
    await json(post(`/api/players/${vance.id}/aliases`, { alias: 'MV' }, cookie));

    const other = (await json<{ players: { id: string }[] }>(get('/api/players?q=Okafor', cookie)))
      .players[0]!;

    const res = await app(post(`/api/players/${other.id}/aliases`, { alias: 'MV' }, cookie), env);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('already means');
  });

  it('can forget a nickname again', async () => {
    const found = await json<{ players: { id: string }[] }>(get('/api/players?q=Vance', cookie));
    const player = found.players[0]!;
    await json(post(`/api/players/${player.id}/aliases`, { alias: 'Temp Nick' }, cookie));
    await json(post(`/api/players/${player.id}/aliases`, { alias: 'Temp Nick', remove: true }, cookie));
    const after = await json<{ aliases: string[] }>(get(`/api/players/${player.id}/aliases`, cookie));
    expect(after.aliases).not.toContain('Temp Nick');
  });

  it('refuses a bounce address as the expected sender, and says why', async () => {
    const res = await app(
      post(
        '/api/setup/newsletter',
        { senderEmail: 'bounce+93e88f.63af5d-fantasy-news=juncaj.net@mg-d0.substack.com' },
        cookie,
      ),
      env,
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('changes with every issue');
    expect(error).toContain('@substack.com');
  });

  it('masks sender addresses for the public and shows them once unlocked', async () => {
    await json(
      post(
        '/api/newsletter/ingest',
        {
          messageId: 'privacy-check-1',
          from: 'alexjuncaj@gmail.com',
          subject: 'test',
          date: new Date().toISOString(),
          html: '<p>hello</p>',
        },
        cookie,
      ),
    );

    // Anyone who finds the address can read the fantasy data, but a personal
    // email address is not fantasy data.
    const publicView = await json<{ messages: { fromAddress: string }[] }>(
      get('/api/newsletter/messages'),
    );
    const publicSerialised = JSON.stringify(publicView);
    expect(publicSerialised).not.toContain('alexjuncaj@gmail.com');
    expect(publicView.messages.some((m) => m.fromAddress === 'a***@gmail.com')).toBe(true);

    // The explanation quotes the sender too, so masking one field is not enough.
    expect(publicView.messages.some((m) => (m as { rejectReason?: string }).rejectReason?.includes('a***@gmail.com'))).toBe(
      true,
    );

    const publicStatus = await json<{ lastReceivedFrom: string | null }>(
      get('/api/setup/newsletter'),
    );
    expect(publicStatus.lastReceivedFrom).toBe('a***@gmail.com');
    expect(JSON.stringify(publicStatus)).not.toContain('alexjuncaj@gmail.com');

    // Unlocked, the full address is available — it is needed to accept a sender.
    const ownerView = await json<{ messages: { fromAddress: string }[] }>(
      get('/api/newsletter/messages', cookie),
    );
    expect(ownerView.messages.some((m) => m.fromAddress === 'alexjuncaj@gmail.com')).toBe(true);

    const ownerStatus = await json<{ lastReceivedFrom: string | null }>(
      get('/api/setup/newsletter', cookie),
    );
    expect(ownerStatus.lastReceivedFrom).toBe('alexjuncaj@gmail.com');
  });

  it('explains, rather than crashes, when a newsletter body was not kept', async () => {
    const res = await app(get('/api/newsletter/messages/never-seen/preview', cookie), env);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain('not kept');
  });

  it('recommends a whole lineup against the league roster shape', async () => {
    const body = await json<{
      found: boolean;
      slots: { slot: string; accepts: string[]; playerId: string | null; position: string | null }[];
      swaps: { inPlayerId: string; outPlayerId: string; gain: number }[];
      bench: unknown[];
      undecidable: unknown[];
    }>(get('/api/leagues/demo-league/lineup', cookie));

    expect(body.found).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);

    // Every filled slot holds an eligible player, and nobody starts twice.
    const filled = body.slots.filter((s) => s.playerId != null);
    for (const slot of filled) expect(slot.accepts).toContain(slot.position);
    expect(new Set(filled.map((s) => s.playerId)).size).toBe(filled.length);

    // A suggested change never moves a player onto and off the lineup at once.
    for (const swap of body.swaps) {
      expect(swap.inPlayerId).not.toBe(swap.outPlayerId);
      expect(swap.gain).toBeGreaterThan(0);
    }
  });

  it('serves the lineup without a session, but still refuses writes', async () => {
    // Fantasy data is public by design; nothing here should need unlocking.
    const res = await app(get('/api/leagues/demo-league/lineup'), env);
    expect(res.status).toBe(200);
  });

  it('imports an ADP snapshot and reports match counts', async () => {
    const body = await json<{ created: boolean; matched: number; unmatched: number }>(
      post('/api/adp/import', { content: 'name,position,team,adp\nMarcus Vance,RB,KC,2.4\nWho Dis,WR,SEA,90\n' }, cookie),
    );
    expect(body.created).toBe(true);
    expect(body.matched).toBe(1);
    expect(body.unmatched).toBe(1);
  });

  it('does not duplicate an identical ADP import', async () => {
    const content = 'name,position,team,adp\nMarcus Vance,RB,KC,2.4\n';
    await json(post('/api/adp/import', { content }, cookie));
    const second = await json<{ created: boolean }>(post('/api/adp/import', { content }, cookie));
    expect(second.created).toBe(false);
  });

  it('rejects an unparseable ADP file with a helpful message', async () => {
    const res = await app(post('/api/adp/import', { content: 'total,garbage\n1,2\n' }, cookie), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('no usable rows');
  });

  it('searches players and returns their signal', async () => {
    const body = await json<{ players: { name: string; signal: unknown }[] }>(get('/api/players?q=vance', cookie));
    expect(body.players[0]?.name).toBe('Marcus Vance');
  });

  it('returns a player detail with the full evidence timeline', async () => {
    const body = await json<{ evidence: unknown[]; signal: { raw: { items: number } }; props: unknown[] }>(
      get('/api/players/1001', cookie),
    );
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.props.length).toBeGreaterThan(0);
  });

  it('serves the review queue with player context', async () => {
    const body = await json<{ evidence: { playerName: string }[]; identity: unknown[] }>(get('/api/review/queue', cookie));
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.evidence[0]?.playerName).toBeTruthy();
  });

  it('applies a review decision and returns the refreshed signal', async () => {
    const queue = await json<{ evidence: { id: string; playerId: string }[] }>(get('/api/review/queue', cookie));
    const target = queue.evidence[0]!;
    const body = await json<{ item: { reviewStatus: string }; signal: { pendingCount: number } }>(
      post(`/api/review/evidence/${target.id}`, { action: 'accept' }, cookie),
    );
    expect(body.item.reviewStatus).toBe('accepted');
  });

  it('persists a user correction as authoritative', async () => {
    const queue = await json<{ evidence: { id: string }[] }>(get('/api/review/queue', cookie));
    const target = queue.evidence[0]!;
    const body = await json<{ item: { userOverride: { polarity: string } } }>(
      post(`/api/review/evidence/${target.id}`, { action: 'correct', polarity: 'negative', magnitude: 3 }, cookie),
    );
    expect(body.item.userOverride.polarity).toBe('negative');
  });

  it('ingests a newsletter through the HTTP endpoint', async () => {
    const body = await json<{ status: string; evidenceInserted: number }>(
      post(
        '/api/newsletter/ingest',
        {
          messageId: 'http-1',
          from: 'editor@demo.newsletter',
          subject: 'Camp Report',
          date: '2026-08-14T00:00:00Z',
          html: '<p>Kai Brennan was named the starter.</p>',
        },
        cookie,
      ),
    );
    expect(body.status).toBe('processed');
    expect(body.evidenceInserted).toBe(1);
  });

  it('quarantines a newsletter from an unqualified sender', async () => {
    const body = await json<{ status: string; detail: string }>(
      post('/api/newsletter/ingest', { messageId: 'spam-1', from: 'spam@evil.example', subject: 'hi', html: '<p>x</p>' }, cookie),
    );
    expect(body.status).toBe('quarantined');
    expect(body.detail).toContain('ignored');
  });

  it('compares start/sit with explicit component breakdowns', async () => {
    const body = await json<{
      recommendedPlayerId: string | null;
      evaluations: { name: string; components: unknown[]; expectation: { points: number | null } }[];
      confidence: string;
    }>(post('/api/startsit/compare', { playerIds: ['1001', '1004'] }, cookie));
    expect(body.evaluations).toHaveLength(2);
    expect(body.evaluations[0]?.components.length).toBeGreaterThan(3);
  });

  it('reports missing Vegas data instead of inventing it', async () => {
    // Player 1012 has no props in the mock game.
    const body = await json<{ warnings: string[]; evaluations: { expectation: { points: number | null } }[] }>(
      post('/api/startsit/compare', { playerIds: ['1001', '1012'] }, cookie),
    );
    expect(body.warnings.join(' ')).toContain('no Vegas data');
    const missing = body.evaluations.find((e) => e.expectation.points == null);
    expect(missing).toBeTruthy();
  });

  it('requires at least two players to compare', async () => {
    expect((await app(post('/api/startsit/compare', { playerIds: ['1001'] }, cookie), env)).status).toBe(400);
  });

  it('reports Vegas provider status and freshness', async () => {
    const body = await json<{ provider: string; configured: boolean; fetchedAt: string | null }>(
      get('/api/vegas/status', cookie),
    );
    expect(body.provider).toBe('mock');
    expect(body.fetchedAt).toBeTruthy();
  });

  it('rate limits repeated manual Vegas refreshes', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await app(post('/api/vegas/refresh', {}, cookie), env)).status);
    }
    expect(statuses).toContain(429);
  });

  it('returns 404 for an unknown route', async () => {
    expect((await app(get('/api/nope', cookie), env)).status).toBe(404);
  });

  it('returns 404 for an unknown player', async () => {
    expect((await app(get('/api/players/does-not-exist', cookie), env)).status).toBe(404);
  });

  it('handles a malformed JSON body without crashing', async () => {
    const req = new Request('https://app.test/api/adp/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    expect((await app(req, env)).status).toBe(400);
  });
});
