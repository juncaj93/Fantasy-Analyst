/**
 * The best few unrostered players at each position this league starts.
 *
 * Ordered by the imported draft ranking, falling back to Sleeper's own
 * `search_rank` where no ranking covers a position. That is an ordering, not a
 * judgement — the actual comparison is the same start/sit engine everything else
 * uses, run afterwards on this shortlist.
 *
 * Shared rather than private to the API handler so that a demo's wire is bounded
 * the same way a live one is. A demo that scanned a different pool would answer
 * a different question and look like it had answered this one.
 */

import type { CanonicalPlayer } from '../identity/types.ts';

/**
 * How many unrostered players per position the waiver scan will score.
 *
 * The pool is thousands of players and the intelligence is not free, so the
 * scan takes a bounded slice off the top of the draft order instead. Twelve is
 * comfortably past where a startable free agent is ever found, and it keeps the
 * whole scan to a few dozen players — which is what keeps Team quick on a phone.
 */
export const FREE_AGENTS_PER_POSITION = 12;

/**
 * Positions whose entire league-wide supply is one per NFL team.
 *
 * These are scanned whole, and the reason is that the bound above cannot be
 * applied to them *meaningfully*. It slices off the top of an ordering, and a
 * team defence has no ordering: Sleeper publishes no ADP and no useful
 * `search_rank` for one, so every defence ties at the bottom of both keys and
 * the sort falls through to its last tie-break, the name.
 *
 * Measured on production on 16 September, the defences the waiver scan had to
 * choose between were:
 *
 *     ARI ATL BUF CAR CHI CIN CLE DAL GB IND LV LAC
 *
 * Arizona through Los Angeles, alphabetically, and then it stops. Twelve of
 * thirty-two, chosen by first letter. Tampa Bay and San Francisco — the two a
 * reader could see were the week's obvious streams — sit at 26th and 23rd in
 * the alphabet and had never once been reachable. The lane was not ranking them
 * badly; it had never been shown them.
 *
 * Scanning all of them is affordable in a way that scanning all receivers is
 * not, and the difference is the whole justification: a position with thousands
 * of free agents needs a bound or the scan is unbounded work, and a position
 * with at most thirty-two in existence has a natural one. {@link WHOLE_POSITION_CAP}
 * keeps that claim true even if a league invents a position this app has not
 * seen.
 */
export const WHOLE_SLATE_POSITIONS: ReadonlySet<string> = new Set(['DEF', 'DST', 'D/ST']);

/**
 * The hard ceiling on a whole-slate position, so "scan them all" stays bounded.
 *
 * Thirty-two, one per NFL team, and nothing above is a defence this app can
 * price. A league that somehow produces more falls back to the ordinary bound
 * rather than growing the scan without limit.
 */
export const WHOLE_POSITION_CAP = 32;

export function boundedFreeAgentIds(
  players: CanonicalPlayer[],
  opts: {
    rosteredIds: Set<string>;
    startable: Set<string>;
    /** Draft order, when a ranking has been imported. */
    ranks: Map<string, { adp: number | null }>;
    perPosition?: number;
  },
): string[] {
  const perPosition = opts.perPosition ?? FREE_AGENTS_PER_POSITION;
  const available = players.filter(
    (p) => p.active && !opts.rosteredIds.has(p.id) && (opts.startable.size === 0 || opts.startable.has(p.position)),
  );

  const byPosition = new Map<string, CanonicalPlayer[]>();
  for (const p of available) {
    const bucket = byPosition.get(p.position);
    if (bucket) bucket.push(p);
    else byPosition.set(p.position, [p]);
  }

  const ids: string[] = [];
  for (const [position, bucket] of byPosition) {
    bucket.sort(
      (a, b) =>
        (opts.ranks.get(a.id)?.adp ?? Infinity) - (opts.ranks.get(b.id)?.adp ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
        a.fullName.localeCompare(b.fullName),
    );
    /*
     * The slice is only as good as the order it slices. Where there is no
     * order, take the lot — see {@link WHOLE_SLATE_POSITIONS}.
     */
    const take =
      WHOLE_SLATE_POSITIONS.has(position.toUpperCase()) && bucket.length <= WHOLE_POSITION_CAP
        ? bucket.length
        : perPosition;
    for (const p of bucket.slice(0, take)) ids.push(p.id);
  }
  return ids;
}
