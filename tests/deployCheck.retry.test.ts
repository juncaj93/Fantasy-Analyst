/**
 * The deploy check retries a dropped connection and still fails on a real error
 * (Round 10).
 *
 * On 5 November 2026 a release that was fine failed its post-deploy check
 * because one curl to the lineup route ended with error 56 (the connection
 * dropped while the answer was arriving), and the deploy had to be re-run by
 * hand. The check is now `scripts/check-deployed-site.mjs`; these drive it
 * with a scripted site, no network, no clock.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script, deliberately not part of the app build
import { checkDeployedSite } from '../scripts/check-deployed-site.mjs';
// @ts-expect-error -- a plain .mjs script, deliberately not part of the app build
import { NETWORK_ATTEMPTS, fetchWithRetry } from '../scripts/lib/retryFetch.mjs';
// @ts-expect-error -- a plain .mjs script, deliberately not part of the app build
import { readHealth } from '../scripts/check-release-sha.mjs';
import { readWorkflow, steps } from './helpers/workflowYaml.ts';

const SITE = 'https://fantasy-analyst.example';

/** What curl reports as error 56: the connection reset while the body was arriving. */
function droppedMidBody(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
    },
  });
  return new Response(body, { status: 200 });
}

/** The request never got an answer at all. */
const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));

type Answer = () => Promise<Response> | Response;

/** A healthy deployment, with per-path overrides consumed in order. */
function site(overrides: Record<string, Answer[]> = {}) {
  const calls: string[] = [];
  const healthy: Record<string, Answer> = {
    'GET /api/health': () => Response.json({ ok: true, release: { gitSha: 'abc' } }),
    'GET /': () => new Response('<!doctype html><div id="root"></div><script type="module" src="/a.js"></script>'),
    'GET /api/leagues/does-not-exist/lineup': () => Response.json({ error: 'league not found' }, { status: 404 }),
    'POST /api/sleeper/sync-players': () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  };
  const queues = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]]));
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    calls.push(key);
    const next = queues[key]?.shift() ?? healthy[key];
    if (!next) return new Response('not found', { status: 404 });
    return next();
  };
  return { fetchImpl, calls, count: (key: string) => calls.filter((c) => c === key).length };
}

const run = (s: ReturnType<typeof site>) =>
  checkDeployedSite({ url: SITE, fetchImpl: s.fetchImpl, sleep: async () => {}, onLine: () => {} });

describe('the deploy check', () => {
  it('passes a healthy deployment, with one request per question', async () => {
    const s = site();
    expect(await run(s)).toEqual({ ok: true, failures: [] });
    expect(s.calls).toEqual(['GET /api/health', 'GET /', 'GET /api/leagues/does-not-exist/lineup', 'POST /api/sleeper/sync-players']);
  });

  it('no longer reads /api/overview, the many-table read', async () => {
    const s = site();
    await run(s);
    expect(s.calls.some((c) => c.includes('/api/overview'))).toBe(false);
  });

  it('retries a connection that dropped while the answer arrived (curl error 56), and passes', async () => {
    const s = site({ 'GET /api/leagues/does-not-exist/lineup': [droppedMidBody] });
    expect(await run(s)).toEqual({ ok: true, failures: [] });
    expect(s.count('GET /api/leagues/does-not-exist/lineup')).toBe(2);
  });

  it('retries a request that got no answer at all, and passes', async () => {
    const s = site({ 'GET /': [refused, refused] });
    expect((await run(s)).ok).toBe(true);
    expect(s.count('GET /')).toBe(3);
  });

  it('fails once the connection keeps dropping, after a bounded number of tries', async () => {
    const s = site({ 'GET /api/leagues/does-not-exist/lineup': Array(NETWORK_ATTEMPTS + 2).fill(droppedMidBody) });
    const verdict = await run(s);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/lineup route: no answer/);
    expect(s.count('GET /api/leagues/does-not-exist/lineup')).toBe(NETWORK_ATTEMPTS);
  });

  it('still fails on a real error, without retrying it', async () => {
    const s = site({ 'GET /api/leagues/does-not-exist/lineup': [() => new Response('internal error', { status: 500 })] });
    const verdict = await run(s);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/lineup route: HTTP 500/);
    expect(s.count('GET /api/leagues/does-not-exist/lineup')).toBe(1);
  });

  it('fails when the lineup route is missing (the router, not the handler, answered)', async () => {
    const s = site({ 'GET /api/leagues/does-not-exist/lineup': [() => Response.json({ error: 'not found' }, { status: 404 })] });
    expect((await run(s)).ok).toBe(false);
  });

  it('fails on an empty page or an error page where the app should be', async () => {
    expect((await run(site({ 'GET /': [() => new Response('')] }))).ok).toBe(false);
    expect((await run(site({ 'GET /': [() => new Response('<h1>Error 1101</h1>', { status: 500 })] }))).ok).toBe(false);
  });

  it('fails when a stranger’s write goes through, at once', async () => {
    const s = site({ 'POST /api/sleeper/sync-players': [() => Response.json({ written: 3300 })] });
    const verdict = await run(s);
    expect(verdict.ok).toBe(false);
    expect(s.count('POST /api/sleeper/sync-players')).toBe(1);
  });

  it('waits while the passphrase propagates (503), then passes on the 401', async () => {
    const s = site({ 'POST /api/sleeper/sync-players': [() => new Response('{}', { status: 503 })] });
    expect((await run(s)).ok).toBe(true);
    expect(s.count('POST /api/sleeper/sync-players')).toBe(2);
  });
});

describe('the shared retry', () => {
  it('hands back any real answer untouched, whatever its status', async () => {
    let calls = 0;
    const got = await fetchWithRetry(`${SITE}/x`, {}, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('nope', { status: 404 });
      },
      sleep: async () => {},
    });
    expect(got).toMatchObject({ ok: true, status: 404, text: 'nope', attempts: 1 });
    expect(calls).toBe(1);
  });
});

describe('the revision check', () => {
  it('treats a body that stops part way as "not reached", so its own retries cover it', async () => {
    const health = await readHealth(SITE, async () => droppedMidBody());
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/stopped answering part way/);
  });
});

describe('the release workflow uses the lighter check', () => {
  const { yaml } = readWorkflow('release.yml');
  const release = steps(yaml, 'release');
  const step = (name: string) => release.find((s) => s['name'] === name);

  it('runs the script, not a row of curl calls', () => {
    const run = String(step('Check the deployed site actually works')?.['run']);
    expect(run).toContain('node scripts/check-deployed-site.mjs');
    expect(run).not.toContain('curl');
  });

  it('loads first-run data only on the deploy that created the database', () => {
    for (const name of [
      'Load the NFL player list on first run',
      "Load last season's statistics if they are missing",
      'Read the injury report on first run',
      'Read the weekly usage file on first run',
      'Read the nflverse feeds on first run',
    ]) {
      expect(step(name)?.['if'], name).toBe("${{ steps.d1.outputs.created == 'yes' }}");
    }
    expect(String(step('Find or create the database')?.['run'])).toContain('echo "created=yes" >> "$GITHUB_OUTPUT"');
  });

  it('keeps the live-version check', () => {
    expect(String(step('Check production is answering as this revision')?.['run'])).toContain('scripts/check-release-sha.mjs');
  });
});
