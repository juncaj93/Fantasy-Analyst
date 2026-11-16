/**
 * Round 34, Alex's go on two follow-ups to the CPU finding:
 *
 *  - a simple free limit on the heavy public reads, which never limits a
 *    logged-in phone and leaves Team's lineup and Matchup alone;
 *  - one quick retry when Cloudflare refuses a Players card, Data health or
 *    Check's verdict (its logs show the next request passes).
 *
 * Every check here fails on the code before this change.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import workerEntry from '../src/worker/index.ts';
import type { WorkerEnv } from '../src/worker/index.ts';
import { HEAVY_READS_PER_MINUTE, HeavyReadLimiter, isHeavyRead } from '../src/server/http/rateLimit.ts';
import { createSessionCookie } from '../src/server/http/auth.ts';
import { READ_RETRY_DELAYS_MS, withCpuRetry } from '../src/web/supportRetry.ts';
import { ApiError } from '../src/web/apiResponse.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('which reads count as heavy', () => {
  it('the Waivers build, the board, offers, snapshots, trade sweeps and diagnostics do', () => {
    for (const path of [
      '/api/leagues/abc/waivers',
      '/api/leagues/abc/support-snapshot',
      '/api/leagues/abc/trades/build',
      '/api/leagues/abc/trades/check',
      '/api/players/season',
      '/api/trades/screens/offers',
      '/api/trades/smart',
      '/api/diagnostics/trade-values',
    ])
      expect(isHeavyRead('GET', path), path).toBe(true);
  });

  it('Team, Matchup, a card, Data health, Check and every write do not', () => {
    for (const path of ['/api/leagues/abc/lineup', '/api/leagues/abc/matchup', '/api/leagues/abc/roster', '/api/players/123/season', '/api/data-health', '/api/trades/screens/verdict', '/api/overview'])
      expect(isHeavyRead('GET', path), path).toBe(false);
    expect(isHeavyRead('POST', '/api/leagues/abc/waivers')).toBe(false);
  });
});

describe('the limiter', () => {
  it(`allows ${HEAVY_READS_PER_MINUTE} heavy reads a minute per address, then refuses, then resets`, () => {
    const limiter = new HeavyReadLimiter();
    const t = 1_000_000;
    for (let i = 0; i < HEAVY_READS_PER_MINUTE; i++) expect(limiter.allow('1.2.3.4', t + i)).toBe(true);
    expect(limiter.allow('1.2.3.4', t + 100)).toBe(false);
    expect(limiter.allow('5.6.7.8', t + 100), 'another address is untouched').toBe(true);
    expect(limiter.allow('1.2.3.4', t + 60_000), 'a new minute starts fresh').toBe(true);
  });
});

describe('the Worker', () => {
  const env = {
    SESSION_SECRET: 'round34-session-secret-value-32-chars',
    get DB(): never {
      throw new Error('no database in this test');
    },
  } as unknown as WorkerEnv;
  const heavy = (ip: string, cookie?: string) =>
    new Request('https://app.test/api/leagues/abc/waivers', { headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) } });

  it('answers a runaway loop with 429 JSON once an address is over the limit', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < HEAVY_READS_PER_MINUTE; i++) expect((await workerEntry.fetch(heavy('9.9.9.1'), env)).status).not.toBe(429);
      const refused = await workerEntry.fetch(heavy('9.9.9.1'), env);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
      expect(await refused.json()).toEqual({ error: 'Too many requests right now. Try again in a minute.' });
    } finally {
      quiet.mockRestore();
    }
  });

  it('never limits a logged-in phone', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cookie = (await createSessionCookie(env)).split(';')[0]!;
      for (let i = 0; i < HEAVY_READS_PER_MINUTE + 5; i++) expect((await workerEntry.fetch(heavy('9.9.9.2', cookie), env)).status).not.toBe(429);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('one quick retry on a refused read', () => {
  it('a 503 is tried once more after a short wait, and the second answer is used', async () => {
    let calls = 0;
    const waits: number[] = [];
    const answer = await withCpuRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new ApiError('refused', 503);
        return 'card';
      },
      { delays: READ_RETRY_DELAYS_MS, sleep: async (ms) => void waits.push(ms) },
    );
    expect(answer).toBe('card');
    expect(calls).toBe(2);
    expect(waits).toEqual([400]);
  });

  it('only once: a second refusal is shown as before', async () => {
    let calls = 0;
    await expect(
      withCpuRetry(
        async () => {
          calls += 1;
          throw new ApiError('refused', 503);
        },
        { delays: READ_RETRY_DELAYS_MS, sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
  });

  it('the Players card, Data health and Check use it', () => {
    for (const file of ['src/web/components/players2/seasonCard.tsx', 'src/web/components/dataHealth.tsx', 'src/web/components/trades2/checkTab.tsx'])
      expect(read(file), file).toMatch(/withCpuRetry\(\(\) => api\.get<\w+>\(.*\{ delays: READ_RETRY_DELAYS_MS \}\)/);
  });
});
