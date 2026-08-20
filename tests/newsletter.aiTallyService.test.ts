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
import { AI_TALLY_RULE_ID, TALLY_PROTOCOL } from '../src/core/newsletter/aiTally.ts';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { CLEAN_NEWSLETTER } from './fixtures/newsletters.ts';

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
     * +2 arriving, and the parser's own +1 for the same player in the same
     * issue stopping — so the honest move is +1, not +2. Advertising the
     * arrival alone would promise a number the ledger will not show.
     */
    expect(preview.tallyDelta).toEqual([{ playerId: '9', playerName: 'Jordan Love', net: 1 }]);
    expect(preview.parserSuperseded).toHaveLength(1);
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

    const second = await service.applyAiTally(await stored(), paste);
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(2);
    expect(second.retired).toBe(0);
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
   * A newsletter's message id is shared with whatever the deterministic parser
   * found in it. Displacing the parser's reading of a player the tally scores
   * is deliberate; sweeping away its reading of everyone else would be the
   * import discarding evidence it never claimed to own.
   */
  it('a revised import leaves the parser rows it does not score alone', async () => {
    // Marvin Harrison Jr. is in the dictionary but not in this newsletter, so
    // nothing the parser wrote here is the tally's to displace.
    const parserRows = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).filter(
      (e) => e.ruleId !== AI_TALLY_RULE_ID,
    );
    expect(parserRows.length).toBeGreaterThan(0);

    await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +2 | First reading'));
    await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +1 | Revised down'));

    const after = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).filter(
      (e) => e.ruleId !== AI_TALLY_RULE_ID,
    );
    expect(after.map((e) => e.dedupeKey).sort()).toEqual(parserRows.map((e) => e.dedupeKey).sort());
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
    expect(outcome.parserSuperseded).toBe(1);

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
    expect(preview.parserSuperseded).toHaveLength(0);
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
    expect(preview.parserSuperseded).toHaveLength(0);

    await service.applyAiTally(await stored(), block(`${name} | +2 | The tally's reading`));
    const after = (await evidence.listByDedupeKeys([parser.dedupeKey])).get(parser.dedupeKey)!;
    expect(after.reviewStatus).toBe('corrected');
    expect(after.userOverride?.magnitude).toBe(3);
  });

  it('leaves alone a player the tally does not score', async () => {
    const untouched = (await evidence.listLiveBySourceMessage(MESSAGE_ID)).filter(
      (e) => e.ruleId !== AI_TALLY_RULE_ID,
    );
    // Marvin Harrison Jr. is in the dictionary but not in this newsletter.
    await service.applyAiTally(await stored(), block('Marvin Harrison Jr. | +2 | Unrelated to this issue'));
    const after = await evidence.listLiveBySourceMessage(MESSAGE_ID);
    for (const row of untouched) {
      expect(after.find((e) => e.id === row.id)?.reviewStatus).toBe(row.reviewStatus);
    }
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
});
