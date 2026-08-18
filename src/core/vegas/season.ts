/**
 * Season-long market expectations, in this league's points.
 *
 * A betting line is not a projection and this module is careful never to turn
 * one into the other. What it does is arithmetic the user could do themselves:
 * the market says 1,085 receiving yards, this league pays 0.1 a yard, so that
 * is 108.5 points of receiving yardage. Nothing is assumed about the markets
 * that are missing — a receiver with no reception market is not a receiver with
 * zero receptions, so the result carries its own coverage and says what it did
 * not have.
 *
 * The same normalised shape serves the weekly Start/Sit layer, which asks the
 * identical question over one game rather than a season.
 */

import { resolvePlayer } from '../identity/index.ts';
import type { PlayerIndex } from '../identity/index.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import { SEASON_MARKET_KEYS, type SeasonMarketKey, type SeasonMarketQuote } from './types.ts';

/** One market for one canonical player, after identity resolution. */
export interface PlayerSeasonMarket {
  /** Null when the provider's name could not be resolved. Never guessed. */
  playerId: string | null;
  sourcePlayerName: string;
  market: SeasonMarketKey;
  line: number | null;
  book: string;
  bookCount: number;
}

/**
 * Resolve provider names to canonical players, and take one line per market.
 *
 * The same identity ladder the newsletter uses — no second matcher, no fuzzy
 * fallback. A name that does not resolve to exactly one player keeps its quote
 * with a null id: it is stored so it can be audited and repaired, and it
 * contributes to nothing until somebody says who it is.
 */
