/**
 * Draw every season screen from a production snapshot, locally, at phone widths.
 *
 *   npm run build
 *   node scripts/replay-screens.mjs snapshot.json out-dir [360,390]
 *
 * `snapshot.json` is the decoded blob `probe-screens-snapshot.mjs` prints: a map
 * of request path to `{ status, body }`. The built SPA in `dist/web` is served
 * from a throwaway local server, every `/api/` request is answered from the
 * snapshot through a Playwright route (exact path first, then the same path
 * with any query, then a 404), and each tab is opened and screenshotted whole.
 *
 * Nothing reaches production: the browser never leaves 127.0.0.1, and a request
 * the snapshot does not hold is refused, not forwarded.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from '@playwright/test';

const [snapshotPath, outDir = 'replay-out', widthsArg = '360,390'] = process.argv.slice(2);
if (!snapshotPath) {
  console.error('usage: node scripts/replay-screens.mjs snapshot.json out-dir [widths]');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const widths = widthsArg.split(',').map(Number);
const root = join(process.cwd(), 'dist/web');
if (!existsSync(join(root, 'index.html'))) {
  console.error('dist/web is missing: run npm run build first');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  let file = join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || url.pathname === '/') file = join(root, 'index.html');
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const byPath = new Map();
for (const [key, value] of Object.entries(snapshot)) {
  const pathname = key.split('?')[0];
  if (!byPath.has(pathname)) byPath.set(pathname, value);
}
const missed = new Set();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tabs = ['team', 'matchup', 'waivers', 'trades', 'players', 'setup'];
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname + url.search;
    const hit = snapshot[key] ?? byPath.get(url.pathname);
    if (route.request().method() !== 'GET' || !hit) {
      missed.add(`${route.request().method()} ${key}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not in snapshot' }) });
    }
    return route.fulfill({ status: hit.status, contentType: 'application/json', body: hit.body });
  });
  await page.goto(base);
  await page.waitForTimeout(1500);
  for (const tab of tabs) {
    const button = page.getByTestId(`tab-${tab}`);
    if ((await button.count()) === 0) {
      console.log(`${width}: no ${tab} tab`);
      continue;
    }
    await button.click();
    await page.waitForTimeout(1500);
    const file = join(outDir, `${tab}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${width}: ${file}`);
  }
  await context.close();
}
await browser.close();
server.close();
if (missed.size > 0) console.log(`not in the snapshot (answered 404):\n  ${[...missed].join('\n  ')}`);
