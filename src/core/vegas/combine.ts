/**
 * Averaging sportsbooks, not providers (Round 23, Alex: "more data the better,
 * just average it").
 *
 * Every odds API resells the same handful of books, so DraftKings' 64.5 seen
 * through two APIs is one opinion, not two. Each number (a player's line, a game
 * total, a spread) is combined from up to one value per **book**, deduplicated by
 * book name and kept from whichever source saw it most recently.
 *
 * The rules, from the Round 21 research (docs/vegas/ROUND21_SOURCES.md, section 6):
 *
 *   - **Fresh only.** A book's value counts while it was seen within 12 hours
 *     (game more than 24 hours out), 3 hours (2 to 24 hours out) or 45 minutes
 *     (under 2 hours out). Older values are ignored.
 *   - **Three or more books:** drop any book further from the median than the
 *     market's band, then average what is left.
 *   - **Two books:** average them when they are inside the band, otherwise use
 *     the one seen most recently.
 *   - **One book:** use it as is.
 *   - **No fresh book:** no number. Downstream that is the minus-1 rule, unchanged.
 *
 * Bands: total 3.0 points, spread 2.5, yards the larger of 10 yards and 15%,
 * receptions 1.0, touchdown lines 0.5, anytime touchdown 15 percentage points.
 *
 * Pure: no clock, no database, no provider.
 */

import type { MarketKey } from './types.ts';

/** What kind of number is being combined, which decides its outlier band. */
export type LineKind = 'total' | 'spread' | 'yards' | 'receptions' | 'td_line' | 'anytime_td';

export function kindForMarket(market: MarketKey): LineKind {
  switch (market) {
    case 'pass_yards':
    case 'rush_yards':
    case 'receiving_yards':
      return 'yards';
    case 'receptions':
      return 'receptions';
    case 'pass_tds':
      return 'td_line';
    case 'anytime_td':
      return 'anytime_td';
  }
}

/** How far from the median a book may sit before it is dropped as an outlier. */
export function outlierBand(kind: LineKind, centre: number): number {
  switch (kind) {
    case 'total':
      return 3.0;
    case 'spread':
      return 2.5;
    case 'yards':
      return Math.max(10, Math.abs(centre) * 0.15);
    case 'receptions':
      return 1.0;
    case 'td_line':
      return 0.5;
    case 'anytime_td':
      return 0.15;
  }
}

/**
 * How recently a book must have been seen to count, in minutes.
 *
 * Unknown kickoff is treated as far out (the widest window), the same way the
 * staleness table treats it.
 */
export function freshWindowMinutes(hoursToKickoff: number | null): number {
  if (hoursToKickoff == null || !Number.isFinite(hoursToKickoff) || hoursToKickoff > 24) return 12 * 60;
  if (hoursToKickoff >= 2) return 3 * 60;
  return 45;
}

/** One book's value for one number. */
export interface BookValue {
  /** The book's name as the source spelled it ("draftkings", "DraftKings"). */
  book: string;
  value: number;
  /** When this value was seen, ISO. */
  at: string;
  /** The odds API that delivered it, for audit. */
  source?: string;
}

export interface Combined {
  /** The combined number, one decimal (anytime touchdown: a probability, four). Null when no fresh book. */
  value: number | null;
  /** The books that made the number, after staleness and outliers. */
  kept: BookValue[];
  /** How many fresh books there were before the outlier step. */
  fresh: number;
  /** Those fresh books, kept or not (what is worth carrying to the next look). */
  freshValues: BookValue[];
  method: 'none' | 'single' | 'average' | 'newest';
}

