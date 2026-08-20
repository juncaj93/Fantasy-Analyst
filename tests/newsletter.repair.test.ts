/**
 * Repairing a newsletter that was already ingested from an unreadable body.
 *
 * This is the half of the incident that a decoder fix alone does not solve. The
 * affected issue is already in the message log, its body stored exactly as it
 * was misread, and its evidence already derived from that garbage. Fixing the
 * decoder makes the NEXT newsletter correct; these tests are about making the
 * one that already landed correct, without counting anything twice and without
 * overruling anything the user decided.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { parseRawEmail } from '../src/worker/index.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { SUBSTACK_RAW_MIME } from './fixtures/newsletters.ts';

const SOURCES = [
  { id: 'ff', label: 'FF Newsletter', fromPatterns: ['@substack.com'], subjectPatterns: [], enabled: true },
];

const MESSAGE_ID = 'issue-4f2a1c';

/**
 * The body exactly as the folded-header bug stored it: the whole raw MIME
 * payload, from the first boundary on, parked in the plain-text column.
 */
const CORRUPT_BODY = SUBSTACK_RAW_MIME.slice(SUBSTACK_RAW_MIME.indexOf('----==_mimepart_outer_68aa'));

/** The email as production has it stored today. */
function asStored() {
  return toEmailMessage({
    messageId: MESSAGE_ID,
    from: 'Fantasy Football Weekly <ffweekly@substack.com>',
    subject: 'Week 1 Camp Risers',
    date: '2026-08-13T12:00:00.000Z',
    text: CORRUPT_BODY,
  });
}

/** The same email as it would arrive through the repaired worker. */
function asDelivered() {
  const parsed = parseRawEmail(SUBSTACK_RAW_MIME);
  return toEmailMessage({
    messageId: MESSAGE_ID,
    from: 'Fantasy Football Weekly <ffweekly@substack.com>',
    subject: parsed.subject,
    date: '2026-08-13T12:00:00.000Z',
    html: parsed.html,
    text: parsed.text,
  });
}

