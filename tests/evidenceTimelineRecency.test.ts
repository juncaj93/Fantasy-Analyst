/**
 * Which rows the evidence timeline opens on.
 *
 * The timeline is the app's "entire ledger" surface, so a rule that hides part
 * of it by default is exactly the rule worth asserting directly rather than
 * through a rendered tree — the same reason `selectLatestNews` is a pure
 * exported function and not an expression inside a component.
 *
 * Three properties matter here, and only the first is about tidiness:
 *
 *   1. the boundary is each row's own `sourceDate`, so an old fact imported
 *      today is still old and a recent one backfilled last year is still
 *      recent;
 *   2. nothing is lost — `recent` and `older` partition the input, in order, so
 *      expanding the control reproduces the original list exactly;
 *   3. a row that cannot be dated is never hidden. An unparseable date is not
 *      evidence of age, and the one outcome this change must not produce is a
 *      row vanishing from the ledger on a guess.
 */

import { describe, expect, it } from 'vitest';
import { partitionByRecency } from '../src/web/components/playerPage.tsx';
import { RECENCY_WINDOWS } from '../src/core/evidence/aggregate.ts';

const NOW = new Date('2026-08-28T00:00:00.000Z');

/** `days` before NOW, as the ledger stores it. */
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const row = (id: string, sourceDate: string) => ({ id, sourceDate });

describe('the evidence timeline collapses on the recent window', () => {
  it('opens on the last thirty days, which is the window the rest of the app means', () => {
    expect(RECENCY_WINDOWS.last30).toBe(30);
  });

  it('keeps items inside the window and folds the ones outside it', () => {
    const { recent, older } = partitionByRecency(
      [row('a', daysAgo(0)), row('b', daysAgo(29)), row('c', daysAgo(31)), row('d', daysAgo(400))],
      NOW,
    );
    expect(recent.map((r) => r.id)).toEqual(['a', 'b']);
    expect(older.map((r) => r.id)).toEqual(['c', 'd']);
  });

  /** The boundary itself: thirty days old is still inside a thirty-day window. */
  it('counts the boundary day as recent rather than old', () => {
    const { recent, older } = partitionByRecency([row('edge', daysAgo(30))], NOW);
    expect(recent.map((r) => r.id)).toEqual(['edge']);
    expect(older).toEqual([]);
  });

  /**
   * The requirement in the brief, stated as a test.
   *
   * A backfilled row carries the date the news happened; the row it was
   * imported alongside may be months newer. Splitting on anything but
   * `sourceDate` would file them together.
   */
  it('splits on the source date and not on any other date the row carries', () => {
    const old = { id: 'backfilled', sourceDate: daysAgo(200), createdAt: daysAgo(0) };
    const { recent, older } = partitionByRecency([old], NOW);
    expect(older.map((r) => r.id)).toEqual(['backfilled']);
    expect(recent).toEqual([]);
  });

  it('never hides a row whose date cannot be read', () => {
    for (const bad of ['', 'not a date', 'soon']) {
      const { recent, older } = partitionByRecency([row('undateable', bad)], NOW);
      expect(recent.map((r) => r.id), `"${bad}" was hidden on a guess`).toEqual(['undateable']);
      expect(older).toEqual([]);
    }
  });

  /**
   * Expanding the control has to give the reader the list they would have had.
   *
   * Not merely the same rows — the same rows in the same order, because the
   * timeline's promise is that it is chronological.
   */
  it('partitions without losing or reordering anything', () => {
    const items = [
      row('a', daysAgo(1)),
      row('b', daysAgo(20)),
      row('c', daysAgo(45)),
      row('d', daysAgo(60)),
      row('e', daysAgo(2)),
    ];
    const { recent, older } = partitionByRecency(items, NOW);
    expect(recent.length + older.length).toBe(items.length);
    // Newest-first input, so recent-then-older is the input again.
    const rejoined = [...recent, ...older].map((r) => r.id).sort();
    expect(rejoined).toEqual(items.map((r) => r.id).sort());
    // And each half kept its own relative order.
    expect(recent.map((r) => r.id)).toEqual(['a', 'b', 'e']);
    expect(older.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('folds nothing when every item is recent', () => {
    const { recent, older } = partitionByRecency([row('a', daysAgo(1)), row('b', daysAgo(3))], NOW);
    expect(recent).toHaveLength(2);
    expect(older).toEqual([]);
  });

  it('takes the window as an argument rather than hard-coding thirty', () => {
    const { recent, older } = partitionByRecency([row('a', daysAgo(10))], NOW, 7);
    expect(recent).toEqual([]);
    expect(older.map((r) => r.id)).toEqual(['a']);
  });
});
