/**
 * Round 28: the per-game "lines on file" read must not walk the whole table.
 *
 * Cap Watch, Sunday 15 November 2026: `SELECT * FROM player_props WHERE
 * snapshot_id IN (...) AND scope = 'week'` was 62 to 82% of the app's reads on
 * Friday to Sunday, about 48,000 rows a call, 64 calls between 6:49 and
 * 10:49 AM ET. It runs once per game every time a look is stored
 * (`LookStore.storeLook` -> `PropsRepo.currentForEvent`). With two or more
 * looks on file SQLite chose the scope index, on which every weekly line has
 * the same value, and read every weekly line in the table.
 *
 * These tests check three things:
 *   1. the plan, for one look and for many (the old test only had one look,
 *      which is why it never caught this);
 *   2. the rows each plan walks on a realistic table (old vs new);
 *   3. the answer is unchanged: the same lines are written, and the Vegas
 *      numbers for ten players (Start/Sit, Compare and Waivers all read them
 *      through `latestForPlayers` / `previousForPlayers`) are identical with
 *      the old query and the new one.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import type { Database, PreparedStatement } from '../src/server/db.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { slateWindow } from '../src/core/nfl/slateWindow.ts';

const H = 3_600_000;
const NEW_SQL = /AND \+scope = 'week'/;

/** The database as the old code saw it: the per-game read without the plus. */
function legacy(inner: Database): Database {
  const old = (sql: string) => sql.replace(NEW_SQL, "AND scope = 'week'");
  return {
    prepare: (sql: string): PreparedStatement => inner.prepare(old(sql)),
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };
}

/** The SQL `currentForEvent` sends, captured from a real call. */
async function perGameSql(): Promise<string> {
  const db = await createTestDb();
  await addGame(db, 'e1', '2026-11-15T18:00:00Z', 3, 5);
  const counting = countingDb(db);
  await new PropsRepo(counting.db).currentForEvent('e1');
  const hit = counting.tallies().find((t) => t.sql.startsWith('SELECT * FROM player_props WHERE snapshot_id IN'));
  expect(hit, 'currentForEvent reads player_props by snapshot').toBeTruthy();
  return hit!.sql;
}