describe('repairing an already-ingested newsletter', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;
  let evidence: EvidenceRepo;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    evidence = new EvidenceRepo(db);
    await service.setSources(SOURCES);
  });

  it('reads the stored corrupt body as the real newsletter', async () => {
    const outcome = await service.ingest(asStored());
    expect(outcome.status).toBe('processed');
    // The recovery ran, and said so.
    expect(outcome.coverage?.repairs.length).toBeGreaterThan(0);
    // And the news is there, from a body that previously yielded fragments.
    const names = (outcome.result?.evidence ?? []).map((e) => e.playerName);
    expect(names).toContain('Bijan Robinson');
    expect(names).toContain('Puka Nacua');
  });

  it('offers no encoding or URL fragment as a missing player name', async () => {
    const outcome = await service.ingest(asStored());
    for (const name of outcome.coverage?.unknownNames ?? []) {
      expect(name, name).toMatch(/^[A-Za-z'’.\-]+(?: [A-Za-z'’.\-]+)*$/);
    }
  });

  it('reaches the same evidence whether the body was stored corrupt or clean', async () => {
    const fromCorrupt = await service.ingest(asStored());

    const fresh = new NewsletterService(await freshDb());
    await fresh.setSources(SOURCES);
    const fromClean = await fresh.ingest(asDelivered());

    const keys = (o: typeof fromCorrupt) => (o.result?.evidence ?? []).map((e) => e.dedupeKey).sort();
    expect(keys(fromCorrupt)).toEqual(keys(fromClean));
  });

  // -------------------------------------------------------------- reprocess --
  it('previews the repair before doing anything', async () => {
    await service.ingest(asStored());
    const stored = await service.storedMessage(MESSAGE_ID);
    const preview = await service.previewReprocess(stored!);

    expect(preview.repairs.length).toBeGreaterThan(0);
    expect(preview.detail).toContain('repairs the text first');
    // A preview writes nothing.
    const before = await evidence.countAll();
    await service.previewReprocess(stored!);
    expect(await evidence.countAll()).toBe(before);
  });

  it('reprocessing the same message twice adds nothing the second time', async () => {
    await service.ingest(asStored());
    const stored = await service.storedMessage(MESSAGE_ID);

    const first = await service.reprocess(stored!);
    const afterFirst = await evidence.countAll();
    const second = await service.reprocess(stored!);

    expect(second.evidenceInserted).toBe(0);
    expect(await evidence.countAll()).toBe(afterFirst);
    expect(first.messageId).toBe(second.messageId);
  });

  it('leaves the tally identical across repeated reprocessing', async () => {
    await service.ingest(asStored());
    const stored = await service.storedMessage(MESSAGE_ID);
    await service.reprocess(stored!);
    const before = await signals(evidence);
    await service.reprocess(stored!);
    await service.reprocess(stored!);
    expect(await signals(evidence)).toEqual(before);
  });

  /**
   * The double-count this whole path exists to prevent.
   *
   * The one signal that DID survive the original ingestion was read out of a
   * fragment, so it carries a dedupe key derived from that fragment's text. The
   * repaired parse describes the same news in clean prose, which is a different
   * key. Insert-only would leave both in the ledger, and the player's tally
   * would count one piece of news twice.
   */
  it('does not count one piece of news twice after the text is repaired', async () => {
    // Ingest the corrupt body the way the OLD parser saw it, so the ledger
    // holds a row whose excerpt is a fragment.
    const legacy = await service.ingest(
      toEmailMessage({
        messageId: MESSAGE_ID,
        from: 'Fantasy Football Weekly <ffweekly@substack.com>',
        subject: 'Week 1 Camp Risers',
        date: '2026-08-13T12:00:00.000Z',
        // A fragment of the sort the undecoded body produced, carrying a real
        // rule match for a real player.
        text: 'Bijan Robinson was named the starter, and the coach called him =',
      }),
    );
    expect(legacy.evidenceInserted).toBe(1);
    const legacyKey = legacy.result!.evidence[0]!.dedupeKey;
    const bijan = legacy.result!.evidence[0]!.playerId;

    // Now the stored body is repaired and the message re-read.
    await replaceStoredBody(db, MESSAGE_ID, CORRUPT_BODY);
    const stored = await service.storedMessage(MESSAGE_ID);
    const outcome = await service.reprocess(stored!);

    expect(outcome.detail).toContain('retired');

    const live = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).filter((e) => e.playerId === bijan);
    expect(live).toHaveLength(1);
    expect(live[0]!.dedupeKey).not.toBe(legacyKey);
    expect(live[0]!.excerpt).toContain('"the engine"');
    // The retired row is still in the ledger, marked, not deleted.
    const all = await evidence.listForPlayer(bijan);
    expect(all.find((e) => e.dedupeKey === legacyKey)?.reviewStatus).toBe('ignored');
  });

  it('never overrules a correction the user made', async () => {
    const legacy = await service.ingest(
      toEmailMessage({
        messageId: MESSAGE_ID,
        from: 'Fantasy Football Weekly <ffweekly@substack.com>',
        subject: 'Week 1 Camp Risers',
        date: '2026-08-13T12:00:00.000Z',
        text: 'Bijan Robinson was named the starter, and the coach called him =',
      }),
    );
    const legacyKey = legacy.result!.evidence[0]!.dedupeKey;
    const stored0 = (await evidence.listByDedupeKeys([legacyKey])).get(legacyKey)!;
    await evidence.applyReview(Number(stored0.id), 'correct', { polarity: 'negative', magnitude: 1 });

    await replaceStoredBody(db, MESSAGE_ID, CORRUPT_BODY);
    const outcome = await service.reprocess((await service.storedMessage(MESSAGE_ID))!);

    expect(outcome.detail).toContain('left exactly as you set them');
    const kept = (await evidence.listByDedupeKeys([legacyKey])).get(legacyKey);
    expect(kept?.reviewStatus).toBe('corrected');
    // The correction lives in the override, and the repair does not touch it.
    expect(kept?.userOverride?.polarity).toBe('negative');
  });

  it('retires nothing when the stored body was readable all along', async () => {
    const fresh = new NewsletterService(db);
    await fresh.ingest(asDelivered());
    const stored = await fresh.storedMessage(MESSAGE_ID);
    const preview = await fresh.previewReprocess(stored!);
    expect(preview.repairs).toEqual([]);
    expect(preview.wouldRetire).toEqual([]);

    const before = await evidence.listLiveBySourceMessage(MESSAGE_ID);
    const outcome = await fresh.reprocess(stored!);
    expect(outcome.evidenceInserted).toBe(0);
    expect(await evidence.listLiveBySourceMessage(MESSAGE_ID)).toHaveLength(before.length);
  });

  async function freshDb() {
    const other = await createTestDb();
    await new PlayerRepo(other).upsertMany(TEST_PLAYERS);
    return other;
  }
});

/** Every player's derived signal, as a comparable snapshot. */
async function signals(evidence: EvidenceRepo): Promise<[string, number][]> {
  const rows = await evidence.listApplied(200);
  const net = new Map<string, number>();
  for (const row of rows) {
    const signed = row.polarity === 'positive' ? row.magnitude : row.polarity === 'negative' ? -row.magnitude : 0;
    net.set(row.playerId, (net.get(row.playerId) ?? 0) + signed);
  }
  return [...net.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Swap the retained body of a logged message, as a decoder fix effectively does. */
async function replaceStoredBody(db: NodeSqliteDatabase, messageId: string, text: string): Promise<void> {
  await db
    .prepare('UPDATE newsletter_messages SET body_text = ?, body_html = NULL WHERE message_id = ?')
    .bind(text, messageId)
    .run();
}
