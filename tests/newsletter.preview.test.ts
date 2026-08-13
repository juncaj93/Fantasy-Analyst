/**
 * Reprocess preview — what a rule change would actually do, before it does it.
 *
 * The point of the preview is honesty about a subtlety: reprocessing is
 * insert-only, so an improved rule can disagree with a stored item and still
 * leave it alone. The preview has to surface that rather than imply the
 * disagreement will be resolved.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { CLEAN_NEWSLETTER } from './fixtures/newsletters.ts';

const SENDER = 'editor@ffnewsletter.example';

const SOURCES = [
  {
    id: 'ff-newsletter',
    label: 'FF Newsletter',
    fromPatterns: ['@ffnewsletter.example'],
    subjectPatterns: [],
    enabled: true,
  },
];

function inbound(messageId = 'preview-1') {
  return toEmailMessage({
    messageId,
    from: SENDER,
    subject: 'Training Camp Notes',
    date: '2026-08-13T12:00:00.000Z',
    html: CLEAN_NEWSLETTER,
  });
}

describe('previewReprocess', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    await service.setSources(SOURCES);
  });

  it('reports everything as new before anything is stored', async () => {
    const preview = await service.previewReprocess(inbound());
    expect(preview.wouldAdd).toBeGreaterThan(0);
    expect(preview.alreadyStored).toBe(0);
    expect(preview.playersAffected).toBeGreaterThan(0);
    expect(preview.detail).toContain('would be added');
  });

  it('writes nothing', async () => {
    const evidence = new EvidenceRepo(db);
    expect(await evidence.countAll()).toBe(0);
    await service.previewReprocess(inbound());
    expect(await evidence.countAll()).toBe(0);
  });

  it('reports nothing new once the same newsletter has been ingested', async () => {
    await service.ingest(inbound());
    const preview = await service.previewReprocess(inbound());
    expect(preview.wouldAdd).toBe(0);
    expect(preview.alreadyStored).toBeGreaterThan(0);
    expect(preview.tallyDelta).toEqual([]);
    expect(preview.detail).toContain('Nothing new');
  });

  it('matches what reprocessing then actually inserts', async () => {
    const preview = await service.previewReprocess(inbound());
    const outcome = await service.reprocess(inbound());
    expect(outcome.evidenceInserted).toBe(preview.wouldAdd);
  });

  it('flags a stored item the rules now read differently, and does not claim it will change', async () => {
    await service.ingest(inbound());
    const evidence = new EvidenceRepo(db);

    // Simulate a rule change by moving a stored row away from what the current
    // rules produce. The classifier is deterministic, so this is the same
    // situation as editing rules.ts and re-running.
    const before = await service.previewReprocess(inbound());
    expect(before.stale).toEqual([]);

    const all = await db
      .prepare("SELECT id FROM evidence_items WHERE user_override_json IS NULL ORDER BY id LIMIT 1")
      .first<{ id: number }>();
    await db
      .prepare("UPDATE evidence_items SET polarity = 'negative', magnitude = 9 WHERE id = ?")
      .bind(all!.id)
      .run();

    const preview = await service.previewReprocess(inbound());
    expect(preview.stale).toHaveLength(1);
    expect(preview.stale[0]!.storedMagnitude).toBe(9);
    expect(preview.stale[0]!.newMagnitude).not.toBe(9);
    // The honest part: it says the item is left alone, not that it is fixed.
    expect(preview.detail).toContain('leaves them as they are');

    // And reprocessing really does leave it alone.
    await service.reprocess(inbound());
    const after = await evidence.getById(all!.id);
    expect(after?.magnitude).toBe(9);
  });

  it('reports a disagreement on a corrected item as protected, never as stale', async () => {
    await service.ingest(inbound());
    const evidence = new EvidenceRepo(db);
    const row = await db
      .prepare('SELECT id FROM evidence_items ORDER BY id LIMIT 1')
      .first<{ id: number }>();

    await evidence.applyReview(row!.id, 'correct', { polarity: 'negative', magnitude: 3 });
    await db
      .prepare("UPDATE evidence_items SET polarity = 'negative', magnitude = 3 WHERE id = ?")
      .bind(row!.id)
      .run();

    const preview = await service.previewReprocess(inbound());
    expect(preview.protectedByUser).toHaveLength(1);
    expect(preview.stale).toEqual([]);
    expect(preview.detail).toContain('you corrected are protected');
  });

  it('counts a tally change only for items that would really be added', async () => {
    const preview = await service.previewReprocess(inbound());
    const claimed = preview.tallyDelta.reduce((total, d) => total + Math.abs(d.net), 0);
    expect(claimed).toBeGreaterThan(0);

    // After ingesting, a second preview must promise no movement at all.
    await service.ingest(inbound());
    const second = await service.previewReprocess(inbound());
    expect(second.tallyDelta).toEqual([]);
  });

  it('keeps the body of a processed newsletter so its rules can be re-run', async () => {
    await service.ingest(inbound('kept-1'));
    const stored = await service.storedMessage('kept-1');
    expect(stored).not.toBeNull();
    expect(stored!.html).toContain('Bijan Robinson');
  });

  it('does not keep the body of quarantined mail', async () => {
    const outcome = await service.ingest(
      toEmailMessage({
        messageId: 'spam-1',
        from: 'marketing@random.example',
        subject: 'Buy things',
        date: '2026-08-13T12:00:00.000Z',
        html: CLEAN_NEWSLETTER,
      }),
    );
    expect(outcome.status).toBe('quarantined');
    // Recording that it arrived is useful; storing what a stranger sent is not.
    expect(await service.storedMessage('spam-1')).toBeNull();
  });

  it('still reports parser coverage so rules can be improved from it', async () => {
    const preview = await service.previewReprocess(inbound());
    expect(preview.coverage).toBeDefined();
    expect(preview.coverage.sentencesWithPlayers).toBeGreaterThan(0);
  });
});
