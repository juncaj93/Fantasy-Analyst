/**
 * What a date on an evidence row means, and which windows may believe it.
 *
 * The ledger holds two kinds of row and they answer different questions with
 * the same field. A weekly tally row is one issue's reading of one player, so
 * its `sourceDate` is when that news happened. A backfill row is a running
 * tally "covering several earlier issues" carried across as a single item
 * (`core/newsletter/tally.ts`), so its `sourceDate` is when the summary was
 * *imported* — the period it describes ended there but began somewhere further
 * back that the ledger never recorded.
 *
 * Treating the second as the first is how a whole season's tally, imported on a
 * Tuesday, becomes "this week's news" on Wednesday. Seven days cannot contain
 * several weekly issues, so a carried-over row is provably not 7-day evidence
 * and is excluded from that window.
 *
 * Thirty days is a different matter and is deliberately left alone: "several
 * earlier issues" *may* fit inside a month, and excluding a row from a window
 * it might legitimately belong to would be inventing a fact in the other
 * direction. The lifetime record keeps every point either way, which is the
 * one thing about a carried tally that is never in doubt.
 *
 * The first half of this file pins the consumers that must not move. The second
 * half pins the ones that must.
 */

import { describe, expect, it } from 'vitest';
import { aggregatePlayerSignal, effectiveEvidence } from '../src/core/evidence/aggregate.ts';
import type { EvidenceItem } from '../src/core/evidence/types.ts';

const NOW = '2026-08-13T12:00:00.000Z';

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

let seq = 0;

function row(over: Partial<EvidenceItem>): EvidenceItem {
  const id = `e${++seq}`;
  return {
    id,
    playerId: 'p1',
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: 'm1',
    sourceDate: daysAgo(2),
    excerpt: 'excerpt',
    contextSummary: null,
    category: 'role',
    polarity: 'positive',
    magnitude: 1,
    confidence: 'medium',
    confidenceScore: 0.6,
    ruleId: 'pos.role',
    reviewStatus: 'auto_applied',
    userOverride: null,
    dedupeKey: id,
    createdAt: NOW,
    ...over,
  } as EvidenceItem;
}

/** One issue's reading of one player: the date is when the news happened. */
const weekly = (magnitude: number, ageDays: number) =>
  row({ ruleId: 'ai-tally-import', magnitude, sourceDate: daysAgo(ageDays) });

/** A running tally over several earlier issues, carried across as one item. */
const carried = (magnitude: number, ageDays: number) =>
  row({
    ruleId: 'tally-backfill',
    magnitude,
    sourceDate: daysAgo(ageDays),
    contextSummary: `Carried over from a running tally covering several earlier issues (net +${magnitude}).`,
  });

const signal = (items: EvidenceItem[]) => aggregatePlayerSignal('p1', items, { now: NOW });

// ---------------------------------------------------------------------------
// What must not move
// ---------------------------------------------------------------------------

describe('the lifetime record keeps every point, whatever carried it', () => {
  it('counts a carried tally at its full magnitude', () => {
    const s = signal([carried(13, 2)]);
    expect(s.raw.net).toBe(13);
    expect(s.raw.items).toBe(1);
  });

  it('counts it the same whether it was imported today or last month', () => {
    expect(signal([carried(13, 1)]).raw.net).toBe(signal([carried(13, 40)]).raw.net);
  });

  it('keeps a ±2 weekly row at the magnitude it was written', () => {
    expect(signal([weekly(2, 1)]).raw.net).toBe(2);
  });
});

describe('the 30-day window is unchanged', () => {
  /**
   * Deliberate. A run of "several earlier issues" may genuinely sit inside a
   * month, so excluding it would assert something the ledger does not know.
   */
  it('still counts a recently imported carried tally', () => {
    expect(signal([carried(13, 2)]).last30.net).toBe(13);
    expect(signal([carried(13, 2)]).last30.items).toBe(1);
  });

  it('still drops one that is older than the window', () => {
    expect(signal([carried(13, 40)]).last30.net).toBe(0);
  });

  it('is unaffected for a player whose evidence is all weekly rows', () => {
    const s = signal([weekly(2, 25), weekly(2, 18), weekly(1, 3)]);
    expect([s.last30.net, s.last30.items]).toEqual([5, 3]);
  });
});

describe('the season and category views are unchanged', () => {
  it('counts a carried tally toward the season to date', () => {
    const s = aggregatePlayerSignal('p1', [carried(13, 2)], { now: NOW, seasonStart: daysAgo(60) });
    expect(s.seasonToDate.net).toBe(13);
  });

  it('still files it under its category', () => {
    const s = signal([carried(13, 2)]);
    expect(s.categoryBreakdown['role']).toEqual({ positive: 13, negative: 0, items: 1 });
  });
});

describe('review status still decides what counts at all', () => {
  it('excludes a pending carried tally from every window', () => {
    const s = signal([{ ...carried(13, 2), reviewStatus: 'pending' }]);
    expect([s.raw.net, s.last30.net, s.last7.net]).toEqual([0, 0, 0]);
    expect(s.pendingCount).toBe(1);
  });

  for (const status of ['rejected', 'ignored'] as const) {
    it(`excludes a ${status} carried tally from every window`, () => {
      const s = signal([{ ...carried(13, 2), reviewStatus: status }]);
      expect([s.raw.net, s.last30.net, s.last7.net]).toEqual([0, 0, 0]);
    });
  }

  it('still lets a user override win over the imported magnitude', () => {
    const s = signal([{ ...carried(13, 2), reviewStatus: 'corrected', userOverride: { magnitude: 4 } }]);
    expect(s.raw.net).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// What must move
// ---------------------------------------------------------------------------

describe('the 7-day window believes only what happened in it', () => {
  it('keeps a weekly row out of nothing — the date means what it says', () => {
    expect(signal([weekly(2, 3)]).last7.net).toBe(2);
  });

  /** The defect: imported on Tuesday, "this week's news" on Wednesday. */
  it('excludes a carried tally imported inside the window', () => {
    const s = signal([carried(13, 2)]);
    expect(s.last7.net).toBe(0);
    expect(s.last7.items).toBe(0);
    // ...while the same row still carries its full weight everywhere else.
    expect([s.last30.net, s.raw.net]).toEqual([13, 13]);
  });

  it('reports how much of the record is carried rather than observed', () => {
    expect(signal([carried(13, 2)]).carriedOverItems).toBe(1);
    expect(signal([weekly(2, 2), weekly(1, 3)]).carriedOverItems).toBe(0);
    expect(signal([carried(9, 12), weekly(1, 2)]).carriedOverItems).toBe(1);
  });

  it('leaves a genuine recent week visible beside a carried tally', () => {
    // The shape of the live Gibbs row: an older carried +9 and this week's +1.
    const s = signal([carried(9, 12), weekly(1, 2)]);
    expect([s.last7.net, s.last30.net, s.raw.net]).toEqual([1, 10, 10]);
  });

  it('marks the item itself, so the reason is inspectable', () => {
    expect(effectiveEvidence(carried(13, 2)).spansPriorIssues).toBe(true);
    expect(effectiveEvidence(weekly(2, 2)).spansPriorIssues).toBe(false);
  });
});
