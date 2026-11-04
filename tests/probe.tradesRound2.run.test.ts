/**
 * The round 2 trade probe, run for real against a real server, so the one
 * production run cannot be spent on a bug in the script. The league is the
 * trade test league with its one fair deal, plus this season's points and
 * Sleeper's next weeks stored, so the season rates have both halves.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { forgetPlayerReads } from '../src/server/repos/players.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { aheadPointsKey, seasonPointsKey } from '../src/core/sleeper/weekPoints.ts';
import { MINE, THEIRS, envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { createTestDb } from './helpers/db.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/probe-trades-round2.mjs', import.meta.url));

let server: Server;
let base = '';

beforeAll(async () => {
  const db = await createTestDb();
  forgetPlayerReads(db);
  await seed(db, { fairDeal: true });
  const settings = new SettingsRepo(db);
  const points: Record<string, number[]> = {};
  for (const [id, , ppg] of [...MINE, ...THEIRS]) points[id] = [ppg, ppg, ppg, ppg];
  await settings.set(seasonPointsKey('2026'), { season: '2026', through: 4, fetchedAt: new Date().toISOString(), points });
  for (const week of [6, 7, 8]) {
    const row: Record<string, number> = {};
    for (const [id, , ppg] of [...MINE, ...THEIRS]) row[id] = ppg;
    await settings.set(aheadPointsKey('2026', week), { season: '2026', week, fetchedAt: new Date().toISOString(), points: row });
  }
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

describe('scripts/probe-trades-round2.mjs', () => {
  it('reads the season data, the board, the closest ideas and Build a trade, and reports the rows', async () => {
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, APP_URL: base, LEAGUE_ID: 'tony' };
      delete env['CLOUDFLARE_API_TOKEN'];
      execFile('node', [SCRIPT], { env, timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0, text: `${stdout}${stderr}` });
      });
    });
    if (process.env.PROBE_DEBUG) console.log(out.text);
    expect(out.code, out.text).toBe(0);
    expect(out.text).toMatch(/season points through week 4; Sleeper's later weeks stored: 6, 7, 8/);
    expect(out.text).toMatch(/rows returned \d+ in \d+ statements/);
    expect(out.text).toMatch(/closest ideas/);
    expect(out.text).toMatch(/Trade ideas, as the phone sees them/);
    expect(out.text).toMatch(/Build a trade: all teams/);
    expect(out.text).not.toMatch(/HTTP (4|5)\d\d/);
  }, 90_000);
});
