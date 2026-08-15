/**
 * Market normalization + consensus.
 *
 * Vendor market names are mapped here and nowhere else. Contradictory quotes are
 * never silently merged: every contributing book is retained on the consensus
 * record.
 */

import { PlayerIndex, resolvePlayer } from '../identity/index.ts';
import type { MarketKey, PlayerProp, RawPropQuote } from './types.ts';

/**
 * External market name -> internal key.
 *
 * The Odds API keys are listed first; alternates and other vendors' spellings
 * follow. Unknown keys return null and are dropped rather than guessed.
 *
 * NOTE: verify against the live provider docs before enabling a real adapter —
 * see docs/VEGAS.md.
 */
const MARKET_ALIASES: Record<string, MarketKey> = {
  // The Odds API
  player_pass_yds: 'pass_yards',
  player_pass_tds: 'pass_tds',
  player_rush_yds: 'rush_yards',
  player_receptions: 'receptions',
  player_reception_yds: 'receiving_yards',
  player_anytime_td: 'anytime_td',
  // Common alternates / other vendors
  player_pass_yards: 'pass_yards',
  player_passing_yards: 'pass_yards',
  passing_yards: 'pass_yards',
  player_pass_touchdowns: 'pass_tds',
  passing_tds: 'pass_tds',
  player_rush_yards: 'rush_yards',
  rushing_yards: 'rush_yards',
  player_rec_yds: 'receiving_yards',
  player_receiving_yards: 'receiving_yards',
  receiving_yards: 'receiving_yards',
  receptions: 'receptions',
  player_recs: 'receptions',
  anytime_touchdown_scorer: 'anytime_td',
  anytime_td: 'anytime_td',
  player_td_anytime: 'anytime_td',
  to_score_a_touchdown: 'anytime_td',
};

/** Map a vendor market name to the internal vocabulary, or null if unsupported. */
export function normalizeMarket(external: string): MarketKey | null {
  if (!external) return null;
  const key = external.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return MARKET_ALIASES[key] ?? null;
}

/** American odds -> implied probability (still containing the vig). */
export function americanToProbability(odds: number | null): number | null {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/**
 * Remove the vig from a two-way market. With only one side priced the raw
 * implied probability is returned unchanged (and is therefore an overestimate —
 * callers should treat it as approximate).
 */
export function devig(overPrice: number | null, underPrice: number | null): number | null {
  const p = americanToProbability(overPrice);
  const q = americanToProbability(underPrice);
  if (p == null) return null;
  if (q == null) return round4(p);
  const total = p + q;
  if (total <= 0) return null;
  return round4(p / total);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

export interface ConsensusOptions {
  /** Drop quotes whose line deviates more than this fraction from the median. */
  outlierTolerance?: number;
}

/**
 * One quote per book, from however many that book sent.
 *
 * A provider that returns the same book twice for the same market — a retry
 * that landed, two events covering one game, an alternate-line row that maps to
 * the same key — must not get two votes. The median is a vote count, so a book
 * quoted twice pulls the consensus toward itself and, worse, lifts `bookCount`
 * off 1, which is the number the Start/Sit uncertainty penalty reads to decide
 * whether a market rests on a single book.
 *
 * Collapsed by taking the median of that book's own quotes, so a book that
 * genuinely moved mid-fetch contributes its middle line rather than whichever
 * row happened to arrive first. Order-independent by construction.
 */
export function oneQuotePerBook(group: RawPropQuote[]): RawPropQuote[] {
  const byBook = new Map<string, RawPropQuote[]>();
  for (const q of group) {
    const key = (q.book ?? '').toLowerCase();
    const list = byBook.get(key);
    if (list) list.push(q);
    else byBook.set(key, [q]);
  }

  const out: RawPropQuote[] = [];
  for (const quotes of byBook.values()) {
    if (quotes.length === 1) {
      out.push(quotes[0]!);
      continue;
    }
    const first = quotes[0]!;
    out.push({
      ...first,
      line: median(quotes.map((q) => q.line).filter((l): l is number => l != null)),
      overPrice: median(quotes.map((q) => q.overPrice).filter((p): p is number => p != null)),
      underPrice: median(quotes.map((q) => q.underPrice).filter((p): p is number => p != null)),
    });
  }
  return out;
}

/**
 * Collapse per-book quotes into one consensus row per (player, market).
 *
 * Players are resolved through the canonical identity ladder; an unresolved or
 * ambiguous name yields `playerId: null` and the row is retained with its
 * original source name so the review queue can fix it.
 *
 * Every book gets exactly one vote — see `oneQuotePerBook`.
 */
export function buildConsensus(
  quotes: RawPropQuote[],
  index: PlayerIndex,
  opts: ConsensusOptions = {},
): PlayerProp[] {
  const tolerance = opts.outlierTolerance ?? 0.25;
  const groups = new Map<string, RawPropQuote[]>();
  for (const q of quotes) {
    const key = `${q.playerName.toLowerCase()}|${q.market}`;
    const list = groups.get(key);
    if (list) list.push(q);
    else groups.set(key, [q]);
  }

  const out: PlayerProp[] = [];
  for (const raw of groups.values()) {
    const group = oneQuotePerBook(raw);
    const first = group[0]!;
    const match = resolvePlayer({ name: first.playerName }, index);

    const lines = group.map((g) => g.line).filter((l): l is number => l != null);
    const medianLine = median(lines);
    // Drop books whose line is implausibly far from the median.
    const kept = medianLine == null
      ? group
      : group.filter((g) => g.line == null || Math.abs(g.line - medianLine) <= Math.max(1, Math.abs(medianLine) * tolerance));

    const keptLines = kept.map((g) => g.line).filter((l): l is number => l != null);
    const line = median(keptLines);
    const overPrice = median(kept.map((g) => g.overPrice).filter((p): p is number => p != null));
    const underPrice = median(kept.map((g) => g.underPrice).filter((p): p is number => p != null));

    // Distinct books, never quote count: `bookCount` and `books` answer the same
    // question and a reader who compares them must not find them disagreeing.
    const books = [...new Set(kept.map((g) => g.book))].sort();

    out.push({
      playerId: match.status === 'matched' ? match.playerId : null,
      sourcePlayerName: first.playerName,
      market: first.market,
      line,
      overPrice: overPrice == null ? null : Math.round(overPrice),
      underPrice: underPrice == null ? null : Math.round(underPrice),
      bookCount: books.length,
      consensusMethod: books.length === 0 ? 'none' : books.length === 1 ? 'single' : 'median',
      books,
      impliedProbability:
        first.market === 'anytime_td'
          ? devig(overPrice == null ? null : Math.round(overPrice), underPrice == null ? null : Math.round(underPrice))
          : null,
    });
  }

  return out.sort((a, b) => a.sourcePlayerName.localeCompare(b.sourcePlayerName) || a.market.localeCompare(b.market));
}
