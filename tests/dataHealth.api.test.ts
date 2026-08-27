/**
 * `GET /api/data-health` — the contract, and the four things it must never do.
 *
 * §18's read-only guarantee is asserted next door, in
 * `dataHealth.isolation.test.ts`, by watching every statement the endpoint
 * prepares. This file is about the contract a caller depends on: the shape, the
 * auth, and the promise that nothing in the payload is a secret, a provider
 * payload or a raw exception.
 *
 * §12's other rule is here too: `/api/health` is not touched. That endpoint has
 * a release-gate job — an exact SHA comparison is the last thing standing
 * between a bad deploy and production — and growing it is how that check starts
 * failing for reasons unrelated to the deploy.
 */

import { describe, expect, it } from 'vitest';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { createTestDb } from './helpers/db.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { SOURCE_POLICIES } from '../src/core/health/policy.ts';
import type { DataHealthView } from '../src/core/health/model.ts';
import type { Database } from '../src/server/db.ts';

const app = createApp();

/** A transport that fails the test if anything reaches it. */
function forbiddenFetch(): SleeperClient {
  return new SleeperClient({
    fetch: async (url) => {
      throw new Error(`data health made a network request: ${String(url)}`);
    },
  });
}

async function env(db: Database, over: Partial<AppEnv> = {}): Promise<AppEnv> {
  return {
    db,
    sleeper: forbiddenFetch(),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: 'abc123',
    ...over,
  };
}

async function read(db: Database, over: Partial<AppEnv> = {}): Promise<DataHealthView> {
  const res = await app(new Request('https://app.test/api/data-health'), await env(db, over));
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  return (await res.json()) as DataHealthView;
}

describe('the contract', () => {
  it('answers with every field the screen and the snapshot read', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const view = await read(db);

    expect(view.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.release.gitSha).toBe('abc123');
    expect(typeof view.overall.headline).toBe('string');
    expect(view.overall.headline.length).toBeGreaterThan(0);
    expect(typeof view.overall.needsAttention).toBe('number');
    expect(Array.isArray(view.sources)).toBe(true);
  });

  it('reports every source the policy declares, in the policy order', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const view = await read(db);
    expect(view.sources.map((s) => s.id)).toEqual(SOURCE_POLICIES.map((p) => p.id));
  });

  it('uses only the canonical state words', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const view = await read(db);
    const allowed = new Set(['current', 'stale', 'waiting', 'degraded', 'missing', 'deferred', 'unknown']);
    for (const source of view.sources) expect(allowed.has(source.state), `${source.id}: ${source.state}`).toBe(true);
  });

  /**
   * A source nothing has been recorded for reports `unknown`, never `current`.
   *
   * The flattening this whole model refuses: turning an absence of measurement
   * into a measurement is how a health screen becomes worse than none.
   */
  it('never reports current for a source it has measured nothing about', async () => {
    const db = await createTestDb();
    const view = await read(db);
    for (const source of view.sources) {
      if (source.lastSuccessAt == null && source.lastAttemptAt == null) {
        expect(source.state, source.id).not.toBe('current');
      }
    }
  });
});

describe('what it must never carry', () => {
  const SECRETS = ['correct horse battery staple', 'test-secret-value-at-least-32-chars-long'];

  it('carries no passphrase, session secret or provider key', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const res = await app(
      new Request('https://app.test/api/data-health'),
      await env(db, { ODDS_API_KEY: 'sk-live-should-never-appear' } as Partial<AppEnv>),
    );
    const body = await res.text();
    for (const secret of [...SECRETS, 'sk-live-should-never-appear']) {
      expect(body, `the payload contained ${secret}`).not.toContain(secret);
    }
  });

  /**
   * A note is a sentence written for a person, and nothing else.
   *
   * The exact failure this guards: a pipeline note that interpolates an
   * exception, which on a provider failure is the request URL. Bounded at
   * capture, and asserted here on the finished payload.
   */
  it('carries no URL, no stack frame and no unbounded note', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const view = await read(db);
    const notes = [
      ...view.sources.map((s) => s.note),
      ...view.sources.map((s) => s.technical.note),
      ...(view.lastRun?.steps ?? []).map((s) => s.note),
    ].filter((n): n is string => n != null);

    for (const note of notes) {
      expect(note).not.toMatch(/https?:\/\//);
      expect(note).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
      expect(note.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('it changes nothing and asks nobody anything', () => {
  /**
   * Every source read below would go through a transport that throws if it were
   * asked to fetch. A green test is the proof that none of them did.
   */
  it('makes no provider request of any kind', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    await expect(read(db)).resolves.toBeTruthy();
  });

  it('is a GET, and the route table has no writer for this path', async () => {
    const db = await createTestDb();
    const res = await app(new Request('https://app.test/api/data-health', { method: 'POST' }), await env(db));
    expect(res.status).toBe(404);
  });

  /**
   * A read, so it is answerable without unlocking — like every other read in
   * this app. The auth middleware guards writes; a support surface that
   * required a passphrase would be unusable in the moment it exists for.
   */
  it('answers a locked session, because it is a read', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const res = await app(new Request('https://app.test/api/data-health'), await env(db));
    expect(res.status).toBe(200);
  });
});

describe('the release endpoint is left alone', () => {
  /**
   * §12, asserted rather than promised. `/api/health` exists to answer three
   * things, and the third — the exact revision — is what the release gate
   * compares. Nothing from this lane may appear in it.
   */
  it('/api/health still answers exactly what it answered before', async () => {
    const db = await createTestDb();
    const res = await app(new Request('https://app.test/api/health'), await env(db));
    expect(await res.json()).toEqual({
      ok: true,
      service: 'fantasy-analyst',
      release: { gitSha: 'abc123' },
    });
  });
});
