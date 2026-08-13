/**
 * Setup status and configuration.
 *
 * The point of these tests is that a brand-new deployment tells the user what
 * to do next, in plain language, and that every state transition is reflected
 * honestly — including "we don't have an email address yet".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { SetupService } from '../src/server/services/setupService.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';

const ADDRESS = 'fantasy-news@example.net';

function service(db: NodeSqliteDatabase, address: string | null = ADDRESS): SetupService {
  return new SetupService(db, new MockVegasProvider(MOCK_GAMES), address);
}

function step(status: Awaited<ReturnType<SetupService['status']>>, id: string) {
  return status.steps.find((s) => s.id === id)!;
}

describe('setup status — brand new deployment', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('lists all five areas in order', async () => {
    const status = await service(db).status();
    expect(status.steps.map((s) => s.id)).toEqual(['sleeper', 'league', 'adp', 'newsletter', 'vegas']);
  });

  it('tells the user what to do first, without jargon', async () => {
    const status = await service(db).status();
    const text = status.steps.map((s) => `${s.summary} ${s.action ?? ''}`).join(' ');
    expect(step(status, 'sleeper').state).toBe('todo');
    expect(step(status, 'sleeper').action).toContain('Sleeper username');
    for (const jargon of ['POST', 'JSON', 'endpoint', 'binding', 'environment variable', 'HTTP']) {
      expect(text.toLowerCase(), `setup text should avoid "${jargon}"`).not.toContain(jargon.toLowerCase());
    }
  });

  it('is not ready for draft day', async () => {
    expect((await service(db).status()).readyForDraft).toBe(false);
  });

  it('says the newsletter address is not set up when the deployment has none', async () => {
    const status = await service(db, null).status();
    expect(status.newsletter.addressConfigured).toBe(false);
    expect(status.newsletter.address).toBeNull();
    expect(step(status, 'newsletter').state).toBe('todo');
    expect(step(status, 'newsletter').summary).toContain('not set up');
  });

  it('shows the address once the deployment provides one', async () => {
    const status = await service(db).status();
    expect(status.newsletter.address).toBe(ADDRESS);
    expect(status.newsletter.addressConfigured).toBe(true);
    // Address known but sender not chosen yet.
    expect(step(status, 'newsletter').state).toBe('warn');
    expect(step(status, 'newsletter').action).toContain('which sender');
  });

  it('asks the user to subscribe once the sender is configured', async () => {
    await new NewsletterService(db).setSources([
      { id: 'ff', label: 'FF', fromPatterns: ['news@theirsite.com'], enabled: true },
    ]);
    const status = await service(db).status();
    expect(step(status, 'newsletter').action).toContain(`Subscribe your FF Newsletter to ${ADDRESS}`);
  });

  it('reports Vegas as optional and not live', async () => {
    const status = await service(db).status();
    expect(step(status, 'vegas').state).toBe('off');
    expect(status.vegas.live).toBe(false);
    expect(status.vegas.note).toContain('Practice data');
  });

  it('prefers an in-app address override over the deployment value', async () => {
    const svc = service(db);
    expect(await svc.inboundAddress()).toBe(ADDRESS);
    const { SettingsRepo, SETTING_KEYS } = await import('../src/server/repos/settings.ts');
    await new SettingsRepo(db).set(SETTING_KEYS.inboundAddress, 'other@example.net');
    expect(await svc.inboundAddress()).toBe('other@example.net');
  });
});

describe('setup status — configured deployment', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('reports every area as done and ready for the draft', async () => {
    const status = await service(db).status();
    expect(step(status, 'sleeper').state).toBe('ok');
    expect(step(status, 'league').state).toBe('ok');
    expect(step(status, 'adp').state).toBe('ok');
    expect(status.readyForDraft).toBe(true);
  });

  it('summarises the league in fantasy terms', async () => {
    const status = await service(db).status();
    expect(step(status, 'league').summary).toContain('Demo Dynasty');
    expect(step(status, 'league').summary).toContain('Half PPR');
  });

  /**
   * Draft order needs an imported ranking. Sleeper's search_rank is not one —
   * it ranks by who gets looked up — so it must never be reported as a source.
   */
  it('reports draft order from the imported ranking, with match counts', async () => {
    const status = await service(db).status();
    const adp = step(status, 'adp');
    expect(adp.title).toBe('Draft order');
    expect(adp.state).toBe('ok');
    expect(adp.summary).toMatch(/\d+ of \d+ players matched/);
    expect(status.adp.source).toBe('imported file');
    expect(adp.summary).not.toMatch(/Sleeper/);
  });

  it('counts newsletter activity', async () => {
    const status = await service(db).status();
    expect(status.newsletter.totals.newslettersProcessed).toBe(1);
    expect(status.newsletter.totals.evidenceItems).toBeGreaterThan(0);
    expect(status.newsletter.lastProcessedAt).toBeTruthy();
    expect(status.newsletter.lastProcessedDetail).toContain('Found news on');
  });

  it('warns when Sleeper is connected but the player list is empty', async () => {
    const fresh = await createTestDb();
    const { SettingsRepo, SETTING_KEYS } = await import('../src/server/repos/settings.ts');
    await new SettingsRepo(fresh).set(SETTING_KEYS.sleeperUser, {
      userId: 'u1',
      username: 'me',
      displayName: 'Me',
    });
    const status = await service(fresh).status();
    expect(step(status, 'sleeper').state).toBe('warn');
    expect(step(status, 'sleeper').action).toContain('player list');
  });

  it('warns when the selected league does not contain the user roster', async () => {
    await db.exec('UPDATE rosters SET is_mine = 0');
    const status = await service(db).status();
    expect(step(status, 'league').state).toBe('warn');
    expect(status.league.rosterFound).toBe(false);
  });
});

