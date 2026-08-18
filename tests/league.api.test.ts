/**
 * The league-intelligence endpoints, over the real router and a real database.
 *
 * This workstream owns no screens. It fills the one field the waiver board
 * declares and nothing else supplies — `WaiverLeagueIntel.competition` — and
 * adds the three questions nothing else answers: which deals to propose, what
 * the weeks ahead look like, and what changed since you last looked.
 *
 * The first test is therefore a contract test against `core/waivers/board.ts`:
 * if this pass stops filling those fields, or fills them with something the
 * board cannot read, the Waivers screen silently degrades to "unknown" and
 * nothing else would notice.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
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
const post = (path: string, body?: unknown) =>
  new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });

interface WaiverPayload {
  upgrades: {
    candidates: {
      playerId: string;
      competition: { level: string; label: string; detail: string | null } | null;
      multiWeek: { level: string; label: string; detail: string | null } | null;
    }[];
  }[];
}

describe('league intelligence fills the waiver board’s own fields', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
  });

  it('attaches competition to every candidate', async () => {
    const res = await app(get('/api/leagues/demo-league/waivers'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaiverPayload;

    const candidates = body.upgrades.flatMap((u) => u.candidates);
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      // Present-and-null is a pass that found nothing; absent is no pass at all.
      // This pass ran, so the field may not be absent.
      expect(candidate.competition, candidate.playerId).not.toBeUndefined();
      expect(['high', 'medium', 'low', 'unknown']).toContain(candidate.competition!.level);
      expect(candidate.competition!.label).toBeTruthy();
    }
  });

  it('leaves the rest of the waiver payload exactly as it was', async () => {
    const body = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as Record<string, unknown>;
    // The keys the Waivers screen and the board module read.
    for (const key of ['league', 'found', 'dataFreshness', 'upgrades', 'pool', 'faab', 'notes', 'considered']) {
      expect(Object.keys(body), key).toContain(key);
    }
  });

  /*
   * The end-to-end proof that the seam is actually closed.
   *
   * `buildWaiverBoard` names the columns still waiting on a supplier in
   * `pending`, and the screen prints that line. If this pass stops filling
   * competition the board goes back to advertising it as missing — and this
   * test is the only thing that would notice, because a null field renders as a
   * quiet dash rather than an error.
   *
   * Multi-week value is deliberately *not* asserted. It shares the line, but
   * its supplier declines when no usage is stored — `waiverMultiWeek` says so
   * in as many words — and the seeded database stores none. Requiring it here
   * would pin a behaviour that is correct only when a usage feed has run, and
   * the point of this test is that competition arrives independently of that.
   */
  it('stops the board advertising competition as pending', async () => {
    const advice = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as Parameters<
      typeof buildWaiverBoard
    >[0];
    const board = buildWaiverBoard(advice);

    expect(board.rows.length).toBeGreaterThan(0);
    expect(board.pending).not.toContain('likely competition');
    expect(board.rows.every((r) => r.competition != null)).toBe(true);
  });

  it('is stable: the same request twice returns the same order', async () => {
    const first = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as WaiverPayload;
    const second = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as WaiverPayload;
    expect(second.upgrades.flatMap((u) => u.candidates.map((c) => c.playerId))).toEqual(
      first.upgrades.flatMap((u) => u.candidates.map((c) => c.playerId)),
    );
  });
});

describe('the questions nothing else answers', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
  });

  it('offers trade fits where both sides gain, or says why it cannot', async () => {
    const res = await app(get('/api/leagues/demo-league/trade-fit'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      ideas: { valueToUser: number; valueToPartner: number; plausibility: number }[];
      notes: string[];
    };
    expect(body.found).toBe(true);
    for (const idea of body.ideas) {
      // The invariant of the whole module: both sides gain, or it is not listed.
      expect(idea.valueToUser).toBeGreaterThan(0);
      expect(idea.valueToPartner).toBeGreaterThan(0);
    }
    // No profiles synced in the demo database, and it says so rather than
    // presenting untested plausibility as measured.
    expect(body.notes.join(' ')).toContain('untested rather than measured');
  });

  it('plans quietly, and names the input it does not have', async () => {
    const body = (await (await app(get('/api/leagues/demo-league/plan'), env)).json()) as {
      byes: { gaps: unknown[]; available: boolean; note: string };
      playoffs: { weight: number; weeks: number[] };
    };
    expect(body.byes.gaps).toEqual([]);
    expect(body.byes.available).toBe(false);
    expect(body.byes.note).toContain('no bye-week source');
    expect(body.playoffs.weight).toBe(0);
    expect(body.playoffs.weeks).toEqual([15, 16, 17]);
  });

  it('starts the feed empty, which is the ordinary answer', async () => {
    const body = (await (await app(get('/api/leagues/demo-league/feed'), env)).json()) as {
      events: unknown[];
      unseen: number;
    };
    expect(body.events).toEqual([]);
    expect(body.unseen).toBe(0);
  });

  it('404s for a league that does not exist', async () => {
    for (const path of ['trade-fit', 'plan', 'feed']) {
      expect((await app(get(`/api/leagues/nope/${path}`), env)).status, path).toBe(404);
    }
  });

  it('requires an unlocked session to mark the feed seen', async () => {
    expect((await app(post('/api/leagues/demo-league/feed/seen'), env)).status).toBe(401);
  });
});

describe('nothing in this app submits a transaction', () => {
  it('reaches Sleeper only to read', async () => {
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
     * The REST client is GET-only by construction — one private `get`, and
     * nothing else issues a request — so the check is against the source: no
     * PUT, PATCH or DELETE anywhere near Sleeper, and no GraphQL mutation.
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

    const client = readFileSync('src/core/sleeper/client.ts', 'utf8');
    expect(client).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    for (const word of ['waiverClaim', 'submitBid', 'proposeTrade', 'setLineup']) {
      expect(client).not.toContain(word);
    }
  });
});
