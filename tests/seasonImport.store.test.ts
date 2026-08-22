/**
 * Storing preseason snapshots, previewing them, and revising them.
 *
 * Against a real database, because the behaviours that matter here are about
 * identity and replacement rather than arithmetic: whether a second paste of
 * the same capture revises or stacks, whether a later capture is kept beside an
 * earlier one, and whether a preview leaves the database exactly as it found it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PreseasonSnapshotsRepo, captureLabel } from '../src/server/repos/preseasonSnapshots.ts';
import { PreseasonImportService } from '../src/server/services/preseasonImportService.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';

let db: NodeSqliteDatabase;
let service: PreseasonImportService;

const AUG_20 = `player,team,position,market,line,over_price,under_price
Bijan Robinson,ATL,RB,Rushing Yards,1250.5,-112,-108
Jordan Love,GB,QB,Passing TDs,28.5,-110,-110
D'Andre Swift,CHI,RB,Receiving Yards,410.5,-115,-105`;

// A week later, from the same book, with one line moved.
const AUG_28 = `player,team,position,market,line
Bijan Robinson,ATL,RB,Rushing Yards,1310.5`;

beforeEach(async () => {
  db = await createTestDb();
  await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
  service = new PreseasonImportService(db);
});

async function storedRows(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM player_props WHERE scope = 'season'")
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function storedSnapshots(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM prop_snapshots WHERE scope = 'season' AND capture_source IS NOT NULL")
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const REQ = { season: '2026', source: 'Win With Odds', capturedAt: '2026-08-20' };

describe('preview writes nothing', () => {
  it('reports what would happen and stores none of it', async () => {
    const out = await service.preview({ ...REQ, content: AUG_20 });
    expect(out.committed).toBe(false);
    expect(out.counts.accepted).toBe(3);
    expect(await storedRows()).toBe(0);
    expect(await storedSnapshots()).toBe(0);
  });

  it('files no Review items', async () => {
    await service.preview({ ...REQ, content: `player,market,line\nNobody At All,Receiving Yards,900.5` });
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(0);
  });

  it('shows the coverage the board would end up with', async () => {
    const out = await service.preview({ ...REQ, content: AUG_20 });
    expect(out.resultingCoverage.players).toBe(3);
    expect(out.resultingCoverage.sources[0]?.source).toBe('Win With Odds');
  });
});

describe('applying a snapshot', () => {
  it('stores the rows and labels the capture', async () => {
    const out = await service.apply({ ...REQ, content: AUG_20 });
    expect(out.committed).toBe(true);
    expect(await storedRows()).toBe(3);
    expect(out.label).toBe('Win With Odds · Aug 20');
  });

  it('keeps the capture date, not the import date, as the provenance', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const [snap] = await new PreseasonSnapshotsRepo(db).list('2026');
    expect(snap?.capturedAt).toBe('2026-08-20');
    // Imported now, captured in August: an August number stays an August number.
    expect(snap?.importedAt).not.toBe('2026-08-20');
  });

  it('records one book as one book, never as a consensus', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const row = await db
      .prepare("SELECT book_count, consensus_method FROM player_props WHERE scope = 'season' LIMIT 1")
      .first<Record<string, unknown>>();
    expect(Number(row?.['book_count'])).toBe(1);
    expect(String(row?.['consensus_method'])).toBe('single');
  });

  it('keeps absent odds null in the database', async () => {
    await service.apply({ ...REQ, capturedAt: '2026-08-28', content: AUG_28 });
    const row = await db
      .prepare("SELECT over_price, under_price FROM player_props WHERE scope = 'season' LIMIT 1")
      .first<Record<string, unknown>>();
    expect(row?.['over_price']).toBeNull();
    expect(row?.['under_price']).toBeNull();
  });
});

describe('idempotence and revision', () => {
  it('revises rather than stacks when the same capture is imported twice', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    await service.apply({ ...REQ, content: AUG_20 });
    expect(await storedSnapshots()).toBe(1);
    expect(await storedRows()).toBe(3);
  });

  it('replaces the rows of a corrected re-import, leaving no trace of the mistake', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const corrected = `player,team,position,market,line
Bijan Robinson,ATL,RB,Rushing Yards,1150.5`;
    await service.apply({ ...REQ, content: corrected });

    expect(await storedSnapshots()).toBe(1);
    expect(await storedRows()).toBe(1);
    const row = await db
      .prepare("SELECT line FROM player_props WHERE scope = 'season'")
      .first<{ line: number }>();
    expect(Number(row?.line)).toBe(1150.5);
  });

  it('keeps a later capture alongside the earlier one', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    await service.apply({ ...REQ, capturedAt: '2026-08-28', content: AUG_28 });
    expect(await storedSnapshots()).toBe(2);
    const snaps = await new PreseasonSnapshotsRepo(db).list('2026');
    expect(snaps.map((s) => s.capturedAt)).toEqual(['2026-08-28', '2026-08-20']);
  });

  it('tells a preview that it would revise an existing capture', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const out = await service.preview({ ...REQ, content: AUG_20 });
    expect(out.replaces?.capturedAt).toBe('2026-08-20');
  });

  it('does not double-count the capture it would replace', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const out = await service.preview({ ...REQ, content: AUG_20 });
    // Three players before, three after — not six.
    expect(out.resultingCoverage.players).toBe(3);
  });
});

describe('history across captures', () => {
  it('lets a later capture move a line without deleting the others', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    await service.apply({ ...REQ, capturedAt: '2026-08-28', content: AUG_28 });

    // The Aug 28 capture named one player. The other two must survive it.
    const out = await service.preview({ ...REQ, capturedAt: '2026-08-29', content: AUG_28 });
    expect(out.resultingCoverage.players).toBe(3);
  });

  it('keeps every capture readable after the fact', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    await service.apply({ ...REQ, capturedAt: '2026-08-28', content: AUG_28 });
    const snaps = await new PreseasonSnapshotsRepo(db).list('2026');
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.label !== '')).toBe(true);
  });
});

describe('unresolved players', () => {
  const WITH_UNKNOWN = `player,team,position,market,line
Bijan Robinson,ATL,RB,Rushing Yards,1250.5
Some Unknown Rookie,SEA,WR,Receiving Yards,450.5
Chris Johnson,,,Rushing Yards,800.5`;

  it('stores the row with no player id rather than dropping it', async () => {
    await service.apply({ ...REQ, content: WITH_UNKNOWN });
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM player_props WHERE scope = 'season' AND player_id IS NULL",
      )
      .first<{ n: number }>();
    // Two unresolved: an unknown name and an ambiguous one.
    expect(Number(row?.n)).toBe(2);
  });

  it('files a Review item for each unresolved name', async () => {
    const out = await service.apply({ ...REQ, content: WITH_UNKNOWN });
    expect(out.reviewsFiled).toBe(2);
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(2);
  });

  it('does not file the same question twice on a re-import', async () => {
    await service.apply({ ...REQ, content: WITH_UNKNOWN });
    await service.apply({ ...REQ, content: WITH_UNKNOWN });
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(2);
  });

  it('contributes nothing to the board until it is resolved', async () => {
    const out = await service.apply({ ...REQ, content: WITH_UNKNOWN });
    // Three rows stored, one player usable.
    expect(out.counts.accepted).toBe(3);
    expect(out.resultingCoverage.players).toBe(1);
  });

  it('carries no polarity into the review queue', async () => {
    await service.apply({ ...REQ, content: WITH_UNKNOWN });
    const row = await db
      .prepare('SELECT proposed_polarity, proposed_magnitude FROM identity_reviews LIMIT 1')
      .first<Record<string, unknown>>();
    // Asking "who is this" must not also nudge a ranking.
    expect(String(row?.['proposed_polarity'])).toBe('neutral');
    expect(Number(row?.['proposed_magnitude'])).toBe(0);
  });
});

describe('weekly and season data stay apart', () => {
  it('writes only season-scoped rows', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM player_props WHERE scope = 'week'")
      .first<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });

  it('marks the snapshot as hand-imported, distinguishably', async () => {
    await service.apply({ ...REQ, content: AUG_20 });
    const row = await db
      .prepare("SELECT provider FROM prop_snapshots WHERE scope = 'season' LIMIT 1")
      .first<{ provider: string }>();
    expect(String(row?.provider)).toMatch(/^manual:/);
  });
});

describe('the capture label', () => {
  it('reads as a person would write it', () => {
    expect(captureLabel('Win With Odds', '2026-08-27')).toBe('Win With Odds · Aug 27');
  });
});
