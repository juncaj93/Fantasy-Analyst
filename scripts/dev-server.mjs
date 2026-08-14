/**
 * Local dev + e2e server.
 *
 * Serves the same `createApp()` API the worker uses, backed by node:sqlite
 * instead of D1, plus the built SPA from dist/web. Wrangler/workerd is not
 * required to run or test the app locally.
 *
 * Usage:
 *   npm run build:server && node scripts/dev-server.mjs [--port 8787] [--seed]
 *
 * Env:
 *   FA_DISABLE_AUTH=1   skip the passphrase gate (e2e only)
 *   FA_SEED=1           load demo fixtures into a fresh database
 *   FA_DB=path.sqlite   persist to disk instead of memory
 *   NEWSLETTER_ADDRESS  dedicated inbound address shown in Settings
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(argValue('--port', process.env.PORT ?? 8787));
const dbPath = argValue('--db', process.env.FA_DB ?? ':memory:');
const seed = args.includes('--seed') || process.env.FA_SEED === '1';
const disableAuth = process.env.FA_DISABLE_AUTH === '1';

const bundlePath = join(root, 'dist/server/bundle.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing dist/server/bundle.mjs — run: npm run build:server');
  process.exit(1);
}

const { NodeSqliteDatabase, createApp, SleeperClient, MockVegasProvider, seedDemoData, MOCK_GAMES } =
  await import(bundlePath);

const db = new NodeSqliteDatabase(dbPath);
// Apply every migration in order, exactly like `wrangler d1 migrations apply`.
for (const file of (await readdir(join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(join(root, 'migrations', file), 'utf8'));
}

if (seed) {
  const summary = await seedDemoData(db);
  console.log(`[dev] seeded ${JSON.stringify(summary)}`);
}

const app = createApp();
const env = {
  db,
  sleeper: new SleeperClient(),
  vegas: new MockVegasProvider(MOCK_GAMES),
  inboundAddress: process.env.NEWSLETTER_ADDRESS ?? null,
  APP_PASSPHRASE: process.env.APP_PASSPHRASE ?? 'devpass',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'dev-session-secret-not-for-production',
  disableAuth,
  // Plain-HTTP local server: the Secure attribute would make the cookie
  // unusable. Never set in the deployed worker.
  insecureCookies: process.env.FA_INSECURE_COOKIES === '1',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  // iOS will parse a manifest served as text/plain, but a wrong type here
  // would hide a wrong type in production, and the e2e suite checks it.
  '.webmanifest': 'application/manifest+json',
};

const distDir = join(root, 'dist/web');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = [];
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) for (const item of v) headers.push([k, item]);
        else headers.push([k, v]);
      }
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const response = await app(request, env);
      const outHeaders = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(response.status, outHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    // Static SPA with history fallback.
    let filePath = join(distDir, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (url.pathname === '/' || !existsSync(filePath)) filePath = join(distDir, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('build the SPA first: npm run build');
      return;
    }
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(port, () => {
  console.log(`[dev] fantasy-analyst on http://127.0.0.1:${port} (auth ${disableAuth ? 'disabled' : 'enabled'})`);
});
