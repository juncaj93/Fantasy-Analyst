/**
 * The ChatGPT tally import against a real ledger.
 *
 * The pure module decides what a pasted block means; this is about what
 * happens when that meets evidence already in the database — pasting twice,
 * pasting a correction, pasting something that agrees with a row the parser
 * already wrote, and pasting a name the user has since ruled on.
 *
 * Those are the ways an import quietly counts something twice, which is the
 * one failure the ledger cannot tolerate.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AI_TALLY_RULE_ID, ALLOWED_SCORES, TALLY_PROTOCOL } from '../src/core/newsletter/aiTally.ts';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { CLEAN_NEWSLETTER } from './fixtures/newsletters.ts';
import { LEGACY_ROWS, seedLegacyClassifierRows } from './helpers/newsletter.ts';

const SENDER = 'editor@ffnewsletter.example';
const SOURCES = [
  { id: 'ff', label: 'FF Newsletter', fromPatterns: ['@ffnewsletter.example'], subjectPatterns: [], enabled: true },
];
const MESSAGE_ID = 'ai-tally-issue';

const block = (...rows: string[]) => [TALLY_PROTOCOL, ...rows, 'END_NEWSLETTER_TALLY'].join('\n');

function inbound() {
  return toEmailMessage({
    messageId: MESSAGE_ID,
    from: SENDER,
    subject: 'Training Camp Notes',
    date: '2026-08-20T12:00:00.000Z',
    html: CLEAN_NEWSLETTER,
  });
}

describe('the ChatGPT tally import', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;
  let evidence: EvidenceRepo;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    evidence = new EvidenceRepo(db);
    await service.setSources(SOURCES);
    await service.ingest(inbound());
    /*
     * The issue arrives with the old path's rows already on it.
     *
     * Arrival writes nothing now, so a fixture built from ingestion alone would
     * have no classifier rows in it — and the reconciliation that stops those
     * rows counting beside the approved tally is the single most important
     * thing this file tests. It is exactly the production newsletter's shape:
     * three automatic signals, filed against this message id, that the tally
     * has to displace rather than stack on.
     */
    await seedLegacyClassifierRows(evidence, MESSAGE_ID, LEGACY_ROWS);
  });

  const stored = async () => (await service.storedMessage(MESSAGE_ID))!;

  // ------------------------------------------------------------- copy out ---
  it('hands over the newsletter as clean readable text', async () => {
    const source = await service.chatSource(await stored());
    expect(source.startsWith('NEWSLETTER_SOURCE_V1')).toBe(true);
    expect(source).toContain(`Message-ID: ${MESSAGE_ID}`);
    expect(source).toContain('Bijan Robinson was named the starter');
    // The delivery, not the article.
    expect(source).not.toMatch(/https?:|Unsubscribe|Privacy Policy|=E2=80|<[a-z]/i);
  });

  /**
   * ...and hands over the job with it.
   *
   * The block used to be the article alone, which worked only because it was
   * pasted into a thread that already knew what to do with it. That is a
   * standing instruction living in one conversation on one device, and a new
   * thread — or a different phone — gets an answer in a shape the importer
   * refuses. Every rule here is one the importer already enforces, so the
   * constants are read from the module rather than restated.
   */
  it('carries the rules the importer will hold the answer to', async () => {
    const source = await service.chatSource(await stored());

    // The exact protocol, so the answer comes back parseable.
    expect(source).toContain(TALLY_PROTOCOL);
    expect(source).toContain('END_NEWSLETTER_TALLY');
    expect(source).toContain('| score |');

    // The four scores it accepts, and nothing implying an open range.
    for (const score of ALLOWED_SCORES) {
      expect(source).toContain(score > 0 ? `+${score}` : String(score));
    }

    // The three semantics the ledger assumes and cannot check for itself.
    expect(source).toMatch(/one row per player/i);
    expect(source).toMatch(/leave a player out/i);
    expect(source).toMatch(/full names/i);

    // Instructions are not delivery either: no links, no markup.
    expect(source).not.toMatch(/https?:|<[a-z]/i);
  });

  // -------------------------------------------------------------- preview ---
  it('previews without writing anything', async () => {
    const before = await evidence.countAll();
    const preview = await service.previewAiTally(
      await stored(),
      block('Jordan Love | +2 | Full command of the offence'),
    );
    expect(preview.ready).toHaveLength(1);
    expect(preview.ready[0]).toMatchObject({ playerName: 'Jordan Love', score: 2 });
    /*
     * Everything the approved tally moves, including what it stops.
     *
     * +2 arrives for Love and the classifier's own +1 for him stops, so his
     * honest move is +1 rather than +2. The other two moves are the rest of the
     * classifier's reading of this issue coming off: the tally is the reading
     * of the *newsletter*, so a player it omits was omitted deliberately and an
     * automatic score for him cannot survive underneath it.
     *
     * Advertising only the arrival would promise a number the ledger will not
     * show — and leaving the other two counting is the double-hit this lane
     * exists to close.
     */
    expect(preview.tallyDelta).toEqual([
      { playerId: '9', playerName: 'Jordan Love', net: 1 },
      { playerId: '10', playerName: 'Bijan Robinson', net: -1 },
      { playerId: '11', playerName: 'Puka Nacua', net: 1 },
    ]);
    expect(preview.parserSuperseded).toHaveLength(3);
    expect(await evidence.countAll()).toBe(before);
  });

  it('refuses a paste that is not the protocol, and says so', async () => {
    const preview = await service.previewAiTally(await stored(), 'here are my thoughts on the week');
    expect(preview.protocolOk).toBe(false);
    expect(preview.error).toContain(TALLY_PROTOCOL);
    expect(preview.ready).toHaveLength(0);
  });

  it('separates ready, already-imported and needs-review', async () => {
    const paste = block(
      'Jordan Love | +2 | Full command of the offence',
      'Chris Johnson | +1 | Two players have this name',
      'Somebody Nobody | -1 | Not in the dictionary',
    );
    const first = await service.previewAiTally(await stored(), paste);
    expect(first.ready).toHaveLength(1);
    expect(first.ambiguous).toHaveLength(1);
    expect(first.unmatched).toHaveLength(1);
    expect(first.detail).toContain('2 need review');

    await service.applyAiTally(await stored(), paste);

    const second = await service.previewAiTally(await stored(), paste);
    expect(second.ready).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]?.alreadyImported).toBe(true);
    expect(second.detail).toContain('Nothing would change');
  });

  // ---------------------------------------------------------------- apply ---
  it('writes the score at the size it was given', async () => {
    const outcome = await service.applyAiTally(
      await stored(),
      block('Jordan Love | +2 | Full command of the offence', 'Tyler Boyd | -2 | Lost the job'),
    );
    expect(outcome.inserted).toBe(2);

    const love = (await evidence.listForPlayer('9')).find((e) => e.ruleId === AI_TALLY_RULE_ID)!;
    expect(love).toMatchObject({ polarity: 'positive', magnitude: 2, reviewStatus: 'auto_applied' });
    expect(love.excerpt).toBe('Full command of the offence');
    expect(love.sourceMessageId).toBe(MESSAGE_ID);

    const boyd = (await evidence.listForPlayer('7')).find((e) => e.ruleId === AI_TALLY_RULE_ID)!;
    expect(boyd).toMatchObject({ polarity: 'negative', magnitude: 2 });
  });

  it('reaches the derived signal, which is what every screen reads', async () => {
    await service.applyAiTally(await stored(), block('Jordan Love | +2 | Full command of the offence'));
    const signal = await evidence.refreshSignal('9', {});
    expect(signal.raw.net).toBeGreaterThanOrEqual(2);
  });

  it('sends an unresolved name to Review rather than guessing', async () => {
    await service.applyAiTally(await stored(), block('Chris Johnson | +2 | Won the job outright'));
    const reviews = await new NewsletterRepo(db).listIdentityReviews(50);
    const mine = reviews.find((r) => r.matchedText === 'Chris Johnson');
    expect(mine).toBeTruthy();
    expect(mine?.proposedMagnitude).toBe(2);
    expect(mine?.candidates.length).toBeGreaterThan(1);
  });

  // --------------------------------------------------------- idempotence ---
  it('pasting the same block twice adds nothing the second time', async () => {
    const paste = block('Jordan Love | +2 | Full command of the offence', 'Tyler Boyd | -1 | Split work');
    const first = await service.applyAiTally(await stored(), paste);
    expect(first.inserted).toBe(2);

    const before = await evidence.countAll();
    const signalBefore = (await evidence.refreshSignal('9', {})).raw.net;

    /*
     * Recognised as a replay, not merely survived as one.
     *
     * The server holds a durable record of which tally is standing for this
     * newsletter, so the second call writes nothing at all and says which day
     * the first one landed — rather than doing the whole import again and
     * truthfully reporting that it changed nothing. Nothing here depends on a
     * disabled button or on anything the browser remembers.
     */
    const second = await service.applyAiTally(await stored(), paste);
    expect(second.replayed).toBe(true);
    expect(second.inserted).toBe(0);
    expect(second.retired).toBe(0);
    expect(second.detail).toContain('already applied');
    expect(await evidence.countAll()).toBe(before);
    expect((await evidence.refreshSignal('9', {})).raw.net).toBe(signalBefore);
  });

  /**
   * A corrected tally replaces the one it corrects. Stacking them would leave
   * the ledger holding both readings of the same week.
   */
  it('a revised paste replaces the earlier one rather than stacking', async () => {
    await service.applyAiTally(await stored(), block('Jordan Love | +2 | Full command of the offence'));
    const revised = block('Jordan Love | +1 | On reflection, only a mild positive');

    const preview = await service.previewAiTally(await stored(), revised);
    expect(preview.ready).toHaveLength(1);
    expect(preview.wouldRetire).toHaveLength(1);
    expect(preview.wouldRetire[0]?.magnitude).toBe(2);
    // +1 arriving and +2 leaving is a net move of -1, not a fresh +1.
    expect(preview.tallyDelta).toEqual([{ playerId: '9', playerName: 'Jordan Love', net: -1 }]);

    const outcome = await service.applyAiTally(await stored(), revised);
    expect(outcome.inserted).toBe(1);
    expect(outcome.retired).toBe(1);

    const live = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).filter(
      (e) => e.ruleId === AI_TALLY_RULE_ID,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.magnitude).toBe(1);
    // Retired, not deleted.
    const all = (await evidence.listForPlayer('9')).filter((e) => e.ruleId === AI_TALLY_RULE_ID);
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.reviewStatus === 'ignored')).toHaveLength(1);
  });

  /**
   * The revision sweep is scoped to this import's own rows.
   *
   * Two different sweeps run when a tally is applied and they must not be
   * confused. The *revision* sweep retires rows an earlier paste of this same
   * tally wrote and this one no longer asks for — scoped by `rule_id` to the
   * import's own rows. The *displacement* below retires what the classifier
   * wrote for this issue, once, because the approved tally has replaced it.
   *
   * The property here is that revising a tally is not a second displacement:
   * the classifier's rows are already retired after the first apply, and the
   * second must not re-report them as though it had retired them again.
   */
  it('a revised import does not re-retire what the first one already displaced', async () => {
    const first = await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +2 | First reading'));
    expect(first.parserSuperseded).toBe(LEGACY_ROWS.length);

    const second = await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +1 | Revised down'));
    expect(second.parserSuperseded).toBe(0);
    expect(second.retired).toBe(1);

    // Retired, not deleted: every one of them is still in the ledger.
    const all = await evidence.listForPlayer('10');
    expect(all.filter((e) => e.sourceMessageId === MESSAGE_ID)).toHaveLength(1);
  });

  it('never overrules a correction the user made', async () => {
    await service.applyAiTally(await stored(), block('Jordan Love | +2 | Full command of the offence'));
    const mine = (await evidence.listForPlayer('9')).find((e) => e.ruleId === AI_TALLY_RULE_ID)!;
    await evidence.applyReview(Number(mine.id), 'correct', { polarity: 'negative', magnitude: 1 });

    const preview = await service.previewAiTally(
      await stored(),
      block('Jordan Love | +1 | Revised down'),
    );
    expect(preview.protectedByUser).toHaveLength(1);
    expect(preview.wouldRetire).toHaveLength(0);

    const outcome = await service.applyAiTally(await stored(), block('Jordan Love | +1 | Revised down'));
    expect(outcome.protectedByUser).toBe(1);
    expect(outcome.detail).toContain('left as you set them');

    const kept = (await evidence.listByDedupeKeys([mine.dedupeKey])).get(mine.dedupeKey);
    expect(kept?.reviewStatus).toBe('corrected');
    expect(kept?.userOverride?.polarity).toBe('negative');
  });

  // ----------------------------------------------- the authoritative layer ---
  /**
   * The double-count this design exists to prevent.
   *
   * A newsletter scored by hand has one semantic reading, and it is the
   * imported one. The parser's reading of the same player in the same issue
   * must stop counting rather than stacking underneath it — otherwise one
   * newsletter contributes twice for one player.
   */
  it('one newsletter cannot contribute both a parser score and its ChatGPT replacement', async () => {
    const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
      (e) => e.ruleId !== AI_TALLY_RULE_ID && e.polarity === 'positive' && !e.userOverride,
    )!;
    const name = TEST_PLAYERS.find((p) => p.id === parser.playerId)!.fullName;
    const before = (await evidence.refreshSignal(parser.playerId, {})).raw.net;

    const preview = await service.previewAiTally(await stored(), block(`${name} | +2 | The tally's reading`));
    expect(preview.parserSuperseded.map((r) => r.id)).toContain(parser.id);
    expect(preview.detail).toContain('counted once');
    // The advertised move already nets the parser row out.
    const promised = preview.tallyDelta.find((d) => d.playerId === parser.playerId)!.net;
    expect(promised).toBe(2 - parser.magnitude);

    const outcome = await service.applyAiTally(await stored(), block(`${name} | +2 | The tally's reading`));
    // All three of the classifier's rows for this issue, not just this player's:
    // the approved tally is the reading of the newsletter, whole.
    expect(outcome.parserSuperseded).toBe(LEGACY_ROWS.length);

    const rows = (await evidence.listForPlayer(parser.playerId)).filter(
      (e) => e.sourceMessageId === MESSAGE_ID,
    );
    const counted = rows.filter((e) => ['auto_applied', 'accepted', 'corrected'].includes(e.reviewStatus));
    // Exactly one row from this newsletter counts for this player, and it is
    // the imported one.
    expect(counted).toHaveLength(1);
    expect(counted[0]?.ruleId).toBe(AI_TALLY_RULE_ID);
    expect(counted[0]?.magnitude).toBe(2);

    // The parser's finding survives for audit, it simply stops contributing.
    const retired = rows.find((e) => e.id === parser.id)!;
    expect(retired.reviewStatus).toBe('ignored');
    expect(retired.excerpt).toBe(parser.excerpt);
    expect(retired.ruleId).toBe(parser.ruleId);

    // And the promise the preview made is the move the ledger actually shows.
    expect((await evidence.refreshSignal(parser.playerId, {})).raw.net).toBe(before + promised);
  });

  /**
   * Pointing the other way is a genuine question, not a duplicate: the parser
   * may have read a different sentence. Neither counted nor discarded.
   */
  it('parks a parser row that disagrees, rather than counting or discarding it', async () => {
    const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
      (e) => e.ruleId !== AI_TALLY_RULE_ID && e.polarity === 'positive' && !e.userOverride,
    )!;
    const name = TEST_PLAYERS.find((p) => p.id === parser.playerId)!.fullName;

    const preview = await service.previewAiTally(await stored(), block(`${name} | -1 | The other way`));
    expect(preview.parserNeedsReview.map((r) => r.id)).toContain(parser.id);
    // The contradicted row waits for a person; the rest of the classifier's
    // reading of the issue is simply retired, which is a different disposition
    // and has to stay one.
    expect(preview.parserSuperseded.map((r) => r.id)).not.toContain(parser.id);
    expect(preview.parserSuperseded).toHaveLength(LEGACY_ROWS.length - 1);
    expect(preview.detail).toContain('point the other way');

    const outcome = await service.applyAiTally(await stored(), block(`${name} | -1 | The other way`));
    expect(outcome.parserNeedsReview).toBe(1);

    const after = (await evidence.listByDedupeKeys([parser.dedupeKey])).get(parser.dedupeKey)!;
    expect(after.reviewStatus).toBe('pending');
    // Parked, not counted.
    const rows = (await evidence.listForPlayer(parser.playerId)).filter(
      (e) => e.sourceMessageId === MESSAGE_ID,
    );
    const counted = rows.filter((e) => ['auto_applied', 'accepted', 'corrected'].includes(e.reviewStatus));
    expect(counted.every((e) => e.ruleId === AI_TALLY_RULE_ID)).toBe(true);
  });

  it('never displaces a parser row the user has ruled on', async () => {
    const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
      (e) => e.ruleId !== AI_TALLY_RULE_ID && e.polarity === 'positive' && !e.userOverride,
    )!;
    await evidence.applyReview(Number(parser.id), 'correct', { polarity: 'positive', magnitude: 3 });
    const name = TEST_PLAYERS.find((p) => p.id === parser.playerId)!.fullName;

    const preview = await service.previewAiTally(await stored(), block(`${name} | +2 | The tally's reading`));
    expect(preview.ready[0]?.parserRows.map((r) => r.disposition)).toContain('protected');
    // Protected means untouched, not "nothing else happens": the classifier's
    // other rows for this issue still stop counting.
    expect(preview.parserSuperseded.map((r) => r.id)).not.toContain(parser.id);
    expect(preview.parserSuperseded).toHaveLength(LEGACY_ROWS.length - 1);

    await service.applyAiTally(await stored(), block(`${name} | +2 | The tally's reading`));
    const after = (await evidence.listByDedupeKeys([parser.dedupeKey])).get(parser.dedupeKey)!;
    expect(after.reviewStatus).toBe('corrected');
    expect(after.userOverride?.magnitude).toBe(3);
  });

  /**
   * A player the tally omits was omitted on purpose.
   *
   * This used to assert the opposite — that the classifier's reading of a player
   * the tally does not name survived — and that was the double-hit. The tally
   * protocol says explicitly to omit players whose meaningful signals cancel, so
   * silence about a player is a verdict of nothing rather than an absence of
   * one, and an automatic score for him cannot go on counting underneath it.
   *
   * Rows filed against *other* newsletters are untouched, which is what keeps
   * this scoped to one issue rather than to the ledger.
   */
  it('stops the classifier counting for a player the tally does not score', async () => {
    await seedLegacyClassifierRows(evidence, 'another-issue', [
      { playerId: '5', polarity: 'positive', magnitude: 2, excerpt: 'From a different week entirely.' },
    ]);

    await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +2 | Unrelated to this issue'));

    const mine = await evidence.listLiveBySourceMessage(MESSAGE_ID);
    expect(mine.filter((e) => e.ruleId !== AI_TALLY_RULE_ID)).toHaveLength(0);

    const elsewhere = await evidence.listLiveBySourceMessage('another-issue');
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]?.reviewStatus).toBe('auto_applied');
  });

  it('displacing is idempotent — running it again changes nothing', async () => {
    const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
      (e) => e.ruleId !== AI_TALLY_RULE_ID && e.polarity === 'positive' && !e.userOverride,
    )!;
    const name = TEST_PLAYERS.find((p) => p.id === parser.playerId)!.fullName;
    const paste = block(`${name} | +2 | The tally's reading`);

    await service.applyAiTally(await stored(), paste);
    const net = (await evidence.refreshSignal(parser.playerId, {})).raw.net;
    const count = await evidence.countAll();

    const again = await service.applyAiTally(await stored(), paste);
    expect(again.inserted).toBe(0);
    expect(again.parserSuperseded).toBe(0);
    expect(await evidence.countAll()).toBe(count);
    expect((await evidence.refreshSignal(parser.playerId, {})).raw.net).toBe(net);
  });

  /*
   * A substantially revised block pasted over an earlier one.
   *
   * Every way a player can differ between two readings of the same issue, in a
   * single import, because that is how a revision actually arrives — not one
   * case at a time. What has to hold across all of them is one sentence: the
   * newsletter's semantic reading is the newest one, counted once.
   *
   * The closing assertion is the one that matters. For every player the preview
   * names a number, and the ledger moves by exactly that number. A promise the
   * ledger does not keep is how a double count hides.
   */
  describe('a revised block over an earlier one', () => {
    // Players the newsletter itself never mentions, so these cases turn on the
    // revision rules alone and not on anything the parser found.
    const FIRST = block(
      'Marvin Harrison Jr. | +2 | Unchanged between the two readings',
      'Amon-Ra St. Brown | +1 | First reading, revised later',
      "D'Andre Swift | -2 | Dropped from the revised reading",
    );

    it('replaces every case cleanly and moves each score by exactly what it promised', async () => {
      // The parser's own reading of a player the revision scores...
      const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
        (e) => e.ruleId !== AI_TALLY_RULE_ID && e.polarity === 'positive' && e.playerId === '10',
      )!;
      // ...and one the user has ruled on, which nothing here may touch.
      const ruled = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
        (e) => e.ruleId !== AI_TALLY_RULE_ID && e.playerId === '9',
      )!;
      await evidence.applyReview(Number(ruled.id), 'correct', { polarity: 'positive', magnitude: 3 });

      await service.applyAiTally(await stored(), FIRST);

      const players = ['4', '5', '6', '3', '10', '9'];
      const before = new Map<string, number>();
      for (const id of players) before.set(id, (await evidence.refreshSignal(id, {})).raw.net);

      const revised = block(
        'Marvin Harrison Jr. | +2 | Unchanged between the two readings',
        'Amon-Ra St. Brown | +2 | Revised upward on a second look',
        'José Ramírez | -1 | New in the revised reading',
        'Bijan Robinson | +2 | The revision reads the same issue',
        'Jordan Love | +1 | The revision reads the same issue',
      );

      const preview = await service.previewAiTally(await stored(), revised);

      // Same player, same score, same words: one row, already counting.
      expect(preview.duplicates.map((r) => r.playerId)).toEqual(['4']);
      // Changed score, new player, and the two the parser also read.
      expect(preview.ready.map((r) => r.playerId).sort()).toEqual(['10', '5', '6', '9']);
      // The earlier +1 for St. Brown and the -2 for Swift, who the revision drops.
      expect(preview.wouldRetire.map((r) => r.playerId).sort()).toEqual(['3', '5']);
      /*
       * Robinson's classifier row stopped counting on the FIRST paste, not this
       * one — the approved tally speaks for the whole issue, so displacement
       * happens once, when the issue is first scored. By the time a revision
       * arrives there is nothing left to displace except the row the user
       * corrected, which nothing here may touch.
       */
      expect((await evidence.listByDedupeKeys([parser.dedupeKey])).get(parser.dedupeKey)?.reviewStatus).toBe(
        'ignored',
      );
      expect(preview.parserSuperseded).toHaveLength(0);
      expect(preview.protectedByUser).toHaveLength(0);
      expect(
        preview.ready.find((r) => r.playerId === '9')?.parserRows.map((p) => p.disposition),
      ).toEqual(['protected']);

      const outcome = await service.applyAiTally(await stored(), revised);
      expect(outcome.inserted).toBe(4);
      expect(outcome.alreadyPresent).toBe(1);
      expect(outcome.retired).toBe(2);
      expect(outcome.parserSuperseded).toBe(0);

      // Every number the preview promised is the number the ledger moved by.
      const promised = new Map(preview.tallyDelta.map((d) => [d.playerId, d.net]));
      for (const id of players) {
        const now = (await evidence.refreshSignal(id, {})).raw.net;
        expect(`${id}: ${now - before.get(id)!}`).toBe(`${id}: ${promised.get(id) ?? 0}`);
      }

      // A player dropped from the revision keeps its row, retired not deleted.
      const swift = (await evidence.listForPlayer('3')).filter((e) => e.sourceMessageId === MESSAGE_ID);
      expect(swift).toHaveLength(1);
      expect(swift[0]?.reviewStatus).toBe('ignored');

      // And nobody is counted twice by this newsletter, except where the user's
      // own correction stands beside the import — which the preview said.
      for (const id of players) {
        const counted = (await evidence.listForPlayer(id))
          .filter((e) => e.sourceMessageId === MESSAGE_ID)
          .filter((e) => ['auto_applied', 'accepted', 'corrected'].includes(e.reviewStatus));
        expect(`${id}: ${counted.length}`).toBe(`${id}: ${id === '9' ? 2 : counted.length && 1}`);
      }
    });

    /**
     * A row that is not counting cannot stop counting.
     *
     * The first paste parks the parser's row because it points the other way.
     * The second agrees with it, so the row is retired — but it has contributed
     * nothing since the first paste, so retiring it moves no score. Deriving
     * the move from polarity and magnitude instead of from what the row
     * actually contributes overstates it by exactly the parked magnitude.
     */
    it('promises a move only for rows that are actually counting', async () => {
      const parser = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).find(
        (e) => e.ruleId !== AI_TALLY_RULE_ID && e.playerId === '10',
      )!;
      expect(parser.polarity).toBe('positive');

      // Points the other way: the parser's row is parked, not retired.
      await service.applyAiTally(await stored(), block('Bijan Robinson | -1 | Reads the other way'));
      expect((await evidence.listByDedupeKeys([parser.dedupeKey])).get(parser.dedupeKey)?.reviewStatus)
        .toBe('pending');

      const before = (await evidence.refreshSignal('10', {})).raw.net;
      const revised = block('Bijan Robinson | +2 | Revised, and now it agrees');
      const preview = await service.previewAiTally(await stored(), revised);

      // +2 in, the earlier -1 out, and the parked parser row contributing
      // nothing either way: +3, not +3 plus a magnitude that was never counted.
      expect(preview.tallyDelta).toEqual([{ playerId: '10', playerName: 'Bijan Robinson', net: 3 }]);

      await service.applyAiTally(await stored(), revised);
      expect((await evidence.refreshSignal('10', {})).raw.net).toBe(before + 3);
    });

    /**
     * Reverting to an earlier reading.
     *
     * Inserts are keyed on the row's identity, so re-pasting a block whose rows
     * were written once and later retired inserts nothing — the keys are taken.
     * Without bringing those rows back the import would report them as already
     * present while they counted nothing, which is the failure hardest to
     * notice: the ledger says the score is there and the score is not.
     */
    it('brings back a row a later revision had retired, when a paste asks for it again', async () => {
      const first = block('Marvin Harrison Jr. | +2 | The first reading');
      await service.applyAiTally(await stored(), first);
      const afterFirst = (await evidence.refreshSignal('4', {})).raw.net;

      await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +1 | The second reading'));
      expect((await evidence.refreshSignal('4', {})).raw.net).toBe(afterFirst - 1);

      const preview = await service.previewAiTally(await stored(), first);
      expect(preview.reinstated.map((r) => r.playerId)).toEqual(['4']);
      expect(preview.duplicates).toHaveLength(0);
      expect(preview.tallyDelta).toEqual([{ playerId: '4', playerName: 'Marvin Harrison Jr.', net: 1 }]);

      const count = await evidence.countAll();
      const outcome = await service.applyAiTally(await stored(), first);
      expect(outcome.reinstated).toBe(1);
      expect(outcome.inserted).toBe(0);
      // Nothing was created to bring it back, and nothing was deleted to retire
      // the reading it replaces.
      expect(await evidence.countAll()).toBe(count);
      expect((await evidence.refreshSignal('4', {})).raw.net).toBe(afterFirst);

      const rows = (await evidence.listForPlayer('4')).filter((e) => e.sourceMessageId === MESSAGE_ID);
      expect(rows).toHaveLength(2);
      expect(rows.filter((e) => e.reviewStatus === 'auto_applied')).toHaveLength(1);
      expect(rows.filter((e) => e.reviewStatus === 'ignored')).toHaveLength(1);
    });

    it('reinstating is idempotent, and a rejection is not reinstated', async () => {
      const first = block('Marvin Harrison Jr. | +2 | The first reading');
      await service.applyAiTally(await stored(), first);
      await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +1 | The second reading'));
      await service.applyAiTally(await stored(), first);

      const net = (await evidence.refreshSignal('4', {})).raw.net;
      const again = await service.applyAiTally(await stored(), first);
      expect(again.reinstated).toBe(0);
      expect(again.inserted).toBe(0);
      expect((await evidence.refreshSignal('4', {})).raw.net).toBe(net);

      // A row the user rejected is out of reach: only what an import retired
      // can be un-retired by one.
      const live = (await evidence.listForPlayer('4')).find((e) => e.reviewStatus === 'auto_applied')!;
      await evidence.applyReview(Number(live.id), 'reject', null);
      await service.applyAiTally(await stored(), first);
      expect((await evidence.listByDedupeKeys([live.dedupeKey])).get(live.dedupeKey)?.reviewStatus)
        .toBe('rejected');
    });

    /**
     * Ignoring a row by hand leaves exactly the state an import leaves.
     *
     * Same `ignored` status, no override, and — if the import had retired it
     * once before — the same note. Nothing on the row distinguishes the two, so
     * eligibility asks the review history instead. Without that, a later paste
     * would quietly undo the user's decision.
     */
    it('does not reinstate a row the user retired by hand', async () => {
      const first = block('Marvin Harrison Jr. | +2 | The first reading');
      await service.applyAiTally(await stored(), first);
      await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +1 | The second reading'));

      // The row the first paste wrote: retired by the revision, and now the
      // user says they want it left out.
      const retired = (await evidence.listForPlayer('4')).find((e) => e.reviewStatus === 'ignored')!;
      await evidence.applyReview(Number(retired.id), 'ignore', null);

      const preview = await service.previewAiTally(await stored(), first);
      expect(preview.reinstated).toHaveLength(0);
      expect(preview.duplicates.map((r) => r.playerId)).toEqual(['4']);

      const outcome = await service.applyAiTally(await stored(), first);
      expect(outcome.reinstated).toBe(0);
      expect((await evidence.listByDedupeKeys([retired.dedupeKey])).get(retired.dedupeKey)?.reviewStatus)
        .toBe('ignored');
    });
  });
});
