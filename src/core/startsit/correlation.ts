/**
 * The other manager is in the game too.
 *
 * Head-to-head fantasy is not a points contest against the field, it is a
 * margin against one specific lineup — and that means two players who are
 * identical on every axis this app measures can still be different starts. If
 * the opponent has a quarterback and his top receiver in a game everybody
 * expects to be a shootout, then that game going wild is a week you lose. Being
 * *in* that game is how an underdog wins it; being out of it is how a favourite
 * protects a lead.
 *
 * ## Bounded, and it is the whole design
 *
 * This is a **tiebreaker**. It is offered only when two candidates are already
 * within {@link CORRELATION.tolerance} points of each other, it may move at
 * most {@link CORRELATION.maxPoints}, and it can never be the reason a worse
 * player starts. That ordering is enforced here rather than trusted to a
 * caller: {@link breakTieOnCorrelation} returns `null` the moment the gap
 * between the two players exceeds the tolerance, whatever the correlation says.
 *
 * ## And it only speaks when the mode has an opinion
 *
 * In Balanced there is no preference at all, because there is no answer: the
 * value of correlation depends entirely on whether you are trying to raise the
 * variance of the margin or lower it, and Balanced has not said. Ceiling wants
 * exposure to the game that can go wild; Floor wants to be somewhere else. A
 * mode that has not asked the question does not get an answer invented for it.
 *
 * Nothing here reads a defence, a projection or a market. It reads which game a
 * player is in and who else is in it.
 */

import type { StartSitMode } from './mode.ts';

export const CORRELATION = {
  /** Points of separation within which this is allowed to speak at all. */
  tolerance: 0.6,
  /** The most it may be worth, in fantasy points. */
  maxPoints: 0.35,
  /**
   * Opponent starters in one game at which the exposure is "a stack".
   *
   * Two, because one opposing receiver in a game is a coincidence and two is a
   * decision that manager made.
   */
  stackSize: 2,
} as const;

export type CorrelationVerdict = 'correlated' | 'anti_correlated' | 'neutral' | 'unknown';

/** One player, reduced to the two facts this module needs. */
export interface GameParticipant {
  playerId: string;
  name: string;
  /** A stable key for the game: both teams, however the caller spells it. */
  gameId: string | null;
}

export interface OpponentExposure {
  gameId: string;
  /** How many of the opponent's likely starters are in it. */
  starters: number;
  names: string[];
  /** The market total for the game, when it is priced. */
  total: number | null;
}

export interface CorrelationAssessment {
  verdict: CorrelationVerdict;
  /** Points, signed. Bounded by {@link CORRELATION.maxPoints}. */
  points: number;
  display: string;
  driver: string | null;
}

export const NO_CORRELATION: CorrelationAssessment = {
  verdict: 'unknown',
  points: 0,
  display: 'no opponent lineup to read',
  driver: null,
};

/**
 * Build the map of which games the opponent is exposed to.
 *
 * A game with fewer than {@link CORRELATION.stackSize} opponent starters is
 * left out entirely: it is not exposure, and keeping it would make the map look
 * like an opinion about every game on the slate.
 */
export function opponentExposure(
  opponentStarters: GameParticipant[],
  gameTotals: Map<string, number> = new Map(),
): Map<string, OpponentExposure> {
  const byGame = new Map<string, GameParticipant[]>();
  for (const starter of opponentStarters) {
    if (!starter.gameId) continue;
    byGame.set(starter.gameId, [...(byGame.get(starter.gameId) ?? []), starter]);
  }

  const out = new Map<string, OpponentExposure>();
  for (const [gameId, players] of byGame) {
    if (players.length < CORRELATION.stackSize) continue;
    out.set(gameId, {
      gameId,
      starters: players.length,
      names: players.map((p) => p.name),
      total: gameTotals.get(gameId) ?? null,
    });
  }
  return out;
}

/**
 * What being in this game is worth, given what the mode is chasing.
 *
 * Returns points that a caller may add to a *tiebreak*, never to a projection.
 * The sign is the whole content: Ceiling pays for exposure to the opponent's
 * shootout, Floor pays for staying out of it, Balanced pays nothing either way.
 */
