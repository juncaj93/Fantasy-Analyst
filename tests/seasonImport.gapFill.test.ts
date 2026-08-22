/**
 * Choosing one line per player+market from more than one capture.
 *
 * The failure this exists to prevent is quiet: "latest snapshot wins" reads as
 * obviously correct and deletes coverage, because a small later capture
 * replaces a large earlier one for every player it never mentioned.
 */

import { describe, expect, it } from 'vitest';
import { resolveSeasonLines, summariseLineage, type SnapshotLine } from '../src/core/seasonImport/gapFill.ts';

function line(over: Partial<SnapshotLine> & { playerId: string; source: string; capturedAt: string }): SnapshotLine {
  return {
    market: 'season_receiving_yards',
    line: 1000,
    overPrice: null,
    underPrice: null,
    snapshotId: 1,
    ...over,
  } as SnapshotLine;
}

describe('one line per player and market', () => {
  it('prefers the primary source where it has an opinion', () => {
    const out = resolveSeasonLines(
      [
        line({ playerId: 'p1', source: 'Book B', capturedAt: '2026-08-28', line: 1200, snapshotId: 2 }),
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', line: 1100, snapshotId: 1 }),
      ],
      { primarySource: 'Book A' },
    );
    // Newer, but not primary — so it does not win.
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(1100);
    expect(out[0]?.source).toBe('Book A');
    expect(out[0]?.filledFromSecondary).toBe(false);
  });

  it('fills a gap the primary never priced', () => {
    const out = resolveSeasonLines(
      [
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
        line({ playerId: 'p2', source: 'Book B', capturedAt: '2026-08-28', line: 640, snapshotId: 2 }),
      ],
      { primarySource: 'Book A' },
    );
    const filled = out.find((l) => l.playerId === 'p2');
    expect(filled?.source).toBe('Book B');
    expect(filled?.filledFromSecondary).toBe(true);
  });

  it('does not let a small later capture delete a broad earlier one', () => {
    // The whole point. Book A priced three players in August; Book B priced one
    // of them a week later. Two must survive untouched.
    const out = resolveSeasonLines(
      [
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
        line({ playerId: 'p2', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
        line({ playerId: 'p3', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
        line({ playerId: 'p2', source: 'Book B', capturedAt: '2026-08-28', line: 1, snapshotId: 2 }),
      ],
      { primarySource: 'Book A' },
    );
    expect(out).toHaveLength(3);
    expect(out.every((l) => l.source === 'Book A')).toBe(true);
  });

  it('takes the later capture from the same source, which is line movement', () => {
    const out = resolveSeasonLines(
      [
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', line: 1100, snapshotId: 1 }),
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-28', line: 1180, snapshotId: 2 }),
      ],
      { primarySource: 'Book A' },
    );
    expect(out[0]?.line).toBe(1180);
  });

  it('never averages two books into a number neither published', () => {
    const out = resolveSeasonLines([
      line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', line: 1100, snapshotId: 1 }),
      line({ playerId: 'p1', source: 'Book B', capturedAt: '2026-08-20', line: 1300, snapshotId: 2 }),
    ]);
    expect(out).toHaveLength(1);
    // 1200 would be the midpoint, and nobody offered it.
    expect(out[0]?.line).not.toBe(1200);
    expect([1100, 1300]).toContain(out[0]?.line);
  });

  it('keeps each line pointing at the source that published it', () => {
    const out = resolveSeasonLines(
      [
        line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
        line({ playerId: 'p2', source: 'Book B', capturedAt: '2026-08-28', snapshotId: 2 }),
      ],
      { primarySource: 'Book A' },
    );
    expect(out.find((l) => l.playerId === 'p1')?.source).toBe('Book A');
    expect(out.find((l) => l.playerId === 'p2')?.source).toBe('Book B');
  });

  it('separates markets for the same player', () => {
    const out = resolveSeasonLines([
      line({ playerId: 'p1', market: 'season_receiving_yards', source: 'A', capturedAt: '2026-08-20' }),
      line({ playerId: 'p1', market: 'season_receptions', line: 90, source: 'A', capturedAt: '2026-08-20' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('is order-independent', () => {
    const rows = [
      line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', line: 1100, snapshotId: 1 }),
      line({ playerId: 'p1', source: 'Book B', capturedAt: '2026-08-28', line: 1300, snapshotId: 2 }),
    ];
    const a = resolveSeasonLines(rows, { primarySource: 'Book A' });
    const b = resolveSeasonLines([...rows].reverse(), { primarySource: 'Book A' });
    expect(a).toEqual(b);
  });

  it('leads with the newest capture when no primary is named', () => {
    const out = resolveSeasonLines([
      line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', line: 1100, snapshotId: 1 }),
      line({ playerId: 'p1', source: 'Book B', capturedAt: '2026-08-28', line: 1300, snapshotId: 2 }),
    ]);
    expect(out[0]?.line).toBe(1300);
    // Nothing was "filled from a secondary" when there was no primary to miss.
    expect(out[0]?.filledFromSecondary).toBe(false);
  });
});

describe('what a baseline was built from', () => {
  it('reports every contributing source', () => {
    const summary = summariseLineage(
      resolveSeasonLines(
        [
          line({ playerId: 'p1', source: 'Book A', capturedAt: '2026-08-20', snapshotId: 1 }),
          line({ playerId: 'p2', source: 'Book B', capturedAt: '2026-08-28', snapshotId: 2 }),
        ],
        { primarySource: 'Book A' },
      ),
    );
    expect(summary.players).toBe(2);
    expect(summary.sources.map((s) => s.source).sort()).toEqual(['Book A', 'Book B']);
    expect(summary.filledFromSecondary).toBe(1);
  });
});
