/**
 * The newsletter takeaway, one fixture per case the brief names.
 *
 * The last test in this file is the one that matters most: the headline appears
 * and every number stays exactly where it was. A takeaway that moves a tally is
 * the same evidence counted twice.
 */

import { describe, expect, it } from 'vitest';
import { selectTakeaway } from '../src/core/evidence/takeaway.ts';
import { aggregatePlayerSignal } from '../src/core/evidence/aggregate.ts';
import type { EvidenceItem } from '../src/core/evidence/types.ts';

const NOW = new Date('2026-09-20T00:00:00.000Z');

let seq = 0;
function item(over: Partial<EvidenceItem> = {}): EvidenceItem {
  seq++;
  return {
    id: `e${seq}`,
    playerId: 'maye',
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: `m${seq}`,
    sourceDate: '2026-09-18',
    excerpt: 'Drake Maye is #1 in completion rate in the NFL over the last four weeks.',
    contextSummary: null,
    category: 'performance',
    polarity: 'positive',
    magnitude: 2,
    confidence: 'high',
    confidenceScore: 0.9,
    ruleId: 'r1',
    reviewStatus: 'auto_applied',
    userOverride: null,
    dedupeKey: `d${seq}`,
    createdAt: '2026-09-18T00:00:00.000Z',
    ...over,
  };
}

