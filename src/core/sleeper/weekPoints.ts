/**
 * What every player actually scored in one finished week, in this league's scoring.
 *
 * Read for one question: who did the room just watch score? Most managers in
 * this league chase last week's points, so it is the bid model's strongest pull
 * (see `core/waivers/bidModel.ts`).
 *
 * Sleeper's weekly stats endpoint (`/stats/nfl/regular/<season>/<week>`) is one
 * free request for every player. A league's points are the sum of each stat
 * times the league's own value for it, the same arithmetic Sleeper's matchups
 * use: checked on 8 October 2026 against `players_points` for every rostered
 * player in weeks 3 and 4 of Tony's Pizza Fantasy, 322 of 322 matched to the
 * hundredth, defences included.
 *
 * Stored compact, one settings row per week (`sleeper.weekPoints.<season>.<week>`):
 * no schema change, one row read on the Waivers screen.
 */

export interface StoredWeekPoints {
  season: string;
  week: number;
  fetchedAt: string;
  /** Player id to points, rounded to the hundredth. Players under 0.05 either way are left out. */
  points: Record<string, number>;
}

export function weekPointsKey(season: string, week: number): string {
  return `sleeper.weekPoints.${season}.${week}`;
}

/** One week of raw stats, scored. */
export function scoreWeek(
  stats: Record<string, Record<string, unknown>> | null | undefined,
  scoring: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [playerId, line] of Object.entries(stats ?? {})) {
    if (!line || typeof line !== 'object') continue;
    let total = 0;
    for (const [stat, value] of Object.entries(line)) {
      const weight = scoring[stat];
      if (typeof value !== 'number' || !Number.isFinite(value) || typeof weight !== 'number') continue;
      total += weight * value;
    }
    if (Math.abs(total) >= 0.05) out[playerId] = Math.round(total * 100) / 100;
  }
  return out;
}

/**
 * The most recent week whose games are over, as of `now`.
 *
 * The current week counts once its last kickoff is five hours gone; before
 * that it is the week before. Kickoffs come from the players already in hand,
 * so no schedule read is needed.
 */
export function lastCompletedWeek(week: number, kickoffs: readonly (string | null | undefined)[], now: Date): number {
  const times = kickoffs
    .map((k) => (k ? Date.parse(k) : Number.NaN))
    .filter((t) => Number.isFinite(t) && Math.abs(t - now.getTime()) < 8 * 86_400_000);
  if (times.length === 0) return week - 1;
  const last = Math.max(...times);
  return now.getTime() > last + 5 * 3_600_000 ? week : week - 1;
}

/**
 * Sleeper's projection for a week still to come, in this league's scoring.
 *
 * The waiver planner's number for a later week when no Vegas line is posted
 * for it (`core/waivers/aheadWeeks.ts`). Stored as one settings row per week,
 * `sleeper.aheadPoints.<season>.<week>`, beside last week's points: no schema
 * change, and never written into the shared projection table, so the
 * Start/Sit number for the current week reads exactly what it read before.
 */
export function aheadPointsKey(season: string, week: number): string {
  return `sleeper.aheadPoints.${season}.${week}`;
}

/** Positions the planner values from a later week's projection. A defence stays with the defence planner. */
const AHEAD_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * Sleeper's projections feed, scored the same way `scoreWeek` scores a
 * finished week: each projected stat times the league's own value for it
 * (six for a passing touchdown and minus two for an interception in this
 * league). Rows outside the four valued positions are left out.
 */
export function scoreProjectionRows(rows: unknown, scoring: Readonly<Record<string, number>>): Record<string, number> {
  if (!Array.isArray(rows)) return {};
  const stats: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { player_id?: unknown; stats?: unknown; player?: { position?: unknown } | null };
    const id = r.player_id == null ? '' : String(r.player_id);
    if (!id || !r.stats || typeof r.stats !== 'object') continue;
    const position = r.player?.position == null ? null : String(r.player.position).toUpperCase();
    if (position != null && !AHEAD_POSITIONS.has(position)) continue;
    stats[id] = r.stats as Record<string, unknown>;
  }
  return scoreWeek(stats, scoring);
}

/**
 * This season's points, week by week, for every player: the drop score's
 * season and recent totals and the elite-back read (`waivers/dropScore.ts`).
 * Built from the weekly rows above into one settings row,
 * `sleeper.seasonPoints.<season>`, so the Waivers screen reads one row
 * instead of up to seventeen.
 */
export interface StoredSeasonPoints {
  season: string;
  /** Weeks covered: 1 to this. */
  through: number;
  fetchedAt: string;
  /** Player id to points by week (index 0 is week 1), one decimal. */
  points: Record<string, number[]>;
}

export function seasonPointsKey(season: string): string {
  return `sleeper.seasonPoints.${season}`;
}

/** Combine finished weeks into the season row. A week with no row reads as zeros. */
export function buildSeasonPoints(
  season: string,
  through: number,
  weeks: ReadonlyMap<number, Readonly<Record<string, number>>>,
  now: Date,
): StoredSeasonPoints {
  const points: Record<string, number[]> = {};
  for (let w = 1; w <= through; w++) {
    for (const [id, value] of Object.entries(weeks.get(w) ?? {})) {
      const row = (points[id] ??= Array.from({ length: through }, () => 0));
      row[w - 1] = Math.round(value * 10) / 10;
    }
  }
  return { season, through, fetchedAt: now.toISOString(), points };
}
