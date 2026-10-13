/**
 * Which D1 statements each screen's requests issue, on this checkout.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round2-statements.ts <out.json>
 *
 * Runs the real app over the seeded demo league (in memory, no network) and
 * records every statement per screen: Team (roster, lineup, waivers), Matchup,
 * and Compare (a comparison, plus the picker's lists where this checkout has
 * them). The probe joins these with production's rows-read-per-call for the
 * same statements, which gives each screen's cost per load before and after.
 * Each screen gets a fresh database so one screen's caches cannot hide
 * another's reads.
 */

import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { seedDemoData } from '../src/devserver/seed.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { Database, PreparedStatement } from '../src/server/db.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: startsit-round2-statements.ts <out.json>');
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

function watch(db: Database, log: string[]): Database {
  const wrap = (s: PreparedStatement, sql: string): PreparedStatement => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v), sql),
    first: (c?: string) => (log.push(sql), c === undefined ? s.first() : s.first(c)),
    all: () => (log.push(sql), s.all()),
    run: () => (log.push(sql), s.run()),
  }) as PreparedStatement;
  return { prepare: (sql) => wrap(db.prepare(sql), sql), batch: (l) => db.batch(l), exec: (q) => db.exec(q) };
}

const SCREENS: { screen: string; requests: { method: 'GET' | 'POST'; path: string; body?: unknown }[] }[] = [
  { screen: 'Team', requests: [{ method: 'GET', path: '/api/leagues/demo-league/roster' }, { method: 'GET', path: '/api/leagues/demo-league/lineup' }, { method: 'GET', path: '/api/leagues/demo-league/waivers' }] },
  { screen: 'Matchup', requests: [{ method: 'GET', path: '/api/leagues/demo-league/matchup' }] },
  { screen: 'Compare (one comparison)', requests: [{ method: 'POST', path: '/api/startsit/compare', body: 'PAIR' }] },
  { screen: 'Compare picker: My roster', requests: [{ method: 'GET', path: '/api/leagues/demo-league/compare-pool?tab=mine' }] },
  { screen: 'Compare picker: Waivers', requests: [{ method: 'GET', path: '/api/leagues/demo-league/compare-pool?tab=waivers' }] },
  { screen: 'Compare picker (before): player search', requests: [{ method: 'GET', path: '/api/players?q=&leagueId=demo-league&limit=100' }] },
];

const result: Record<string, { status: number[]; sql: string[] }> = {};
for (const { screen, requests } of SCREENS) {
  const raw = new NodeSqliteDatabase(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  await seedDemoData(raw);
  const log: string[] = [];
  const env: AppEnv = {
    db: watch(raw, log),
    sleeper: new SleeperClient({ fetch: (async () => new Response('null', { status: 200 })) as typeof fetch }),
    vegas: new MockVegasProvider([]),
    disableAuth: true,
    waitUntil: () => {},
  };
  const app = createApp();
  const status: number[] = [];
  for (const r of requests) {
    let body = r.body;
    if (body === 'PAIR') {
      const lineup = (await (await app(new Request('https://app.test/api/leagues/demo-league/lineup'), env)).json()) as { starters?: { playerId: string }[] };
      log.length = 0;
      body = { leagueId: 'demo-league', playerIds: (lineup.starters ?? []).slice(0, 2).map((s) => s.playerId) };
    }
    const res = await app(
      new Request(`https://app.test${r.path}`, {
        method: r.method,
        ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      }),
      env,
    );
    status.push(res.status);
  }
  result[screen] = { status, sql: log.map((s) => s.replace(/\s+/g, ' ').trim()) };
}
writeFileSync(out, JSON.stringify(result));
console.log(Object.entries(result).map(([k, v]) => `${k}: ${v.sql.length} statements (HTTP ${v.status.join(',')})`).join('\n'));
