/**
 * What production says it is running.
 *
 * The release path's whole claim — CI validated this revision, this revision
 * was deployed, this revision is live — is only checkable because the last of
 * those three can be read from outside. That makes `/api/health` load-bearing
 * infrastructure rather than a liveness ping, and these are the assertions the
 * deploy check and the smoke check both rest on.
 *
 * See docs/RELEASE.md.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, reportedGitSha, type AppEnv } from '../src/server/app.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const SHA = '21c37b41ef72cac46323bebd1d6e6b421298862b';

describe('/api/health reports the deployed revision', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  const env = (overrides: Partial<AppEnv> = {}): AppEnv => ({
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider([]),
    ...overrides,
  });

  const health = async (overrides: Partial<AppEnv> = {}) => {
    const res = await app(new Request('https://app.test/api/health'), env(overrides));
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; service: string; release: { gitSha: string } };
  };

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp();
  });

  it('reports the revision the deployment was built from', async () => {
    expect((await health({ releaseSha: SHA })).release.gitSha).toBe(SHA);
  });

  /*
   * The value comes from deploy-time configuration and nothing else: no GitHub
   * API call, no row in D1, no build timestamp standing in for a revision. So a
   * deployment that was never stamped has to say so rather than invent one.
   */
  it('says "unknown" where nothing was injected', async () => {
    expect((await health()).release.gitSha).toBe('unknown');
    expect((await health({ releaseSha: null })).release.gitSha).toBe('unknown');
    expect((await health({ releaseSha: '' })).release.gitSha).toBe('unknown');
    expect((await health({ releaseSha: '   ' })).release.gitSha).toBe('unknown');
  });

  it('stays small — status, service, revision, and nothing else', async () => {
    const body = await health({ releaseSha: SHA });
    expect(Object.keys(body).sort()).toEqual(['ok', 'release', 'service']);
    expect(Object.keys(body.release)).toEqual(['gitSha']);
    expect(body).toEqual({ ok: true, service: 'fantasy-analyst', release: { gitSha: SHA } });
  });

  /*
   * A public endpoint. The revision is a commit id that anyone can already read
   * in the repository; a passphrase, a session secret or an API key is not, and
   * none of them has any business in a health response.
   */
  it('never leaks anything else from the environment', async () => {
    const secrets = {
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      inboundAddress: 'fantasy-news@example.com',
    };
    const text = JSON.stringify(await health({ releaseSha: SHA, ...secrets }));
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
  });

  it('is served without a session, so a check needs no credentials', async () => {
    const res = await app(new Request('https://app.test/api/health'), env({
      APP_PASSPHRASE: 'correct horse battery staple',
      releaseSha: SHA,
    }));
    expect(res.status).toBe(200);
  });
});

describe('reportedGitSha', () => {
  it('passes a revision through untouched', () => {
    expect(reportedGitSha(SHA)).toBe(SHA);
  });

  it('turns every flavour of absent into "unknown"', () => {
    for (const value of [undefined, null, '', '  ', '\n']) expect(reportedGitSha(value)).toBe('unknown');
  });

  it('trims, so a stray newline in the injected value is not a different revision', () => {
    expect(reportedGitSha(`  ${SHA}\n`)).toBe(SHA);
  });
});
