/**
 * What actually changed, out of a file that is republished whole.
 *
 * The same problem the injury diff solves, and for the same reason: nflverse
 * republishes the entire season file whenever anything in it is revised, so an
 * ingest of the latest week arrives as ~350 rows at the positions this app
 * carries, nearly all of them identical to what is already stored. A week's
 * numbers settle within a day or two of the game and then never move again, so
 * after the first ingest of a week the honest number of writes is zero.
 *
 * Three things are deliberately not conflated: the *file* changing (a validator
 * moved), a *row* changing (some byte differs), and a player's *usage* changing
 * (a number this app reads differs). Only the third earns a write.
 */

/** The stored shape this compares against, narrowed to what is read back. */
export interface ComparableUsage {
  playerId: string;
  season: string;
  week: number;
  passAttempts: number | null;
  carries: number | null;
  targets: number | null;
  receptions: number | null;
  targetShare: number | null;
  wopr: number | null;
}

export interface UsageDiff {
  /** Rows to write: genuinely new, or genuinely different. */
  changed: ComparableUsage[];
  /** How many incoming rows were examined, changed or not. */
  examined: number;
  /** Unchanged rows — the number this module exists to keep at zero cost. */
  unchanged: number;
  /** Players whose usage moved, for anything downstream that cares. */
  changedPlayerIds: string[];
}

export function keyOf(row: { playerId: string; season: string; week: number }): string {
  return `${row.playerId}:${row.season}:${row.week}`;
}

/**
 * Compare an ingest against what is stored.
 *
 * `stored` is keyed by `${playerId}:${season}:${week}`. A key absent from it is
 * a first sighting and is written. Unlike the injury diff there are no events:
 * a target count is a measurement of a game that has already happened, not a
 * transition anybody needs to be told about, and "he had eight targets, revised
 * to nine" is a correction rather than news.
 */
export function diffUsage(incoming: ComparableUsage[], stored: Map<string, ComparableUsage>): UsageDiff {
  const changed: ComparableUsage[] = [];
  const changedPlayerIds = new Set<string>();
  let unchanged = 0;

  for (const row of incoming) {
    const previous = stored.get(keyOf(row));
    if (previous && !moved(previous, row)) {
      unchanged++;
      continue;
    }
    changed.push(row);
    changedPlayerIds.add(row.playerId);
  }

  return {
    changed,
    examined: incoming.length,
    unchanged,
    changedPlayerIds: [...changedPlayerIds].sort(),
  };
}

/**
 * Did any number this app actually reads move?
 *
 * The rates are compared at the precision they are stored with rather than
 * exactly: `target_share` is a float the source computes, and a rounding change
 * in the fourteenth decimal place is not a role change. Everything else in the
 * row — team, position, the file's timestamp, row order — is not compared at
 * all, because none of it alters what the app would say.
 */
function moved(before: ComparableUsage, after: ComparableUsage): boolean {
  return (
    before.passAttempts !== after.passAttempts ||
    before.carries !== after.carries ||
    before.targets !== after.targets ||
    before.receptions !== after.receptions ||
    !sameRate(before.targetShare, after.targetShare) ||
    !sameRate(before.wopr, after.wopr)
  );
}

/** Four decimal places: finer than any share this app displays or compares. */
function sameRate(before: number | null, after: number | null): boolean {
  if (before == null || after == null) return before === after;
  return Math.abs(before - after) < 0.00005;
}
