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
  /**
   * The composite, 0-100. Higher is better. Null when no market priced him and
   * his total is therefore not on the same scale as anybody else's.
   */
  score: number | null;
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

  /*
   * Unscored players last, before anything else is considered.
   *
   * This is the engine's own first sort key and it has to be reproduced here,
   * because reproducing only the *second* one is what put seven players
   * carrying `ADP —`, `Val —` and `Next —` at the top of the board. A player no
   * market has priced has a total near zero — market value is absent rather
   * than low — and zero beats the negative total every priced player carries
   * until the draft reaches his ADP. Ordering on `total` alone therefore floats
   * exactly the players the board knows least about.
   *
   * `score` is null for precisely those players, so it is the cheapest correct
   * test, and it keeps the client's ordering tied to the same fact the Score
   * column is showing rather than to a second rule that can drift from it.
   */
  const unscoredLast = (a: T, b: T): number => Number(a.score == null) - Number(b.score == null);
  const byComposite = (a: T, b: T): number =>
    unscoredLast(a, b) || b.total - a.total || a.name.localeCompare(b.name);

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
    return out.sort(byComposite);
  }

  const valueOf = (row: T): number | null => (mode === 'dog' ? row.dogAdp : row.adp);

  return out.sort((a, b) => {
    const av = usable(valueOf(a));
    const bv = usable(valueOf(b));
    // Missing values at the bottom, whichever market is being read.
    if (av == null && bv == null) return byComposite(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    // Ascending: the earliest pick is the top of the board.
    return av - bv || byComposite(a, b);
  });
}

/**
 * Which order the board is actually in, given everything that has an opinion.
 *
 * Three things can claim to order these rows and exactly one of them wins at a
 * time. Written as a function rather than left as a ternary in the screen
 * because the precedence *is* the feature, and a precedence living inside a
 * React component can only be checked by driving a browser — which is how it
 * came to be wrong without anything noticing.
 *
 * The order of the checks below is the whole specification:
 *
 *  1. **A drag that has not landed yet.** While the round trip is in flight the
 *     row stays where it was dropped. Without this it snaps back for the length
 *     of a request, which reads as the drop having failed.
 *  2. **The stored queue order**, whenever the queue is what is on screen. The
 *     server already returns the ★ filter in the reader's order, so this is
 *     mostly a matter of *not* re-sorting it.
 *  3. **The selected sort mode**, for the ordinary board.
 *
 * The bug this replaces: step 3 ran inside the queue whenever the selected mode
 * was not Score. A reader who had been reading the board by DOG could drag a
 * row anywhere and `sortBoard` put it straight back on the next render. Nothing
 * was wrong with the drag; the queue was simply not the authority on its own
 * order.
 *
 * `sort` is deliberately still an input, and deliberately unused in the queue
 * branch. The mode the reader chose is *remembered* rather than overridden, so
 * leaving the queue puts them back on the board they were reading instead of
 * making them reselect it.
 */
export function orderBoardRows<T extends SortableRow & { playerId: string }>(
  rows: readonly T[],
  view: {
    /** True when the ★ queue is the current filter. */
    isQueue: boolean;
    /** The sort mode the reader has selected, for the ordinary board. */
    sort: SortMode;
    /**
     * Ids in the order a drag just put them, before the server has confirmed
     * it. Null at rest, and ignored outside the queue — a sequence of queued
     * ids is not an ordering of the full board.
     */
    pendingQueueOrder?: readonly string[] | null;
  },
): T[] {
  if (!view.isQueue) return sortBoard(rows, view.sort);
  return view.pendingQueueOrder ? reorderByIds(rows, view.pendingQueueOrder) : [...rows];
}

/**
 * Rows in the sequence named by `ids`, with anything unnamed left at the end.
 *
 * Tolerant on purpose. A drag commits an order for the rows that were on screen
 * when it started, and by the time it lands a pick may have removed one of them
 * or a star pressed on another screen may have added one. Neither is an error,
 * and neither may drop a row: ids that no longer exist are skipped, and rows the
 * sequence does not mention keep their incoming order after the ones it does.
 */
export function reorderByIds<T extends { playerId: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.playerId, row]));
  const out: T[] = [];
  const placed = new Set<string>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || placed.has(id)) continue;
    out.push(row);
    placed.add(id);
  }
  for (const row of rows) if (!placed.has(row.playerId)) out.push(row);
  return out;
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
