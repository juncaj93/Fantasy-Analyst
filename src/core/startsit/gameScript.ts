/**
 * The game he is walking into, and what that does to his job.
 *
 * Two numbers describe a football game before it is played: how many points the
 * market expects in total, and which way it expects them to be shared. Between
 * them they imply a team total, and a team total is the closest thing available
 * to "how many chances will this offence get".
 *
 * That much is environment and applies to everybody on the team. The second
 * half is the part a lineup screen has to get right: **the same script means
 * opposite things to different roles.**
 *
 *   - A back on a team favoured by ten sees the fourth quarter with a lead,
 *     which is the most valuable quarter a running back has.
 *   - A receiver on a team trailing by ten sees fifty pass attempts. Losing is
 *     bad for the offence and good for his volume, and a model that penalises
 *     him for his team being an underdog has the sign backwards.
 *   - A back who catches passes is not hurt by trailing at all; the passing
 *     down is his down.
 *   - A quarterback who runs has a floor that survives a bad script, because
 *     the ten carries happen whether or not the passing game works.
 *
 * ## Bounded, and unknown when it is unknown
 *
 * The whole component is worth at most {@link GAME_SCRIPT.maxPoints}, which is
 * about a third of what the market's own projection of the player is worth. It
 * is context, not a projection. With no spread and no total it contributes
 * nothing and says so — there is no default game.
 */

import type { RoleBucket } from './roleProfile.ts';

export const GAME_SCRIPT = {
  /** The most this component can move a player, in fantasy points. */
  maxPoints: 1.2,
  /**
   * A neutral NFL team total, in points.
   *
   * Half of a 45-point game, which is close to the modern league mean. The
   * environment half of this component measures distance from here.
   */
  neutralTeamTotal: 22.5,
  /** Team-total distance at which the environment half saturates. */
  fullTeamTotalSwing: 6,
  /** Points of spread at which the script half saturates. */
  fullSpread: 9,
} as const;

export interface GameContext {
  /**
   * The player's team's spread. Negative when favoured, positive as underdog.
   * Null when the market has not priced the game.
   */
  spread: number | null;
  /** The game total. Null when unpriced. */
  total: number | null;
  /** The opponent, for the sentence. */
  opponent?: string | null;
}

export interface GameScriptAssessment {
  /** Points added to the Start/Sit score. Bounded. */
  points: number;
  /** The team total the two numbers imply, when both are known. */
  impliedTeamTotal: number | null;
  favoured: boolean | null;
  /** The component line. */
  display: string;
  unknown: boolean;
  driver: string | null;
}

export const NO_GAME_SCRIPT: GameScriptAssessment = {
  points: 0,
  impliedTeamTotal: null,
  favoured: null,
  display: 'no game line',
  unknown: true,
  driver: null,
};

/**
 * How much of the script half a role feels, and in which direction.
 *
 * Positive means "being favoured helps him", negative means "trailing helps
 * him", zero means the script is not his problem. These are the directional
 * claims of the module, kept in one table so they can be read and argued with
 * rather than being scattered through branches.
 */
const SCRIPT_SENSITIVITY: Record<string, number> = {
  rushing_back: 1,
  dual_threat_back: 0.5,
  receiving_back: -0.2,
  deep_receiver: -0.5,
  intermediate_receiver: -0.5,
  underneath_receiver: -0.4,
  rushing_quarterback: 0.2,
  pocket_quarterback: -0.2,
};

/** The fallback when a player's role could not be classified. */
const POSITION_SENSITIVITY: Record<string, number> = {
  RB: 0.7,
  WR: -0.45,
  TE: -0.3,
  QB: -0.1,
};

export function assessGameScript(
  position: string,
  bucket: RoleBucket,
  game: GameContext,
): GameScriptAssessment {
  const { spread, total } = game;
  if (spread == null && total == null) return NO_GAME_SCRIPT;

  /*
   * The implied team total, which needs both numbers.
   *
   * total/2 − spread/2: a 47-point game with a 7-point favourite implies 27 for
   * the favourite and 20 for the underdog. With only one of the two known the
   * environment half is skipped rather than guessed — half a market is not a
   * market.
   */
  const impliedTeamTotal =
    spread == null || total == null ? null : round1(total / 2 - spread / 2);

  const environment =
    impliedTeamTotal == null
      ? 0
      : clamp(
          (impliedTeamTotal - GAME_SCRIPT.neutralTeamTotal) / GAME_SCRIPT.fullTeamTotalSwing,
          -1,
          1,
        );

  const sensitivity = SCRIPT_SENSITIVITY[bucket] ?? POSITION_SENSITIVITY[position.toUpperCase()] ?? 0;
  // Favoured is a negative spread, and a positive sensitivity means being
  // favoured helps — hence the sign flip.
  const scriptStrength = spread == null ? 0 : clamp(-spread / GAME_SCRIPT.fullSpread, -1, 1);
  const script = scriptStrength * sensitivity;

  /*
   * Environment carries more than script, and that ordering is the point.
   *
   * How many points an offence is expected to score is a stronger and better
   * measured claim than how those points will be distributed between running
   * and throwing. A model that let script dominate would start a bad offence's
   * running back in every blowout.
   */
  const combined = clamp(0.6 * environment + 0.4 * script, -1, 1);
  const points = round2(combined * GAME_SCRIPT.maxPoints);
  const favoured = spread == null ? null : spread < 0;

  return {
    points,
    impliedTeamTotal,
    favoured,
    display: describe(spread, total, impliedTeamTotal, game.opponent ?? null),
    unknown: false,
    driver: driverOf(points, favoured, impliedTeamTotal, sensitivity),
  };
}

function describe(
  spread: number | null,
  total: number | null,
  impliedTeamTotal: number | null,
  opponent: string | null,
): string {
  const bits: string[] = [];
  if (spread != null) {
    bits.push(spread === 0 ? 'pick’em' : spread < 0 ? `favoured by ${Math.abs(spread)}` : `underdog by ${spread}`);
  }
  if (total != null) bits.push(`${total}-point total`);
  if (impliedTeamTotal != null) bits.push(`${impliedTeamTotal} implied`);
  if (opponent) bits.push(`vs ${opponent}`);
  return bits.join(' · ');
}

function driverOf(
  points: number,
  favoured: boolean | null,
  impliedTeamTotal: number | null,
  sensitivity: number,
): string | null {
  if (Math.abs(points) < 0.4) return null;
  if (impliedTeamTotal != null && impliedTeamTotal >= GAME_SCRIPT.neutralTeamTotal + 3 && points > 0) {
    return `Strong game environment · ${impliedTeamTotal} implied team points`;
  }
  if (impliedTeamTotal != null && impliedTeamTotal <= GAME_SCRIPT.neutralTeamTotal - 3 && points < 0) {
    return `Weak game environment · ${impliedTeamTotal} implied team points`;
  }
  if (points > 0) {
    return favoured && sensitivity > 0
      ? 'Game script favours his role · leading teams run'
      : 'Game script favours his role · trailing teams throw';
  }
  return favoured && sensitivity < 0
    ? 'Game script works against his role · a lead means fewer throws'
    : 'Game script works against his role';
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
