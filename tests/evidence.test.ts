import { describe, expect, it } from 'vitest';
import { aggregateAll, aggregatePlayerSignal, effectiveEvidence, emptySignal } from '../src/core/evidence/aggregate.ts';
import type { EvidenceItem } from '../src/core/evidence/types.ts';

const NOW = '2026-08-13T12:00:00.000Z';

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

function item(partial: Partial<EvidenceItem> & { id: string }): EvidenceItem {
  return {
    playerId: 'p1',
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: 'm1',
    sourceDate: daysAgo(1),
    excerpt: 'excerpt',
    contextSummary: null,
    category: 'role',
    polarity: 'positive',
    magnitude: 1,
    confidence: 'high',
    confidenceScore: 0.9,
    ruleId: 'pos.x',
    reviewStatus: 'auto_applied',
    userOverride: null,
    dedupeKey: partial.id,
    createdAt: NOW,
    ...partial,
  } as EvidenceItem;
}

describe('effectiveEvidence', () => {
  it('counts an auto-applied positive item', () => {
    const e = effectiveEvidence(item({ id: '1', polarity: 'positive', magnitude: 2 }));
    expect(e.delta).toBe(2);
    expect(e.counted).toBe(true);
  });

  it('counts a negative item as a negative delta', () => {
    expect(effectiveEvidence(item({ id: '1', polarity: 'negative', magnitude: 3 })).delta).toBe(-3);
  });

  it('gives mixed and neutral a zero delta', () => {
    expect(effectiveEvidence(item({ id: '1', polarity: 'mixed', magnitude: 2 })).delta).toBe(0);
    expect(effectiveEvidence(item({ id: '1', polarity: 'neutral', magnitude: 2 })).delta).toBe(0);
  });

  it('excludes pending, rejected and ignored items', () => {
    for (const status of ['pending', 'rejected', 'ignored'] as const) {
      expect(effectiveEvidence(item({ id: '1', reviewStatus: status })).counted).toBe(false);
    }
  });

  it('lets a user override beat the classifier', () => {
    const e = effectiveEvidence(
      item({
        id: '1',
        polarity: 'positive',
        magnitude: 1,
        reviewStatus: 'corrected',
        userOverride: { polarity: 'negative', magnitude: 3 },
      }),
    );
    expect(e.polarity).toBe('negative');
    expect(e.delta).toBe(-3);
  });

  it('lets a user override reassign the player', () => {
    const e = effectiveEvidence(
      item({ id: '1', playerId: 'wrong', reviewStatus: 'corrected', userOverride: { playerId: 'right' } }),
    );
    expect(e.playerId).toBe('right');
  });
});

describe('aggregatePlayerSignal', () => {
  const items = [
    item({ id: '1', polarity: 'positive', magnitude: 2, sourceDate: daysAgo(2) }),
    item({ id: '2', polarity: 'positive', magnitude: 1, sourceDate: daysAgo(15) }),
    item({ id: '3', polarity: 'negative', magnitude: 1, sourceDate: daysAgo(3), category: 'injury' }),
    item({ id: '4', polarity: 'negative', magnitude: 2, sourceDate: daysAgo(200), category: 'injury' }),
    item({ id: '5', polarity: 'mixed', magnitude: 0, sourceDate: daysAgo(1) }),
    item({ id: '6', polarity: 'positive', magnitude: 3, sourceDate: daysAgo(1), reviewStatus: 'pending' }),
  ];

  it('computes the lifetime tally from the whole ledger', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.raw.positive).toBe(3);
    expect(signal.raw.negative).toBe(3);
    expect(signal.raw.net).toBe(0);
  });

  it('keeps recent windows separate from the lifetime tally', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.last7.net).toBe(1); // +2 (2d) and -1 (3d)
    expect(signal.last21.net).toBe(2); // adds +1 from 15 days ago
    expect(signal.raw.net).toBe(0);
  });

  it('excludes pending items from every window but counts them separately', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.pendingCount).toBe(1);
    expect(signal.raw.net).toBe(0); // the pending +3 is not included
  });

  it('counts mixed items without moving the net', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.mixedCount).toBe(1);
  });

  it('respects the season-to-date boundary without deleting old evidence', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW, seasonStart: daysAgo(30) });
    expect(signal.seasonToDate.net).toBe(2); // the 200-day-old -2 falls outside
    expect(signal.raw.items).toBe(5); // but it is still in the lifetime ledger
  });

  it('breaks tallies down by category', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.categoryBreakdown['injury']).toEqual({ positive: 0, negative: 3, items: 2 });
  });

  it('tracks the most recent evidence date', () => {
    const signal = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(signal.lastEvidenceAt).toBe(daysAgo(1));
  });

  it('handles a player with no evidence', () => {
    const signal = aggregatePlayerSignal('p1', [], { now: NOW });
    expect(signal.raw.net).toBe(0);
    expect(signal.lastEvidenceAt).toBeNull();
  });

  it('is deterministic', () => {
    const a = aggregatePlayerSignal('p1', items, { now: NOW });
    const b = aggregatePlayerSignal('p1', items, { now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('aggregateAll', () => {
  it('groups by effective player id, following overrides', () => {
    const signals = aggregateAll(
      [
        item({ id: '1', playerId: 'a', polarity: 'positive', magnitude: 1 }),
        item({
          id: '2',
          playerId: 'a',
          polarity: 'negative',
          magnitude: 2,
          reviewStatus: 'corrected',
          userOverride: { playerId: 'b' },
        }),
      ],
      { now: NOW },
    );
    expect(signals.get('a')?.raw.net).toBe(1);
    expect(signals.get('b')?.raw.net).toBe(-2);
  });
});

describe('emptySignal', () => {
  it('returns a zeroed signal', () => {
    const s = emptySignal('p1', NOW);
    expect(s.raw.net).toBe(0);
    expect(s.pendingCount).toBe(0);
  });
});
