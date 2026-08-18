/**
 * The queue keeps the order the reader put it in.
 *
 * Reported: dragging a player in the ★ queue appeared to work and then the list
 * snapped back to the board's ordering. The drag was never the problem —
 * `queueOrder.ts` and `dragReorder.ts` are both correct and both already
 * tested. **The precedence was the problem.** The screen computed
 *
 *     isQueue && sort === 'score' ? queuedRows : sortBoard(queuedRows, sort)
 *
 * so a reader who had been reading the board by ADP or DOG and then opened
 * their shortlist got `sortBoard` re-ordering it on every render, including the
 * one immediately after their drop.
 *
 * That precedence now lives in `orderBoardRows`, as a pure function, for the
 * reason it was wrong in the first place: a rule that only exists inside a React
 * component can only be checked by driving a browser, and nothing was.
 *
 * Numbered against the addendum's required invariants.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT_MODE,
  SORT_MODES,
  orderBoardRows,
  reorderByIds,
  sortBoard,
  type SortMode,
  type SortableRow,
} from '../src/core/draft/boardSort.ts';
import { queueSequence, removeFromQueue, reorderQueue, type QueueEntry } from '../src/core/draft/queueOrder.ts';

type Row = SortableRow & { playerId: string };

/**
 * Four queued players whose every ordering is different, so a test cannot pass
 * by accident: the reader's order, Score order, ADP order and DOG order are
 * four distinct permutations.
 */
const ROWS: Row[] = [
  { playerId: 'd', name: 'Dara', score: 40, total: -2.9, adp: 12, dogAdp: 60 },
  { playerId: 'c', name: 'Cass', score: 60, total: -0.4, adp: 55, dogAdp: 14 },
  { playerId: 'b', name: 'Bel', score: 80, total: 1.1, adp: 30, dogAdp: 48 },
  { playerId: 'a', name: 'Ari', score: 90, total: 1.6, adp: 44, dogAdp: 22 },
];

/** The order the reader dragged them into: exactly the array order above. */
const MANUAL = ROWS.map((r) => r.playerId);

const idsOf = (rows: readonly Row[]) => rows.map((r) => r.playerId);
const inQueue = (sort: SortMode, pendingQueueOrder: readonly string[] | null = null) =>
  idsOf(orderBoardRows(ROWS, { isQueue: true, sort, pendingQueueOrder }));

describe('1 — the queue renders the stored order, whatever the sort control says', () => {
  it('keeps the server’s order under every sort mode', () => {
    for (const sort of SORT_MODES) {
      expect(inQueue(sort), sort).toEqual(MANUAL);
    }
  });

  it('mutation: the old precedence loses the order under ADP and DOG', () => {
    // The regression, reconstructed exactly as the screen had it.
    const old = (sort: SortMode) =>
      idsOf(sort === DEFAULT_SORT_MODE ? [...ROWS] : sortBoard(ROWS, sort));
    expect(old('score')).toEqual(MANUAL); // which is why it looked fine to test
    expect(old('adp')).not.toEqual(MANUAL);
    expect(old('dog')).not.toEqual(MANUAL);
  });

  it('the four orderings really are four different lists', () => {
    // Otherwise the assertions above could pass without the fix.
    const orders = SORT_MODES.map((m) => idsOf(sortBoard(ROWS, m)).join(''));
    expect(new Set([...orders, MANUAL.join('')]).size).toBe(4);
  });
});

describe('2 — dragging changes the order, and 3-5 nothing puts it back', () => {
  const entries: QueueEntry[] = [
    { playerId: 'd', order: 1000 },
    { playerId: 'c', order: 2000 },
    { playerId: 'b', order: 3000 },
    { playerId: 'a', order: 4000 },
  ];

  it('a drag moves the player and writes one row', () => {
    const moved = reorderQueue(entries, 'a', 0);
    expect(moved.sequence).toEqual(['a', 'd', 'c', 'b']);
    expect(moved.writes).toHaveLength(1);
    expect(moved.writes[0]!.playerId).toBe('a');
  });

  it('3 — a rerender does not restore Score order', () => {
    const dropped = reorderQueue(entries, 'a', 0).sequence;
    // Two consecutive renders of the same state, as React would produce them.
    const once = idsOf(orderBoardRows(ROWS, { isQueue: true, sort: 'score', pendingQueueOrder: dropped }));
    const twice = idsOf(orderBoardRows(ROWS, { isQueue: true, sort: 'score', pendingQueueOrder: dropped }));
    expect(once).toEqual(dropped);
    expect(twice).toEqual(dropped);
  });

  it('4 — a poll that returns the stored order does not restore Score order', () => {
    /*
     * What a refresh actually does: the client drops its local override and the
     * server's rows arrive already in the reader's order. The ordering function
     * must then leave them alone — which is the case the old code got wrong,
     * because `sortBoard` ran over exactly these rows.
     */
    const fromServer = reorderByIds(ROWS, ['a', 'd', 'c', 'b']);
    for (const sort of SORT_MODES) {
      expect(idsOf(orderBoardRows(fromServer, { isQueue: true, sort, pendingQueueOrder: null })), sort).toEqual([
        'a',
        'd',
        'c',
        'b',
      ]);
    }
  });

  it('5 — a completed pick removes one row and reorders nothing', () => {
    const after = removeFromQueue(entries, ['c']);
    expect(queueSequence(after)).toEqual(['d', 'b', 'a']);
    // The survivors keep the ranks they had: no renumber on an event the user
    // did not cause.
    expect(after.map((e) => e.order)).toEqual([1000, 3000, 4000]);

    const rows = ROWS.filter((r) => r.playerId !== 'c');
    expect(idsOf(orderBoardRows(rows, { isQueue: true, sort: 'dog', pendingQueueOrder: null }))).toEqual([
      'd',
      'b',
      'a',
    ]);
  });
});