export function assessCorrelation(
  player: GameParticipant,
  exposure: Map<string, OpponentExposure>,
  mode: StartSitMode,
): CorrelationAssessment {
  if (exposure.size === 0) return NO_CORRELATION;
  if (mode === 'balanced') {
    return {
      verdict: 'neutral',
      points: 0,
      display: 'Balanced mode takes no view on correlation',
      driver: null,
    };
  }
  if (!player.gameId) {
    return { ...NO_CORRELATION, display: 'his game is not known' };
  }

  const shared = exposure.get(player.gameId);
  if (!shared) {
    // Not in any of the opponent's games. That is worth something to Floor and
    // nothing to Ceiling: avoiding a shootout you are not in is not a decision.
    return mode === 'floor'
      ? {
          verdict: 'anti_correlated',
          points: round2(CORRELATION.maxPoints * 0.5),
          display: 'not in a game the opponent is stacked in',
          driver: 'Keeps your week independent of the opponent’s best game',
        }
      : { verdict: 'neutral', points: 0, display: 'not in a game the opponent is stacked in', driver: null };
  }

  /*
   * How much this is worth scales with the stack and with the total.
   *
   * Three opponent starters in a game with a 51-point total is the situation
   * the feature exists for; two in a game priced at 38 is the same shape and
   * much less of it. The total is used only when it is known — an unpriced game
   * keeps the stack part of the reasoning and drops the environment part.
   */
  const stackWeight = Math.min(1, (shared.starters - CORRELATION.stackSize + 1) / 2);
  const totalWeight = shared.total == null ? 0.6 : clamp01((shared.total - 41) / 8);
  const magnitude = CORRELATION.maxPoints * (0.4 + 0.6 * stackWeight) * (0.5 + 0.5 * totalWeight);
  const names = shared.names.slice(0, 2).join(' and ');

  if (mode === 'ceiling') {
    return {
      verdict: 'correlated',
      points: round2(magnitude),
      display: `same game as the opponent's ${names}${shared.total == null ? '' : ` · ${shared.total} total`}`,
      driver: `Chasing points · if that game goes off, you are in it too`,
    };
  }

  return {
    verdict: 'correlated',
    points: round2(-magnitude),
    display: `same game as the opponent's ${names}${shared.total == null ? '' : ` · ${shared.total} total`}`,
    driver: `Protecting a lead · this is the game that beats you if it goes off`,
  };
}

export interface TiebreakResult {
  preferredPlayerId: string;
  /** The points that decided it, after the bound. */
  edge: number;
  detail: string;
}

/**
 * Choose between two players who are already a coin flip.
 *
 * The gap is checked first and the correlation second, and never the other way
 * round. A caller that wants to use this on players two points apart gets
 * `null`, which is the module declining to be the reason a worse player starts.
 */
export function breakTieOnCorrelation(
  a: { playerId: string; name: string; score: number | null; gameId: string | null },
  b: { playerId: string; name: string; score: number | null; gameId: string | null },
  exposure: Map<string, OpponentExposure>,
  mode: StartSitMode,
): TiebreakResult | null {
  if (a.score == null || b.score == null) return null;
  if (Math.abs(a.score - b.score) > CORRELATION.tolerance) return null;
  if (mode === 'balanced') return null;

  const left = assessCorrelation({ playerId: a.playerId, name: a.name, gameId: a.gameId }, exposure, mode);
  const right = assessCorrelation({ playerId: b.playerId, name: b.name, gameId: b.gameId }, exposure, mode);
  const edge = round2(a.score + left.points - (b.score + right.points));
  if (edge === 0) return null;

  const winner = edge > 0 ? a : b;
  const winning = edge > 0 ? left : right;
  // Only report when correlation actually changed the order; otherwise the
  // better player was simply the better player and this had nothing to do
  // with it.
  const wouldHaveWonAnyway = Math.sign(a.score - b.score) === Math.sign(edge) && Math.sign(a.score - b.score) !== 0;
  if (wouldHaveWonAnyway) return null;

  return {
    preferredPlayerId: winner.playerId,
    edge: Math.abs(edge),
    detail: `${winner.name} on a tiebreak — ${winning.display}`,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
