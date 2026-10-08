/**
 * The research-tally headline counts, stored between writes (finding D2).
 *
 * `summary()` was a full pass over evidence_items on every Setup load: 64 reads
 * and 84,224 rows inside the nightly sweep's window on 7 October 2026. It is
 * now kept in one settings row, cleared by every write the repo makes.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { EvidenceRepo, EVIDENCE_SUMMARY_KEY } from '../src/server/repos/evidence.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { player } from './helpers/players.ts';

const item = (key: string, reviewStatus: 'pending' | 'auto_applied', polarity: 'positive' | 'negative' = 'positive') => ({
  dedupeKey: key,
  playerId: '10',
  playerName: 'Bijan Robinson',
  sourceType: 'newsletter' as const,
  sourceName: 'FF Newsletter',
  sourceMessageId: 'msg-1',
  sourceDate: '2026-10-01T12:00:00.000Z',
  excerpt: `Item ${key}`,
  contextSummary: null,
  category: null,
  polarity,
  magnitude: 1,
  confidence: 'high' as const,
  confidenceScore: 0.9,
  ruleId: 'test',
  reviewStatus,
  notes: [],
  blockIndex: 0,
});

async function seeded() {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([player({ id: '10', fullName: 'Bijan Robinson', position: 'RB', team: 'ATL' })]);
  await new EvidenceRepo(db).insertProposed([item('a', 'pending'), item('b', 'auto_applied'), item('c', 'auto_applied', 'negative')] as never);
  return db;
}

describe('the research summary', () => {
  it('is computed once, then read from one stored row', async () => {
    const real = await seeded();
    const first = await new EvidenceRepo(real).summary();
    expect(first).toEqual({ total: 3, pending: 1, autoAppliedPositive: 1, autoAppliedNegative: 1 });

    const counting = countingDb(real);
    const again = await new EvidenceRepo(counting.db).summary();
    expect(again).toEqual(first);
    const scans = counting.tallies().filter((t) => t.sql.includes('FROM evidence_items'));
    expect(scans, 'a second read never walks the table').toEqual([]);
  });

  it('is cleared by a new item, so the next read counts it', async () => {
    const db = await seeded();
    const repo = new EvidenceRepo(db);
    await repo.summary();
    await repo.insertProposed([item('d', 'pending')] as never);
    expect((await repo.summary()).pending).toBe(2);
  });

  it('is cleared by a review', async () => {
    const db = await seeded();
    const repo = new EvidenceRepo(db);
    await repo.summary();
    const pending = (await repo.listPending())[0]!;
    await repo.applyReview(Number(pending.id), 'reject', null);
    expect((await repo.summary()).pending).toBe(0);
  });

  it('is cleared when an import retires rows', async () => {
    const db = await seeded();
    const repo = new EvidenceRepo(db);
    await repo.summary();
    await repo.supersedeStaleImports('msg-1', ['a'], 'replaced');
    const after = await repo.summary();
    expect(after.autoAppliedPositive + after.autoAppliedNegative).toBe(0);
  });

  it('recomputes when the stored copy is unreadable', async () => {
    const db = await seeded();
    await db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').bind(EVIDENCE_SUMMARY_KEY, 'not json', 'x').run();
    expect((await new EvidenceRepo(db).summary()).total).toBe(3);
  });
});
