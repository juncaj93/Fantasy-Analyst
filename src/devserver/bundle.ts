/**
 * Entry point for the local dev/e2e server bundle.
 *
 * Re-exports everything `scripts/dev-server.mjs` needs, plus deterministic demo
 * fixtures used by e2e runs. This module is never deployed — the worker bundle
 * has its own entry (src/worker/index.ts).
 */

export { NodeSqliteDatabase } from '../server/adapters/nodeSqlite.ts';
export { createApp } from '../server/app.ts';
export { SleeperClient } from '../core/sleeper/client.ts';
export { MockVegasProvider } from '../core/vegas/mockProvider.ts';
export { seedDemoData, MOCK_GAMES, DEMO_NEWSLETTER } from './seed.ts';
