/**
 * A newsletter creates work waiting for a person, and never a fantasy opinion.
 *
 * This file is the corrective lane's own contract, and it is written around the
 * three questions the lane has to be able to answer out loud:
 *
 *   1. If a newsletter arrives tomorrow, can it change a player tally before a
 *      ChatGPT tally has been pasted and approved?
 *   2. Can the same newsletter ever count twice, because both the retired
 *      automatic path and the new tally path saw it?
 *   3. Once an issue is processed, does Setup go back to being clean until
 *      another one arrives?
 *
 * The answers have to be no / no / yes, and each of them is a test here rather
 * than a claim in a commit message. The second is the expensive one: a double
 * count is silent, permanent and lands in a ledger every recommendation in the
 * app reads.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AI_TALLY_RULE_ID, importAiTally } from '../src/core/newsletter/aiTally.ts';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { SetupService } from '../src/server/services/setupService.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import {
  LEGACY_ROWS,
  NEWSLETTER_SOURCES,
  newsletterMessage,
  seedLegacyClassifierRows,
  tallyBlock,
} from './helpers/newsletter.ts';
import { CLEAN_NEWSLETTER } from './fixtures/newsletters.ts';

const MESSAGE_ID = 'msg-1';

/** The counted lifetime net for one player, straight from the ledger. */
async function netOf(evidence: EvidenceRepo, playerId: string): Promise<number> {
  return (await evidence.refreshSignal(playerId, {})).raw.net;
}

