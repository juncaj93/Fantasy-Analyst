/**
 * Three ways to read the same board.
 *
 * The board arrives ranked by the composite and that stays the default, because
 * it is the one ordering that has an opinion. The other two exist because
 * during a draft "who does the market have next" is a real question with a real
 * answer, and answering it by squinting at an ADP column is not the same as
 * being shown it.
 *
 * The only thing this module does is **reorder**. It is a pure function from a
 * list to a permutation of that list: the objects that come out are the objects
 * that went in, unmodified and un-cloned. Nothing here can touch Score, Val,
 * Next%, a tier, a tally, a queue flag or a My Guy rating, because it never
 * writes to a recommendation at all — which is a stronger guarantee than
 * remembering not to.
 *
 * ## Where the missing values go
 *
 * At the bottom, in every mode. A player the chosen market has not priced has
 * no position in that market's order, and inventing one — treating him as pick
 * zero, or as the deepest pick, or as his Sleeper number when the DOG column is
 * empty — is the substitution this whole feature is built to avoid. He keeps
 * his row, shows a dash, and sorts after everybody the market did price.
 *
 * Below the priced players, the unpriced ones keep the composite's order rather
 * than falling into alphabetical noise: the board's own opinion is the best
 * available tie-break when the market has none.
 */

/** The three orderings, and the ids the control uses. */
export const SORT_MODES = ['score', 'adp', 'dog'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const DEFAULT_SORT_MODE: SortMode = 'score';

/** The label each mode wears on the control. Short: it shares a row. */
export const SORT_LABELS: Record<SortMode, string> = {
  score: 'Score',
  adp: 'ADP',
  dog: 'DOG',
};

/** What each mode means, for the accessible name and the tooltip. */
export const SORT_DESCRIPTIONS: Record<SortMode, string> = {
  score: 'Sort by Fantasy Analyst score, the full composite ranking',
  adp: 'Sort by Sleeper ADP, earliest first',
  dog: 'Sort by raw Underdog ADP, earliest first',
};

/** The least a row must carry to be sorted. Anything richer also works. */
export interface SortableRow {
  /** The composite, 0-100. Higher is better. */
  score: number;
  /** The sum the composite is derived from — the board's own ordering key. */
  total: number;
  /** Sleeper ADP. */
  adp: number | null;
  /** Raw Underdog ADP. */
  dogAdp: number | null;
  name: string;
}

export function isSortMode(value: string | null | undefined): value is SortMode {
  return value != null && (SORT_MODES as readonly string[]).includes(value);
}

/**
 * The board, in the requested order.
 *
 * Returns a new array; the elements inside it are the caller's own objects, by
 * reference. `score` is the identity ordering in practice — the server already
 * sorted by the composite — but it is re-applied rather than assumed, so a
 * caller that has filtered, sliced or concatenated still gets the ordering it
 * asked for.
 */
export function sortBoard<T extends SortableRow>(rows: readonly T[], mode: SortMode): T[] {
  const out = [...rows];

  if (mode === 'score') {
    /*
     * The composite, exactly as the engine ordered it: `total` and not `score`.
     *
     * `score` is `total` squeezed through a logistic and rounded to a whole
     * number, so sorting on it collapses genuinely different players into ties
     * and then breaks those ties alphabetically — reordering rows the server
     * had deliberately separated. Sorting on `total` reproduces the board the
     * server sent, which is the promise "Score is the default" is making.
     */
    return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  const valueOf = (row: T): number | null => (mode === 'dog' ? row.dogAdp : row.adp);

  return out.sort((a, b) => {
    const av = usable(valueOf(a));
    const bv = usable(valueOf(b));
    // Missing values at the bottom, whichever market is being read.
    if (av == null && bv == null) return b.total - a.total || a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    // Ascending: the earliest pick is the top of the board.
    return av - bv || b.total - a.total || a.name.localeCompare(b.name);
  });
}

/**
 * Whether the DOG mode has anything to order by.
 *
 * A control offering a sort that produces one undifferentiated block of dashes
 * is the same mistake as a position chip that can only return nothing. The
 * caller may still render the mode — the board says why DOG is missing
 * elsewhere — but it can use this to say so rather than leaving the reader to
 * discover it by tapping.
 */
export function hasDogCoverage(rows: readonly SortableRow[]): boolean {
  return rows.some((row) => usable(row.dogAdp) != null);
}

/**
 * Orderable, which is a weaker question than valid.
 *
 * Any finite number has a place in an ascending order, and deciding here that
 * some of them do not would mean the ADP sort and the ADP column disagreed
 * about who is priced. Validity is settled at ingestion — see `underdog.ts`.
 */
function usable(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}
