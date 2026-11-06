/**
 * Does the deployment actually work? The release's post-deploy check.
 *
 *   node scripts/check-deployed-site.mjs <site url>
 *
 * Four questions, each one a single small request:
 *
 *   1. `/api/health` answers 200 (waiting for a fresh deployment to come up);
 *   2. the home page is the app: a 200 with a page that loads a script;
 *   3. the lineup route is registered: an unknown league is refused by the
 *      handler ("league not found", which needs a working database read of
 *      one row), not by the router;
 *   4. a write with no session is refused with 401 (waiting while the
 *      passphrase secret propagates; a 503 then is still closed).
 *
 * It replaced a row of `curl` calls. Two differences, both deliberate:
 *
 *   - a dropped connection is retried (see `lib/retryFetch.mjs`) instead of
 *     failing the deploy, which is what happened on 5 November 2026;
 *   - `/api/overview` is no longer read here. It walked several tables on a
 *     cold Worker to say "the database answers", which the lineup route says
 *     for one row. The iPhone smoke that follows loads the real app anyway.
 *
 * Any real answer that is wrong still fails: a 500, an error page, an empty
 * page, a missing route, or a write that is not refused.
 */

import { pathToFileURL } from 'node:url';
import { fetchWithRetry } from './lib/retryFetch.mjs';

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for a fresh deployment, and for the passphrase to take effect. */
export const COME_UP_ATTEMPTS = 6;
export const COME_UP_DELAY_MS = 10_000;

export async function checkDeployedSite({
  url,
  fetchImpl = fetch,
  sleep = sleepFor,
  onLine = () => {},
  networkDelayMs,
  comeUpDelayMs = COME_UP_DELAY_MS,
}) {
  const base = url.replace(/\/$/, '');
  const failures = [];
  const get = (path, init) =>
    fetchWithRetry(`${base}${path}`, init, {
      fetchImpl,
      sleep,
      onRetry: onLine,
      ...(networkDelayMs != null ? { delayMs: networkDelayMs } : {}),
    });
  const said = (r) => (r.ok ? `HTTP ${r.status}` : `no answer (${r.error})`);

  // 1. Up, as this deployment.
  let health;
  for (let attempt = 1; attempt <= COME_UP_ATTEMPTS; attempt++) {
    health = await get('/api/health');
    if (health.ok && health.status === 200) break;
    if (attempt < COME_UP_ATTEMPTS) {
      onLine(`  waiting for the site to come up (attempt ${attempt}, got ${said(health)})`);
      await sleep(comeUpDelayMs);
    }
  }
  onLine(`health: ${said(health)} ${health.ok ? health.text.slice(0, 200) : ''}`.trim());
  if (!(health.ok && health.status === 200)) failures.push(`/api/health: ${said(health)}`);

  // 2. The app's own page, not an error page and not an empty one.
  const home = await get('/');
  const isApp = home.ok && home.status === 200 && /<script[\s>]/i.test(home.text);
  onLine(`home page: ${said(home)}${home.ok ? `, ${home.text.length} bytes` : ''}`);
  if (!isApp) failures.push(`home page: ${home.ok && home.status === 200 ? 'empty or not the app' : said(home)}`);

  // 3. The lineup route exists, and its handler reached the database.
  const lineup = await get('/api/leagues/does-not-exist/lineup');
  onLine(`lineup route: ${said(lineup)} ${lineup.ok ? lineup.text.slice(0, 120) : ''}`.trim());
  if (!(lineup.ok && lineup.text.includes('league not found'))) failures.push(`lineup route: ${said(lineup)}, not "league not found"`);

  // 4. A stranger cannot write.
  let write;
  for (let attempt = 1; attempt <= COME_UP_ATTEMPTS; attempt++) {
    write = await get('/api/sleeper/sync-players', { method: 'POST' });
    if (write.ok && write.status === 401) break;
    // A 5xx is "not ready yet" (503 while the passphrase propagates) and waits.
    // Anything else, a 200 above all (a write that went through), fails now.
    if (write.ok && write.status < 500) break;
    if (attempt < COME_UP_ATTEMPTS) {
      onLine(`  waiting for the passphrase to take effect (attempt ${attempt}, got ${said(write)})`);
      await sleep(comeUpDelayMs);
    }
  }
  onLine(`unauthenticated write: ${said(write)} (expected 401 = refused)`);
  if (!(write.ok && write.status === 401)) failures.push(`unauthenticated write: ${said(write)}, expected 401`);

  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? '';
  if (!url) {
    console.error('usage: node scripts/check-deployed-site.mjs <site url>');
    process.exit(2);
  }
  console.log(`Checking ${url}`);
  const verdict = await checkDeployedSite({ url, onLine: (line) => console.log(line) });
  if (verdict.ok) {
    console.log('ok: the deployment answers, serves the app, has its lineup route and refuses a stranger');
    process.exit(0);
  }
  for (const failure of verdict.failures) console.error(`::error::${failure}`);
  process.exit(1);
}
