/**
 * `MKT PTS`, and the two ways a number like it goes wrong.
 *
 * It is **the league's** points, not a generic projection: the same market
 * lines have to produce different totals in a PPR league and a standard one,
 * and a six-point passing touchdown has to be worth more than a four-point one.
 * A single hardcoded rate would pass every test that only checked the
 * arithmetic was self-consistent.
 *
 * And it is **not a second opinion about the market**. The number shown is the
 * one `seasonBaseline` already computed for the `market_expectation` component
 * — the same object, not a parallel derivation — so showing it cannot move the
 * ranking. That is asserted here rather than assumed, because a second
 * conversion path is the exact failure this was written to avoid.
 */

import { describe, expect, it } from 'vitest';
import { seasonBaseline, seasonPropSummary } from '../src/core/vegas/season.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';

const PPR = buildScoringProfile({ rec: 1, pass_td: 4 }, []);
const HALF = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const STANDARD = buildScoringProfile({ rec: 0, pass_td: 4 }, []);
const SIX_POINT = buildScoringProfile({ rec: 1, pass_td: 6 }, []);

const RECEIVER = [
  { market: 'season_receptions', line: 84 },
  { market: 'season_receiving_yards', line: 1085 },
  { market: 'season_receiving_tds', line: 7.5 },
] as const;

const PASSER = [
  { market: 'season_pass_yards', line: 4050 },
  { market: 'season_pass_tds', line: 29.5 },
  { market: 'season_rush_yards', line: 385 },
  { market: 'season_rush_tds', line: 3.5 },
] as const;

/** The points component of a summary, which is the one this file is about. */
function points(position: string, markets: readonly { market: string; line: number }[], profile: typeof PPR) {
  const list = markets.map((m) => ({ market: m.market as never, line: m.line }));
  const baseline = seasonBaseline(position, list, profile);
  const summary = seasonPropSummary(position, list, { baseline })!;
  return { baseline, summary, component: summary.components.find((c) => c.label === 'pts')! };
}

describe('the league’s own scoring, not a generic one', () => {
  it('gives PPR, half-PPR and standard three different totals from identical lines', () => {
    const full = points('WR', RECEIVER, PPR).component.value;
    const half = points('WR', RECEIVER, HALF).component.value;
    const none = points('WR', RECEIVER, STANDARD).component.value;

    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(none);
    // 84 receptions is the whole of the difference, at a point and half a point.
    expect(full - half).toBeCloseTo(42, 5);
    expect(half - none).toBeCloseTo(42, 5);
  });

  it('pays a six-point passing touchdown more than a four-point one', () => {
    const four = points('QB', PASSER, PPR).component.value;
    const six = points('QB', PASSER, SIX_POINT).component.value;
    // 29.5 passing touchdowns, two points more each.
    expect(six - four).toBeCloseTo(59, 5);
  });

  it('pays a tight end his league’s reception premium', () => {
    const premium = buildScoringProfile({ rec: 1, bonus_rec_te: 0.5, pass_td: 4 }, []);
    const asTe = points('TE', RECEIVER, premium).component.value;
    const asWr = points('WR', RECEIVER, premium).component.value;
    expect(asTe - asWr).toBeCloseTo(42, 5);
  });
});

describe('what it refuses to invent', () => {
  it('marks a total built from part of the picture rather than printing it bare', () => {
    const partial = points('QB', [{ market: 'season_pass_yards', line: 4050 }], PPR);
    expect(partial.component.text.startsWith('~')).toBe(true);
    expect(partial.component.missing.length).toBeGreaterThan(0);
    expect(partial.baseline.coverage).toBeLessThan(1);
  });

  it('prints a complete total without a qualifier', () => {
    const complete = points('WR', RECEIVER, PPR);
    expect(complete.baseline.missing).toEqual([]);
    expect(complete.component.text.startsWith('~')).toBe(false);
  });

  it('leaves a missing component out of the sum rather than calling it zero', () => {
    const withTds = points('WR', RECEIVER, PPR).component.value;
    const withoutTds = points('WR', RECEIVER.filter((m) => m.market !== 'season_receiving_tds'), PPR).component.value;
    // Dropping the touchdown market lowers the total by exactly its points and
    // by nothing else — it is absent, not zero, and nothing was rescaled.
    expect(withTds - withoutTds).toBeCloseTo(7.5 * PPR.recTd, 5);
  });

  it('says nothing at all when no market priced him', () => {
    const baseline = seasonBaseline('WR', [], PPR);
    expect(baseline.points).toBeNull();
    expect(seasonPropSummary('WR', [], { baseline })).toBeNull();
  });
});

