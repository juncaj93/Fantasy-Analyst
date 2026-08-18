/**
 * The queue keeps the order the reader put it in.
 *
 * Everything here is about survival: an order is only worth having if it comes
 * back the same after a refresh, after a pick lands, after a player is added
 * from another screen and after ten drags in a row. The failure this guards is
 * not a crash — it is a shortlist that quietly re-sorts itself into board order
 * while the reader is looking at something else.
 */

import { describe, expect, it } from 'vitest';
import {
  QUEUE_STEP,
  appendRank,
  compact,
  needsCompaction,
  queueSequence,
  rankBetween,
  reconcileQueue,
  removeFromQueue,
  reorderQueue,
  type QueueEntry,
} from '../src/core/draft/queueOrder.ts';

const QUEUE: QueueEntry[] = [
  { playerId: 'a', order: 1000 },
  { playerId: 'b', order: 2000 },
  { playerId: 'c', order: 3000 },
  { playerId: 'd', order: 4000 },
];

/** Apply a result's writes, as the server would. */
function applied(entries: QueueEntry[], writes: QueueEntry[]): QueueEntry[] {
  const byId = new Map(entries.map((e) => [e.playerId, { ...e }]));
  for (const write of writes) {
    const existing = byId.get(write.playerId);
    if (existing) existing.order = write.order;
    else byId.set(write.playerId, { ...write });
  }
  return [...byId.values()];
}

