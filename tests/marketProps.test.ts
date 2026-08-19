/**
 * The `MKT` line, and the arithmetic behind it.
 *
 * One number on this line is not a market. `84.5 scrim yd` is a rushing line
 * added to a receiving one — a sum this app performed — and the whole of this
 * file is about the difference between that and something a book quoted.
 *
 * Three rules, each with its own failure if it goes:
 *
 *   * **Only compatible components are summed.** Nothing here may ever add a
 *     yardage line to a touchdown line.
 *   * **A missing component is not zero.** A receiver priced on receiving
 *     yards alone must not read `scrim yd`, because that would claim his
 *     rushing was measured and found to be nothing.
 *   * **A sum is never presented as a single market.** `derived` says which is
 *     which, and the parts it was built from travel with it.
 */

import { describe, expect, it } from 'vitest';
import { seasonHeadline, seasonPropSummary } from '../src/core/vegas/season.ts';

describe('a quarterback', () => {
  const full = [
    { market: 'season_pass_yards', line: 4050 },
    { market: 'season_pass_tds', line: 29.5 },
    { market: 'season_rush_yards', line: 385 },
    { market: 'season_rush_tds', line: 3.5 },
  ] as const;

  it('shows all four, each its own market rather than a sum', () => {
    const summary = seasonPropSummary('QB', [...full])!;
    expect(summary.headline).toBe('4,050 pass yd · 29.5 pass TD · 385 rush yd · 3.5 rush TD');
    expect(summary.derived).toBe(false);
    expect(summary.components).toHaveLength(4);
    for (const component of summary.components) {
      expect(component.derived, `${component.label} must not be a sum`).toBe(false);
      expect(component.parts).toHaveLength(1);
    }
  });

  it('shows what is priced and nothing where a market is absent', () => {
    const summary = seasonPropSummary('QB', [
      { market: 'season_pass_yards', line: 4050 },
      { market: 'season_pass_tds', line: 29.5 },
    ])!;
    expect(summary.headline).toBe('4,050 pass yd · 29.5 pass TD');
    // The rushing markets are named as absent, and appear nowhere as a zero.
    expect(summary.missing).toEqual(['season_rush_yards', 'season_rush_tds']);
    expect(summary.headline).not.toMatch(/\b0 rush/);
  });

  it('reads the same however the provider ordered the markets', () => {
    const reversed = [...full].reverse();
    expect(seasonHeadline('QB', reversed)).toBe(seasonHeadline('QB', [...full]));
  });
});

describe('a runner or a receiver', () => {
  const both = [
    { market: 'season_rush_yards', line: 1020 },
    { market: 'season_receiving_yards', line: 420 },
    { market: 'season_rush_tds', line: 8.5 },
    { market: 'season_receiving_tds', line: 2 },
  ] as const;

  it('combines the two halves, and says the total is a sum', () => {
    const summary = seasonPropSummary('RB', [...both])!;
    expect(summary.headline).toBe('1,440 scrim yd · 10.5 TD');
    expect(summary.derived).toBe(true);

    const [yards, tds] = summary.components;
    expect(yards!.derived).toBe(true);
    expect(yards!.value).toBe(1440);
    expect(yards!.parts.map((p) => p.market)).toEqual(['season_rush_yards', 'season_receiving_yards']);
    expect(tds!.derived).toBe(true);
    expect(tds!.value).toBe(10.5);
  });

  it('never adds a yardage line to a touchdown line', () => {
    const summary = seasonPropSummary('WR', [...both])!;
    for (const component of summary.components) {
      const kinds = new Set(component.parts.map((p) => (p.market.includes('_tds') ? 'td' : 'yards')));
      expect(kinds.size, `${component.label} mixes units`).toBe(1);
    }
  });

  it('calls a half a half, rather than a total with the other half at zero', () => {
    const receivingOnly = seasonPropSummary('WR', [
      { market: 'season_receiving_yards', line: 1085 },
      { market: 'season_receiving_tds', line: 7.5 },
    ])!;

    expect(receivingOnly.headline).toBe('1,085 rec yd · 7.5 rec TD');
    expect(receivingOnly.headline).not.toContain('scrim');
    expect(receivingOnly.derived).toBe(false);
    // 1,085 is his receiving yards. It is not his scrimmage yards, and the
    // absent rushing market is named rather than counted as nothing.
    expect(receivingOnly.components[0]!.missing).toEqual(['season_rush_yards']);
    expect(receivingOnly.components[0]!.value).toBe(1085);

    const rushingOnly = seasonPropSummary('RB', [
      { market: 'season_rush_yards', line: 1020 },
      { market: 'season_rush_tds', line: 8.5 },
    ])!;
    expect(rushingOnly.headline).toBe('1,020 rush yd · 8.5 rush TD');
    expect(rushingOnly.derived).toBe(false);
  });

  it('is not tricked into a sum by a market quoted twice', () => {
    const summary = seasonPropSummary('RB', [
      { market: 'season_rush_yards', line: 1020 },
      { market: 'season_rush_yards', line: 980 },
    ])!;
    expect(summary.components[0]!.value).toBe(1020);
    expect(summary.components[0]!.derived).toBe(false);
  });
});

describe('when the market is not there', () => {
  it('says nothing at all rather than zero', () => {
    expect(seasonPropSummary('RB', [])).toBeNull();
    expect(seasonPropSummary('QB', [{ market: 'season_pass_yards', line: null }])).toBeNull();
    expect(seasonHeadline('WR', [])).toBeNull();
  });

  it('still reports a market the position’s summary does not ask for', () => {
    // Receptions are not part of a receiver's summary, but a card with a real
    // market on it must not go blank.
    const summary = seasonPropSummary('WR', [{ market: 'season_receptions', line: 84 }])!;
    expect(summary.headline).toBe('84 rec');
    expect(summary.derived).toBe(false);
  });

  it('never emits a zero for an absent component', () => {
    const partial = seasonPropSummary('RB', [{ market: 'season_receiving_tds', line: 2 }])!;
    expect(partial.headline).toBe('2 rec TD');
    for (const component of partial.components) {
      for (const part of component.parts) expect(part.line).not.toBe(0);
    }
  });
});

describe('provenance', () => {
  it('keeps the line each market contributed, and how many books stood behind it', () => {
    const summary = seasonPropSummary('RB', [
      { market: 'season_rush_yards', line: 1020, bookCount: 4 },
      { market: 'season_receiving_yards', line: 420, bookCount: 3 },
    ])!;

    const yards = summary.components[0]!;
    expect(yards.derived).toBe(true);
    expect(yards.parts).toEqual([
      { market: 'season_rush_yards', line: 1020, bookCount: 4 },
      { market: 'season_receiving_yards', line: 420, bookCount: 3 },
    ]);
    // The printed number is recoverable from the parts, which is what makes the
    // breakdown an audit rather than a caption.
    expect(yards.parts.reduce((t, p) => t + p.line, 0)).toBe(yards.value);
  });
});
