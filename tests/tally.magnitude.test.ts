/**
 * Imported tally rows keep the score that was written down.
 *
 * A row in the hand-maintained tally is not a sentence — it is a net score
 * covering several issues that somebody already decided. "JSN +11" is worth
 * eleven, and the two ways the app used to lose that are both regressions worth
 * a permanent test:
 *
 *  1. the row's name did not resolve, so confirming who it was created a ±1
 *     stand-in and ten of the eleven points vanished;
 *  2. re-importing after that confirmation wrote the real row alongside the
 *     stand-in, counting the same score twice.
 *
 * Both are checked here against the actual document in the repository, not a
 * fixture, so a change to either the file or the importer has to stay honest.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlayerIndex } from '../src/core/identity/index.ts';
import { groupUnresolved, suspiciousZeroBoosts } from '../src/core/identity/repair.ts';
import { importTally } from '../src/core/newsletter/tally.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { RepairService } from '../src/server/services/repairService.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const DOC = readFileSync(
  fileURLToPath(new URL('../data/imports/2026-08-13-tally-r1-r4.md', import.meta.url)),
  'utf8',
);

/** Exactly what `import-tally.yml` sends. */
const IMPORT = {
  sourceName: 'FF Newsletter tally (issues 1-4)',
  sourceDate: '2026-08-13T00:00:00.000Z',
  sourceMessageId: 'tally:data/imports/2026-08-13-tally-r1-r4.md',
};

/**
 * The reference totals from the handoff brief.
 *
 * These are reconciliation checks, not the definition: they are read straight
 * from the document, so if the file changes the expectation moves with it.
 */
const REFERENCE: Record<string, number> = {
  'Puka Nacua': 13,
  'Josh Allen': 10,
  'Jahmyr Gibbs': 9,
  'Jonathan Taylor': 7,
  'Jalen Hurts': 7,
  'Sam LaPorta': 6,
  'Trevor Lawrence': 6,
  "De'Von Achane": 6,
  "D'Andre Swift": 6,
  'Kyle Pitts': -5,
  'Chuba Hubbard': -4,
};

const ROSTER = [
  // Deliberately WITHOUT a "JSN" alias: the point of the test is what happens
  // when the name has to be confirmed by a human first.
  player({ id: 'jsn', fullName: 'Jaxon Smith-Njigba', team: 'SEA', position: 'WR' }),
  ...Object.keys(REFERENCE).map((name, i) =>
    player({ id: `ref-${i}`, fullName: name, team: 'FA', position: 'WR' }),
  ),
];

const ID_BY_NAME = new Map(ROSTER.map((p) => [p.fullName, p.id]));

async function netOf(db: NodeSqliteDatabase, name: string): Promise<number> {
  const id = ID_BY_NAME.get(name)!;
  return (await new EvidenceRepo(db).getSignals([id])).get(id)?.raw.net ?? 0;
}

describe('an imported tally row keeps its own score', () => {
  it('carries the row score as the item magnitude, not ±1', () => {
    const result = importTally(DOC, new PlayerIndex(ROSTER), IMPORT);
    for (const [name, score] of Object.entries(REFERENCE)) {
      const item = result.evidence.find((e) => e.playerName === name);
      expect(item, `${name} should have matched`).toBeDefined();
      expect(item!.magnitude, `${name} magnitude`).toBe(Math.abs(score));
      expect(item!.polarity).toBe(score > 0 ? 'positive' : 'negative');
    }
  });

  it('carries the score onto an unresolved row too, so confirming it can recover it', () => {
    const result = importTally(DOC, new PlayerIndex(ROSTER), IMPORT);
    const jsn = result.identityReviews.find((r) => r.matchedText === 'JSN');
    expect(jsn, 'JSN should be waiting for a human').toBeDefined();
    expect(jsn!.proposedMagnitude).toBe(11);
    expect(jsn!.proposedPolarity).toBe('positive');
  });

  it('reports what an unresolved name is actually costing, weighted by score', () => {
    const result = importTally(DOC, new PlayerIndex(ROSTER), IMPORT);
    const groups = groupUnresolved(
      result.identityReviews.map((r, id) => ({ id, ...r })),
      IMPORT.sourceDate,
    );
    const jsn = groups.find((g) => g.alias === 'JSN');
    // One row, worth eleven — not one row worth one.
    expect(jsn?.items).toBe(1);
    expect(jsn?.net).toBe(11);
  });

  it('flags a single high-scoring alias whose likeliest owner has nothing', () => {
    const suspicions = suspiciousZeroBoosts(
      [
        {
          alias: 'JSN',
          normalizedAlias: 'jsn',
          reviewIds: [1],
          items: 1,
          net: 11,
          net30: 11,
          example: 'JSN +11',
          candidates: [{ playerId: 'jsn', name: 'Jaxon Smith-Njigba', team: 'SEA', position: 'WR', detail: '' }],
        },
      ],
      new Map([['jsn', 0]]),
    );
    expect(suspicions).toHaveLength(1);
    expect(suspicions[0]!.net).toBe(11);
  });
});