describe('newsletter takeaway (§15)', () => {
  it('lifts one clear supported fact', () => {
    const takeaway = selectTakeaway([item()], { now: NOW });
    expect(takeaway?.text).toBe('Drake Maye is #1 in completion rate in the NFL over the last four weeks.');
    expect(takeaway?.evidenceItemIds).toHaveLength(1);
    expect(takeaway?.sourceName).toBe('FF Newsletter');
  });

  it('collapses duplicate evidence instead of counting it as corroboration', () => {
    const republished = [
      item({ sourceName: 'FF Newsletter', sourceDate: '2026-09-18', sourceMessageId: 'm1' }),
      item({ sourceName: 'FF Newsletter', sourceDate: '2026-09-18', sourceMessageId: 'm1' }),
    ];
    const takeaway = selectTakeaway(republished, { now: NOW });
    expect(takeaway?.corroboration).toBe(1);
    expect(takeaway?.evidenceItemIds).toHaveLength(2);
  });

  it('rewards a fact two different issues actually repeated', () => {
    const once = selectTakeaway([item()], { now: NOW })!;
    const twice = selectTakeaway([item(), item({ sourceDate: '2026-09-11' })], { now: NOW })!;
    expect(twice.corroboration).toBe(2);
    expect(twice.alternatives).toHaveLength(0);
    expect(once.text).toBe(twice.text);
  });

  it('prefers a specific fact over generic praise', () => {
    const takeaway = selectTakeaway(
      [
        item({ excerpt: 'He looked sharp.', category: 'coach_comment' }),
        item({ excerpt: 'Leads the league with a 32% target share since week 1.', category: 'usage' }),
      ],
      { now: NOW },
    );
    expect(takeaway?.text).toContain('32% target share');
  });

  it('prefers the recent of two otherwise equal facts', () => {
    const takeaway = selectTakeaway(
      [
        item({ excerpt: 'Played 88% of snaps in week 1.', sourceDate: '2026-08-01', category: 'usage' }),
        item({ excerpt: 'Played 91% of snaps in week 3.', sourceDate: '2026-09-18', category: 'usage' }),
      ],
      { now: NOW },
    );
    expect(takeaway?.text).toContain('91%');
  });

  it('lets an important old fact still beat a trivial new one', () => {
    const takeaway = selectTakeaway(
      [
        item({ excerpt: 'Named the starter and taking every first-team rep.', sourceDate: '2026-09-01', category: 'role', magnitude: 3 }),
        item({ excerpt: 'Was a full participant in practice.', sourceDate: '2026-09-19', category: 'practice', magnitude: 1 }),
      ],
      { now: NOW },
    );
    expect(takeaway?.text).toContain('Named the starter');
  });

  it('quotes what the source said and never strengthens it', () => {
    const source = 'Ranked #1 in completion rate over the cited span.';
    const takeaway = selectTakeaway([item({ excerpt: source })], { now: NOW });
    expect(takeaway?.text).toBe(source);
    // No superlative appears that the source did not contain.
    expect(takeaway?.text).not.toContain('best');
    expect(takeaway?.text).not.toContain('elite');
  });

  it('picks the most decision-relevant of several competing facts', () => {
    const takeaway = selectTakeaway(
      [
        item({ excerpt: 'Scored two touchdowns on Sunday.', category: 'performance' }),
        item({ excerpt: 'Has taken over as the three-down back with 78% of snaps.', category: 'role' }),
        item({ excerpt: 'The coach called him a pro.', category: 'coach_comment' }),
      ],
      { now: NOW },
    );
    expect(takeaway?.text).toContain('three-down back');
    expect(takeaway?.alternatives.length).toBeGreaterThan(0);
  });

  it('lets a correction speak, and ignores a retraction', () => {
    const corrected = selectTakeaway(
      [
        item({
          reviewStatus: 'corrected',
          userOverride: { note: 'Actually the WR2, not the WR1.', polarity: 'negative', magnitude: 1 },
          category: 'depth_chart',
        }),
      ],
      { now: NOW },
    );
    expect(corrected?.text).toBe('Actually the WR2, not the WR1.');

    const retracted = selectTakeaway([item({ reviewStatus: 'rejected' }), item({ reviewStatus: 'ignored' })], { now: NOW });
    expect(retracted).toBeNull();
  });

  it('never quotes an item reassigned to a different player', () => {
    const takeaway = selectTakeaway(
      [item({ reviewStatus: 'corrected', userOverride: { playerId: 'someone_else' } })],
      { now: NOW, playerId: 'maye' },
    );
    expect(takeaway).toBeNull();
  });

  it('never quotes an item still awaiting review', () => {
    expect(selectTakeaway([item({ reviewStatus: 'pending' })], { now: NOW })).toBeNull();
  });

  it('will not let a mixed or neutral item explain a signed tally', () => {
    expect(selectTakeaway([item({ polarity: 'mixed' }), item({ polarity: 'neutral' })], { now: NOW })).toBeNull();
  });

  it('declines to trim a paragraph into a headline', () => {
    const paragraph = `${'He is having a fine season and the coaching staff is pleased with his development. '.repeat(3)}`;
    expect(selectTakeaway([item({ excerpt: paragraph })], { now: NOW })).toBeNull();
  });

  it('returns null when there is nothing useful to say', () => {
    expect(selectTakeaway([], { now: NOW })).toBeNull();
    expect(
      selectTakeaway([item({ excerpt: 'He looked good.', category: 'coach_comment', magnitude: 1, confidence: 'low' })], {
        now: NOW,
      }),
    ).toBeNull();
  });

  it('is deterministic across identical inputs in a different order', () => {
    const a = item({ excerpt: 'Took 71% of the snaps.', category: 'usage' });
    const b = item({ excerpt: 'Ran 42 routes, most on the team.', category: 'usage' });
    expect(selectTakeaway([a, b], { now: NOW })?.text).toBe(selectTakeaway([b, a], { now: NOW })?.text);
  });

  it('keeps provenance for the deeper evidence view', () => {
    const takeaway = selectTakeaway([item()], { now: NOW })!;
    expect(takeaway.evidenceItemIds.length).toBeGreaterThan(0);
    expect(takeaway.sourceDate).toBe('2026-09-18');
    expect(['extracted', 'templated']).toContain(takeaway.derivation);
  });

  it('the headline appears and every number stays exactly where it was', () => {
    /*
     * The scoring-safety pin. The takeaway explains the tally; the underlying
     * evidence has already been counted once by it, and this asserts the
     * headline adds nothing a second time.
     */
    const items = [
      item({ excerpt: 'Has taken over as the three-down back with 78% of snaps.', category: 'role', magnitude: 3 }),
      item({ excerpt: 'Scored two touchdowns on Sunday.', category: 'performance', magnitude: 1 }),
    ];
    const before = aggregatePlayerSignal('maye', items, { now: NOW });
    const takeaway = selectTakeaway(items, { now: NOW });
    const after = aggregatePlayerSignal('maye', items, { now: NOW });

    expect(takeaway).not.toBeNull();
    expect(takeaway!.scoreDelta).toBe(0);
    expect(after).toEqual(before);
    expect(after.raw.net).toBe(4);
  });
});