// ------------------------------------------------------------------- API -----
describe('setup API', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  const get = (path: string) => new Request(`https://app.test${path}`, { headers: { cookie } });
  const post = (path: string, body: unknown) =>
    new Request(`https://app.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    env = {
      db,
      sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
      vegas: new MockVegasProvider(MOCK_GAMES),
      inboundAddress: ADDRESS,
      APP_PASSPHRASE: 'pass phrase for tests',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    };
    app = createApp();
    const res = await app(
      new Request('https://app.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: 'pass phrase for tests' }),
      }),
      env,
    );
    cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  });

  it('lets anyone read the setup status', async () => {
    const res = await app(new Request('https://app.test/api/setup/status'), env);
    expect(res.status).toBe(200);
  });

  it('requires an unlocked session to change configuration', async () => {
    const res = await app(
      new Request('https://app.test/api/setup/newsletter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senderEmail: 'news@theirsite.com' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns the setup status', async () => {
    const body = (await (await app(get('/api/setup/status'), env)).json()) as { steps: unknown[] };
    expect(body.steps).toHaveLength(5);
  });

  it('saves a newsletter sender typed as a plain address', async () => {
    const body = (await (
      await app(post('/api/setup/newsletter', { senderEmail: 'News@TheirSite.com ' }), env)
    ).json()) as { senderConfigured: boolean; expectedSenders: string[] };
    expect(body.senderConfigured).toBe(true);
    expect(body.expectedSenders).toEqual(['news@theirsite.com']);
  });

  it('accepts a bare domain as the sender', async () => {
    const res = await app(post('/api/setup/newsletter', { senderEmail: '@theirsite.com' }), env);
    expect(res.status).toBe(200);
  });

  it('rejects nonsense with a readable message', async () => {
    const res = await app(post('/api/setup/newsletter', { senderEmail: 'not an address' }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('does not look like');
  });

  it('treats a subject filter as literal text, not a pattern', async () => {
    await app(post('/api/setup/newsletter', { senderEmail: 'news@theirsite.com', subjectContains: 'Week (1)' }), env);
    const svc = new NewsletterService(db);
    const sources = await svc.getSources();
    // The parentheses must be escaped, or the filter would silently match nothing.
    expect(sources[0]?.subjectPatterns?.[0]).toBe('Week \\(1\\)');
  });

  it('lets the user set the inbound address from the app', async () => {
    const body = (await (
      await app(post('/api/setup/newsletter', { inboundAddress: 'mine@example.org' }), env)
    ).json()) as { address: string };
    expect(body.address).toBe('mine@example.org');
  });

  it('rejects an invalid inbound address', async () => {
    const res = await app(post('/api/setup/newsletter', { inboundAddress: 'nope' }), env);
    expect(res.status).toBe(400);
  });

  it('exposes the newsletter status on its own', async () => {
    const body = (await (await app(get('/api/setup/newsletter'), env)).json()) as { address: string };
    expect(body.address).toBe(ADDRESS);
  });

  it('lists already-applied evidence so it stays inspectable', async () => {
    await new NewsletterService(db).setSources([
      { id: 'ff', label: 'FF', fromPatterns: ['@ffnewsletter.example'], enabled: true },
    ]);
    const { toEmailMessage } = await import('../src/core/newsletter/source.ts');
    const { CLEAN_NEWSLETTER } = await import('./fixtures/newsletters.ts');
    await new NewsletterService(db).ingest(
      toEmailMessage({
        messageId: 'applied-1',
        from: 'editor@ffnewsletter.example',
        subject: 'Notes',
        date: '2026-08-13T12:00:00.000Z',
        html: CLEAN_NEWSLETTER,
      }),
    );
    const body = (await (await app(get('/api/review/applied'), env)).json()) as {
      evidence: { reviewStatus: string; playerName: string }[];
    };
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.evidence.every((e) => e.reviewStatus !== 'pending')).toBe(true);
    expect(body.evidence[0]?.playerName).toBeTruthy();
  });
});