/** "DraftKings", "draftkings" and "draft_kings" are one book. */
export function bookKey(book: string): string {
  return (book ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ms = (iso: string): number => Date.parse(iso);

/**
 * One value per book: the newest. A book quoted twice must not get two votes.
 * Values with no readable time are kept but sort as oldest.
 */
export function latestPerBook(values: readonly BookValue[]): BookValue[] {
  const byBook = new Map<string, BookValue>();
  for (const v of values) {
    if (!Number.isFinite(v.value)) continue;
    const key = bookKey(v.book);
    if (!key) continue;
    const held = byBook.get(key);
    const at = ms(v.at);
    const heldAt = held ? ms(held.at) : NaN;
    if (!held || (Number.isFinite(at) && (!Number.isFinite(heldAt) || at > heldAt))) byBook.set(key, v);
  }
  return [...byBook.values()];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function round(value: number, kind: LineKind): number {
  return kind === 'anytime_td' ? Math.round(value * 10_000) / 10_000 : Math.round(value * 10) / 10;
}

/**
 * Combine the books' values for one number, by the rules above.
 *
 * `now` is when the combining happens; `kickoff` decides the freshness window.
 */
export function combineBookValues(
  values: readonly BookValue[],
  kind: LineKind,
  opts: { now: number; kickoff: string | number | null },
): Combined {
  const kickoff = typeof opts.kickoff === 'number' ? opts.kickoff : opts.kickoff ? ms(opts.kickoff) : NaN;
  const hours = Number.isFinite(kickoff) ? (kickoff - opts.now) / 3_600_000 : null;
  const window = freshWindowMinutes(hours) * 60_000;
  const fresh = latestPerBook(values).filter((v) => {
    const at = ms(v.at);
    return Number.isFinite(at) && opts.now - at <= window;
  });

  if (fresh.length === 0) return { value: null, kept: [], fresh: 0, freshValues: [], method: 'none' };
  if (fresh.length === 1) return { value: round(fresh[0]!.value, kind), kept: fresh, fresh: 1, freshValues: fresh, method: 'single' };

  if (fresh.length === 2) {
    const [a, b] = fresh as [BookValue, BookValue];
    const mean = (a.value + b.value) / 2;
    if (Math.abs(a.value - b.value) <= outlierBand(kind, mean)) {
      return { value: round(mean, kind), kept: fresh, fresh: 2, freshValues: fresh, method: 'average' };
    }
    const newest = ms(a.at) >= ms(b.at) ? a : b;
    return { value: round(newest.value, kind), kept: [newest], fresh: 2, freshValues: fresh, method: 'newest' };
  }

  const centre = median(fresh.map((v) => v.value));
  const band = outlierBand(kind, centre);
  const kept = fresh.filter((v) => Math.abs(v.value - centre) <= band);
  // Books split in two far camps leave nothing inside the band: the median is
  // still the honest middle, so every book is kept and the median stands.
  if (kept.length === 0) return { value: round(centre, kind), kept: fresh, fresh: fresh.length, freshValues: fresh, method: 'average' };
  const mean = kept.reduce((sum, v) => sum + v.value, 0) / kept.length;
  return { value: round(mean, kind), kept, fresh: fresh.length, freshValues: fresh, method: kept.length === 1 ? 'single' : 'average' };
}

// ------------------------------------------------------------- odds <-> chance

/** American odds to the implied chance (vig still in). */
export function americanToChance(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/** A chance back to American odds, whole numbers. */
export function chanceToAmerican(p: number | null | undefined): number | null {
  if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

// ------------------------------------------------------------- game lines

/** One book's game lines, as one source saw them. */
export interface GameBookLine {
  book: string;
  total: number | null;
  /** The handicap from `spreadTeam`'s side. Negative = favoured. */
  spread: number | null;
  spreadTeam: string | null;
  at: string;
  source?: string;
}

export interface CombinedGameLines {
  total: number | null;
  spread: number | null;
  spreadTeam: string | null;
  totalBooks: number;
  spreadBooks: number;
}

/**
 * The game's combined total and spread.
 *
 * Spreads are turned to one team's side before they are compared, because a
 * book quoting the favourite at -3.5 and another quoting the underdog at +3.5
 * agree. `teams` is the game's two sides in the app's codes; a spread whose team
 * is neither is dropped rather than guessed. The side kept is `prefer` when
 * given (the side already stored, so a combined line never flips sign just
 * because the first book in the list changed), else the first book's.
 */
export function combineGameLines(
  books: readonly GameBookLine[],
  teams: readonly string[],
  opts: { now: number; kickoff: string | number | null; prefer?: string | null },
): CombinedGameLines {
  const totals: BookValue[] = [];
  for (const b of books) {
    if (b.total != null && Number.isFinite(b.total)) totals.push({ book: b.book, value: b.total, at: b.at, source: b.source });
  }
  const total = combineBookValues(totals, 'total', opts);

  const sides = teams.map((t) => t.toUpperCase());
  const ref =
    (opts.prefer && sides.includes(opts.prefer.toUpperCase()) ? opts.prefer.toUpperCase() : null) ??
    books.map((b) => b.spreadTeam?.toUpperCase() ?? null).find((t) => t != null && (sides.length === 0 || sides.includes(t))) ??
    null;
  const spreads: BookValue[] = [];
  if (ref) {
    const other = sides.find((t) => t !== ref) ?? null;
    for (const b of books) {
      if (b.spread == null || !Number.isFinite(b.spread) || !b.spreadTeam) continue;
      const team = b.spreadTeam.toUpperCase();
      const value = team === ref ? b.spread : other != null && team === other ? -b.spread : null;
      if (value == null) continue;
      spreads.push({ book: b.book, value, at: b.at, source: b.source });
    }
  }
  const spread = combineBookValues(spreads, 'spread', opts);
  return {
    total: total.value,
    spread: spread.value,
    spreadTeam: spread.value == null ? null : ref,
    totalBooks: total.kept.length,
    spreadBooks: spread.kept.length,
  };
}
