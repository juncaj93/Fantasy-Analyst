/**
 * What the rest of the season thinks of a waiver candidate.
 *
 * The board answers one question well — is this man better than the one he
 * would replace, *this* week — and a claim is rarely only about this week. A
 * back who is a marginal add on Sunday and the clear handcuff to a workhorse
 * for the next three months is a different decision from one who is the same
 * marginal add and nothing afterwards, and the board could not tell them apart.
 *
 * ## Why not the multi-week column that already exists
 *
 * It is a different horizon with a different source, and both are wanted.
 * `core/value/multiWeek.ts` carries this week's score forward four weeks
 * through role, schedule and regression, which makes it the best available
 * statement about *form* — and it needs in-season usage to say anything at all.
 * In week one there is none, every component reports unknown, and the column
 * correctly stays empty. That is the gap this fills: the market's season-long
 * lines are quoted before a snap is played and are already stored for the draft
 * board.
 *
 * So they sit beside each other rather than one replacing the other. Where both
 * speak they are two readings of two horizons from two sources, and a screen
 * showing both is showing more than either.
 *
 * ## What the number is, and what it is not
 *
 * A player's season market total, converted with the league's own scoring by
 * {@link seasonBaseline}, divided by the games left in the season. It is a
 * **rate**, and the only thing it may be compared with is another rate — which
 * is why the comparison here is against the same player's own week rather than
 * against a table of thresholds.
 *
 * It is not a projection of any particular week. The market prices a season and
 * this divides it; a player who misses four games has the same rate as one who
 * plays every week for the same total, and nothing here knows the difference.
 * That is why the output is a band and a sentence rather than a figure the
 * board ranks on. **Nothing in this module reaches the ranking.** The board's
 * order is the this-week decision it has always been.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { SeasonMarketKey } from '../vegas/types.ts';
import { seasonBaseline } from '../vegas/season.ts';

/** Games in an NFL regular season, which is what a season line is quoted over. */
export const SEASON_GAMES = 17;

/**
 * How far a season rate must sit from the week's own number to be worth saying.
 *
 * A fifth, either way. Two numbers built from different sources over different
 * horizons will never agree exactly, and a chip that fired on a rounding
 * difference would be noise on every row — the reader would stop reading it,
 * which costs more than the chip is worth.
 */
export const AGREEMENT_BAND = 0.2;

/**
 * The share of a position's season markets that must be quoted to say anything.
 *
 * A receiver priced for receptions and not for yards is priced for a fraction
 * of what he does, and the total that comes back is not small because he is bad
 * — it is small because nobody asked. Below this the answer is `unknown`, which
 * the board reports as pending rather than as a verdict.
 */
export const MIN_MARKET_COVERAGE = 0.5;

export type SeasonOutlookLevel =
  /** The rest of the season likes him more than this week does. */
  | 'season_asset'
  /** The two horizons agree. */
  | 'in_line'
  /** This week is the best of him; the season is quieter. */
  | 'this_week_only'
  | 'unknown';

export interface SeasonOutlook {
  level: SeasonOutlookLevel;
  /** The word a chip may print. */
  label: string;
  /** The market's own per-week rate for the rest of the season. */
  perWeek: number | null;
  /** One sentence, naming both numbers so neither is taken for the other. */
  detail: string | null;
}

export const SEASON_OUTLOOK_LABELS: Record<SeasonOutlookLevel, string> = {
  season_asset: 'Season asset',
  in_line: 'Season: in line',
  this_week_only: 'This week only',
  unknown: 'Season: unknown',
};

const UNKNOWN: SeasonOutlook = {
  level: 'unknown',
  label: SEASON_OUTLOOK_LABELS.unknown,
  perWeek: null,
  detail: null,
};

/**
 * Read one candidate's season market against his week.
 *
 * Returns `unknown` — never a neutral-looking `in_line` — whenever the market
 * is too thin, the week could not be scored, or the season is over. Those are
 * three different silences and they are all silence; a board that printed
 * "in line" for a player nobody priced would be inventing an agreement between
 * two numbers, one of which does not exist.
 */
export function seasonOutlookFor(opts: {
  position: string;
  /** This player's stored season-long market lines. */
  markets: { market: SeasonMarketKey; line: number | null }[];
  profile: ScoringProfile;
  /** His Start/Sit score for this week, which is what the board already ranks on. */
  thisWeekScore: number | null;
  /** Games left including this one. Drives the rate and nothing else. */
  gamesRemaining: number;
}): SeasonOutlook {
  if (opts.thisWeekScore == null || !Number.isFinite(opts.thisWeekScore)) return UNKNOWN;
  if (!Number.isFinite(opts.gamesRemaining) || opts.gamesRemaining <= 0) return UNKNOWN;

  const baseline = seasonBaseline(opts.position, opts.markets, opts.profile);
  if (baseline.points == null || baseline.coverage < MIN_MARKET_COVERAGE) return UNKNOWN;

  /*
   * The season total is quoted over a whole season, so the rate is over a whole
   * season too. Dividing what is left of the total by what is left of the
   * calendar would be the same number with more steps — and would need to know
   * what he has already scored, which is not what a season line describes.
   */
  const perWeek = round2(baseline.points / SEASON_GAMES);
  const week = opts.thisWeekScore;

  const level: SeasonOutlookLevel =
    week <= 0
      ? perWeek > 0
        ? 'season_asset'
        : 'in_line'
      : perWeek >= week * (1 + AGREEMENT_BAND)
        ? 'season_asset'
        : perWeek <= week * (1 - AGREEMENT_BAND)
          ? 'this_week_only'
          : 'in_line';

  return {
    level,
    label: SEASON_OUTLOOK_LABELS[level],
    perWeek,
    detail: `market has him at ${perWeek.toFixed(1)} a week for the season, against ${week.toFixed(1)} this week`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
