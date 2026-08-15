/**
 * The league-intelligence endpoints, over the real router and a real database.
 *
 * These are contract tests. Channel 2's Waivers page, the Trades page and the
 * What Changed feed are built against these payloads, so the shapes are pinned
 * here rather than left to whoever reads them next.
 *
 * One test matters more than the rest: nothing in this app submits a
 * transaction. It is asserted against the whole route table, not against a list
 * somebody remembered to update.
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

const get = (path: string) => new Request(`https://app.test${path}`);
const post = (path: string, body?: unknown, cookie?: string) =>
  new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });

describe('league intelligence endpoints', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
  });

  it('reports manager profiles and the limits behind them', async () => {
    const res = await app(get('/api/leagues/demo-league/managers'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      managers: unknown[];
      limits: string[];
      faabLeague: boolean;
      transactionsOnRecord: number;
    };

    expect(Array.isArray(body.managers)).toBe(true);
    expect(body.transactionsOnRecord).toBe(0);
    expect(body.faabLeague).toBe(false);
    expect(body.limits).toContain('league history has never been synced');
  });

  it('builds a waiver board with every dimension present', async () => {
    const res = await app(get('/api/leagues/demo-league/waiver-board?limit=5'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      board: {
        priority: number;
        priorityParts: { key: string; label: string; value: number }[];
        thisWeek: { known: boolean };
        next4: { known: boolean };
        needFitLabel: string;
        horizonLabel: string;
        expectedCost: { known: boolean; display: string };
        competition: { label: string };
      }[];
      considered: number;
    };

    expect(body.board.length).toBeGreaterThan(0);
    for (const row of body.board) {
      expect(typeof row.priority).toBe('number');
      expect(row.priorityParts.length).toBeGreaterThan(0);
      expect(row.needFitLabel).toBeTruthy();
      expect(row.horizonLabel).toBeTruthy();
      expect(['Low competition', 'Likely 2–3 bidders', 'High pressure']).toContain(row.competition.label);
      // With no transaction history, the price is honestly unknown.
      expect(row.expectedCost.known).toBe(false);
      // And the four-week outlook is not invented.
      expect(row.next4.known).toBe(false);
    }
  });

  it('is stable: the same request twice returns the same order', async () => {
    const first = (await (await app(get('/api/leagues/demo-league/waiver-board?limit=8'), env)).json()) as {
      board: { playerId: string }[];
    };
    const second = (await (await app(get('/api/leagues/demo-league/waiver-board?limit=8'), env)).json()) as {
      board: { playerId: string }[];
    };
    expect(second.board.map((r) => r.playerId)).toEqual(first.board.map((r) => r.playerId));
  });

  it('offers trade fits, or says why it cannot', async () => {
    const res = await app(get('/api/leagues/demo-league/trade-fit'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { found: boolean; ideas: { valueToUser: number; valueToPartner: number }[] };
    expect(body.found).toBe(true);
    for (const idea of body.ideas) {
      // The invariant of the whole module: both sides gain, or it is not listed.
      expect(idea.valueToUser).toBeGreaterThan(0);
      expect(idea.valueToPartner).toBeGreaterThan(0);
    }
  });

  it('plans quietly, and names the input it does not have', async () => {
    const res = await app(get('/api/leagues/demo-league/plan'), env);
    const body = (await res.json()) as {
      byes: { gaps: unknown[]; available: boolean; note: string };
      playoffs: { weight: number; weeks: number[] };
    };
    expect(body.byes.gaps).toEqual([]);
    expect(body.byes.available).toBe(false);
    expect(body.byes.note).toContain('no bye-week source');
    // No record synced, so playoff weeks carry no weight at all.
    expect(body.playoffs.weight).toBe(0);
    expect(body.playoffs.weeks).toEqual([15, 16, 17]);
  });

  it('starts the feed empty, which is the ordinary answer', async () => {
    const res = await app(get('/api/leagues/demo-league/feed'), env);
    const body = (await res.json()) as { events: unknown[]; unseen: number };
    expect(body.events).toEqual([]);
    expect(body.unseen).toBe(0);
  });

  it('404s for a league that does not exist', async () => {
    for (const path of ['managers', 'waiver-board', 'trade-fit', 'plan', 'feed']) {
      expect((await app(get(`/api/leagues/nope/${path}`), env)).status, path).toBe(404);
    }
  });

  it('requires an unlocked session to sync history', async () => {
    const res = await app(post('/api/leagues/demo-league/history/sync'), env);
    expect(res.status).toBe(401);
  });
});

describe('nothing in this app submits a transaction', () => {
  it('has no Sleeper write anywhere in the source', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
      }
    };
    walk('src');

    /*
     * Every path that reaches Sleeper is a read.
     *
     * The REST client is GET-only by construction — there is one private `get`
     * and nothing else issues a request — so the check is against the source:
     * no PUT, PATCH or DELETE anywhere near Sleeper, and no GraphQL mutation.
     *
     * The one POST that exists is deliberate and is not a write: Sleeper's
     * GraphQL endpoint takes its *query* in a POST body, which is how the
     * player outlook is read. Asserting "no POST" would fail on it and the
     * honest fix would be to weaken the test, so the test asks the real
     * question instead — is anything being mutated.
     */
    const sleeperFiles = files.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return source.includes('api.sleeper.app') || source.includes('sleeper.app/graphql');
    });
    expect(sleeperFiles.length).toBeGreaterThan(0);

    const offenders = sleeperFiles.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return /method:\s*'(PUT|PATCH|DELETE)'/.test(source) || /\bmutation\s*[({]/.test(source);
    });
    expect(offenders).toEqual([]);

    // And the REST client offers no method that could file a transaction.
    const client = readFileSync('src/core/sleeper/client.ts', 'utf8');
    expect(client).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    for (const word of ['waiverClaim', 'submitBid', 'proposeTrade', 'setLineup']) {
      expect(client).not.toContain(word);
    }
  });
});
