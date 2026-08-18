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
  for (const bucket of byPosition.values()) {
    bucket.sort(
      (a, b) =>
        (opts.ranks.get(a.id)?.adp ?? Infinity) - (opts.ranks.get(b.id)?.adp ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
        a.fullName.localeCompare(b.fullName),
    );
    for (const p of bucket.slice(0, perPosition)) ids.push(p.id);
  }
  return ids;
}
