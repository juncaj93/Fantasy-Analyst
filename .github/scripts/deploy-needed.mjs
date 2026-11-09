/**
 * Does this revision change anything the live site runs?
 *
 *   node .github/scripts/deploy-needed.mjs <candidate sha> [site url]
 *
 * Prints one word on stdout, `yes` or `no`, and its reasons on stderr.
 *
 * Why this exists (Round 14, the D1 budget). Every green CI run on main used to
 * become a deploy, and every deploy ends in a live check against production that
 * reads 133k to 190k database rows. A commit that only touched docs, tests or a
 * workflow file paid that in full to re-publish exactly the Worker that was
 * already live. On 22 October that happened seventeen times.
 *
 * So Deploy now asks first. It compares the candidate with the revision
 * production itself reports at `/api/health` (which reads no database rows),
 * and if every file that differs is one the Worker never ships, there is nothing
 * to deploy and nothing new to check. Production keeps running the revision it
 * has, which has the same app code.
 *
 * Fails open, toward deploying. Anything this cannot answer for certain (the
 * site does not say what it runs, the live revision is not in the history, git
 * cannot diff, the list is empty for a reason it cannot see) prints `yes`, and
 * the normal release and its live checks run exactly as before. Skipping is only
 * ever the result of a positive answer.
 *
 * Lives under `.github/` on purpose: a change to this file is itself a change
 * the Worker never ships, so it can never be the reason a deploy happens.
 *
 * Dependency-free: it runs in Deploy's first job, before `npm ci`.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SITE = 'https://fantasy-analyst.juncaj93.workers.dev';

/**
 * Files the Worker and the site never ship. Deny by default: anything not
 * matched here (src/, migrations/, wrangler.toml, package files, build config,
 * data/, scripts/ the build uses, public assets) counts as app code.
 */
const NOT_SHIPPED = [
  /^docs\//,
  /^tests\//,
  /^e2e\//,
  /^e2e-production\//,
  /^\.github\//,
  // Markdown at the repository root (README and friends), never anything under src/.
  /^[^/]+\.md$/,
  // One-off investigation scripts. The build never imports them.
  /^scripts\/probe-[^/]+\.m?[jt]s$/,
  // Test runner configuration.
  /^playwright(\.production)?\.config\.ts$/,
  /^vitest\.config\.ts$/,
];

export function isShipped(file) {
  return !NOT_SHIPPED.some((pattern) => pattern.test(file));
}

/**
 * The verdict for a list of changed paths, as `git diff --name-only` prints them.
 *
 * An empty list is "nothing changed", which needs no deploy. A list with any
 * shipped file needs one.
 */
export function deployNeeded(files) {
  const cleaned = files.map((f) => f.trim()).filter((f) => f !== '');
  const shipped = cleaned.filter(isShipped);
  return { needed: shipped.length > 0, shipped, total: cleaned.length };
}

/** The revision `/api/health` reports, or null when it does not say. */
export function liveRevision(body) {
  const sha = body?.release?.gitSha;
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'unknown') return null;
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : null;
}

/**
 * The whole decision, with the network and git passed in so the tests can run
 * it without either. Every path that cannot answer for certain returns `yes`.
 */
export async function decide({ candidate, fetchHealth, changedFiles }) {
  let body;
  try {
    body = await fetchHealth();
  } catch (error) {
    return { needed: true, reason: `could not read /api/health (${error?.message ?? error}); deploying as normal` };
  }
  const live = liveRevision(body);
  if (live === null) {
    return { needed: true, reason: 'production does not report a usable revision; deploying as normal' };
  }
  let files;
  try {
    files = changedFiles(live, candidate);
  } catch (error) {
    return { needed: true, live, reason: `could not compare ${live} with ${candidate} (${error?.message ?? error}); deploying as normal` };
  }
  const verdict = deployNeeded(files);
  if (verdict.needed) {
    return {
      needed: true,
      live,
      reason: `${verdict.shipped.length} of ${verdict.total} changed files are app code (first: ${verdict.shipped[0]})`,
    };
  }
  return {
    needed: false,
    live,
    reason: `production runs ${live}; all ${verdict.total} files changed since then are docs, tests or workflows`,
  };
}

async function main() {
  const [candidate, site = DEFAULT_SITE] = process.argv.slice(2);
  if (!candidate) {
    console.error('usage: deploy-needed.mjs <candidate sha> [site url]');
    process.stdout.write('yes\n');
    return;
  }
  const result = await decide({
    candidate,
    fetchHealth: async () => {
      const response = await fetch(`${site.replace(/\/$/, '')}/api/health`, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    changedFiles: (from, to) =>
      execFileSync('git', ['diff', '--name-only', `${from}`, `${to}`], { encoding: 'utf8' }).split('\n'),
  });
  console.error(`deploy needed: ${result.needed ? 'yes' : 'no'} (${result.reason})`);
  if (result.live) console.error(`live revision: ${result.live}`);
  process.stdout.write(result.needed ? 'yes\n' : 'no\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`deploy-needed failed (${error?.message ?? error}); deploying as normal`);
    process.stdout.write('yes\n');
  });
}
