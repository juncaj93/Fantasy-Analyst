/**
 * Turning stored weeks into the series the role detector reads.
 *
 * `assessRole` takes `RoleMetric[]` — per-game values, oldest first — and has
 * two properties that decide everything here: it needs **three recent games and
 * three baseline games** before it will say anything at all, and it gives high
 * confidence only when metrics *agree*. So which metrics are fed in is not a
 * presentation choice; it is the difference between a claim that means
 * something and one that is two views of the same number nodding at each other.
 */

import type { RoleMetric } from '../startsit/decisions.ts';

/** One stored week of usage, in the shape the read path holds it. */
export interface UsageWeek {
  week: number;
  seasonType: string;
  passAttempts: number | null;
  carries: number | null;
  targets: number | null;
  receptions: number | null;
  targetShare: number | null;
  wopr: number | null;
  /*
   * The 0018 columns, optional because a week stored before that migration does
   * not carry them and because the source itself leaves several blank. Absent
   * and null mean the same thing everywhere they are read: not known.
   *
   * Deliberately *not* fed to `toRoleMetrics`. The role detector's confidence
   * rests on metrics that can genuinely disagree, and receiving yards agree
   * with targets almost by construction — see the note on the metric table
   * below. These are read by `core/startsit/tdDependency.ts` and
   * `core/startsit/roleProfile.ts`, which are asking different questions.
   */
  opponent?: string | null;
  passYards?: number | null;
  passTds?: number | null;
  rushYards?: number | null;
  rushTds?: number | null;
  recYards?: number | null;
  recTds?: number | null;
  receivingAirYards?: number | null;
  airYardsShare?: number | null;
}

/**
 * How many games back a metric reaches.
 *
 * Eight: three recent against a five-game baseline. Longer is not better here.
 * The detector compares the last three games with everything before them, so a
 * seventeen-game baseline averages away exactly the change the feature exists
 * to find — a receiver who has doubled his targets over a month barely moves a
 * mean that still carries September. Five games is a recent enough baseline to
 * be about this season's role and long enough that one quiet game does not
 * become the baseline itself.
 */
export const ROLE_WINDOW_GAMES = 8;

/**
 * The metrics for a position, and why these pairs.
 *
 * Each position gets two metrics that can genuinely disagree, because that is
 * what the detector's confidence rests on:
 *
 *   - **QB** — pass attempts and carries. Passing volume and designed running
 *     are different jobs, and a quarterback whose rushing role is growing while
 *     his attempts hold is a real and separate thing.
 *   - **RB** — carries and targets. The ground role and the passing-down role
 *     are the two halves of a back's usage and they move independently; a back
 *     losing carries while gaining targets has not simply "declined".
 *   - **WR/TE** — targets and target share. Volume, and volume with the team's
 *     pace divided out. A receiver whose targets rose because his team threw
 *     forty times has a rising *count* and a flat *share*, and the detector
 *     seeing those disagree is exactly right: that is not his role changing.
 *
 * Receptions and WOPR are stored and deliberately not fed in. Receptions are a
 * subset of targets and WOPR is built from target share, so both would agree
 * with their partner almost by construction — and an agreement test between two
 * views of the same number is not agreement, it is double counting, and it
 * would manufacture "high confidence" out of one signal.
 */
const METRICS_BY_POSITION: Record<string, { key: string; label: string; of: (w: UsageWeek) => number | null }[]> = {
  QB: [
    { key: 'pass_attempts', label: 'Pass attempts', of: (w) => w.passAttempts },
    { key: 'carries', label: 'Carries', of: (w) => w.carries },
  ],
  RB: [
    { key: 'carries', label: 'Carries', of: (w) => w.carries },
    { key: 'targets', label: 'Targets', of: (w) => w.targets },
  ],
  WR: [
    { key: 'targets', label: 'Targets', of: (w) => w.targets },
    { key: 'target_share', label: 'Target share', of: (w) => w.targetShare },
  ],
  TE: [
    { key: 'targets', label: 'Targets', of: (w) => w.targets },
    { key: 'target_share', label: 'Target share', of: (w) => w.targetShare },
  ],
};

/**
 * Build the per-game series for one player.
 *
 * Three rules, all of them about not inventing anything:
 *
 *   - **regular season only.** A fantasy season ends in week 17 or 18, so a
 *     January playoff week is not part of the population any lineup question is
 *     asked about — and only a handful of teams have those games at all, which
 *     would make one player's "last three" mean something different from
 *     another's.
 *   - **a missing week is not a zero.** The source publishes a row per game
 *     *played*; an inactive player has no row. His absence is a game that did
 *     not happen, and writing a 0 for it would invent the strongest possible
 *     evidence of a collapsing role out of a bye.
 *   - **a blank field is not a zero either.** A null from the source drops that
 *     game from that metric rather than being counted as none.
 */
export function toRoleMetrics(position: string, weeks: UsageWeek[]): RoleMetric[] {
  const definitions = METRICS_BY_POSITION[position.toUpperCase()];
  if (!definitions) return [];

  const games = weeks
    .filter((w) => w.seasonType.toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-ROLE_WINDOW_GAMES);
  if (games.length === 0) return [];

  const out: RoleMetric[] = [];
  for (const definition of definitions) {
    const perGame: number[] = [];
    for (const game of games) {
      const value = definition.of(game);
      if (value == null) continue;
      perGame.push(value);
    }
    // A metric with nothing in it is left out rather than passed in empty: the
    // detector counts metrics, and an empty one would dilute the agreement test
    // it uses to decide confidence.
    if (perGame.length > 0) out.push({ key: definition.key, label: definition.label, perGame });
  }
  return out;
}
