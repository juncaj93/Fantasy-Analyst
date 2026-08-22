/**
 * "Receiving Yards" -> `season_receiving_yards`, and nothing by guesswork.
 *
 * A person copying a sportsbook table should never have to learn this app's
 * internal market keys, so every spelling a real table uses is listed here. The
 * list is explicit rather than fuzzy on purpose: a fuzzy matcher that maps an
 * unrecognised column onto the nearest key is how a rushing line becomes a
 * receiving one, and the two are the same magnitude for exactly the players
 * where it matters most.
 *
 * So an unknown market is rejected with the text that was not understood, and
 * the row is reported rather than dropped. The user can then correct the source
 * or route it through the normalisation fallback — both of which are better
 * than a board quietly holding a number under the wrong name.
 *
 * Everything here is season-scoped. A table of *weekly* props run through this
 * importer would map onto season keys and be stored as season totals, which is
 * the one confusion the whole two-scope design exists to prevent — so
 * `looksLikeWeeklyMagnitude` gives the caller a way to say so out loud.
 */

import { SEASON_MARKET_KEYS, type SeasonMarketKey } from '../vegas/types.ts';

/**
 * Every spelling seen on a real season-long table, normalised to lower case
 * with punctuation and spacing removed.
 *
 * Ordering is irrelevant — this is an exact lookup, and that is the point.
 */
const MARKET_ALIASES: Record<string, SeasonMarketKey> = {
  // passing yards
  passingyards: 'season_pass_yards',
  passyards: 'season_pass_yards',
  passyds: 'season_pass_yards',
  passingyds: 'season_pass_yards',
  seasonpassingyards: 'season_pass_yards',
  season_pass_yards: 'season_pass_yards',
  totalpassingyards: 'season_pass_yards',

  // passing touchdowns
  passingtouchdowns: 'season_pass_tds',
  passingtds: 'season_pass_tds',
  passtds: 'season_pass_tds',
  passingtd: 'season_pass_tds',
  season_pass_tds: 'season_pass_tds',
  totalpassingtouchdowns: 'season_pass_tds',

  // rushing yards
  rushingyards: 'season_rush_yards',
  rushyards: 'season_rush_yards',
  rushyds: 'season_rush_yards',
  rushingyds: 'season_rush_yards',
  season_rush_yards: 'season_rush_yards',
  totalrushingyards: 'season_rush_yards',

  // rushing touchdowns
  rushingtouchdowns: 'season_rush_tds',
  rushingtds: 'season_rush_tds',
  rushtds: 'season_rush_tds',
  season_rush_tds: 'season_rush_tds',
  totalrushingtouchdowns: 'season_rush_tds',

  // receptions
  receptions: 'season_receptions',
  receivingreceptions: 'season_receptions',
  catches: 'season_receptions',
  rec: 'season_receptions',
  season_receptions: 'season_receptions',
  totalreceptions: 'season_receptions',

  // receiving yards
  receivingyards: 'season_receiving_yards',
  recyards: 'season_receiving_yards',
  recyds: 'season_receiving_yards',
  receivingyds: 'season_receiving_yards',
  season_receiving_yards: 'season_receiving_yards',
  totalreceivingyards: 'season_receiving_yards',

  // receiving touchdowns
  receivingtouchdowns: 'season_receiving_tds',
  receivingtds: 'season_receiving_tds',
  rectds: 'season_receiving_tds',
  season_receiving_tds: 'season_receiving_tds',
  totalreceivingtouchdowns: 'season_receiving_tds',
};

/**
 * Markets a table may well carry that this app deliberately does not store.
 *
 * Named separately from "unknown" because they are different problems with
 * different answers: an unrecognised column might be a typo worth fixing, while
 * these are real markets the scoring model has no use for, and telling someone
 * to go and fix a column that was never wanted wastes their evening.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  passingattempts: 'passing attempts',
  passingcompletions: 'passing completions',
  passinginterceptions: 'interceptions thrown',
  interceptions: 'interceptions thrown',
  rushingattempts: 'rushing attempts',
  carries: 'rushing attempts',
  fantasypoints: 'fantasy points',
  anytimetouchdown: 'anytime touchdown',
  sacks: 'sacks',
  tackles: 'tackles',
  fieldgoals: 'field goals',
  wins: 'team wins',
  mvp: 'awards',
};

export function normalizeMarketText(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/\((?:o\/u|over\/under|ou)\)/g, ' ')
    .replace(/\b(?:o\/u|over\/under|total|season(?:[- ]long)?|reg(?:ular)?[- ]season|full[- ]season)\b/g, ' ')
    .replace(/[^a-z0-9_]+/g, '');
}

export type MarketLookup =
  | { ok: true; market: SeasonMarketKey }
  | { ok: false; reason: string; supported: boolean };

/**
 * Which internal market this column is, or exactly why it is not one.
 *
 * The failure carries prose rather than a code because it is shown to the
 * person who pasted the table, and "unsupported market" tells them nothing
 * about which column to look at.
 */
export function lookupSeasonMarket(raw: string): MarketLookup {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'no market named on this row', supported: false };

  const key = normalizeMarketText(text);
  // Checked before the alias table strips its qualifiers, so "total passing
  // yards" still resolves while "passing attempts" is refused by name.
  const direct = MARKET_ALIASES[key] ?? MARKET_ALIASES[text.toLowerCase().replace(/[^a-z0-9_]+/g, '')];
  if (direct) return { ok: true, market: direct };

  const unsupported = KNOWN_UNSUPPORTED[key];
  if (unsupported) {
    return {
      ok: false,
      reason: `"${text}" is ${unsupported}, which this app does not score against a season baseline`,
      supported: false,
    };
  }

  return {
    ok: false,
    reason: `"${text}" is not a market this app recognises`,
    supported: false,
  };
}

/** Every market this importer can store, for showing the user what is accepted. */
export const SUPPORTED_SEASON_MARKETS: readonly SeasonMarketKey[] = SEASON_MARKET_KEYS;

/**
 * Plausible whole-season magnitudes, used to catch a weekly table pasted here.
 *
 * Not a validity rule and deliberately not enforced as one — a line is the
 * market's opinion and this app does not get to overrule it. It is a warning
 * signal only: seventeen games of receiving yards is not 64.5, and a snapshot
 * full of numbers that size is a Sunday table in the wrong door.
 */
const SEASON_FLOOR: Record<SeasonMarketKey, number> = {
  season_pass_yards: 1000,
  season_pass_tds: 6,
  season_rush_yards: 150,
  season_rush_tds: 2,
  season_receptions: 15,
  season_receiving_yards: 150,
  season_receiving_tds: 2,
};

export function looksLikeWeeklyMagnitude(market: SeasonMarketKey, line: number): boolean {
  return Number.isFinite(line) && line < SEASON_FLOOR[market];
}
