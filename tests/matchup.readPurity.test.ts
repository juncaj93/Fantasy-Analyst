/**
 * `GET /api/leagues/:id/matchup` is a read, and this is the proof.
 *
 * The final comprehensive audit's F-01, pinned. The route used to build the
 * forecast and then write both sides of it to the calibration ledger on the way
 * out — an insert and an update per roster, plus two settlement updates once the
 * games were over. Six write statements behind a `GET`.
 *
 * The defect was never the ledger, which this app genuinely needs: a win
 * probability nobody wrote down at the time cannot be graded afterwards,
 * because the Sunday that produced it is gone. The defect was *where* the write
 * lived. Both guards in `server/app.ts` classify a request by its method —
 * `isWrite()` is `method !== 'GET' && method !== 'HEAD'` — so a hidden write on
 * a GET is invisible to the passphrase guard **and** to the Demo Mode guard.
 * The second one is the sharp end: Demo Mode's entire promise is that nothing
 * in a demo can change live data, and a demo browser opening the Matchup screen
 * was writing rows to the live calibration table.
 *
 * ## What is asserted, and why in two ways
 *
 * Every case here proves purity twice over:
 *
 *   1. **The whole database is unchanged.** Every row of every table is
 *      snapshotted before and after and compared. That is the §2 invariant
 *      stated directly — no calibration row, no forecast history, and no other
 *      persistent state mutated as an incidental side effect — rather than a
 *      count of one table that a write to a second table would sail past.
 *   2. **No mutating statement was even attempted.** The database is wrapped in
 *      a recorder that watches every `prepare()`. A snapshot alone cannot see
 *      an `INSERT … ON CONFLICT DO NOTHING` against a row that already exists,
 *      or an `UPDATE` whose `WHERE` matched nothing — both of which are writes
 *      that happened to be no-ops on that fixture, and both of which are
 *      exactly how this defect would come back.
 *
 * The second check is what makes the mutation test at the bottom meaningful.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import { MatchupService } from '../src/server/services/matchupService.ts';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import type { Database, DbResult, PreparedStatement } from '../src/server/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

/** The demo league starts QB, RB, RB, WR, WR, TE, FLEX. */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '0', '1007', '1011', '1017', '1019'];

interface MatchupRow {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: string[];
  players: string[];
  players_points: Record<string, number>;
}

function rows(over: Partial<{ mine: Partial<MatchupRow>; theirs: Partial<MatchupRow> }> = {}): MatchupRow[] {
  return [
    {
      roster_id: 1,
      matchup_id: 1,
      points: 0,
      starters: MINE,
      players: [...MINE, '1009', '1014'],
      players_points: {},
      ...over.mine,
    },
    {
      roster_id: 2,
      matchup_id: 1,
      points: 0,
      starters: THEIRS,
      players: ['1010', '1006', '1007', '1011', '1017', '1019', '1013', '1018'],
      players_points: {},
      ...over.theirs,
    },
  ];
}

function sleeperServing(matchups: unknown): SleeperClient {
  return new SleeperClient({
    fetch: async (url) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname)
        ? new Response(JSON.stringify(matchups), { status: 200 })
        : new Response('null', { status: 200 }),
  });
}

