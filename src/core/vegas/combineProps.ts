/**
 * One look at a game, combined with what is stored, and what has to be written.
 *
 * The write-on-change half of Round 23. Every look used to store a full copy of
 * the game: 50 to 80 player lines, changed or not, about five database writes
 * each. Now a look is averaged by book (`combine.ts`), compared with the line
 * each player already has on file, and only a line whose combined number moved
 * is written. A line that is withdrawn everywhere gets a small "gone" marker so
 * readers stop showing it.
 *
 * "Moved" means a number a screen uses changed:
 *
 *   - the line (yards, catches, touchdown lines), one decimal;
 *   - the anytime-touchdown chance, by half a percentage point or more (it is
 *     the only market whose price feeds a number; yardage prices do not, see
 *     `startsit/propConversion.ts`, which needs both sides and is only given one);
 *   - whether one book or several stand behind it (the single-book penalty in
 *     Start/Sit reads exactly that).
 *
 * Pure: no clock, no database, no provider.
 */

import { resolvePlayer, type PlayerIndex } from '../identity/index.ts';
import {
  americanToChance,
  bookKey,
  chanceToAmerican,
  combineBookValues,
  kindForMarket,
  type BookValue,
  type Combined,
} from './combine.ts';
import type { BookQuote, MarketKey, PlayerProp, RawPropQuote } from './types.ts';

/** The line a player has on file for one market, as the reader would see it. */
export interface StoredLine extends PlayerProp {
  /** True when the newest stored row is a "gone" marker. */
  gone: boolean;
}

export interface LookResult {
  /** Every line the game has after this look (gone ones left out). */
  current: PlayerProp[];
  /** The rows to write: changed or new lines, and "gone" markers. */
  changed: PlayerProp[];
}

const key = (name: string, market: MarketKey) => `${name.trim().toLowerCase()}|${market}`;

/** The chance moved by at least this much before it counts as a change. */
export const CHANCE_STEP = 0.005;

/**
 * Combine one look's quotes with the stored lines.
 *
 * `quotes` are one per book per player per market, as the adapter sends them.
 * `stored` are the lines on file for the same game (newest per player and
 * market). `now` is the look's own time; `kickoff` sets the freshness window.
 */
export function combineLook(
  quotes: readonly RawPropQuote[],
  stored: readonly StoredLine[],
  index: PlayerIndex,
  opts: { now: number; kickoff: string | null; source: string },
): LookResult {
  const at = new Date(opts.now).toISOString();
  const groups = new Map<string, { name: string; market: MarketKey; books: BookQuote[] }>();
  for (const q of quotes) {
    const k = key(q.playerName, q.market);
    const g = groups.get(k) ?? { name: q.playerName, market: q.market, books: [] };
    g.books.push({ book: q.book, line: q.line, price: q.overPrice, at: q.at ?? at, source: opts.source });
    groups.set(k, g);
  }
  const onFile = new Map<string, StoredLine>();
  for (const s of stored) onFile.set(key(s.sourcePlayerName, s.market), s);

  const current: PlayerProp[] = [];
  const changed: PlayerProp[] = [];
  const keys = new Set([...groups.keys(), ...onFile.keys()]);
  for (const k of keys) {
    const group = groups.get(k);
    const held = onFile.get(k) ?? null;
    const name = group?.name ?? held!.sourcePlayerName;
    const market = group?.market ?? held!.market;
    // This look's books win over the same book on file; the rest carry on
    // until they are too old to count.
    const merged = mergeBooks(held?.bookDetail ?? [], group?.books ?? []);
    const line = combineMarket(market, merged, opts);

    const playerId =
      held?.playerId ??
      (() => {
        const match = resolvePlayer({ name }, index);
        return match.status === 'matched' ? match.playerId : null;
      })();

    const next: PlayerProp =
      line.value == null
        ? {
            playerId,
            sourcePlayerName: name,
            market,
            line: null,
            overPrice: null,
            underPrice: null,
            bookCount: 0,
            consensusMethod: 'none',
            books: [],
            impliedProbability: null,
            bookDetail: [],
          }
        : {
            playerId,
            sourcePlayerName: name,
            market,
            line: line.line,
            overPrice: line.price,
            underPrice: null,
            bookCount: line.kept.length,
            consensusMethod: line.method,
            books: [...new Set(line.kept.map((b) => b.book))].sort(),
            impliedProbability: line.chance,
            bookDetail: line.fresh.map((b) =>
              line.kept.some((k) => bookKey(k.book) === bookKey(b.book)) ? { ...b, out: undefined } : { ...b, out: true },
            ),
          };

    if (next.consensusMethod !== 'none') current.push(next);
    if (differs(held, next)) changed.push(next);
  }

  const order = (a: PlayerProp, b: PlayerProp) =>
    a.sourcePlayerName.localeCompare(b.sourcePlayerName) || a.market.localeCompare(b.market);
  return { current: current.sort(order), changed: changed.sort(order) };
}

