/**
 * 0042 clears the provider payload from old weekly snapshots, and nothing else.
 *
 * Rows are inserted after the schema is built (the migration has already run
 * once on an empty table), then the migration is run again: the same thing
 * production sees, where the rows exist before it arrives.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const MIGRATION = readFileSync(
  new URL('../migrations/0042_strip_stored_provider_payload.sql', import.meta.url),
  'utf8',
);

const PAYLOAD = { eventID: 'e1', odds: { a: { byBookmaker: { dk: { odds: '-110' } } } } };
const QUOTES = [{ playerName: 'Joe Burrow', market: 'pass_yards', line: 250.5, overPrice: -115, underPrice: null, book: 'sportsgameodds' }];
const LINES = { total: 47.5, spread: -3.5, spreadTeam: 'CIN' };

async function insert(db: NodeSqliteDatabase, eventId: string, scope: string, raw: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
       VALUES ('sportsgameodds', ?, '2026-09-27T17:00:00.000Z', '2026-09-27T16:07:07.000Z', ?, ?)`,
    )
    .bind(eventId, raw, scope)
    .run();
}

async function stored(db: NodeSqliteDatabase, eventId: string): Promise<string> {
  const row = await db.prepare('SELECT raw_json FROM prop_snapshots WHERE event_id = ?').bind(eventId).first<{ raw_json: string }>();
  return row!.raw_json;
}

describe('migration 0042', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('drops the payload from a weekly snapshot and keeps its quotes and game lines', async () => {
    const set = { provider: 'sportsgameodds', eventId: 'week-old', gameStart: '2026-09-27T17:00:00.000Z', fetchedAt: '2026-09-27T16:07:07.000Z', quotes: QUOTES, gameLines: LINES, raw: PAYLOAD };
    await insert(db, 'week-old', 'week', JSON.stringify(set));

    await db.exec(MIGRATION);

    const after = JSON.parse(await stored(db, 'week-old'));
    expect(after.raw).toBeNull();
    expect(after.quotes).toEqual(QUOTES);
    expect(after.gameLines).toEqual(LINES);
    expect(after.eventId).toBe('week-old');
    expect(after.fetchedAt).toBe('2026-09-27T16:07:07.000Z');
  });

  it('leaves other scopes, new-shape rows and unreadable rows exactly as they were', async () => {
    const season = JSON.stringify({ quotes: [], raw: PAYLOAD });
    const fresh = JSON.stringify({ quotes: QUOTES, raw: null });
    await insert(db, 'season-row', 'season', season);
    await insert(db, 'week-new', 'week', fresh);
    await insert(db, 'week-broken', 'week', 'not json');

    await db.exec(MIGRATION);

    expect(await stored(db, 'season-row')).toBe(season);
    expect(await stored(db, 'week-new')).toBe(fresh);
    expect(await stored(db, 'week-broken')).toBe('not json');
  });

  it('changes nothing when it runs a second time', async () => {
    await insert(db, 'week-old', 'week', JSON.stringify({ quotes: QUOTES, raw: PAYLOAD }));
    await db.exec(MIGRATION);
    const once = await stored(db, 'week-old');
    await db.exec(MIGRATION);
    expect(await stored(db, 'week-old')).toBe(once);
  });
});
