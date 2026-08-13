/**
 * Bundle the local dev/e2e server with esbuild.
 *
 * Node cannot execute our TypeScript directly (it uses parameter properties,
 * which type-stripping does not support), so the dev server consumes a bundle.
 * The deployed worker is bundled separately by Wrangler from src/worker/index.ts.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/devserver/bundle.ts`],
  outfile: `${root}dist/server/bundle.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['node:*'],
});
