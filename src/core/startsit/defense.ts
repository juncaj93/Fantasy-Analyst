/**
 * What a defence gives up, to the kind of player you are actually starting.
 *
 * "Defence versus WR" is the weakest useful statistic in fantasy football. It
 * folds four different jobs into one number, and it is dominated by who a
 * defence happened to play: a unit that has faced three number-one receivers
 * looks terrible and may not be. This module fixes both halves of that.
 *
 * ## Role, not position
 *
 * Every game a defence has faced is bucketed by the **role** of the player who
 * produced it — downfield receiver, underneath receiver, receiving back,
 * rushing quarterback, and the rest of the vocabulary in `roleProfile.ts`. The
 * lookup is then made under the bucket of the player being started, so a
 * defence that suffocates downfield throwing and leaks underneath produces two
 * different answers for two of your receivers, which is the entire point.
 *
 * The buckets are depth-of-target based rather than alignment based, because
 * alignment is not in any free source this app ingests. That limitation is
 * stated in full at the top of `roleProfile.ts` and is not restated in every
 * sentence here; what matters downstream is that both sides of the matchup are
 * described in the same, honestly-sourced vocabulary.
 *
 * ## Opponent quality, divided out
 *
 * Each game contributes a **residual**: what the player scored against this
 * defence, minus what that player normally scores. A defence that allowed 22 to
 * a receiver who averages 20 has allowed nothing remarkable; one that allowed
 * 14 to a receiver who averages 6 has. Averaging residuals rather than raw
 * totals is the whole of the strength-of-schedule correction, it costs one
 * subtraction, and it means a defence cannot look elite for having played
 * nobody.
 *
 * ## Sample, and the refusal to guess
 *
 * A defence has faced perhaps one downfield receiver a week, so a bucket can be
 * thin well into a season. Below {@link DEFENSE.minSample} player-games across
 * {@link DEFENSE.minWeeks} weeks the answer is `insufficient_data` and the
 * matchup component contributes nothing at all. It is never padded with the
 * position-level number, because a specific claim backed by three games is
 * worse than a general one — the fallback to the position bucket happens for
 * *players* whose role could not be classified, which is a different thing.
 */

import type { RoleBucket } from './roleProfile.ts';
import { tendencyKey } from './roleProfile.ts';

export const DEFENSE = {
  /** Player-games of a bucket a defence must have faced before it is described. */
  minSample: 4,
  /** ...across at least this many distinct weeks, so one slate is not a season. */
  minWeeks: 3,
  /** How many recent weeks carry the heavier weight. */
  recentWeeks: 5,
  /** The weight those weeks carry, against 1 for everything earlier. */
  recentWeight: 2,
  /**
   * Residual points per game at which the matchup component saturates.
   *
   * Three points a game above or below what players normally do is a large,
   * visible effect at the scale of a weekly score, and larger figures in a
   * ten-game sample are usually one blowout rather than a tendency.
   */
  fullResidual: 3,
  /** The most this component can move a player, in fantasy points. */
  maxPoints: 1,
} as const;

/** One game a defence gave up, as this module needs it. */
export interface DefenseGame {
  /** The defence that allowed it. */
  defense: string;
  week: number;
  position: string;
  /** The role of the player who produced it. */
  bucket: RoleBucket;
  /** Fantasy points produced, in one league-neutral scale. */
  points: number;
  /**
   * What that player normally produces, on the same scale.
   *
   * Null drops the game from the residual and keeps it in the raw average: a
   * player with no baseline still tells you what the defence allowed, he just
   * cannot tell you whether it was surprising.
   */
  baseline: number | null;
}

export interface DefenseTendency {
  defense: string;
  key: string;
  bucket: RoleBucket | 'any';
  position: string;
  /** Player-games behind the figure. */
  sample: number;
  weeks: number;
  /** Recency-weighted points allowed per game. */
  allowedPerGame: number;
  /** Recency-weighted points above what those players normally produce. */
  residualPerGame: number | null;
  /** `soft` | `neutral` | `tough`, from the residual. */
  rating: 'soft' | 'neutral' | 'tough' | 'insufficient_data';
}

export type DefenseTendencyIndex = Map<string, DefenseTendency>;

/**
 * Build the whole table in one pass over the season's games.
 *
 * Both keys are produced for every defence: the role bucket, and an `any`
 * bucket per position for players whose role could not be classified. They are
 * separate populations rather than one rolled up, so a lookup never silently
 * answers a role question with a position answer.
 */