export function resolveSeasonMarkets(quotes: SeasonMarketQuote[], index: PlayerIndex): PlayerSeasonMarket[] {
  const groups = new Map<string, SeasonMarketQuote[]>();
  for (const quote of quotes) {
    const key = `${quote.playerName.toLowerCase()}|${quote.market}`;
    const list = groups.get(key);
    if (list) list.push(quote);
    else groups.set(key, [quote]);
  }

  const out: PlayerSeasonMarket[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const match = resolvePlayer({ name: first.playerName }, index);
    /*
     * One vote per book.
     *
     * The consensus line is a median, and a median is a vote count: a provider
     * that returns the same book twice — a retry that landed, two events
     * covering one season market — would otherwise pull the line toward that
     * book and report a `bookCount` that overstates how many opinions are
     * actually behind it. A book that quoted more than once contributes its own
     * middle line, which is order-independent.
     */
    const byBook = new Map<string, number[]>();
    for (const quote of group) {
      const key = (quote.book ?? '').toLowerCase();
      const list = byBook.get(key);
      const line = quote.line;
      if (list) {
        if (line != null) list.push(line);
      } else {
        byBook.set(key, line == null ? [] : [line]);
      }
    }
    const perBook = [...byBook.values()]
      .map((lines) => median(lines))
      .filter((l): l is number => l != null);

    out.push({
      playerId: match.status === 'matched' ? match.playerId : null,
      sourcePlayerName: first.playerName,
      market: first.market,
      line: median(perBook),
      book: first.book,
      bookCount: byBook.size,
    });
  }

  return out.sort(
    (a, b) => a.sourcePlayerName.localeCompare(b.sourcePlayerName) || a.market.localeCompare(b.market),
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface BaselineContribution {
  market: SeasonMarketKey;
  line: number;
  points: number;
  detail: string;
}

export interface MarketBaseline {
  /** Fantasy points implied by the markets that exist. Null when none do. */
  points: number | null;
  /**
   * How much of what this position usually scores on had a market, 0..1.
   *
   * A quarterback priced on passing yards alone is a partial picture, and the
   * number that says so travels with the number it qualifies.
   */
  coverage: number;
  contributions: BaselineContribution[];
  /** Markets this position usually has that were absent. Not treated as zero. */
  missing: SeasonMarketKey[];
  /** Plain-language summary, e.g. "partial — receiving yards and receptions". */
  note: string;
}

/**
 * The markets that matter for each position, in the order a reader would want
 * them. Anything outside this list still scores if it is present; the list is
 * what "complete coverage" means for the position.
 */
const POSITION_MARKETS: Record<string, SeasonMarketKey[]> = {
  QB: ['season_pass_yards', 'season_pass_tds', 'season_rush_yards'],
  RB: ['season_rush_yards', 'season_rush_tds', 'season_receptions', 'season_receiving_yards'],
  WR: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
  TE: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
};

const MARKET_LABEL: Record<SeasonMarketKey, string> = {
  season_pass_yards: 'passing yards',
  season_pass_tds: 'passing TDs',
  season_rush_yards: 'rushing yards',
  season_rush_tds: 'rushing TDs',
  season_receptions: 'receptions',
  season_receiving_yards: 'receiving yards',
  season_receiving_tds: 'receiving TDs',
};

/** Short label for a compact card, e.g. "1,085 rec yds". */
const MARKET_UNIT: Record<SeasonMarketKey, string> = {
  season_pass_yards: 'pass yds',
  season_pass_tds: 'pass TD',
  season_rush_yards: 'rush yds',
  season_rush_tds: 'rush TD',
  season_receptions: 'rec',
  season_receiving_yards: 'rec yds',
  season_receiving_tds: 'rec TD',
};

/** How many points one unit of each market is worth in this league. */
function rateFor(market: SeasonMarketKey, position: string, profile: ScoringProfile): number {
  switch (market) {
    case 'season_pass_yards':
      return profile.pointsPerPassYard;
    case 'season_pass_tds':
      return profile.passTd;
    case 'season_rush_yards':
      return profile.pointsPerRushYard;
    case 'season_rush_tds':
      return profile.rushTd;
    case 'season_receptions':
      // Tight-end premium is part of the league's own scoring, so it is part of
      // the arithmetic rather than a special case bolted on later.
      return profile.ppr + (position === 'TE' ? profile.teBonus : 0);
    case 'season_receiving_yards':
      return profile.pointsPerRecYard;
    case 'season_receiving_tds':
      return profile.recTd;
  }
}

/**
 * Turn the season markets a player actually has into this league's points.
 *
 * Returns `points: null` when nothing is priced — never zero, which would read
 * as "the market expects nothing from him".
 */
export function seasonBaseline(
  position: string,
  markets: { market: SeasonMarketKey; line: number | null }[],
  profile: ScoringProfile,
): MarketBaseline {
  const pos = (position ?? '').toUpperCase();
  const expected = POSITION_MARKETS[pos] ?? SEASON_MARKET_KEYS;

  const byMarket = new Map<SeasonMarketKey, number>();
  for (const m of markets) {
    if (m.line == null || !Number.isFinite(m.line)) continue;
    // Providers occasionally quote the same market twice; the first is kept so
    // the result does not depend on array order beyond that.
    if (!byMarket.has(m.market)) byMarket.set(m.market, m.line);
  }

  const contributions: BaselineContribution[] = [];
  let points = 0;
  for (const [market, line] of byMarket) {
    const rate = rateFor(market, pos, profile);
    const value = round2(line * rate);
    points += value;
    contributions.push({
      market,
      line,
      points: value,
      detail: `${formatLine(line)} ${MARKET_LABEL[market]} × ${rate} = ${value} pts`,
    });
  }

  const missing = expected.filter((m) => !byMarket.has(m));
  const coverage = expected.length === 0 ? 0 : round2((expected.length - missing.length) / expected.length);

  if (contributions.length === 0) {
    return {
      points: null,
      coverage: 0,
      contributions: [],
      missing: expected,
      note: 'no season market for this player',
    };
  }

  // Sorted by size so the biggest driver of the number is the first thing read.
  contributions.sort((a, b) => b.points - a.points);

  const covered = contributions.map((c) => MARKET_LABEL[c.market]);
  return {
    points: round2(points),
    coverage,
    contributions,
    missing,
    note:
      missing.length === 0
        ? `complete — ${list(covered)}`
        : `partial — ${list(covered)} available, no market for ${list(missing.map((m) => MARKET_LABEL[m]))}`,
  };
}

/**
 * The one or two numbers worth a line on a draft card.
 *
 * Market expectation, not a bet: no prices, no over/under language, no book
 * names. If only one market exists, one is shown; if none, nothing is — an
 * empty placeholder costs the same space as a real number and says less.
 */
export function seasonHeadline(
  position: string,
  markets: { market: SeasonMarketKey; line: number | null }[],
  limit = 2,
): string | null {
  const pos = (position ?? '').toUpperCase();
  const order = POSITION_MARKETS[pos] ?? SEASON_MARKET_KEYS;
  const byMarket = new Map<SeasonMarketKey, number>();
  for (const m of markets) {
    if (m.line == null || !Number.isFinite(m.line)) continue;
    if (!byMarket.has(m.market)) byMarket.set(m.market, m.line);
  }

  const parts: string[] = [];
  for (const market of order) {
    const line = byMarket.get(market);
    if (line == null) continue;
    parts.push(`${formatLine(line)} ${MARKET_UNIT[market]}`);
    if (parts.length >= limit) break;
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** How many priced peers a comparison needs before it means anything. */
export const MIN_COMPARABLE_PEERS = 3;

/**
 * How a player's market baseline compares with the pool at his position.
 *
 * Scored in [-1, 1] against the position's own spread, because a thousand
 * receiving yards means one thing among receivers and another among tight ends.
 *
 * ## Like for like, which is the whole of this function
 *
 * A baseline is the sum of the markets a player actually has. That makes two
 * baselines built from different market sets **incomparable numbers**, and
 * comparing them anyway is how a missing market turns into a negative opinion:
 * a receiver priced on receiving yards alone implies about 140 points, a
 * receiver priced on yards, receptions and touchdowns implies about 250, and a
 * pool built from the second kind rates the first as a bottom-of-the-position
 * player. Nothing about him is worse. Two of his markets are simply absent, and
 * §15 of the audit brief is explicit that a missing market is not a negative.
 *
 * So the comparison is restricted to the markets *he* has, and to the peers who
 * have at least all of them, each peer re-totalled over that same set. His
 * receiving yards are compared with their receiving yards. When too few peers
 * carry his markets there is no honest comparison to make and the answer is
 * `null` — unknown, which is not zero and is certainly not negative.
 *
 * Coverage still multiplies the result, and now does only what it claims to: a
 * partial picture is less informative, so it is allowed to move the board less.
 * It is a damper on confidence, never a direction.
 */
export function marketExpectationScore(
  baseline: MarketBaseline | null,
  pool: MarketBaseline[],
): number | null {
  if (baseline == null || baseline.points == null) return null;
  const markets = baseline.contributions.map((c) => c.market);
  if (markets.length === 0) return null;

  const comparable: number[] = [];
  for (const peer of pool) {
    if (peer === baseline) continue;
    const byMarket = new Map(peer.contributions.map((c) => [c.market, c.points]));
    // Only peers priced on everything he is priced on. A peer missing one of
    // his markets would contribute a partial total to the comparison pool and
    // reintroduce the very bias this function exists to remove.
    if (!markets.every((m) => byMarket.has(m))) continue;
    comparable.push(round2(markets.reduce((total, m) => total + (byMarket.get(m) ?? 0), 0)));
  }
  if (comparable.length < MIN_COMPARABLE_PEERS) return null;

  const sorted = comparable.sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const spread = Math.max(1, quantile(sorted, 0.75) - quantile(sorted, 0.25));
  const raw = (baseline.points - median) / spread;
  return round3(clamp(raw, -1, 1) * clamp(baseline.coverage, 0, 1));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next == null ? sorted[base]! : sorted[base]! + rest * (next - sorted[base]!);
}

function list(items: string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** 1085 -> "1,085"; 8.5 -> "8.5". Season totals are large enough to need commas. */
export function formatLine(line: number): string {
  const rounded = Math.round(line * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toLocaleString('en-US') : rounded.toLocaleString('en-US');
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
