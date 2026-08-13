/**
 * Help My Scores.
 *
 * The failure this exists to stop: a newsletter says good things about "JSN"
 * nine times, the matcher correctly refuses to guess who that is, and the
 * player's draft boost silently stays at zero. Confirming the name once has to
 * repair every item and actually move the tally — recording the decision
 * without creating the evidence is the bug, not the fix.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { groupUnresolved, repairSummary, suspiciousZeroBoosts } from '../src/core/identity/repair.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { RepairService } from '../src/server/services/repairService.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const NOW = '2026-08-13T00:00:00.000Z';

const review = (over: Partial<Parameters<typeof groupUnresolved>[0][number]> = {}) => ({
  id: 1,
  matchedText: 'JSN',
  excerpt: 'JSN is locked in as the number one target.',
  sourceDate: NOW,
  proposedPolarity: 'positive' as string | null,
  candidates: [{ playerId: 'jsn', name: 'Jaxon Smith-Njigba', team: 'SEA', position: 'WR', detail: 'alias' }],
  ...over,
});

describe('grouping unresolved names', () => {
  it('asks about a name once, not once per sentence', () => {
    const groups = groupUnresolved([review({ id: 1 }), review({ id: 2 }), review({ id: 3 })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ alias: 'JSN', items: 3, net: 3 });
    expect(groups[0]!.reviewIds).toEqual([1, 2, 3]);
  });

  it('treats different spellings of the same name as one question', () => {
    const groups = groupUnresolved([review({ id: 1, matchedText: 'JSN' }), review({ id: 2, matchedText: 'jsn' })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toBe(2);
  });

  it('counts negative news against the total and neutral news not at all', () => {
    const groups = groupUnresolved(
      [
        review({ id: 1, proposedPolarity: 'positive' }),
        review({ id: 2, proposedPolarity: 'negative' }),
        review({ id: 3, proposedPolarity: null }),
      ],
      NOW,
    );
    expect(groups[0]).toMatchObject({ items: 3, net: 0 });
  });

  it('separates what arrived in the last 30 days', () => {
    const groups = groupUnresolved(
      [review({ id: 1 }), review({ id: 2, sourceDate: '2026-01-01T00:00:00.000Z' })],
      NOW,
    );
    expect(groups[0]).toMatchObject({ net: 2, net30: 1 });
  });

  it('puts the biggest unassigned tally first', () => {
    const groups = groupUnresolved(
      [review({ id: 1, matchedText: 'Small' }), review({ id: 2, matchedText: 'Big' }), review({ id: 3, matchedText: 'Big' })],
      NOW,
    );
    expect(groups[0]!.alias).toBe('Big');
  });
});

describe('spotting a player who should have a tally and does not', () => {
  const groups = groupUnresolved([review({ id: 1 }), review({ id: 2 }), review({ id: 3 })], NOW);

  it('flags an alias carrying weight whose likeliest owner has none', () => {
    const found = suspiciousZeroBoosts(groups, new Map([['jsn', 0]]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ alias: 'JSN', net: 3, candidate: { name: 'Jaxon Smith-Njigba' } });
  });

  it('stays quiet when the candidate already has a tally of their own', () => {
    expect(suspiciousZeroBoosts(groups, new Map([['jsn', 6]]))).toEqual([]);
  });

  it('stays quiet about a single stray mention', () => {
    const one = groupUnresolved([review({ id: 1 })], NOW);
    expect(suspiciousZeroBoosts(one, new Map([['jsn', 0]]))).toEqual([]);
  });
});

describe('the summary Setup shows', () => {
  it('says what is missing, in plain language', () => {
    const groups = groupUnresolved([review({ id: 1 }), review({ id: 2 })], NOW);
    const summary = repairSummary(groups);
    expect(summary).toMatchObject({ names: 1, items: 2, net: 2 });
    expect(summary.headline).toContain('1 player name needs matching');
    expect(summary.headline).toContain('+2 net tally is not being counted');
  });

  it('says so when there is nothing to fix', () => {
    expect(repairSummary([]).headline).toContain('Every player name');
  });
});

// ------------------------------------------------------------- end to end ---
describe('confirming a name', () => {
  let db: NodeSqliteDatabase;
  let service: RepairService;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany([
      player({ id: 'jsn', fullName: 'Jaxon Smith-Njigba', team: 'SEA', position: 'WR' }),
    ]);
    const newsletter = new NewsletterRepo(db);
    for (let i = 0; i < 3; i++) {
      await newsletter.insertIdentityReviews([
        {
          sourceMessageId: `msg-${i}`,
          sourceDate: NOW,
          excerpt: `JSN keeps producing (${i}).`,
          matchedText: 'JSN',
          reason: 'no candidate',
          candidates: [{ playerId: 'jsn', name: 'Jaxon Smith-Njigba', team: 'SEA', position: 'WR', detail: 'alias' }],
          proposedPolarity: 'positive',
          proposedCategory: 'usage',
        },
      ]);
    }
    service = new RepairService(db);
  });

  /** The case the brief names as canonical. */
  it('moves the player’s tally, not just the review status', async () => {
    expect((await new EvidenceRepo(db).getSignals(['jsn'])).get('jsn')?.raw.net ?? 0).toBe(0);

    const result = await service.assign('JSN', 'jsn', { now: NOW });
    expect(result).toMatchObject({ resolved: 3, created: 3, net: 3 });

    const signal = (await new EvidenceRepo(db).getSignals(['jsn'])).get('jsn');
    expect(signal?.raw.net).toBe(3);
    expect(signal?.last30.net).toBe(3);
  });

  it('repairs every item under the name from one confirmation', async () => {
    await service.assign('JSN', 'jsn', { now: NOW });
    expect((await service.status(NOW)).groups).toEqual([]);
  });

  it('remembers the name so it resolves by itself next time', async () => {
    await service.assign('JSN', 'jsn', { now: NOW });
    const aliases = await new PlayerRepo(db).listAliases('jsn');
    expect(aliases.map((a) => a.alias)).toContain('JSN');
  });

  it('can be told not to remember', async () => {
    await service.assign('JSN', 'jsn', { remember: false, now: NOW });
    expect(await new PlayerRepo(db).listAliases('jsn')).toEqual([]);
  });

  /** Confirming twice must not double the tally. */
  it('is idempotent', async () => {
    await service.assign('JSN', 'jsn', { now: NOW });
    await expect(service.assign('JSN', 'jsn', { now: NOW })).rejects.toThrow(/no unresolved evidence/);
    expect((await new EvidenceRepo(db).getSignals(['jsn'])).get('jsn')?.raw.net).toBe(3);
  });

  it('refuses a player that does not exist', async () => {
    await expect(service.assign('JSN', 'nobody', { now: NOW })).rejects.toThrow(/not found/);
  });

  it('reports the unassigned tally before it is fixed', async () => {
    const status = await service.status(NOW);
    expect(status.summary).toMatchObject({ names: 1, items: 3, net: 3 });
    expect(status.suspicions[0]?.candidate.name).toBe('Jaxon Smith-Njigba');
  });
});
