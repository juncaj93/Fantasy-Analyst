/**
 * The rest of the season, beside this Sunday.
 *
 * The board has always answered one question — is he better than the man he
 * would replace, this week — and Alex's complaint is that a claim is rarely
 * only about this week: a marginal add with a strong rest-of-season outlook
 * should be distinguishable from a marginal add with nothing behind it.
 *
 * These tests are mostly about the silences. A season signal that spoke
 * confidently from a thin market would be worse than no signal at all, because
 * the reader cannot see which lines were quoted and which were missing.
 */

import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_BAND,
  SEASON_GAMES,
  seasonOutlookFor,
} from '../src/core/waivers/seasonOutlook.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { SeasonMarketKey } from '../src/core/vegas/types.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5 }, []);

/** A receiver's full season market, at a chosen points total for the year. */
function receiver(seasonPoints: number): { market: SeasonMarketKey; line: number | null }[] {
  /*
   * Built from real lines rather than by asserting a total, so the conversion
   * arithmetic is exercised rather than mocked: receiving yards at 0.1, catches
   * at 0.5, touchdowns at 6. Yards carry the balance.
   */
  const receptions = 60;
  const tds = 5;
  const fromRest = receptions * 0.5 + tds * 6;
  const yards = (seasonPoints - fromRest) / 0.1;
  return [
    { market: 'season_receiving_yards', line: yards },
    { market: 'season_receptions', line: receptions },
    { market: 'season_receiving_tds', line: tds },
  ];
}

const ask = (over: Partial<Parameters<typeof seasonOutlookFor>[0]> = {}) =>
  seasonOutlookFor({
    position: 'WR',
    markets: receiver(170),
    profile: HALF_PPR,
    thisWeekScore: 10,
    gamesRemaining: 16,
    ...over,
  });

describe('reading a season against a week', () => {
  it('calls a man the market likes more than Sunday does a season asset', () => {
    // 255 over 17 games is 15 a week against a 10-point week.
    const outlook = ask({ markets: receiver(255), thisWeekScore: 10 });

    expect(outlook.level).toBe('season_asset');
    expect(outlook.perWeek).toBeCloseTo(15, 1);
    expect(outlook.detail).toMatch(/15\.0 a week for the season, against 10\.0 this week/);
  });

  it('calls a man Sunday likes more than the season does a rental', () => {
    // 85 over 17 is 5 a week, against a 10-point week.
    const outlook = ask({ markets: receiver(85), thisWeekScore: 10 });

    expect(outlook.level).toBe('this_week_only');
    expect(outlook.perWeek).toBeCloseTo(5, 1);
  });

  it('says the two agree when they do', () => {
    const outlook = ask({ markets: receiver(10 * SEASON_GAMES), thisWeekScore: 10 });
    expect(outlook.level).toBe('in_line');
  });

  it('does not fire on a rounding difference', () => {
    /*
     * The band exists so the chip is worth reading. Two numbers from two
     * sources over two horizons never agree exactly, and a signal that fired on
     * every row is one the reader learns to ignore.
     */
    const justInside = 10 * (1 + AGREEMENT_BAND) - 0.2;
    const outlook = ask({ markets: receiver(justInside * SEASON_GAMES), thisWeekScore: 10 });
    expect(outlook.level).toBe('in_line');
  });
});

describe('what it refuses to say', () => {
  it('is unknown on a market too thin to read, not "in line"', () => {
    // Receptions alone: one of the three markets a receiver is priced on. The
    // total that comes back is small because nobody asked, not because he is bad.
    const outlook = ask({ markets: [{ market: 'season_receptions', line: 60 }] });

    expect(outlook.level).toBe('unknown');
    expect(outlook.perWeek).toBeNull();
    expect(outlook.detail).toBeNull();
  });

  it('is unknown for a player nobody priced at all', () => {
    expect(ask({ markets: [] }).level).toBe('unknown');
  });

  it('is unknown when this week could not be scored', () => {
    // There is nothing to compare the season against, and the honest output is
    // silence rather than a season figure standing on its own.
    expect(ask({ thisWeekScore: null }).level).toBe('unknown');
  });

  it('is unknown once the season has run out', () => {
    expect(ask({ gamesRemaining: 0 }).level).toBe('unknown');
  });

  it('never returns a figure it did not compute', () => {
    for (const outlook of [ask({ markets: [] }), ask({ thisWeekScore: null })]) {
      expect(outlook.perWeek).toBeNull();
      expect(outlook.label).toMatch(/unknown/i);
    }
  });
});

describe('a player with no week to speak of', () => {
  it('is a season asset when the market still expects something', () => {
    // A zero this week and a real season line is exactly the case the feature
    // was asked for: nothing to do on Sunday, worth holding regardless.
    const outlook = ask({ markets: receiver(170), thisWeekScore: 0 });
    expect(outlook.level).toBe('season_asset');
  });

  it('is not a season asset when the market expects nothing either', () => {
    const outlook = ask({ markets: receiver(0), thisWeekScore: 0 });
    expect(outlook.level).not.toBe('season_asset');
  });
});