describe('the imported tally, end to end', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(ROSTER);
    service = new NewsletterService(db);
  });

  it('reconciles against the reference totals', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    for (const [name, score] of Object.entries(REFERENCE)) {
      expect(await netOf(db, name), `${name} lifetime tally`).toBe(score);
    }
  });

  it('puts the AVOID threshold within reach of an imported row', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    // AVOID is defined at lifetime <= -5. A flattened row could never get there.
    expect(await netOf(db, 'Kyle Pitts')).toBeLessThanOrEqual(-5);
  });

  it('gives a confirmed name its full score, not a ±1 stand-in', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    expect(await netOf(db, 'Jaxon Smith-Njigba')).toBe(0);

    const result = await new RepairService(db).assign('JSN', 'jsn');
    expect(result.net).toBe(11);
    expect(await netOf(db, 'Jaxon Smith-Njigba')).toBe(11);
  });

  it('counts a confirmed score once when the document is imported again', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    await new RepairService(db).assign('JSN', 'jsn');

    // The alias now resolves on its own, so this import writes the real row.
    // The ±1 stand-in written when the name was confirmed must give way to it
    // rather than be counted alongside it.
    const second = await service.importTallyDocument(DOC, IMPORT);
    expect(second.superseded.map((s) => s.playerId)).toContain('jsn');
    expect(await netOf(db, 'Jaxon Smith-Njigba')).toBe(11);
  });

  it('produces the same totals however many times it is run', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    await new RepairService(db).assign('JSN', 'jsn');
    await service.importTallyDocument(DOC, IMPORT);
    const third = await service.importTallyDocument(DOC, IMPORT);

    expect(third.inserted).toBe(0);
    expect(third.superseded).toHaveLength(0);
    expect(await netOf(db, 'Jaxon Smith-Njigba')).toBe(11);
    for (const [name, score] of Object.entries(REFERENCE)) {
      expect(await netOf(db, name), `${name} after three imports`).toBe(score);
    }
  });

  it('windows the score by the date on the document, not the date it was imported', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    await new RepairService(db).assign('JSN', 'jsn');
    await service.importTallyDocument(DOC, IMPORT);

    const repo = new EvidenceRepo(db);
    // Three days after the document: inside the 30-day window.
    let signal = await repo.refreshSignal('jsn', { now: '2026-08-16T00:00:00.000Z' });
    expect(signal.raw.net).toBe(11);
    expect(signal.last30.net).toBe(11);

    // Ten days after: out of the 7-day window, still inside 30.
    signal = await repo.refreshSignal('jsn', { now: '2026-08-23T00:00:00.000Z' });
    expect(signal.raw.net).toBe(11);
    expect(signal.last7.net).toBe(0);
    expect(signal.last30.net).toBe(11);

    // Sixty days after: lifetime only.
    signal = await repo.refreshSignal('jsn', { now: '2026-10-12T00:00:00.000Z' });
    expect(signal.raw.net).toBe(11);
    expect(signal.last30.net).toBe(0);
  });

  /**
   * The same principle, one level further down.
   *
   * The assertion this replaces read `last7 === 11` three days after the
   * document, which looks right and is the very confusion the test's own title
   * objects to. `2026-08-13` is not when JSN earned eleven points — it is the
   * day somebody finished adding up issues one to four. The document's date is
   * the *end* of the period it describes, so it dates the row without dating
   * the news, and seven days cannot hold four issues.
   *
   * Thirty days can, which is why the assertions above are untouched.
   */
  it('never counts a carried tally as this week, however fresh the import', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    const repo = new EvidenceRepo(db);

    // The day after the document, when the row is as fresh as it will ever be.
    const signal = await repo.refreshSignal(ID_BY_NAME.get('Puka Nacua')!, {
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(signal.last7.net).toBe(0);
    expect(signal.last7.items).toBe(0);
    // Every point is still on the record, and still inside the month.
    expect(signal.raw.net).toBe(13);
    expect(signal.last30.net).toBe(13);
    expect(signal.carriedOverItems).toBe(1);
  });

  it('leaves an item the user corrected exactly as they set it', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    await new RepairService(db).assign('JSN', 'jsn');

    const repo = new EvidenceRepo(db);
    const stand = (await repo.listForPlayer('jsn')).find((e) => e.ruleId === 'user_identity_repair')!;
    await repo.applyReview(Number(stand.id), 'correct', { magnitude: 4 });

    const second = await service.importTallyDocument(DOC, IMPORT);
    expect(second.keptForUserOverride.map((k) => k.playerId)).toContain('jsn');

    // The user's 4 stands, and the document's own row is counted too — the
    // import never silently overrules a decision a person made.
    const after = await repo.refreshSignal('jsn');
    expect(after.raw.net).toBe(15);
  });

  it('does not touch evidence belonging to another source', async () => {
    await service.importTallyDocument(DOC, IMPORT);
    const repo = new EvidenceRepo(db);
    await repo.insertProposed([
      {
        dedupeKey: 'unrelated-1',
        playerId: 'jsn',
        playerName: 'Jaxon Smith-Njigba',
        sourceType: 'newsletter',
        sourceName: 'A real newsletter',
        sourceMessageId: 'some-other-email',
        sourceDate: IMPORT.sourceDate,
        excerpt: 'Smith-Njigba ran a route on 92% of dropbacks.',
        contextSummary: null,
        category: 'usage',
        polarity: 'positive',
        magnitude: 2,
        confidence: 'high',
        confidenceScore: 0.9,
        ruleId: 'route-share',
        reviewStatus: 'auto_applied',
        notes: [],
        blockIndex: 0,
      },
    ]);
    await repo.refreshSignal('jsn');

    await service.importTallyDocument(DOC, IMPORT);
    expect((await repo.listForPlayer('jsn')).find((e) => e.dedupeKey === 'unrelated-1')?.reviewStatus).toBe(
      'auto_applied',
    );
    expect(await netOf(db, 'Jaxon Smith-Njigba')).toBe(2);
  });
});

describe('newsletter sentences are unaffected', () => {
  it('still scores a confirmed sentence at its own rule magnitude', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany(ROSTER);
    await new NewsletterRepo(db).insertIdentityReviews([
      {
        sourceMessageId: 'email-1',
        sourceDate: '2026-08-13T00:00:00.000Z',
        excerpt: 'JSN is dealing with a hamstring strain.',
        matchedText: 'JSN',
        reason: 'no candidate',
        candidates: [],
        proposedPolarity: 'negative',
        proposedCategory: 'injury',
        proposedMagnitude: 2,
      },
    ]);

    // Sentence-level scoring is untouched by the tally fix: the item is worth
    // what its rule said, which for this one is 2.
    const result = await new RepairService(db).assign('JSN', 'jsn');
    expect(result.net).toBe(-2);
  });
});
