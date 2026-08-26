/**
 * The comparison that decides whether a release is verified.
 *
 * `scripts/check-release-sha.mjs` is the piece of the release path that runs
 * against a live site, which is exactly why its *logic* is tested here without
 * one: the case worth being sure about is the failing case, and a mismatched
 * production is not a state anyone can conjure on demand.
 *
 * Every branch it can take, and the branch that matters most is the one where
 * production answers happily with the wrong revision.
 */

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- a plain .mjs script, deliberately not part of the app build
import { checkRelease, compareRevision, parseArgs, readHealth, revisionFromHealth } from '../scripts/check-release-sha.mjs';

const A = '21c37b41ef72cac46323bebd1d6e6b421298862b';
const B = '5502058aa1b2c3d4e5f60718293a4b5c6d7e8f90';

const healthy = (sha: string) => ({ ok: true, service: 'fantasy-analyst', release: { gitSha: sha } });

/** A `fetch` that answers `/api/health` with whatever is queued, in order. */
function fakeFetch(...responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  });
  return Object.assign(impl, { calls });
}

describe('reading the revision out of a health response', () => {
  it('finds it where the app puts it', () => {
    expect(revisionFromHealth(healthy(A))).toBe(A);
  });

  it('lowercases, so a capitalised SHA is not a different revision', () => {
    expect(revisionFromHealth(healthy(A.toUpperCase()))).toBe(A);
  });

  it('returns null when the field is missing, not a guess', () => {
    expect(revisionFromHealth({ ok: true, service: 'fantasy-analyst' })).toBeNull();
    expect(revisionFromHealth({ ok: true, release: {} })).toBeNull();
    expect(revisionFromHealth({ ok: true, release: { gitSha: '' } })).toBeNull();
    expect(revisionFromHealth(null)).toBeNull();
    expect(revisionFromHealth('not json at all')).toBeNull();
  });
});

describe('comparing what is live against what was released', () => {
  it('passes when they are the same revision', () => {
    const verdict = compareRevision({ expected: A, body: healthy(A) });
    expect(verdict.ok).toBe(true);
    expect(verdict.actual).toBe(A);
  });

  it('fails when production is running something else, and names both', () => {
    const verdict = compareRevision({ expected: A, body: healthy(B) });
    expect(verdict.ok).toBe(false);
    expect(verdict.actual).toBe(B);
    expect(verdict.reason).toContain(A);
    expect(verdict.reason).toContain(B);
  });

  /*
   * The deploy said it worked, the site answers 200, and it is serving the
   * previous build. Nothing else in the release path notices this, which is
   * the entire reason the check exists.
   */
  it('fails even though the site is perfectly healthy', () => {
    expect(compareRevision({ expected: A, body: healthy(B) }).ok).toBe(false);
  });

  it('fails when the deployment was never stamped', () => {
    const verdict = compareRevision({ expected: A, body: healthy('unknown') });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('unknown');
  });

  /*
   * Rolling back far enough reaches code from before releases had identities.
   * That must read as "production cannot tell us", which is a different problem
   * from "production told us the wrong thing" and needs a different sentence.
   */
  it('explains a health response with no revision in it at all', () => {
    const verdict = compareRevision({ expected: A, body: { ok: true, service: 'fantasy-analyst' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.actual).toBeNull();
    expect(verdict.reason).toContain('release.gitSha');
  });

  it('accepts any live revision when none was expected — but still needs one reported', () => {
    expect(compareRevision({ expected: '', body: healthy(B) }).ok).toBe(true);
    expect(compareRevision({ expected: undefined, body: healthy(B) }).ok).toBe(true);
    expect(compareRevision({ expected: '', body: healthy('unknown') }).ok).toBe(false);
  });

  it('ignores case and surrounding space on the expected side too', () => {
    expect(compareRevision({ expected: ` ${A.toUpperCase()} `, body: healthy(A) }).ok).toBe(true);
  });
});

describe('reading /api/health over HTTP', () => {
  it('asks the health route of the given site', async () => {
    const fetchImpl = fakeFetch({ body: healthy(A) });
    const result = await readHealth('https://site.test/', fetchImpl);
    expect(fetchImpl.calls[0]).toBe('https://site.test/api/health');
    expect(result.ok).toBe(true);
  });

  it('fails on a non-200, quoting what came back', async () => {
    const result = await readHealth('https://site.test', fakeFetch({ status: 503, body: 'unavailable' }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  /*
   * The single-page-app fallback answering for `/api/*` is a real production
   * failure this repository has had before; it looks like a healthy 200 with a
   * page in it. JSON that will not parse is a failure, never an empty pass.
   */
  it('fails on a 200 that is not JSON', async () => {
    const result = await readHealth('https://site.test', fakeFetch({ body: '<!doctype html><title>app</title>' }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('did not answer JSON');
  });

  it('fails, rather than throws, when the site cannot be reached', async () => {
    const result = await readHealth('https://site.test', async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOTFOUND');
  });
});

describe('the retry loop', () => {
  it('accepts a revision that arrives a moment late', async () => {
    const fetchImpl = fakeFetch({ body: healthy(B) }, { body: healthy(A) });
    const lines: string[] = [];
    const verdict = await checkRelease({
      url: 'https://site.test',
      expected: A,
      attempts: 3,
      delayMs: 0,
      fetchImpl,
      onLine: (line: string) => lines.push(line),
    });
    expect(verdict.ok).toBe(true);
    expect(lines.some((line) => line.includes('not yet'))).toBe(true);
  });

  it('gives up on a revision that never changes, and reports the last state', async () => {
    const fetchImpl = fakeFetch({ body: healthy(B) });
    const verdict = await checkRelease({
      url: 'https://site.test',
      expected: A,
      attempts: 3,
      delayMs: 0,
      fetchImpl,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.actual).toBe(B);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops as soon as it agrees, rather than using up its attempts', async () => {
    const fetchImpl = fakeFetch({ body: healthy(A) });
    await checkRelease({ url: 'https://site.test', expected: A, attempts: 5, delayMs: 0, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('the command line', () => {
  it('reads a url and an expected revision', () => {
    expect(parseArgs(['https://site.test', A])).toMatchObject({ url: 'https://site.test', expected: A });
  });

  /*
   * `--attempts 6` with no expected revision must not leave `6` sitting where
   * the revision goes: that comparison fails for a reason that has nothing to
   * do with what is deployed, during an incident, which is the worst possible
   * moment to be reading a misleading error.
   */
  it('never mistakes a flag value for the expected revision', () => {
    const parsed = parseArgs(['https://site.test', '--attempts', '6', '--delay', '10']);
    expect(parsed.expected).toBe('');
    expect(parsed.attempts).toBe(6);
    expect(parsed.delaySeconds).toBe(10);
  });

  it('takes flags on either side of the revision', () => {
    expect(parseArgs(['https://site.test', '--attempts', '4', A])).toMatchObject({ expected: A, attempts: 4 });
  });

  it('falls back to one attempt when a flag value is nonsense', () => {
    expect(parseArgs(['https://site.test', '--attempts', 'soon'])).toMatchObject({ attempts: 1 });
  });
});
