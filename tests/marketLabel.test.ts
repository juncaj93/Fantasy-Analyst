/**
 * The words a screen prints for a market.
 *
 * Two vocabularies in one module, and the tests are mostly about the boundary
 * between them: a season label goes inside a sentence and a weekly one begins
 * its own chip, so they are cased differently on purpose and neither may
 * quietly start answering for the other.
 */

import { describe, expect, it } from 'vitest';
import { marketLabel, seasonMarketLabel, WEEKLY_MARKET_LABEL } from '../src/core/vegas/marketLabel.ts';
import { MARKET_KEYS } from '../src/core/vegas/types.ts';

describe('the weekly market vocabulary', () => {
  it('names every market this app actually reads', () => {
    // The guard that matters. A key added to MARKET_KEYS without a label here
    // would print the storage key on a player's card, which is the defect this
    // table was written for.
    for (const key of MARKET_KEYS) {
      expect(WEEKLY_MARKET_LABEL[key], `no label for ${key}`).toBeTruthy();
      expect(marketLabel(key)).not.toBe(key);
    }
  });

  it('says Rec yards rather than receiving_yards', () => {
    expect(marketLabel('receiving_yards')).toBe('Rec yards');
    expect(marketLabel('receptions')).toBe('Receptions');
  });

  it('begins a label with a capital, because each one starts its own line', () => {
    for (const key of MARKET_KEYS) expect(marketLabel(key)![0]).toMatch(/[A-Z]/);
  });

  it('prints an unknown key rather than hiding it or inventing a name', () => {
    expect(marketLabel('kicking_yards')).toBe('kicking_yards');
  });
});

describe('the season market vocabulary, which is a different one', () => {
  it('stays lower case, because it is read inside a sentence', () => {
    expect(seasonMarketLabel('season_receiving_yards')).toBe('receiving yards');
  });

  it('does not answer for a weekly key', () => {
    // The two tables are keyed differently and must not silently overlap: a
    // weekly key asked of the season table is a caller reading the wrong one.
    expect(seasonMarketLabel('receiving_yards')).toBe('receiving_yards');
  });
});