/** One game: a full copy, then `deltas` change-only looks, `lines` lines each. */
async function addGame(db: Database, eventId: string, kickoff: string, looks: number, lines: number): Promise<number[]> {
  const ids: number[] = [];
  for (let k = 0; k < 25; k++) {
    await db
      .prepare(`INSERT OR IGNORE INTO players (id, full_name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, '2026-11-01', '2026-11-01')`)
      .bind(`${eventId}-p${k}`, `${eventId} P${k}`, `${eventId} p${k}`)
      .run();
  }
  for (let i = 0; i < looks; i++) {
    const at = new Date(Date.parse(kickoff) - (looks - i) * H).toISOString();
    const raw = i === 0 ? '{}' : '{"delta":true}';
    const r = await db
      .prepare(`INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope) VALUES ('sgo',?,?,?,?,'week') RETURNING id`)
      .bind(eventId, kickoff, at, raw)
      .first<{ id: number }>();
    ids.push(Number(r!.id));
    const stmts = [];
    for (let k = 0; k < lines; k++) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, book_count, consensus_method, scope)
             VALUES (?,?,?,?,?,2,'average','week')`,
          )
          .bind(r!.id, `${eventId}-p${k % 25}`, `${eventId} P${k % 25}`, `m${Math.floor(k / 25)}`, 40 + i + k / 10),
      );
    }
    for (let s = 0; s < stmts.length; s += 100) await db.batch(stmts.slice(s, s + 100));
  }
  return ids;
}

async function plan(db: Database, sql: string, params: unknown[]): Promise<string> {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

describe('Round 28: the per-game lines read', () => {
  it('seeks the snapshot index whether the game has one look or thirty', async () => {
    const sql = await perGameSql();
    expect(sql).toMatch(NEW_SQL);
    const db = await createTestDb();
    for (const n of [1, 2, 3, 5, 10, 30]) {
      const sized = sql.replace(/IN \([?,]+\)/, `IN (${Array.from({ length: n }, () => '?').join(',')})`);
      const p = await plan(db, sized, Array(n).fill(1));
      expect(p, `${n} looks`).toContain('USING INDEX idx_player_props_snapshot_player (snapshot_id=?)');
      expect(p, `${n} looks`).not.toContain('idx_player_props_scope');
    }
  });

  it('the old form walked the scope index (every weekly line) as soon as a game had two looks', async () => {
    const sql = (await perGameSql()).replace(NEW_SQL, "AND scope = 'week'");
    const db = await createTestDb();
    expect(await plan(db, sql.replace(/IN \([?,]+\)/, 'IN (?)'), [1])).toContain('idx_player_props_snapshot_player');
    expect(await plan(db, sql.replace(/IN \([?,]+\)/, 'IN (?,?)'), [1, 2])).toContain('idx_player_props_scope (scope=?)');
  });

  it('walks one game\'s lines, not the week: rows per call, old against new', async () => {
    const db = await createTestDb();
    // A Sunday slate: 14 games, each a full copy and 5 change-only looks.
    let target: number[] = [];
    for (let g = 0; g < 14; g++) {
      const ids = await addGame(db, `g${g}`, '2026-11-15T18:00:00Z', 6, g === 0 ? 120 : 80);
      if (g === 0) target = ids;
    }
    const inList = target.map(() => '?').join(',');
    // What each plan walks: the old one the whole scope range, the new one each look's lines.
    const oldWalk = Number((await db.prepare("SELECT COUNT(*) AS n FROM player_props WHERE scope = 'week'").first<{ n: number }>())!.n);
    const newWalk = Number(
      (await db.prepare(`SELECT COUNT(*) AS n FROM player_props WHERE snapshot_id IN (${inList})`).bind(...target).first<{ n: number }>())!.n,
    );
    expect(oldWalk).toBe(14 * 6 * 80 + 6 * 40);
    expect(newWalk).toBe(6 * 120);
    expect(newWalk / oldWalk).toBeLessThan(0.15);

    // And the two forms return the same rows.
    const sql = await perGameSql();
    const rowsOf = async (text: string) =>
      (await db.prepare(text.replace(/IN \([?,]+\)/, `IN (${inList})`)).bind(...target).all<Record<string, unknown>>()).results
        .map((r) => JSON.stringify(r))
        .sort();
    expect(await rowsOf(sql)).toEqual(await rowsOf(sql.replace(NEW_SQL, "AND scope = 'week'")));
  });
});

// ------------------------------------------------------------ same numbers

/** Ten players across the seeded games: roster, opponent and free agents alike. */
const TEN = 10;
/** The seeded games kick off three days from the real clock, so the looks start from it too. */
const START = Date.now() + 1 * H;

async function runRefreshes(db: Database): Promise<void> {
  const { MockVegasProvider } = await import('../src/core/vegas/mockProvider.ts');
  const { MOCK_GAMES } = await import('../src/devserver/seed.ts');
  const { VegasRefreshService } = await import('../src/server/services/vegasRefresh.ts');

  /** Two books; some lines move on each look and one player is pulled on the third. */
  class Books extends MockVegasProvider {
    now = 0;
    look = 0;
    constructor() {
      super(MOCK_GAMES);
    }
    override async getPlayerProps(eventId: string, markets?: never) {
      const raw = await super.getPlayerProps(eventId, markets);
      const at = new Date(this.now).toISOString();
      const look = this.look;
      const quotes = raw.quotes
        .filter((_q, i) => !(look === 2 && i < 6))
        .map((q, i) => (q.line != null && i % 3 === look % 3 ? { ...q, line: q.line + 5 * (look + 1) } : q));
      return {
        ...raw,
        fetchedAt: at,
        quotes: quotes.flatMap((x) => [x, { ...x, book: 'fanduel' }]),
        gameLines: {
          total: 44.5 + look,
          spread: -3,
          spreadTeam: 'KC',
          teams: ['KC', 'CIN'],
          books: [
            { book: 'draftkings', total: 44.5 + look, spread: -3, spreadTeam: 'KC', at },
            { book: 'fanduel', total: 44.5 + look, spread: -3, spreadTeam: 'KC', at },
          ],
        },
      };
    }
    async getAccountUsage(): Promise<unknown> {
      return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 0 } } };
    }
  }

  const provider = new Books();
  const start = START;
  for (let look = 0; look < 4; look++) {
    provider.look = look;
    provider.now = start + look * 7 * H; // past the manual cooldown each time
    await new VegasRefreshService(db, provider).refresh({ manual: true, now: provider.now });
  }
}

async function seededDb(): Promise<Database> {
  const { seedDemoData } = await import('../src/devserver/seed.ts');
  const db = await createTestDb();
  await seedDemoData(db);
  // The seed writes full copies. Start each game's history from them, as production does.
  return db;
}

describe('Round 28: same Vegas numbers before and after', () => {
  it('stores the same lines and shows the same numbers for ten players', async () => {
    const before = await seededDb();
    const after = await seededDb();
    await runRefreshes(legacy(before));
    await runRefreshes(after);

    const table = async (db: Database) =>
      (
        await db
          .prepare(
            `SELECT pp.player_id, pp.source_player_name, pp.market, pp.line, pp.over_price, pp.under_price, pp.book_count,
                    pp.books_json, pp.consensus_method, pp.implied_probability, ps.event_id,
                    -- The seed stamps its copies with the clock, so compare each look's place, not its time.
                    DENSE_RANK() OVER (PARTITION BY ps.event_id ORDER BY ps.fetched_at) AS look
               FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE ps.scope = 'week'
              ORDER BY ps.event_id, ps.fetched_at, pp.id`,
          )
          .all()
      ).results;
    const storedBefore = await table(before);
    expect(storedBefore.length).toBeGreaterThan(0);
    expect(await table(after), 'every line written is the same').toEqual(storedBefore);

    // A game with several looks, so the old query really took the scope index when storing it.
    const looks = await after
      .prepare("SELECT event_id, COUNT(*) AS n FROM prop_snapshots WHERE scope = 'week' GROUP BY event_id")
      .all<{ event_id: string; n: number }>();
    expect(Math.max(...looks.results.map((r) => Number(r.n)))).toBeGreaterThanOrEqual(4);

    const ids = (
      await after
        .prepare("SELECT DISTINCT player_id FROM player_props WHERE player_id IS NOT NULL ORDER BY player_id")
        .all<{ player_id: string }>()
    ).results.map((r) => String(r.player_id));
    expect(ids.length).toBeGreaterThanOrEqual(TEN);
    // Spread across the list, so more than one game and position is in the ten.
    const ten = Array.from({ length: TEN }, (_, i) => ids[Math.floor((i * ids.length) / TEN)]!);

    const window = slateWindow(new Date(START + 21 * H));
    const numbers = async (db: Database) => {
      const repo = new PropsRepo(db);
      const now = await repo.latestForPlayers(ten, window);
      const prev = await repo.previousForPlayers(ten, window);
      const any = await repo.latestForPlayers(ten);
      const pick = (m: Map<string, { market: string; line: number | null; overPrice: number | null; bookCount: number }[]>) =>
        ten.map((id) => [id, (m.get(id) ?? []).map((p) => `${p.market}=${p.line ?? p.overPrice}/${p.bookCount}`).sort()]);
      return { now: pick(now), prev: pick(prev), any: pick(any) };
    };
    const a = await numbers(before);
    const b = await numbers(after);
    expect(b).toEqual(a);
    // The ten carry real numbers, so the comparison is not of empty lists.
    expect(a.now.filter(([, lines]) => (lines as string[]).length > 0).length).toBeGreaterThanOrEqual(TEN - 1);
  });
});