export function buildDefenseTendencies(games: DefenseGame[], throughWeek?: number): DefenseTendencyIndex {
  const latest = throughWeek ?? Math.max(0, ...games.map((g) => g.week));
  const groups = new Map<string, { defense: string; position: string; bucket: RoleBucket | 'any'; rows: DefenseGame[] }>();

  const add = (key: string, defense: string, position: string, bucket: RoleBucket | 'any', game: DefenseGame) => {
    const group = groups.get(key) ?? { defense, position, bucket, rows: [] };
    group.rows.push(game);
    groups.set(key, group);
  };

  for (const game of games) {
    if (!game.defense) continue;
    const position = game.position.toUpperCase();
    add(`${game.defense}|${tendencyKey(position, game.bucket)}`, game.defense, position, game.bucket, game);
    if (game.bucket !== 'unclassified') {
      add(`${game.defense}|${position}:any`, game.defense, position, 'any', game);
    }
  }

  const index: DefenseTendencyIndex = new Map();
  for (const [key, group] of groups) {
    const weight = (row: DefenseGame) => (latest - row.week < DEFENSE.recentWeeks ? DEFENSE.recentWeight : 1);
    const weeks = new Set(group.rows.map((r) => r.week)).size;
    const allowed = weightedMean(group.rows.map((r) => ({ value: r.points, weight: weight(r) })));
    const withBaseline = group.rows.filter((r) => r.baseline != null);
    const residual =
      withBaseline.length === 0
        ? null
        : weightedMean(withBaseline.map((r) => ({ value: r.points - r.baseline!, weight: weight(r) })));

    const enough = group.rows.length >= DEFENSE.minSample && weeks >= DEFENSE.minWeeks;
    index.set(key, {
      defense: group.defense,
      key,
      bucket: group.bucket,
      position: group.position,
      sample: group.rows.length,
      weeks,
      allowedPerGame: round2(allowed),
      residualPerGame: residual == null ? null : round2(residual),
      rating: !enough || residual == null ? 'insufficient_data' : ratingOf(residual),
    });
  }
  return index;
}

function ratingOf(residual: number): 'soft' | 'neutral' | 'tough' {
  if (residual >= 1) return 'soft';
  if (residual <= -1) return 'tough';
  return 'neutral';
}

export interface MatchupAssessment {
  points: number;
  unknown: boolean;
  rating: DefenseTendency['rating'];
  /** Which key answered — the role bucket, or the position fallback. */
  resolvedKey: string | null;
  sample: number;
  display: string;
  driver: string | null;
}

export const NO_MATCHUP: MatchupAssessment = {
  points: 0,
  unknown: true,
  rating: 'insufficient_data',
  resolvedKey: null,
  sample: 0,
  display: 'no opponent tendency data',
  driver: null,
};

/**
 * Look one player's matchup up.
 *
 * The role bucket first. If the defence has not faced enough of that role, the
 * position-level figure answers instead and the display says which of the two
 * it was — a general claim labelled as general is honest, and a general claim
 * dressed as a role read is not.
 */
export function assessMatchup(
  opts: { position: string; bucket: RoleBucket; defense: string | null },
  index: DefenseTendencyIndex,
): MatchupAssessment {
  if (!opts.defense) return NO_MATCHUP;
  const position = opts.position.toUpperCase();
  const roleKey = `${opts.defense}|${tendencyKey(position, opts.bucket)}`;
  const anyKey = `${opts.defense}|${position}:any`;

  const role = index.get(roleKey);
  const generic = index.get(anyKey);
  const chosen =
    role && role.rating !== 'insufficient_data'
      ? role
      : generic && generic.rating !== 'insufficient_data'
        ? generic
        : null;

  if (!chosen || chosen.residualPerGame == null) {
    return {
      ...NO_MATCHUP,
      sample: role?.sample ?? generic?.sample ?? 0,
      display:
        (role?.sample ?? 0) + (generic?.sample ?? 0) === 0
          ? 'no opponent tendency data'
          : `too few games against this role to describe ${opts.defense}`,
    };
  }

  const score = clamp(chosen.residualPerGame / DEFENSE.fullResidual, -1, 1);
  const points = round2(score * DEFENSE.maxPoints);
  const specific = chosen === role;
  const what = specific ? bucketPhrase(opts.bucket) : `${position}s`;

  return {
    points,
    unknown: false,
    rating: chosen.rating,
    resolvedKey: chosen.key,
    sample: chosen.sample,
    display:
      `${opts.defense} allows ${chosen.residualPerGame > 0 ? '+' : ''}${chosen.residualPerGame} pts/game ` +
      `above baseline to ${what} (${chosen.sample} games)`,
    driver: driverOf(points, opts.defense, what, chosen.rating),
  };
}

function bucketPhrase(bucket: RoleBucket): string {
  switch (bucket) {
    case 'deep_receiver':
      return 'downfield receivers';
    case 'intermediate_receiver':
      return 'intermediate receivers';
    case 'underneath_receiver':
      return 'underneath receivers';
    case 'rushing_back':
      return 'rushing backs';
    case 'dual_threat_back':
      return 'dual-threat backs';
    case 'receiving_back':
      return 'receiving backs';
    case 'rushing_quarterback':
      return 'rushing quarterbacks';
    case 'pocket_quarterback':
      return 'pocket quarterbacks';
    default:
      return 'this role';
  }
}

function driverOf(points: number, defense: string, what: string, rating: DefenseTendency['rating']): string | null {
  if (Math.abs(points) < 0.3) return null;
  return rating === 'soft'
    ? `Favourable matchup · ${defense} is generous to ${what}`
    : `Difficult matchup · ${defense} suppresses ${what}`;
}

function weightedMean(rows: { value: number; weight: number }[]): number {
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    total += row.value * row.weight;
    weight += row.weight;
  }
  return weight === 0 ? 0 : total / weight;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
