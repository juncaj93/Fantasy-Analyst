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
