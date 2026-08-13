/**
 * Inbound email handling — the production newsletter path.
 *
 * Covers raw MIME extraction, sender validation, quarantine of unexpected mail,
 * duplicate delivery, malformed input and the parser coverage report.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import { processNewsletter } from '../src/core/newsletter/pipeline.ts';
import { collectUnresolvedNames } from '../src/core/newsletter/mentions.ts';
import { parseRawEmail } from '../src/worker/index.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_INDEX, TEST_PLAYERS } from './helpers/players.ts';
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

function inbound(overrides: Partial<{ messageId: string; from: string; subject: string; html: string }> = {}) {
  return toEmailMessage({
    messageId: overrides.messageId ?? 'inbound-1',
    from: overrides.from ?? SENDER,
    subject: overrides.subject ?? 'Training Camp Notes',
    date: '2026-08-13T12:00:00.000Z',
    html: overrides.html ?? CLEAN_NEWSLETTER,
  });
}

// ---------------------------------------------------------------- raw MIME ---
describe('parseRawEmail', () => {
  it('extracts the HTML part of a multipart newsletter', () => {
    const raw = [
      'From: FF Newsletter <editor@ffnewsletter.example>',
      'Subject: Week 1 Notes',
      'Message-ID: <abc123@mail.example>',
      'Content-Type: multipart/alternative; boundary="XYZ"',
      '',
      '--XYZ',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain version',
      '--XYZ',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Bijan Robinson was named the starter.</p>',
      '--XYZ--',
    ].join('\r\n');

    const parsed = parseRawEmail(raw);
    expect(parsed.subject).toBe('Week 1 Notes');
    expect(parsed.messageId).toBe('<abc123@mail.example>');
    expect(parsed.html).toContain('Bijan Robinson');
    expect(parsed.text).toContain('plain version');
  });

  it('decodes quoted-printable bodies', () => {
    const raw = [
      'Subject: Test',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>Bijan Robinson =',
      'was named the starter=2E</p>',
      '--B--',
    ].join('\r\n');
    expect(parseRawEmail(raw).html).toContain('starter.');
  });

  it('decodes base64 bodies', () => {
    const encoded = Buffer.from('<p>Puka Nacua was limited.</p>').toString('base64');
    const raw = [
      'Subject: Test',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      '--B--',
    ].join('\r\n');
    expect(parseRawEmail(raw).html).toContain('Puka Nacua');
  });

  it('handles a plain-text-only email', () => {
    const raw = 'Subject: Plain\r\nContent-Type: text/plain\r\n\r\nBijan Robinson was named the starter.';
    const parsed = parseRawEmail(raw);
    expect(parsed.text).toContain('Bijan Robinson');
    expect(parsed.html).toBeNull();
  });

  it('does not throw on malformed input', () => {
    for (const raw of ['', 'garbage with no headers', 'Subject: only a header']) {
      expect(() => parseRawEmail(raw)).not.toThrow();
    }
  });
});

// ------------------------------------------------------- service behaviour ---
describe('inbound newsletter service', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;
  let messages: NewsletterRepo;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    messages = new NewsletterRepo(db);
    await service.setSources(SOURCES);
  });

  it('accepts mail from the configured sender', async () => {
    const outcome = await service.ingest(inbound());
    expect(outcome.status).toBe('processed');
    expect(outcome.evidenceInserted).toBeGreaterThan(0);
    expect(outcome.detail).toMatch(/Found news on/);
  });

  it('quarantines an unexpected sender and creates no evidence', async () => {
    const outcome = await service.ingest(inbound({ from: 'marketing@random.example', messageId: 'spam-1' }));
    expect(outcome.status).toBe('quarantined');
    expect(await new EvidenceRepo(db).countAll()).toBe(0);
    const logged = await messages.seen('spam-1');
    expect(logged?.status).toBe('quarantined');
    expect(logged?.rejectReason).toContain('Unexpected sender');
  });

  it('respects a subject filter', async () => {
    await service.setSources([{ ...SOURCES[0]!, subjectPatterns: ['week \\d+'] }]);
    expect((await service.ingest(inbound({ subject: 'Random promo', messageId: 'm1' }))).status).toBe('quarantined');
    expect((await service.ingest(inbound({ subject: 'Week 3 notes', messageId: 'm2' }))).status).toBe('processed');
  });

  it('honours a disabled source', async () => {
    await service.setSources([{ ...SOURCES[0]!, enabled: false }]);
    expect((await service.ingest(inbound())).status).toBe('quarantined');
  });

  it('ignores a duplicate delivery of the same message id', async () => {
    await service.ingest(inbound());
    const before = await new EvidenceRepo(db).countAll();
    const second = await service.ingest(inbound());
    expect(second.status).toBe('duplicate');
    expect(await new EvidenceRepo(db).countAll()).toBe(before);
  });

  it('ignores a resend of identical content under a new message id', async () => {
    await service.ingest(inbound());
    const second = await service.ingest(inbound({ messageId: 'inbound-2' }));
    expect(second.status).toBe('duplicate');
  });

  it('records an unreadable email as an error without throwing', async () => {
    // A player index is required; dropping the players table forces a failure.
    await db.exec('DROP TABLE players');
    const outcome = await service.ingest(inbound({ messageId: 'boom' }));
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toContain('could not be read');
  });

  it('processes an email with no recognisable players without failing', async () => {
    const outcome = await service.ingest(
      inbound({ messageId: 'empty', html: '<p>The league announced a new kickoff rule.</p>' }),
    );
    expect(outcome.status).toBe('no_players');
    expect(outcome.detail).toContain('no player news');
  });

  it('reports the sender as configured only once the user saves one', async () => {
    const fresh = new NewsletterService(await createTestDb());
    expect(await fresh.isSenderConfigured()).toBe(false);

    await fresh.setSources([{ id: 'x', label: 'x', fromPatterns: ['news@theirsite.com'], enabled: true }]);
    expect(await fresh.isSenderConfigured()).toBe(true);

    await fresh.setSources([{ id: 'x', label: 'x', fromPatterns: ['news@theirsite.com'], enabled: false }]);
    expect(await fresh.isSenderConfigured()).toBe(false);
  });

  it('lets a legitimate newsletter through even after a lookalike was quarantined', async () => {
    // A spoofed sender copies the newsletter body first...
    const spoof = await service.ingest(inbound({ from: 'attacker@evil.example', messageId: 'spoof' }));
    expect(spoof.status).toBe('quarantined');
    // ...the genuine issue must still be read.
    const real = await service.ingest(inbound({ messageId: 'genuine' }));
    expect(real.status).toBe('processed');
  });

  it('stores a plain-language outcome for every inbound email', async () => {
    await service.ingest(inbound());
    await service.ingest(
      inbound({ from: 'x@nope.example', messageId: 'q1', html: '<p>Something else entirely.</p>' }),
    );
    const all = await messages.listMessages();
    expect(all).toHaveLength(2);
    for (const m of all) expect(m.detail).toBeTruthy();
  });
});

// -------------------------------------------------------- coverage report ----
describe('parser coverage report', () => {
  it('separates classified from unclassified player sentences', () => {
    const result = processNewsletter(
      {
        messageId: 'c1',
        from: SENDER,
        subject: 'Notes',
        receivedAt: '2026-08-13T12:00:00.000Z',
        html:
          '<p>Bijan Robinson was named the starter.</p>' +
          '<p>Bijan Robinson grew up in Arizona and enjoys fishing.</p>',
        text: null,
      },
      TEST_INDEX,
    );
    expect(result.coverage.sentencesWithPlayers).toBe(2);
    expect(result.coverage.classifiedSentences).toBe(1);
    expect(result.coverage.unclassifiedSentences).toBe(1);
    expect(result.coverage.samples[0]?.excerpt).toContain('fishing');
    expect(result.coverage.samples[0]?.players).toContain('Bijan Robinson');
  });

  it('lists name-like words that are not in the player dictionary', () => {
    const result = processNewsletter(
      {
        messageId: 'c2',
        from: SENDER,
        subject: 'Notes',
        receivedAt: '2026-08-13T12:00:00.000Z',
        html: '<p>Coach Dan Quinnley said Bijan Robinson was named the starter.</p>',
        text: null,
      },
      TEST_INDEX,
    );
    expect(result.coverage.unknownNames.join(' ')).toContain('Quinnley');
  });

  it('does not report a resolved player as unknown', () => {
    const unknown = collectUnresolvedNames('Bijan Robinson was named the starter.', TEST_INDEX, [
      {
        playerId: '10',
        matchedText: 'Bijan Robinson',
        normalized: 'bijan robinson',
        start: 0,
        end: 14,
        surnameOnly: false,
        match: { status: 'matched', playerId: '10', method: 'name_unique', confidence: 1, candidates: [], reason: '' },
      },
    ]);
    expect(unknown).not.toContain('Bijan Robinson');
  });

  it('caps the number of samples it keeps', () => {
    const filler = Array.from(
      { length: 20 },
      (_, i) => `<p>Bijan Robinson enjoyed the ${i} hole golf course yesterday.</p>`,
    ).join('');
    const result = processNewsletter(
      { messageId: 'c3', from: SENDER, subject: 'x', receivedAt: '2026-08-13T12:00:00.000Z', html: filler, text: null },
      TEST_INDEX,
      { maxSamples: 3 },
    );
    expect(result.coverage.samples.length).toBeLessThanOrEqual(3);
  });

  it('counts ambiguous-identity sentences separately', () => {
    const result = processNewsletter(
      {
        messageId: 'c4',
        from: SENDER,
        subject: 'x',
        receivedAt: '2026-08-13T12:00:00.000Z',
        html: '<p>Chris Johnson was named the starter.</p>',
        text: null,
      },
      TEST_INDEX,
    );
    expect(result.coverage.ambiguousIdentitySentences).toBe(1);
  });
});