describe('a newsletter arriving', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;
  let evidence: EvidenceRepo;
  let messages: NewsletterRepo;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    evidence = new EvidenceRepo(db);
    messages = new NewsletterRepo(db);
    await service.setSources(NEWSLETTER_SOURCES);
  });

  const stored = async (id = MESSAGE_ID) => (await service.storedMessage(id))!;

  // ------------------------------------------------------------ ingestion ---

  it('stores the issue and its text, and scores nothing', async () => {
    const outcome = await service.ingest(newsletterMessage());

    expect(outcome.status).toBe('processed');
    expect(outcome.evidenceInserted).toBe(0);
    expect(outcome.identityReviews).toBe(0);
    // Not one row of any kind, at any status. `pending` would count as scoring
    // too: it puts an item in Review, which is the burden this lane retires.
    expect(await evidence.countAll()).toBe(0);
    expect(await evidence.pendingCount()).toBe(0);
    expect(await messages.pendingIdentityCount()).toBe(0);

    // ...and the article is there to hand over.
    const source = await service.chatSource(await stored());
    expect(source).toContain('Bijan Robinson was named the starter');
  });

  it('creates durable pending-tally work that survives a fresh read', async () => {
    await service.ingest(newsletterMessage());

    // Read through a repo built from scratch: nothing in memory is carrying it.
    const next = await new NewsletterRepo(db).nextAwaitingTally();
    expect(next?.messageId).toBe(MESSAGE_ID);
    expect(next?.tallyState).toBe('awaiting');
    expect(next?.talliedAt).toBeNull();
    expect(await new NewsletterRepo(db).awaitingTallyCount()).toBe(1);
  });

  it('does not ask for attention for mail it cannot hand over', async () => {
    await service.ingest(
      toEmailMessage({ messageId: 'spam', from: 'nobody@elsewhere.example', subject: 'hi', html: '<p>x</p>' }),
    );
    expect(await messages.awaitingTallyCount()).toBe(0);
    expect((await messages.lastReceived())?.tallyState).toBe('not_applicable');
  });

  /**
   * One at a time, oldest first.
   *
   * A running tally is cumulative, so scoring this week before last week would
   * be reading the season backwards. The policy is explicit rather than
   * emergent, and nothing anywhere combines two issues into one paste.
   */
  it('works a backlog oldest first, one issue at a time', async () => {
    await service.ingest(newsletterMessage(CLEAN_NEWSLETTER, 'older'));
    await service.ingest(
      toEmailMessage({
        messageId: 'newer',
        from: 'editor@ffnewsletter.example',
        subject: 'Later issue',
        date: '2026-08-20T12:00:00.000Z',
        html: '<p>Puka Nacua returned to full participation.</p>',
      }),
    );

    const pending = await service.pendingTally();
    expect(pending?.messageId).toBe('older');
    expect(pending?.waiting).toBe(2);

    await service.applyAiTally(await stored('older'), tallyBlock('Puka Nacua | +1 | Back at practice.'));
    expect((await service.pendingTally())?.messageId).toBe('newer');
    expect((await service.pendingTally())?.waiting).toBe(1);
  });

  // ------------------------------------------------------ the approval gate ---

  it('previews without touching the ledger, and cancelling changes nothing', async () => {
    await service.ingest(newsletterMessage());
    const before = await evidence.countAll();

    const preview = await service.previewAiTally(
      await stored(),
      tallyBlock('Bijan Robinson | +2 | Named the starter and taking every first-team rep.'),
    );
    expect(preview.ready).toHaveLength(1);
    expect(preview.tallyDelta).toEqual([{ playerId: '10', playerName: 'Bijan Robinson', net: 2 }]);

    // Cancelling is doing nothing at all — there is no second call to make.
    expect(await evidence.countAll()).toBe(before);
    expect((await messages.seen(MESSAGE_ID))?.tallyState).toBe('awaiting');
  });

  it('refuses a paste that is not a tally, and completes nothing', async () => {
    await service.ingest(newsletterMessage());
    const outcome = await service.applyAiTally(await stored(), 'here are my thoughts on the week');

    expect(outcome.completed).toBe(false);
    expect(outcome.detail).toContain('NEWSLETTER_TALLY_V1');
    expect(await evidence.countAll()).toBe(0);
    expect((await messages.seen(MESSAGE_ID))?.tallyState).toBe('awaiting');
  });

  it('never guesses a name it cannot resolve', async () => {
    await service.ingest(newsletterMessage());
    // Two fixture players are called Chris Johnson.
    await service.applyAiTally(await stored(), tallyBlock('Chris Johnson | +2 | Won the job outright'));

    expect(await netOf(evidence, '1')).toBe(0);
    expect(await netOf(evidence, '2')).toBe(0);
    const review = (await messages.listIdentityReviews()).find((r) => r.matchedText === 'Chris Johnson');
    expect(review?.candidates.length).toBeGreaterThan(1);
    // The score is carried at its real size, so confirming who this is recovers
    // the decision rather than a flattened stand-in for it.
    expect(review?.proposedMagnitude).toBe(2);
  });

  it('applies exactly what the preview promised, and no more', async () => {
    await service.ingest(newsletterMessage());
    const paste = tallyBlock(
      'Bijan Robinson | +2 | Named the starter.',
      'Puka Nacua | -1 | Missed Wednesday.',
      'Jordan Love | +1 | Expected to play.',
    );
    const preview = await service.previewAiTally(await stored(), paste);
    const promised = new Map(preview.tallyDelta.map((d) => [d.playerId, d.net]));

    await service.applyAiTally(await stored(), paste);

    for (const [playerId, net] of promised) {
      expect(`${playerId}: ${await netOf(evidence, playerId)}`).toBe(`${playerId}: ${net}`);
    }
    // Nobody the tally did not name moved.
    expect(await netOf(evidence, '7')).toBe(0);
  });

  /**
   * An approved tally that scores nobody still finishes the issue.
   *
   * A quiet week is the commonest answer there is, and if completing an issue
   * needed something to change, that answer would leave a newsletter asking for
   * attention that could never be given. What completes it is the approval, not
   * the size of the move.
   */
  it('completes an issue whose approved tally scores nobody', async () => {
    await service.ingest(newsletterMessage());
    const outcome = await service.applyAiTally(await stored(), tallyBlock());

    expect(outcome.completed).toBe(true);
    expect(outcome.inserted).toBe(0);
    expect(await evidence.countAll()).toBe(0);
    expect(await messages.awaitingTallyCount()).toBe(0);
  });

  // ------------------------------------------------------------ exactly once ---

  describe('exactly once', () => {
    const PASTE = tallyBlock('Bijan Robinson | +2 | Named the starter and taking first-team reps.');

    beforeEach(async () => {
      await service.ingest(newsletterMessage());
    });

    it('applies the same paste twice as one application', async () => {
      const first = await service.applyAiTally(await stored(), PASTE);
      expect(first.inserted).toBe(1);
      expect(first.replayed).toBe(false);

      const second = await service.applyAiTally(await stored(), PASTE);
      expect(second.replayed).toBe(true);
      expect(second.inserted).toBe(0);
      expect(await netOf(evidence, '10')).toBe(2);
      expect(await evidence.countAll()).toBe(1);
    });

    /**
     * The double tap: two requests in flight at once, neither aware of the
     * other, neither able to see the other's writes yet.
     *
     * What is asserted is the ledger, not which of the two reported a replay.
     * Whether the second call recognises the first depends on how far along it
     * was, and that is a race by definition — but the ledger is not allowed to
     * be: one row, at its own size, however the two interleave. That guarantee
     * comes from the row keys underneath rather than from the claim above them,
     * which is exactly why it holds either way.
     */
    it('survives two applies racing on the same paste', async () => {
      await Promise.all([
        service.applyAiTally(await stored(), PASTE),
        service.applyAiTally(await stored(), PASTE),
      ]);
      expect(await netOf(evidence, '10')).toBe(2);
      expect(await evidence.countAll()).toBe(1);
    });

    /**
     * An apply that never reported back is unfinished, not applied.
     *
     * The claim is written before the work so that two requests cannot both
     * think they are first — which means a crash between the two leaves a claim
     * standing over an empty ledger. Refusing the retry there would be the worst
     * of both: the person is told their tally is in, and none of it is.
     */
    it('lets a retry finish an apply that died half-way', async () => {
      const fingerprint = importAiTally(PASTE, await new PlayerRepo(db).buildIndex(), {
        sourceMessageId: MESSAGE_ID,
        sourceDate: '2026-08-13T12:00:00.000Z',
      }).payloadFingerprint!;
      // Exactly what a crash after the claim and before the writes leaves.
      await messages.claimTallyApplication(MESSAGE_ID, fingerprint, '2026-08-13T12:00:00.000Z');

      const retry = await service.applyAiTally(await stored(), PASTE);
      expect(retry.replayed).toBe(false);
      expect(retry.inserted).toBe(1);
      expect(await netOf(evidence, '10')).toBe(2);

      // ...and the next repeat is a replay again, as it should be.
      expect((await service.applyAiTally(await stored(), PASTE)).replayed).toBe(true);
      expect(await netOf(evidence, '10')).toBe(2);
    });

    /**
     * A retry after an ambiguous response. The caller never saw the first
     * answer, so it asks again — and gets the first answer rather than a
     * second application.
     */
    it('answers a retry with what the first application did', async () => {
      await service.applyAiTally(await stored(), PASTE);
      const retry = await service.applyAiTally(await stored(), PASTE);
      expect(retry.detail).toContain('already applied');
      expect(retry.completed).toBe(true);
      expect(await netOf(evidence, '10')).toBe(2);
    });

    /**
     * The one repeat that is not a repeat: pasting an earlier tally after a
     * correction is a revision back to it, and has to bring back what the
     * correction retired.
     */
    it('lets an earlier tally be restored after a correction', async () => {
      const revised = tallyBlock('Bijan Robinson | +1 | On reflection, milder.');
      await service.applyAiTally(await stored(), PASTE);
      await service.applyAiTally(await stored(), revised);
      expect(await netOf(evidence, '10')).toBe(1);

      const back = await service.applyAiTally(await stored(), PASTE);
      expect(back.replayed).toBe(false);
      expect(await netOf(evidence, '10')).toBe(2);
      // Still one counted row, whichever way it has been revised.
      const counted = (await evidence.listForPlayer('10')).filter((e) => e.reviewStatus === 'auto_applied');
      expect(counted).toHaveLength(1);
    });
  });

  // ------------------------------------- the newsletter the old path touched ---

  /**
   * The regression fixture for the issue already in production.
   *
   * It arrived under the retired path and produced three automatic signals.
   * Pasting its intended ChatGPT tally must leave the approved result standing
   * once — not the approved result on top of what the classifier guessed.
   */
  describe('an issue the retired classifier already scored', () => {
    beforeEach(async () => {
      await service.ingest(newsletterMessage());
      await seedLegacyClassifierRows(evidence, MESSAGE_ID, LEGACY_ROWS);
    });

    it('leaves the approved result standing exactly once', async () => {
      // What the old path left behind, counting.
      expect(await netOf(evidence, '10')).toBe(1);
      expect(await netOf(evidence, '11')).toBe(-1);
      expect(await netOf(evidence, '9')).toBe(1);

      await service.applyAiTally(
        await stored(),
        tallyBlock(
          'Bijan Robinson | +2 | Named the starter and taking every first-team rep.',
          'Puka Nacua | -2 | Out of practice all week and no date on his return.',
        ),
      );

      // The tally's numbers, and only the tally's numbers.
      expect(await netOf(evidence, '10')).toBe(2);
      expect(await netOf(evidence, '11')).toBe(-2);
      // A player the tally deliberately omitted scores nothing at all, rather
      // than keeping the classifier's automatic +1.
      expect(await netOf(evidence, '9')).toBe(0);

      // Exactly one counted row per player from this issue, and it is the
      // imported one.
      for (const playerId of ['10', '11']) {
        const counted = (await evidence.listForPlayer(playerId))
          .filter((e) => e.sourceMessageId === MESSAGE_ID)
          .filter((e) => ['auto_applied', 'accepted', 'corrected'].includes(e.reviewStatus));
        expect(`${playerId}: ${counted.length}`).toBe(`${playerId}: 1`);
        expect(counted[0]?.ruleId).toBe(AI_TALLY_RULE_ID);
      }
    });

    it('retires the classifier rows rather than deleting them', async () => {
      await service.applyAiTally(await stored(), tallyBlock('Bijan Robinson | +2 | Named the starter.'));
      const legacy = (await evidence.listForPlayer('10')).find((e) => e.ruleId === 'legacy-classifier')!;
      expect(legacy.reviewStatus).toBe('ignored');
      expect(legacy.excerpt).toBe(LEGACY_ROWS[0]!.excerpt);
    });

    it('never overrules a decision the user already made about a classifier row', async () => {
      const mine = (await evidence.listForPlayer('9')).find((e) => e.ruleId === 'legacy-classifier')!;
      await evidence.applyReview(Number(mine.id), 'accept', null);

      await service.applyAiTally(await stored(), tallyBlock('Bijan Robinson | +2 | Named the starter.'));

      const after = await evidence.getById(Number(mine.id));
      expect(after?.reviewStatus).toBe('accepted');
      expect(await netOf(evidence, '9')).toBe(1);
    });
  });

  // ------------------------------------------------------- derived consumers ---

  /**
   * An approved score has to reach the numbers every screen actually reads, at
   * the size it was written. A ±2 that arrives as a ±1 is a quieter kind of
   * wrong than a double count and just as hard to notice.
   */
  it('reaches the derived signal at the size it was scored', async () => {
    await service.ingest(newsletterMessage());
    await service.applyAiTally(
      await stored(),
      tallyBlock('Bijan Robinson | +2 | Named the starter.', 'Puka Nacua | -2 | Out all week.'),
    );

    const signals = await evidence.getSignals(['10', '11'], { now: '2026-08-14T00:00:00.000Z' });
    expect(signals.get('10')?.raw.net).toBe(2);
    expect(signals.get('11')?.raw.net).toBe(-2);
    // A tally row is one issue's reading of one player and its date is when that
    // news happened, so it belongs in the recency windows.
    expect(signals.get('10')?.last30.net).toBe(2);
  });
});