describe('counted once, and only once', () => {
  it('does not add receptions, receiving yards and a scrimmage total together', () => {
    const { component, summary } = points('RB', [
      { market: 'season_rush_yards', line: 1020 },
      { market: 'season_receiving_yards', line: 420 },
      { market: 'season_receptions', line: 55 },
    ], PPR);

    // Every market appears exactly once behind the points total…
    const markets = component.parts.map((p) => p.market);
    expect(new Set(markets).size).toBe(markets.length);

    // …and the yardage the card shows as `scrim yd` is the display of those
    // same two lines, not a third quantity added on top.
    const scrim = summary.components.find((c) => c.label === 'scrim yd')!;
    expect(scrim.value).toBe(1440);
    expect(component.value).toBeCloseTo(
      1020 * PPR.pointsPerRushYard + 420 * PPR.pointsPerRecYard + 55 * PPR.ppr,
      5,
    );
  });

  it('does not add rushing and receiving touchdowns twice via the combined display', () => {
    const { component, summary } = points('RB', [
      { market: 'season_rush_tds', line: 8.5 },
      { market: 'season_receiving_tds', line: 2 },
    ], PPR);

    const td = summary.components.find((c) => c.label === 'TD')!;
    expect(td.value).toBe(10.5);
    // 10.5 touchdowns' worth of points, once.
    expect(component.value).toBeCloseTo(10.5 * PPR.rushTd, 5);
  });

  it('reconciles exactly to the components the expanded card prints', () => {
    const { component } = points('QB', PASSER, PPR);
    const summed = component.parts.reduce((total, p) => total + (p.points ?? 0), 0);
    expect(Math.round(summed * 100) / 100).toBe(component.value);
  });
});

describe('it is the number the ranking already uses', () => {
  it('shows the same object the market-expectation component scores', () => {
    const list = PASSER.map((m) => ({ market: m.market as never, line: m.line }));
    const baseline = seasonBaseline('QB', list, PPR);
    const summary = seasonPropSummary('QB', list, { baseline })!;
    const shown = summary.components.find((c) => c.label === 'pts')!;

    // Not "equal to" — the same total, from the same baseline, with the same
    // parts. There is no second conversion for the two to drift apart.
    expect(shown.value).toBe(baseline.points);
    expect(shown.parts.map((p) => p.market)).toEqual(baseline.contributions.map((c) => c.market));
    expect(shown.missing).toEqual(baseline.missing);
  });

  it('is absent from the summary when no baseline is offered', () => {
    const list = PASSER.map((m) => ({ market: m.market as never, line: m.line }));
    const summary = seasonPropSummary('QB', list)!;
    expect(summary.components.some((c) => c.label === 'pts')).toBe(false);
  });
});

describe('receptions, back on the card', () => {
  for (const position of ['RB', 'WR', 'TE'] as const) {
    it(`shows a ${position}'s receptions when the market has them`, () => {
      const { summary } = points(position, [
        { market: 'season_receptions', line: 55 },
        { market: 'season_rush_yards', line: 1020 },
        { market: 'season_receiving_yards', line: 420 },
      ], PPR);

      const rec = summary.components.find((c) => c.label === 'rec')!;
      expect(rec, `${position} lost its receptions`).toBeTruthy();
      expect(rec.value).toBe(55);
      // Points first, then receptions, then the yardage — the brief's order.
      expect(summary.components.map((c) => c.label)).toEqual(['pts', 'rec', 'scrim yd']);
    });
  }

  it('omits receptions rather than inventing 0 rec', () => {
    const { summary } = points('RB', [
      { market: 'season_rush_yards', line: 1020 },
      { market: 'season_receiving_yards', line: 420 },
    ], PPR);
    expect(summary.components.some((c) => c.label === 'rec')).toBe(false);
    expect(summary.headline).not.toContain('0 rec');
  });
});