function env(db: Database, matchups: unknown): AppEnv {
  return {
    db,
    sleeper: sleeperServing(matchups),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

function get(path: string, cookies: string[] = []): Request {
  const headers: Record<string, string> = {};
  if (cookies.length) headers['cookie'] = cookies.join('; ');
  return new Request(`https://app.test${path}`, { headers });
}

// --------------------------------------------------------------- the instruments

/** Everything in every table, as a comparable value. */
async function snapshot(db: Database): Promise<Record<string, unknown[]>> {
  const tables = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables.results) {
    const contents = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    // Ordered by their own serialisation, so a differently-ordered scan of the
    // same unchanged rows is not reported as a change.
    out[name] = contents.results.map((row) => JSON.stringify(row)).sort();
  }
  return out;
}

const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i;

/**
 * The database, plus a note of every statement anybody prepared against it.
 *
 * A pass-through in every respect — the underlying database does the work, so
 * every read the request makes behaves exactly as it would in production.
 */
function watched(db: Database): { db: Database; statements: string[]; mutations: () => string[] } {
  const statements: string[] = [];
  const wrapper: Database = {
    prepare(query: string): PreparedStatement {
      statements.push(query);
      return db.prepare(query);
    },
    batch<T = unknown>(list: PreparedStatement[]): Promise<DbResult<T>[]> {
      return db.batch<T>(list);
    },
    exec(query: string) {
      statements.push(query);
      return db.exec(query);
    },
  };
  return { db: wrapper, statements, mutations: () => statements.filter((q) => MUTATING.test(q)) };
}

describe('the Matchup read writes nothing', () => {
  let real: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    real = await createTestDb();
    await seedDemoData(real);
  });

  /**
   * The base case, and the one the audit found.
   *
   * The response is unchanged, the calibration table is empty, no row anywhere
   * moved, and no mutating statement was prepared.
   */
  it('serves the forecast and leaves the database exactly as it found it', async () => {
    const before = await snapshot(real);
    const { db, mutations } = watched(real);

    const res = await app(get('/api/leagues/demo-league/matchup'), env(db, rows()));
    const body = (await res.json()) as { found: boolean; forecast: { teams: { mine: { winProbability: number } } } };

    expect(res.status).toBe(200);
    expect(body.found, 'the read has to actually produce a forecast, or it proves nothing').toBe(true);
    expect(body.forecast.teams.mine.winProbability).toBeGreaterThan(0);

    expect(await calibrationRows(real)).toBe(0);
    expect(mutations(), 'the Matchup GET prepared a mutating statement').toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /**
   * Polling, which is the load this endpoint actually sees.
   *
   * The Matchup screen refreshes while a game is live, so the interesting case
   * is not one read but forty — and not forty identical ones either, because the
   * fingerprint cache short-circuits those before the old recorder was reached.
   * Every read here moves the score, so every read recomputes, which is exactly
   * the path that used to write.
   */
  it('accumulates nothing over a Sunday afternoon of polling', async () => {
    const before = await snapshot(real);
    const { db, mutations } = watched(real);

    for (let i = 0; i < 12; i++) {
      const res = await app(
        get('/api/leagues/demo-league/matchup'),
        env(db, rows({ mine: { points: 10 + i, players_points: { '1003': 10 + i } } })),
      );
      expect(res.status).toBe(200);
    }

    expect(await calibrationRows(real)).toBe(0);
    expect(mutations(), 'polling amplified into writes').toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /** The same holds for an explicitly named week, which takes a different branch. */
  it('writes nothing for a named week either', async () => {
    const before = await snapshot(real);
    const { db, mutations } = watched(real);
    await app(get('/api/leagues/demo-league/matchup?week=1'), env(db, rows()));
    await app(get('/api/leagues/demo-league/matchup?week=7'), env(db, []));
    expect(mutations()).toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /**
   * A finished week, which is where the second write lived.
   *
   * The old recorder settled the ledger whenever the forecast read `final`, so
   * a read of a week that was over wrote four statements and then two more.
   * Sleeper reporting a later current week is what makes this week final.
   */
  it('writes nothing when the week it is asked about is already over', async () => {
    const settledSleeper = new SleeperClient({
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (/\/matchups\/\d+$/.test(path)) {
          return new Response(
            JSON.stringify(
              rows({
                mine: { points: 118.4, players_points: Object.fromEntries(MINE.map((id) => [id, 16.9])) },
                theirs: { points: 96.2, players_points: Object.fromEntries(THEIRS.map((id) => [id, 16.0])) },
              }),
            ),
            { status: 200 },
          );
        }
        return new Response('null', { status: 200 });
      },
    });

    const before = await snapshot(real);
    const { db, mutations } = watched(real);
    const res = await app(get('/api/leagues/demo-league/matchup?week=1'), {
      ...env(db, []),
      sleeper: settledSleeper,
    });
    expect(res.status).toBe(200);

    expect(await calibrationRows(real)).toBe(0);
    expect(mutations(), 'a settled week still settled the ledger from a GET').toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /**
   * **Demo Mode, which is the reason this defect mattered rather than merely
   * being untidy.**
   *
   * §2 says a demo cannot change live data, and the server enforces it a second
   * time below the UI — but only for requests it can see as writes, and the
   * guard reads the method. So a browser carrying `fa_demo=1` was writing rows
   * to the *live* calibration table by opening a screen, and every guard in the
   * app was satisfied.
   */
  it('writes zero live rows for a browser in Demo Mode', async () => {
    const enter = await app(new Request('https://app.test/api/demo/enter', { method: 'POST' }), env(real, rows()));
    const demoCookie = enter.headers.get('set-cookie')!.split(';')[0]!;
    expect(demoCookie).toBe('fa_demo=1');

    const before = await snapshot(real);
    const { db, mutations } = watched(real);
    const res = await app(get('/api/leagues/demo-league/matchup', [demoCookie]), env(db, rows()));

    expect(res.status, 'the demo browser still gets its read').toBe(200);
    expect(await calibrationRows(real)).toBe(0);
    expect(mutations(), 'a Demo Mode GET reached the live database').toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /**
   * And with a valid session, which is the case that most looks like permission.
   *
   * An unlocked session is permission to make a write when you make one. It is
   * not permission for a read to become one.
   */
  it('writes nothing even for an unlocked session', async () => {
    const login = await app(
      new Request('https://app.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
      }),
      env(real, rows()),
    );
    const session = login.headers.get('set-cookie')!.split(';')[0]!;

    const before = await snapshot(real);
    const { db, mutations } = watched(real);
    await app(get('/api/leagues/demo-league/matchup', [session]), env(db, rows()));
    expect(mutations()).toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });

  /** The diagnostics route reads the ledger; it must not write to it either. */
  it('reports calibration without touching the ledger', async () => {
    const before = await snapshot(real);
    const { db, mutations } = watched(real);
    const res = await app(get('/api/diagnostics/matchup-calibration'), env(db, rows()));
    expect(res.status).toBe(200);
    expect(mutations()).toEqual([]);
    expect(await snapshot(real)).toEqual(before);
  });
});

/**
 * The purity is a property of the type, not of a habit.
 *
 * `MatchupSources` — the bag the endpoint hands the assembly — carries no way
 * to write, so no wiring mistake below the route can reintroduce one. The
 * ledger is a *fourth argument* to `buildMatchupResponse`, and the endpoint
 * passes three. That is the whole structural claim, and these read it off the
 * source rather than trusting the docblock.
 */
describe('the read path has nothing to write with', () => {
  it('the endpoint asks for a matchup with no ledger', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const service = readFileSync(
      join(import.meta.dirname, '..', 'src', 'server', 'services', 'matchupService.ts'),
      'utf8',
    );
    const forLeague = service.slice(service.indexOf('async forLeague('), service.indexOf('private sources()'));
    expect(forLeague).toContain('buildMatchupResponse(this.sources(), leagueId, opts)');
    expect(forLeague, 'forLeague must not hand the assembly a ledger').not.toMatch(/ledger/i);
  });

  /**
   * A sources bag has no `record`, so an accidental write is a type error.
   *
   * Asserted at runtime as well as in the compiler, because a compiler
   * assertion is only as good as the next `as never` somebody reaches for.
   */
  it('a sources bag carries no write', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const service = new MatchupService(db, { sleeper: sleeperServing(rows()) });
    // `sources` is private and deliberately so; this reads it the way a mistake
    // would, which is the point.
    const bag = (service as unknown as { sources(): MatchupSources }).sources();
    for (const key of Object.keys(bag)) {
      expect(key, `MatchupSources gained a "${key}" that reads like a write`).not.toMatch(
        /^(record|write|save|insert|settle|upsert|delete)$/i,
      );
    }
  });

  /**
   * Mutation test: put the write back, and the purity check notices.
   *
   * This is the assertion that keeps the rest honest. `buildMatchupResponse`
   * still knows how to record — it has to, or the ledger could not be filled at
   * all — so the failure mode this file guards against is somebody wiring a
   * ledger back onto the request path. Here that is done deliberately, and the
   * database is expected to move. If this test ever passes with an empty
   * `mutations()`, the instrument above has stopped working and every other
   * assertion in this file is worthless.
   */
  it('mutation: handing the assembly a ledger does write, so the instrument is live', async () => {
    const real = await createTestDb();
    await seedDemoData(real);
    const before = await snapshot(real);
    const { db, mutations } = watched(real);

    const service = new MatchupService(db, { sleeper: sleeperServing(rows()) });
    const bag = (service as unknown as { sources(): MatchupSources }).sources();
    const written: unknown[] = [];
    await buildMatchupResponse(bag, 'demo-league', {}, {
      record: async (observation) => {
        written.push(observation);
        await (service as unknown as { record(o: unknown): Promise<void> }).record(observation);
      },
    });

    expect(written, 'the seam the repair removed from the read path').toHaveLength(1);
    expect(mutations().length, 'a ledger-carrying call has to write, or this proves nothing').toBeGreaterThan(0);
    expect(await snapshot(real)).not.toEqual(before);
    expect(await calibrationRows(real)).toBe(2);
  });
});

/**
 * The response is the same response, ledger or no ledger.
 *
 * §5 of the handoff: for the same fixture, the Matchup GET must be semantically
 * identical before and after this repair, and the only difference must be that
 * the database is left alone. The "before" is not runnable from here — it was
 * deleted — but the property it stood for is, because the two paths still share
 * one assembly: `buildMatchupResponse` with three arguments is the read, and the
 * same call with a fourth is the capture.
 *
 * So the differential is run directly. Same sources, same fixed clock, same
 * fixture; one call writes and one does not; the two responses must be deeply
 * equal. Anything the ledger touched on the way past — a mutated forecast, a
 * changed `cached` flag, a field carrying a row id — shows up here as an
 * inequality.
 */
describe('the ledger changes nothing about what is returned', () => {
  it('a recorded call and a pure call produce the identical response', async () => {
    const clock = () => new Date('2026-09-13T16:20:00.000Z');

    // Two databases, seeded identically, so the write has somewhere real to go
    // and cannot contaminate the control.
    const control = await createTestDb();
    await seedDemoData(control);
    const recorded = await createTestDb();
    await seedDemoData(recorded);

    const pure = await new MatchupService(control, { sleeper: sleeperServing(rows()), now: clock }).forLeague(
      'demo-league',
    );

    const writer = new MatchupService(recorded, { sleeper: sleeperServing(rows()), now: clock });
    await writer.captureCalibration('demo-league');
    // Read it back through the endpoint's own entry point, so the comparison is
    // response-to-response rather than response-to-internal-state.
    const afterWriting = await writer.forLeague('demo-league');

    expect(afterWriting).toEqual(pure);
    expect(await calibrationRows(control), 'the control must not have been written to').toBe(0);
    expect(await calibrationRows(recorded), 'and the writer must actually have written').toBe(2);
  });

  /**
   * And a read is unaffected by rows already in the ledger.
   *
   * The one place a stored row can reach the response is `previousForecast`,
   * which feeds the "changed since you looked" insight. That is by design and
   * predates this work; what must not happen is the *forecast* moving because
   * the ledger has contents. Same fixture, same clock, one database with a
   * week's observations already in it.
   */
  it('serves the same forecast whether or not the ledger has rows in it', async () => {
    const clock = () => new Date('2026-09-13T16:20:00.000Z');
    const empty = await createTestDb();
    await seedDemoData(empty);
    const filled = await createTestDb();
    await seedDemoData(filled);
    await new MatchupService(filled, { sleeper: sleeperServing(rows()), now: clock }).captureCalibration('demo-league');

    const a = await new MatchupService(empty, { sleeper: sleeperServing(rows()), now: clock }).forLeague('demo-league');
    const b = await new MatchupService(filled, { sleeper: sleeperServing(rows()), now: clock }).forLeague('demo-league');

    expect(b.forecast!.fingerprint).toBe(a.forecast!.fingerprint);
    expect(b.forecast!.teams).toEqual(a.forecast!.teams);
    expect(b.forecast!.slots).toEqual(a.forecast!.slots);
    expect(b.forecast!.decision).toEqual(a.forecast!.decision);
    expect(b.cards).toEqual(a.cards);
  });
});

async function calibrationRows(db: Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM matchup_forecasts').first<{ n: number }>();
  return row?.n ?? 0;
}
