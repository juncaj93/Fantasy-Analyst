/**
 * Last season, in the two numbers a draft actually asks about.
 *
 * Did he play, and where did he finish. Sleeper's season stats endpoint answers
 * both for every player in one request, publicly and without a key, which is
 * why this exists at all — the alternative was a paid statistics feed, and the
 * project does not take one.
 *
 * The payload carries about 260 columns per player. Three are read.
 */

/** One player's row as Sleeper returns it. Everything is optional; most is. */
export interface RawSeasonStatLine {
  gp?: number | null;
  pts_half_ppr?: number | null;
  pos_rank_half_ppr?: number | null;
}

export interface SeasonStatLine {
  playerId: string;
  position: string;
  /** Games played. `null` means he did not appear, which is not zero. */
  gamesPlayed: number | null;
  pointsHalfPpr: number | null;
  /** Among players at his position who scored at all. 1 is best. */
  positionRankHalfPpr: number | null;
  /** What the payload claimed, for comparison only. */
  providerPositionRank: number | null;
}

/**
 * Half PPR, defined once.
 *
 * The user asked for a half-PPR finish and not for their own league's finish,
 * and those are different numbers in a league with custom scoring — so this
 * must not quietly become "whatever this league scores". It does not read the
 * league at all.
 *
 * The points themselves are Sleeper's `pts_half_ppr`: half a point per
 * reception on top of standard yardage and touchdown scoring, applied by the
 * same system that scores the user's league, to statistics it also owns.
 * Re-deriving points from raw yardage columns would mean maintaining a second
 * scoring engine whose only job is to disagree with the first.
 */
export const HALF_PPR = {
  label: 'half-PPR',
  description: '0.5 per reception, standard yardage and touchdowns, as scored by Sleeper',
} as const;

export interface RankDiagnostics {
  returned: number;
  matched: number;
  unmatched: number;
  /** Players whose computed rank differs from the one in the payload. */
  rankDisagreements: number;
}

/**
 * Turn the season payload into ranked lines for the players this app knows.
 *
 * The rank is computed here rather than taken from `pos_rank_half_ppr`, for one
 * reason that matters on a draft board: Sleeper ranks every player on its
 * books, including the ones who never took a snap. A rookie with no 2025 season
 * comes back as `WR1240`, and printing that on a card is worse than printing
 * nothing — it looks like a finish and it is really a directory position.
 *
 * So the pool is players who scored at all, and everyone else has no rank
 * rather than a large one. At the top of a position the two methods agree
 * exactly; they diverge only down in the tail, which is the part being fixed.
 * Both are returned so the disagreement can be counted rather than assumed.
 */
export function buildSeasonStatLines(
  payload: Record<string, RawSeasonStatLine | unknown>,
  positionOf: (playerId: string) => string | null,
): { lines: SeasonStatLine[]; diagnostics: RankDiagnostics } {
  const scored: SeasonStatLine[] = [];
  const unscored: SeasonStatLine[] = [];
  let returned = 0;
  let unmatched = 0;

  for (const [playerId, raw] of Object.entries(payload)) {
    returned++;
    if (!raw || typeof raw !== 'object') continue;
    const position = positionOf(playerId);
    // Team-level rows (defensive points allowed, and similar) share the shape
    // and are not players. They have no canonical player to attach to.
    if (!position) {
      unmatched++;
      continue;
    }
    const row = raw as RawSeasonStatLine;
    const line: SeasonStatLine = {
      playerId,
      position,
      gamesPlayed: numberOrNull(row.gp),
      pointsHalfPpr: numberOrNull(row.pts_half_ppr),
      positionRankHalfPpr: null,
      providerPositionRank: numberOrNull(row.pos_rank_half_ppr),
    };
    (line.pointsHalfPpr == null ? unscored : scored).push(line);
  }

  const byPosition = new Map<string, SeasonStatLine[]>();
  for (const line of scored) {
    const list = byPosition.get(line.position);
    if (list) list.push(line);
    else byPosition.set(line.position, [line]);
  }
  for (const list of byPosition.values()) {
    // Ties share the better rank, the way a leaderboard does: two players on
    // identical points are both WR7, and the next is WR9.
    list.sort((a, b) => (b.pointsHalfPpr ?? 0) - (a.pointsHalfPpr ?? 0));
    let rank = 0;
    let previous: number | null = null;
    list.forEach((line, i) => {
      if (previous == null || line.pointsHalfPpr !== previous) rank = i + 1;
      previous = line.pointsHalfPpr;
      line.positionRankHalfPpr = rank;
    });
  }

  const lines = [...scored, ...unscored];
  const rankDisagreements = scored.filter(
    (l) => l.providerPositionRank != null && l.providerPositionRank !== l.positionRankHalfPpr,
  ).length;

  return {
    lines,
    diagnostics: { returned, matched: lines.length, unmatched, rankDisagreements },
  };
}

/** `WR7`, or null when there is nothing honest to print. */
export function formatPositionRank(position: string, rank: number | null): string | null {
  if (rank == null || !position) return null;
  return `${position.toUpperCase()}${rank}`;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
