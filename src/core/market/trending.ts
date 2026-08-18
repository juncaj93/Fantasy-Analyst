/**
 * What the rest of Sleeper is chasing, and how fast.
 *
 * Sleeper publishes a global adds/drops leaderboard. It is a genuinely useful
 * signal and a genuinely dangerous one, and the distinction is the reason this
 * module is separate from every scoring path in the app:
 *
 *   **Trending measures attention, not quality.** Half a million people adding a
 *   player tells you the waiver wire is about to get expensive. It does not tell
 *   you he is good. Feeding it into a projection would launder the crowd's
 *   opinion into the app's own numbers and then present the result as
 *   independent evidence — the exact circularity this project exists to avoid.
 *
 * So trending is allowed to do two things: price a bid, and raise a question.
 * It is never allowed to move a projection. `core/market/disagreement.ts` is
 * where the question gets asked.
 *
 * A single snapshot is a rank. Velocity needs two, which is why snapshots are
 * stored: `#2 trending add` is interesting, `add rate accelerated 6×` is why you
 * are reading about him before the room is.
 */

export interface TrendingSnapshotRow {
  playerId: string;
  count: number;
  /** 1-based position in the published list at capture time. */
  rank: number;
}

export interface TrendingSnapshot {
  /** ISO instant the list was captured. */
  capturedAt: string;
  type: 'add' | 'drop';
  /** The window Sleeper counted over, which the counts are only comparable within. */
  lookbackHours: number;
  rows: TrendingSnapshotRow[];
}

/**
 * Turn a raw Sleeper response into a snapshot.
 *
 * Rank is assigned from the response order rather than recomputed from counts:
 * Sleeper's order is the published order, and re-sorting would silently
 * disagree with the thing every other Sleeper user is looking at.
 */
export function toSnapshot(
  rows: { player_id: string; count: number }[],
  opts: { capturedAt: string; type: 'add' | 'drop'; lookbackHours: number },
): TrendingSnapshot {
  return {
    capturedAt: opts.capturedAt,
    type: opts.type,
    lookbackHours: opts.lookbackHours,
    rows: rows
      .filter((r) => typeof r.player_id === 'string' && Number.isFinite(r.count))
      .map((r, i) => ({ playerId: r.player_id, count: Math.max(0, Math.round(r.count)), rank: i + 1 })),
  };
}

export interface TrendingVelocity {
  playerId: string;
  /** Where he sits now. Null when he has fallen off the published list. */
  rank: number | null;
  count: number | null;
  /** Adds per hour over the current window. Sleeper's own count ÷ its lookback. */
  addsPerHour: number | null;
  /**
   * Rank movement since the previous snapshot, positive meaning *climbing*.
   * Null when he was absent from one of the two lists, because entering the
   * list from nowhere is a different event and is reported as `entered`.
   */
  rankMovement: number | null;
  /**
   * Current adds/hour ÷ previous adds/hour. `6` is the `accelerated 6×` line.
   * Null without two comparable snapshots.
   */
  acceleration: number | null;
  entered: boolean;
  /** How much attention he has, 0–1, for anything that wants one number. */
  heat: number;
}

/**
 * The smallest previous rate that may sit under an acceleration ratio.
 *
 * Dividing by a handful of adds produces spectacular multiples out of noise:
 * three adds becoming eighteen is "6× acceleration" and is also nothing. Below
 * this the ratio is withheld rather than published as a headline.
 */
export const MIN_RATE_FOR_ACCELERATION = 5;

/**
 * Compare two snapshots of the same kind.
 *
 * `previous` may be null — the first capture is a legitimate state, and it
 * yields ranks and rates with no velocity, which is honest rather than a gap to
 * be filled in.
 */
export function velocity(current: TrendingSnapshot, previous: TrendingSnapshot | null): Map<string, TrendingVelocity> {
  const out = new Map<string, TrendingVelocity>();
  const prevRows = new Map((previous?.rows ?? []).map((r) => [r.playerId, r]));
  const listSize = Math.max(1, current.rows.length);

  for (const row of current.rows) {
    const rate = current.lookbackHours > 0 ? row.count / current.lookbackHours : null;
    const prev = prevRows.get(row.playerId) ?? null;

    let rankMovement: number | null = null;
    let acceleration: number | null = null;
    if (previous && prev) {
      rankMovement = prev.rank - row.rank;
      const prevRate = previous.lookbackHours > 0 ? prev.count / previous.lookbackHours : null;
      /*
       * Rates from different lookback windows are not comparable, and Sleeper's
       * window is a request parameter rather than a constant. Comparing a
       * 24-hour rate with a 6-hour one produces a ratio that is mostly the
       * window changing, so it is simply not produced.
       */
      if (
        prevRate != null &&
        rate != null &&
        prevRate >= MIN_RATE_FOR_ACCELERATION &&
        previous.lookbackHours === current.lookbackHours
      ) {
        acceleration = round2(rate / prevRate);
      }
    }

    out.set(row.playerId, {
      playerId: row.playerId,
      rank: row.rank,
      count: row.count,
      addsPerHour: rate != null ? round2(rate) : null,
      rankMovement,
      acceleration,
      entered: previous != null && prev == null,
      /*
       * Heat is rank-based, not count-based.
       *
       * Counts swing by an order of magnitude between a quiet Tuesday and a
       * Wednesday after a Sunday injury; rank within the published list is
       * stable and means the same thing in both. #1 is 1.0, the bottom of the
       * list is near 0.
       */
      heat: round3(Math.max(0, (listSize - row.rank + 1) / listSize)),
    });
  }

  return out;
}

/**
 * One short line, or nothing.
 *
 * The brief's two high-value examples are the two cases worth a line at all;
 * everything else is a number the card already shows. `availableInLeague` is
 * passed in rather than inferred, because "still available in your league" is
 * the half of that sentence that makes it actionable and this module has no
 * business knowing about rosters.
 */
export function trendingHeadline(v: TrendingVelocity, opts: { availableInLeague?: boolean } = {}): string | null {
  if (v.acceleration != null && v.acceleration >= 2) {
    return `Add rate accelerated ${formatMultiple(v.acceleration)}`;
  }
  if (v.rank != null && v.rank <= 5) {
    const base = `#${v.rank} trending add`;
    return opts.availableInLeague ? `${base} · still available in your league` : base;
  }
  if (v.entered && v.rank != null && v.rank <= 15) return `New to the trending list at #${v.rank}`;
  return null;
}

function formatMultiple(v: number): string {
  return Number.isInteger(v) ? `${v}×` : `${v.toFixed(1)}×`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