describe('reordering does what a drag means', () => {
  it('moves a player down to the index he was dropped on', () => {
    const result = reorderQueue(QUEUE, 'a', 2);
    expect(result.sequence).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a player up', () => {
    expect(reorderQueue(QUEUE, 'd', 0).sequence).toEqual(['d', 'a', 'b', 'c']);
  });

  it('costs exactly one write', () => {
    const result = reorderQueue(QUEUE, 'a', 2);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.playerId).toBe('a');
    expect(result.compacted).toBe(false);
  });

  it('persists: the stored order reproduces the sequence', () => {
    const result = reorderQueue(QUEUE, 'a', 2);
    expect(queueSequence(applied(QUEUE, result.writes))).toEqual(result.sequence);
  });

  it('clamps a drop past either end rather than failing', () => {
    expect(reorderQueue(QUEUE, 'a', 99).sequence).toEqual(['b', 'c', 'd', 'a']);
    expect(reorderQueue(QUEUE, 'd', -5).sequence).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op when a player is dropped where he already was', () => {
    const result = reorderQueue(QUEUE, 'b', 1);
    expect(result.writes).toEqual([]);
    expect(result.sequence).toEqual(['a', 'b', 'c', 'd']);
  });

  it('will not queue a player by dragging a different one', () => {
    const result = reorderQueue(QUEUE, 'unqueued', 0);
    expect(result.writes).toEqual([]);
    expect(result.sequence).toEqual(['a', 'b', 'c', 'd']);
  });

  it('survives many drags in a row', () => {
    let entries = [...QUEUE];
    let sequence = queueSequence(entries);
    for (let i = 0; i < 50; i++) {
      const target = sequence[i % sequence.length]!;
      const result = reorderQueue(entries, target, (i * 3) % sequence.length);
      entries = result.compacted ? result.writes : applied(entries, result.writes);
      sequence = result.sequence;
      // Whatever happened, the stored order still reproduces the sequence.
      expect(queueSequence(entries)).toEqual(sequence);
    }
    expect(sequence.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('newly queued players append predictably', () => {
  it('goes after everything already queued', () => {
    expect(appendRank(QUEUE)).toBeGreaterThan(4000);
  });

  it('starts a queue that has nobody in it', () => {
    expect(appendRank([])).toBe(QUEUE_STEP);
  });

  it('appends after a queue whose ranks have been rearranged', () => {
    const rearranged: QueueEntry[] = [
      { playerId: 'a', order: 5500 },
      { playerId: 'b', order: 20 },
    ];
    const rank = appendRank(rearranged);
    expect(queueSequence([...rearranged, { playerId: 'new', order: rank }]).at(-1)).toBe('new');
  });
});

describe('players leaving the queue do not corrupt what is left', () => {
  it('keeps every survivor exactly where he was', () => {
    const after = removeFromQueue(QUEUE, ['b']);
    expect(queueSequence(after)).toEqual(['a', 'c', 'd']);
    // Ranks untouched: removal is a filter, not a renumber.
    expect(after.map((e) => e.order)).toEqual([1000, 3000, 4000]);
  });

  it('handles a drafted player who was never in the queue', () => {
    expect(queueSequence(removeFromQueue(QUEUE, ['zzz']))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves an emptied queue empty rather than broken', () => {
    expect(removeFromQueue(QUEUE, ['a', 'b', 'c', 'd'])).toEqual([]);
  });

  it('preserves the reader’s order across a removal and a later drag', () => {
    const reordered = applied(QUEUE, reorderQueue(QUEUE, 'd', 0).writes);
    const afterDraft = removeFromQueue(reordered, ['a']);
    expect(queueSequence(afterDraft)).toEqual(['d', 'b', 'c']);
  });
});

describe('the sparse ladder holds up', () => {
  it('finds room between neighbours', () => {
    expect(rankBetween(1000, 2000)).toBe(1500);
  });

  it('reports no room when two ranks are adjacent', () => {
    expect(rankBetween(10, 11)).toBeNull();
  });

  it('always has room at either end', () => {
    expect(rankBetween(undefined, 10)).toBeLessThan(10);
    expect(rankBetween(10, undefined)).toBeGreaterThan(10);
  });

  it('compacts rather than failing when the gaps run out', () => {
    const tight: QueueEntry[] = [
      { playerId: 'a', order: 1 },
      { playerId: 'b', order: 2 },
      { playerId: 'c', order: 3 },
    ];
    const result = reorderQueue(tight, 'c', 1);
    expect(result.compacted).toBe(true);
    expect(result.sequence).toEqual(['a', 'c', 'b']);
    expect(queueSequence(result.writes)).toEqual(['a', 'c', 'b']);
    expect(needsCompaction(result.writes)).toBe(false);
  });

  it('notices a ladder that has run out of room', () => {
    expect(needsCompaction(QUEUE)).toBe(false);
    expect(needsCompaction([{ playerId: 'a', order: 5 }, { playerId: 'b', order: 6 }])).toBe(true);
  });

  it('lays out a clean ladder from a sequence', () => {
    expect(compact(['x', 'y'])).toEqual([
      { playerId: 'x', order: QUEUE_STEP },
      { playerId: 'y', order: QUEUE_STEP * 2 },
    ]);
  });
});

describe('a stored order and the live queue are reconciled without surprises', () => {
  it('appends a player queued elsewhere after everyone already placed', () => {
    const reconciled = reconcileQueue(QUEUE, ['a', 'b', 'c', 'd', 'new']);
    expect(queueSequence(reconciled).at(-1)).toBe('new');
  });

  it('drops a stored rank for a player no longer queued', () => {
    expect(queueSequence(reconcileQueue(QUEUE, ['a', 'c']))).toEqual(['a', 'c']);
  });

  it('preserves a hand-made order through a reconcile', () => {
    const reordered = applied(QUEUE, reorderQueue(QUEUE, 'd', 0).writes);
    expect(queueSequence(reconcileQueue(reordered, ['a', 'b', 'c', 'd']))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is idempotent', () => {
    const once = reconcileQueue(QUEUE, ['a', 'b', 'c', 'd', 'new']);
    const twice = reconcileQueue(once, queueSequence(once));
    expect(queueSequence(twice)).toEqual(queueSequence(once));
  });

  it('orders a queue with no stored ranks at all, stably', () => {
    const fresh = reconcileQueue([], ['c', 'a', 'b']);
    expect(queueSequence(fresh)).toEqual(['a', 'b', 'c']);
    expect(queueSequence(reconcileQueue([], ['c', 'a', 'b']))).toEqual(queueSequence(fresh));
  });
});