/** Did a number a screen uses change? A missing or gone stored line counts as "no line". */
export function differs(held: StoredLine | null, next: PlayerProp): boolean {
  const before = held && !held.gone && held.consensusMethod !== 'none' ? held : null;
  const after = next.consensusMethod === 'none' ? null : next;
  if (!before && !after) return false;
  if (!before || !after) return true;
  if ((before.line ?? null) !== (after.line ?? null)) return true;
  if (next.market === 'anytime_td') {
    const a = before.impliedProbability;
    const b = after.impliedProbability;
    if ((a == null) !== (b == null)) return true;
    if (a != null && b != null && Math.abs(a - b) >= CHANCE_STEP) return true;
  }
  return (before.bookCount === 1) !== (after.bookCount === 1);
}

function mergeBooks(held: readonly BookQuote[], fresh: readonly BookQuote[]): BookQuote[] {
  const out = new Map<string, BookQuote>();
  for (const b of held) out.set(bookKey(b.book), b);
  for (const b of fresh) {
    const k = bookKey(b.book);
    const was = out.get(k);
    if (!was || Date.parse(b.at) >= Date.parse(was.at)) out.set(k, b);
  }
  return [...out.values()];
}

interface MarketLine {
  value: number | null;
  line: number | null;
  price: number | null;
  chance: number | null;
  method: Combined['method'];
  kept: BookQuote[];
  /** Every fresh book, kept or not, to carry to the next look. */
  fresh: BookQuote[];
}

function combineMarket(
  market: MarketKey,
  books: readonly BookQuote[],
  opts: { now: number; kickoff: string | null },
): MarketLine {
  const none: MarketLine = { value: null, line: null, price: null, chance: null, method: 'none', kept: [], fresh: [] };
  const byKey = new Map(books.map((b) => [bookKey(b.book), b]));
  const pick = (values: BookValue[]) => values.map((v) => byKey.get(bookKey(v.book))!).filter(Boolean);

  if (market === 'anytime_td') {
    /*
     * A touchdown market is a price, not a line: the chance is what is averaged.
     * Books on different lines (0.5 against 1.5) are not the same bet, so the
     * line most books quote is used and the rest set aside.
     */
    const withPrice = books.filter((b) => americanToChance(b.price) != null);
    const counts = new Map<number, number>();
    for (const b of withPrice) {
      const l = b.line ?? 0.5;
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const chosen = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (chosen == null) return none;
    const values: BookValue[] = withPrice
      .filter((b) => (b.line ?? 0.5) === chosen)
      .map((b) => ({ book: b.book, value: americanToChance(b.price)!, at: b.at }));
    const c = combineBookValues(values, 'anytime_td', opts);
    if (c.value == null) return none;
    return {
      value: c.value,
      line: chosen,
      price: chanceToAmerican(c.value),
      chance: c.value,
      method: c.method,
      kept: pick(c.kept),
      fresh: pick(c.freshValues),
    };
  }

  const values: BookValue[] = books
    .filter((b) => b.line != null && Number.isFinite(b.line))
    .map((b) => ({ book: b.book, value: b.line!, at: b.at }));
  const c = combineBookValues(values, kindForMarket(market), opts);
  if (c.value == null) return none;
  const kept = pick(c.kept);
  const chances = kept.map((b) => americanToChance(b.price)).filter((p): p is number => p != null);
  const price = chances.length ? chanceToAmerican(chances.reduce((a, b) => a + b, 0) / chances.length) : null;
  return { value: c.value, line: c.value, price, chance: null, method: c.method, kept, fresh: pick(c.freshValues) };
}
