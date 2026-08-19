/**
 * Why `MKT PTS` helped or hurt, in words.
 *
 * The expanded card can already show what the market implied and which lines it
 * was built from. What it could not say is the thing a reader actually wants at
 * a draft: *is that a good number for this position, and does it agree with what
 * the room is charging?*
 *
 * Both halves are answered from `marketStandings`, which puts the scoring market
 * and the draft market on one [-1, 1] positional scale against the same peers.
 * That shared denominator is the whole point — "the books are keener than the
 * room" means nothing if the two sides were measured against different players.
 *
 * ## This is explanation, and only explanation
 *
 * Nothing here reaches a Draft Score. The score already accounts for both
 * markets, separately and on purpose: `market_expectation` carries what the
 * books imply, `market_value` carries what the draft charges. Their disagreement
 * is therefore *already* priced — it is the difference between two components
 * that are both already in the composite. Adding a third component for it would
 * count the same two facts a second time, which is precisely the double-count
 * the contribution map exists to prevent.
 *
 * So this module returns sentences. It has no weight and no caller in the
 * ranking path.
 */

import type { MarketStandings } from '../vegas/season.ts';

/**
 * Where the adjectives change.
 *
 * A standing is measured in interquartile spreads, so 0.5 is half the distance
 * between a middling player at the position and a clearly good one. Round
 * numbers because the exact cut is a judgement, and a reader who can see the
 * number should not have to reverse-engineer the word.
 */
export const STANDING_BANDS = { strong: 0.5, good: 0.15, poor: -0.15, weak: -0.5 } as const;

/**
 * How far apart the two markets must be before it is worth remarking on.
 *
 * Below `notable` the two are saying the same thing with different rounding, and
 * a card that announced a disagreement every time would teach the reader to stop
 * reading it.
 */
export const DISAGREEMENT_BANDS = { marked: 0.5, notable: 0.25 } as const;

/** Coverage below this is thin enough that the standing is worth qualifying. */
export const THIN_COVERAGE = 0.75;

export interface MarketStrategyNote {
  /** Whether the books rate him above, below or level with his draft cost. */
  kind: 'bullish' | 'bearish' | 'agrees';
  /** How he rates among his position on the books' numbers, e.g. "strong for a WR". */
  standing: string;
  /** What the two markets say about each other, one sentence. */
  disagreement: string | null;
  /** Present when partial coverage means the standing deserves a hedge. */
  caveat: string | null;
}

function standingPhrase(expectation: number, position: string): string {
  const article = /^[AEIOU]/.test(position) ? 'an' : 'a';
  if (expectation >= STANDING_BANDS.strong) return `strong for ${article} ${position}`;
  if (expectation >= STANDING_BANDS.good) return `above the middle for ${article} ${position}`;
  if (expectation > STANDING_BANDS.poor) return `middling for ${article} ${position}`;
  if (expectation > STANDING_BANDS.weak) return `below the middle for ${article} ${position}`;
  return `trails his position`;
}

/**
 * The sentence a reader came for.
 *
 * Null when there is nothing honest to say — no comparable peers, or a draft
 * cost the board never knew — because a hedged sentence about an unknown is
 * worse than no sentence.
 */
export function marketStrategyNote(
  standings: MarketStandings | null,
  position: string,
): MarketStrategyNote | null {
  if (standings == null) return null;

  const standing = standingPhrase(standings.expectation, position);
  const caveat =
    standings.coverage < THIN_COVERAGE
      ? `on ${Math.round(standings.coverage * 100)}% coverage, so read it as a floor`
      : null;

  const gap = standings.disagreement;
  if (gap == null) {
    // He has props and no comparable draft cost. The standing still stands; the
    // comparison does not exist, and is not invented.
    return { kind: 'agrees', standing, disagreement: null, caveat };
  }

  if (gap >= DISAGREEMENT_BANDS.notable) {
    return {
      kind: 'bullish',
      standing,
      disagreement:
        gap >= DISAGREEMENT_BANDS.marked
          ? 'the scoring market is markedly keener on him than his draft cost'
          : 'the scoring market is keener on him than his draft cost',
      caveat,
    };
  }
  if (gap <= -DISAGREEMENT_BANDS.notable) {
    return {
      kind: 'bearish',
      standing,
      disagreement:
        gap <= -DISAGREEMENT_BANDS.marked
          ? 'his props trail his peers badly at this draft cost'
          : 'his props trail his peers at this draft cost',
      caveat,
    };
  }
  return {
    kind: 'agrees',
    standing,
    disagreement: 'the scoring market and the draft market agree on him',
    caveat,
  };
}
