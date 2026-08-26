/**
 * Is production running the revision we think it is?
 *
 *   node scripts/check-release-sha.mjs <site url> [expected sha] [--attempts N] [--delay S]
 *
 * The release path's last link. `release.yml` stamps the revision it checked
 * out into the Worker, `/api/health` reports it back, and this compares the two
 * — at the end of a deploy, at the start of a smoke run, and by hand whenever
 * anyone needs to know what is live:
 *
 *   node scripts/check-release-sha.mjs https://fantasy-analyst.juncaj93.workers.dev
 *
 * With no expected revision it prints what production says and succeeds as long
 * as the site answers. With one, a mismatch is a failure that names both sides —
 * because "the deploy said it worked and production is running something else"
 * is exactly the situation nobody notices without being told.
 *
 * Retries, because a Worker that has just been deployed can answer as the
 * previous version for a few seconds. A *persistent* mismatch is the failure;
 * a momentary one is propagation.
 *
 * Dependency-free on purpose: it runs before `npm ci` in the smoke workflow, so
 * a broken release can be diagnosed without a working install.
 */

import { pathToFileURL } from 'node:url';

/** How `/api/health` says it does not know — see `reportedGitSha` in the app. */
export const UNKNOWN = 'unknown';

/**
 * What a health response says the running revision is.
 *
 * Anything that is not a string revision comes back as null rather than as a
 * guess: a health body without the field is a deployment from before releases
 * carried an identity, or one whose stamp did not survive the build, and both
 * of those are "production cannot tell us", not "production said unknown".
 */
export function revisionFromHealth(body) {
  if (!body || typeof body !== 'object') return null;
  const sha = body.release?.gitSha;
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}

/**
 * Does what production reports match what was released?
 *
 * Returns a verdict rather than throwing, so the retry loop can tell "not yet"
 * from "not ever" and the tests can check both without a network.
 */
export function compareRevision({ expected, body }) {
  const actual = revisionFromHealth(body);
  const want = (expected ?? '').trim().toLowerCase();

  if (actual === null) {
    return {
      ok: false,
      actual: null,
      reason:
        'production did not report a revision at all: /api/health has no release.gitSha. ' +
        'Either this deployment predates release identity, or the deploy-time stamp did not reach the Worker.',
    };
  }
  if (actual === UNKNOWN) {
    return {
      ok: false,
      actual,
      reason:
        'production reports its revision as "unknown", which means it was deployed without being stamped — ' +
        'by hand, rather than by the release workflow.',
    };
  }
  if (want === '') return { ok: true, actual, reason: 'no expected revision given' };
  if (actual !== want) {
    return { ok: false, actual, reason: `production is running ${actual}, not ${want}` };
  }
  return { ok: true, actual, reason: 'production is running the released revision' };
}

/** Reads `/api/health`, returning the parsed body or a reason it could not. */
export async function readHealth(baseUrl, fetchImpl = fetch) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, detail: `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await res.text();
  if (res.status !== 200) {
    return { ok: false, detail: `${url} answered HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    // An HTML error page, or the single-page-app fallback answering for /api/*.
    return { ok: false, detail: `${url} did not answer JSON: ${text.slice(0, 200)}` };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole check, with its retries. Returns the last verdict.
 *
 * `onLine` rather than `console.log` inside, so the tests can read what an
 * operator would have seen.
 */
export async function checkRelease({ url, expected, attempts = 1, delayMs = 10_000, fetchImpl = fetch, onLine = () => {} }) {
  let last = { ok: false, actual: null, reason: 'no attempt was made' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const health = await readHealth(url, fetchImpl);
    last = health.ok
      ? compareRevision({ expected, body: health.body })
      : { ok: false, actual: null, reason: health.detail };
    if (last.ok) {
      onLine(`production reports ${last.actual}`);
      return last;
    }
    if (attempt < attempts) {
      onLine(`  not yet (attempt ${attempt}/${attempts}): ${last.reason}`);
      await sleep(delayMs);
    }
  }
  return last;
}

/**
 * `<url> [expected] [--attempts N] [--delay S]`, in one pass.
 *
 * A flag's value is consumed with the flag rather than filtered out
 * afterwards: `--attempts 6` with no expected revision must not leave `6`
 * sitting where the revision goes, which is how a check ends up comparing
 * production against the number six and failing for the wrong reason.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = { attempts: 1, delaySeconds: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--attempts' || arg === '--delay') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (arg === '--attempts') flags.attempts = value;
      else flags.delaySeconds = value;
      continue;
    }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return { url: positional[0] ?? '', expected: positional[1] ?? '', ...flags };
}

/* ------------------------------------------------------------------ the CLI */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url, expected: want, attempts, delaySeconds } = parseArgs(process.argv.slice(2));

  if (!url) {
    console.error('usage: node scripts/check-release-sha.mjs <site url> [expected sha] [--attempts N] [--delay S]');
    process.exit(2);
  }

  console.log(`Release check: ${url}`);
  if (want) console.log(`expected revision: ${want}`);

  const verdict = await checkRelease({
    url,
    expected: want,
    attempts,
    delayMs: delaySeconds * 1000,
    onLine: (line) => console.log(line),
  });

  if (verdict.ok) {
    console.log(`ok — ${verdict.reason}`);
    process.exit(0);
  }

  console.log(`expected: ${want || '(none given)'}`);
  console.log(`actual:   ${verdict.actual ?? '(none reported)'}`);
  console.error(`::error::Production revision check failed — ${verdict.reason}`);
  process.exit(1);
}