describe('6-8 — leaving and returning to the queue', () => {
  it('6 — the selected mode still orders the ordinary board', () => {
    for (const sort of SORT_MODES) {
      const board = idsOf(orderBoardRows(ROWS, { isQueue: false, sort, pendingQueueOrder: null }));
      expect(board, sort).toEqual(idsOf(sortBoard(ROWS, sort)));
    }
  });

  it('6 — and the queue never changes which mode is selected', () => {
    /*
     * `orderBoardRows` takes the mode and returns rows. It has no way to change
     * it, which is the point: the reader's choice is remembered rather than
     * overridden, so leaving the queue puts them back on the board they were
     * reading instead of making them reselect it.
     */
    for (const sort of SORT_MODES) {
      const view = { isQueue: true, sort, pendingQueueOrder: null };
      orderBoardRows(ROWS, view);
      expect(view.sort).toBe(sort);
    }
  });

  it('7, 8 — returning to the queue shows the manual order again', () => {
    const sort: SortMode = 'dog';
    // …board, queue, board, queue: the queue answer is the same both times, and
    // the board answer is the same both times.
    expect(inQueue(sort)).toEqual(MANUAL);
    expect(idsOf(orderBoardRows(ROWS, { isQueue: false, sort, pendingQueueOrder: null }))).toEqual(
      idsOf(sortBoard(ROWS, sort)),
    );
    expect(inQueue(sort)).toEqual(MANUAL);
  });
});

describe('9-11 — persistence, search and removal', () => {
  it('9 — order is stored as ranks on the server, not derived on the client', () => {
    // A reload replays exactly this: ranks in, sequence out. Nothing about the
    // sequence depends on a score, so a reload cannot produce a different list.
    const stored: QueueEntry[] = [
      { playerId: 'a', order: 500 },
      { playerId: 'd', order: 1000 },
      { playerId: 'c', order: 2000 },
      { playerId: 'b', order: 3000 },
    ];
    expect(queueSequence(stored)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('10 — filtering the queue does not rewrite the stored order', () => {
    const stored: QueueEntry[] = [
      { playerId: 'd', order: 1000 },
      { playerId: 'c', order: 2000 },
      { playerId: 'b', order: 3000 },
      { playerId: 'a', order: 4000 },
    ];
    const visible = ROWS.filter((r) => r.playerId === 'c' || r.playerId === 'a');
    expect(idsOf(orderBoardRows(visible, { isQueue: true, sort: 'adp', pendingQueueOrder: null }))).toEqual([
      'c',
      'a',
    ]);
    // The stored ranks are untouched by having looked at a subset.
    expect(queueSequence(stored)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('11 — a row that vanished mid-drag is skipped, not dropped or duplicated', () => {
    // The drag committed an order for four players; a pick took one of them
    // before the response landed, and another was starred from the Players
    // screen. Neither is an error and neither may lose a row.
    const rows = [...ROWS.filter((r) => r.playerId !== 'b'), { ...ROWS[0]!, playerId: 'new', name: 'New' }];
    const result = idsOf(reorderByIds(rows, ['a', 'b', 'd', 'c']));
    expect(result).toEqual(['a', 'd', 'c', 'new']);
    expect(new Set(result).size).toBe(result.length);
    expect(result).toHaveLength(rows.length);
  });
});

describe('12-13 — the queue changes nothing but the order', () => {
  it('12 — changing the sort mode outside the queue cannot touch stored ranks', () => {
    const stored: QueueEntry[] = [
      { playerId: 'd', order: 1000 },
      { playerId: 'a', order: 2000 },
    ];
    const before = stored.map((e) => ({ ...e }));
    for (const sort of SORT_MODES) orderBoardRows(ROWS, { isQueue: false, sort, pendingQueueOrder: null });
    expect(stored).toEqual(before);
  });

  it('13 — ordering never mutates a row, in either view', () => {
    const snapshot = ROWS.map((r) => ({ ...r }));
    for (const sort of SORT_MODES) {
      for (const isQueue of [true, false]) {
        orderBoardRows(ROWS, { isQueue, sort, pendingQueueOrder: MANUAL });
      }
    }
    expect(ROWS).toEqual(snapshot);
  });

  it('13 — and the rows that come out are the rows that went in, by reference', () => {
    // A copy would be a place for a Score, a tier or a tally to drift. There is
    // no such place: these are permutations, not projections.
    for (const sort of SORT_MODES) {
      const out = orderBoardRows(ROWS, { isQueue: true, sort, pendingQueueOrder: MANUAL });
      expect(out.every((row) => ROWS.includes(row))).toBe(true);
      expect(out).toHaveLength(ROWS.length);
    }
  });
});