describe('what Setup and Data Health say about it', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;

  const setup = () => new SetupService(db, new MockVegasProvider([]), 'inbound@example.test');

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    await service.setSources(NEWSLETTER_SOURCES);
  });

  it('marks the newsletter step while an issue waits, and clears when it is scored', async () => {
    expect((await setup().newsletterStatus()).pendingTally).toBeNull();

    await service.ingest(newsletterMessage());
    const waiting = await setup().newsletterStatus();
    expect(waiting.pendingTally?.messageId).toBe(MESSAGE_ID);
    expect(waiting.pendingTally?.waiting).toBe(1);

    await service.applyAiTally(
      (await service.storedMessage(MESSAGE_ID))!,
      tallyBlock('Bijan Robinson | +2 | Named the starter.'),
    );

    // Back to clean, until another one arrives.
    expect((await setup().newsletterStatus()).pendingTally).toBeNull();
    await service.ingest(
      toEmailMessage({
        messageId: 'next-week',
        from: 'editor@ffnewsletter.example',
        subject: 'Next issue',
        date: '2026-08-20T12:00:00.000Z',
        html: '<p>Something happened.</p>',
      }),
    );
    expect((await setup().newsletterStatus()).pendingTally?.messageId).toBe('next-week');
  });

  /**
   * Waiting for a person is not a broken feed.
   *
   * Delivery freshness and pending human work are different questions with
   * different answers, and conflating them would train the reader to ignore the
   * word "degraded" on the day something has genuinely stopped arriving.
   */
  it('does not call an unscored issue a data-health problem', async () => {
    await service.ingest(newsletterMessage());
    const view = await new DataHealthService(db, {
      vegas: new MockVegasProvider([]),
      releaseSha: null,
    }).view();
    const row = view.sources.find((s) => s.id === 'newsletter')!;

    // Delivery is what health measures, and delivery just happened.
    expect(row.state).toBe('current');
    // A healthy row says nothing, so the pending work does not become a
    // headline on a screen about whether the pipelines are working. It is a
    // diagnostic, and it lives where diagnostics live.
    expect(row.note).toBeNull();
    expect(row.technical.note).toContain('work for you');
  });
});
