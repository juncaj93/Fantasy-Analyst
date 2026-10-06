/**
 * The trade-value probe, run for real against a real server.
 *
 * The probe is how the live check is made through GitHub Actions, and a probe
 * whose example-building has a bug is found out one deploy late. So the script
 * itself is run here, as a child process, against the real router over HTTP on a
 * league with two genuine rosters, and its exit code and output are asserted.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { forgetPlayerReads } from '../src/server/repos/players.ts';
import { TransactionRepo } from '../src/server/repos/transactions.ts';
import { LEAGUE, envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { createTestDb } from './helpers/db.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/probe-trade-values.mjs', import.meta.url));

let server: Server;
let base = '';

beforeAll(async () => {
  const db = await createTestDb();
  forgetPlayerReads(db);
  await seed(db);
  // The deal below has already been made: Alex holds t_wr1 and Dermot holds m_wr5.
  const leagues = new LeagueRepo(db);
  const rosters = await leagues.listRosters(LEAGUE);
  const mine = rosters.find((r) => r.rosterId === 1)!;
  const theirs = rosters.find((r) => r.rosterId === 2)!;
  await leagues.replaceRosters(LEAGUE, [
    { ...mine, playerIds: [...mine.playerIds.filter((id) => id !== 'm_wr5'), 't_wr1'] },
    { ...theirs, playerIds: [...theirs.playerIds.filter((id) => id !== 't_wr1'), 'm_wr5'] },
    ...rosters.filter((r) => r.rosterId > 2),
  ]);
  await new TransactionRepo(db).saveWeek({
    leagueId: LEAGUE,
    season: '2026',
    week: 4,
    settled: true,
    transactions: [
      {
        transaction_id: 'trade-1',
        type: 'trade',
        status: 'complete',
        created: Date.now() - 86_400_000,
        leg: 4,
        roster_ids: [1, 2],
        adds: { t_wr1: 1, m_wr5: 2 },
        drops: { t_wr1: 2, m_wr5: 1 },
        draft_picks: [],
        waiver_budget: [],
      },
    ],
  });
  const { client } = forbiddenSleeper();
  const app = createApp();
  const env = envFor(db, client);
  server = createServer(async (req, res) => {
    const response = await app(new Request(`http://localhost${req.url}`), env);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

describe('scripts/probe-trade-values.mjs', () => {
  it('replays, checks each example from both chairs, reports the cost, and finds nothing absurd', async () => {
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile('node', [SCRIPT], { env: { ...process.env, URL: base }, timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 0, text: `${stdout}${stderr}` });
      });
    });
    if (process.env.PROBE_DEBUG) console.log(out.text);
    expect(out.text).toMatch(/Past league trades, replayed today/);
    expect(out.text).toMatch(/2026 week 4, roster_aware/);
    expect(out.text).toMatch(/a like-for-like swap: my first starting WR/);
    expect(out.text).toMatch(/a two-for-one/);
    expect(out.text).toMatch(/rows,\s+\d+ statements/);
    expect(out.text, out.text).toMatch(/All checks passed/);
    expect(out.code).toBe(0);
  }, 90_000);
});
