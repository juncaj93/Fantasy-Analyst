/**
 * Fantasy outcomes are not independent, and pretending otherwise is a specific
 * lie with a specific direction.
 *
 * Two starters from the same offence rise and fall together; a quarterback and
 * a receiver on opposite sides of one game both do well when it is a shootout;
 * two backs in one committee are splitting a fixed number of carries. Modelling
 * all of that as independent makes both teams' totals *too tightly clustered
 * around their means*, which pushes every win probability toward whichever side
 * is ahead on projection. In a close matchup that is exactly the number a user
 * would act on.
 *
 * ## Why a factor model and not a matrix
 *
 * The obvious implementation is a correlation matrix built from rules, and it
 * has a fatal problem: rules written one pair at a time do not produce a
 * positive semi-definite matrix, and a matrix that is not PSD cannot be
 * factored, which means it cannot be sampled from. The failure is silent —
 * `NaN` appears in a Cholesky step and a win probability comes out as
 * `undefined` on a Sunday.
 *
 * A factor model cannot fail that way. Each player's standard-normal deviate is
 * a weighted sum of shared factors and one of his own, with the weights
 * constrained so the total variance is exactly one. Every correlation it
 * implies is automatically consistent, and the implied numbers are readable
 * straight off the loadings: two players' correlation is the sum of the
 * products of the loadings on the factors they share.
 *
 * ## Deliberately conservative
 *
 * `docs/` has one sentence on this that governs the whole file: calibration
 * matters more than complexity. Every loading here is small, every implied
 * correlation is well inside what published research would support, and there
 * is no attempt to model anything this app has no free data for — no snap
 * shares, no route participation, no depth chart. A correlation the model
 * cannot justify is set to zero rather than guessed at.
 */

/**
 * The loadings, by position. Read them as: how much of a player's week is his
 * offence, how much is his game, and how much is his own.
 *
 * `team` is the offence factor — one draw per NFL club per simulation, shared
 * by everybody on it. `game` is the shootout factor, one draw per fixture,
 * shared by both sides. `rival` is the usage-competition factor, one draw per
 * club *and position*, and it is the only one applied with alternating signs:
 * the first back on a roster gets `+`, the second `−`, so their correlation
 * through it is negative. That is the committee, and it is why two backs from
 * one team are not two independent chances at a good afternoon.
 *
 * The residual weight is whatever is left to make the three sum to one in
 * squares, so no combination here can produce a variance other than one.
 */
export const FACTOR_LOADINGS: Record<string, { team: number; game: number; rival: number }> = {
  // A quarterback *is* his offence, more than anyone else on it.
  QB: { team: 0.55, game: 0.25, rival: 0 },
  // Receivers share the passing game; two of them still both benefit from a
  // good one, so the rival term is small and does not overturn that.
  WR: { team: 0.45, game: 0.25, rival: 0.2 },
  TE: { team: 0.4, game: 0.22, rival: 0.2 },
  // A back's week is volume, which is far less tied to how well the offence
  // throws — and far more contested by the man behind him.
  RB: { team: 0.2, game: 0.1, rival: 0.35 },
  K: { team: 0.3, game: 0.15, rival: 0 },
  DEF: { team: 0.25, game: -0.3, rival: 0 },
};

const DEFAULT_LOADING = { team: 0.25, game: 0.15, rival: 0 };

/** One player's place in the factor structure. */
export interface FactorAssignment {
  playerId: string;
  /** Index into the per-team factor draws, or -1 when the club is unknown. */
  teamFactor: number;
  /** Index into the per-fixture factor draws, or -1 when the game is unknown. */
  gameFactor: number;
  /** Index into the per-team-and-position factor draws, or -1. */
  rivalFactor: number;
  /** `+1` or `−1`, alternating within a club's players at one position. */
  rivalSign: number;
  team: number;
  game: number;
  rival: number;
  /** Whatever is left over, so the three loadings and this sum to one in squares. */
  residual: number;
}

export interface FactorStructure {
  assignments: FactorAssignment[];
  teamFactors: number;
  gameFactors: number;
  rivalFactors: number;
}

/**
 * Assign every player to the factors he shares with the others.
 *
 * Order matters for exactly one thing: which of two teammates at a position
 * gets the `+` side of the usage-competition factor. It is decided by the order
 * the players arrive, which the caller sorts by projection — so the bigger
 * share of the committee is the `+`, and the arrangement is stable for an
 * unchanged matchup state, which is what §5 requires of everything here.
 */
export function buildFactorStructure(
  players: { playerId: string; position: string; team: string; opponent: string | null }[],
): FactorStructure {
  const teamIndex = new Map<string, number>();
  const gameIndex = new Map<string, number>();
  const rivalIndex = new Map<string, number>();
  const rivalSeen = new Map<string, number>();

  const indexOf = (map: Map<string, number>, key: string | null): number => {
    if (!key) return -1;
    const existing = map.get(key);
    if (existing != null) return existing;
    const next = map.size;
    map.set(key, next);
    return next;
  };

  const assignments = players.map((player) => {
    const team = (player.team ?? '').toUpperCase();
    const opponent = (player.opponent ?? '').toUpperCase();
    const position = (player.position ?? '').toUpperCase();
    const loading = FACTOR_LOADINGS[position] ?? DEFAULT_LOADING;

    /*
     * Both clubs, in a stable order, so the two sides of one fixture land on
     * one factor. Without the sort, `KC@CIN` and `CIN@KC` would be two games.
     */
    const gameKey = team && opponent ? [team, opponent].sort().join('@') : null;
    const rivalKey = team && loading.rival !== 0 ? `${team}:${position}` : null;

    const rivalFactor = indexOf(rivalIndex, rivalKey);
    let rivalSign = 1;
    if (rivalKey) {
      const seen = rivalSeen.get(rivalKey) ?? 0;
      rivalSeen.set(rivalKey, seen + 1);
      rivalSign = seen % 2 === 0 ? 1 : -1;
    }

    const sumSquares = loading.team ** 2 + loading.game ** 2 + loading.rival ** 2;
    return {
      playerId: player.playerId,
      teamFactor: indexOf(teamIndex, team || null),
      gameFactor: indexOf(gameIndex, gameKey),
      rivalFactor,
      rivalSign,
      team: loading.team,
      game: loading.game,
      rival: loading.rival,
      // Guarded, though no table entry comes close: a residual of zero would
      // make a player a deterministic function of the slate, which is nonsense.
      residual: Math.sqrt(Math.max(1 - sumSquares, 0.05)),
    } satisfies FactorAssignment;
  });

  return {
    assignments,
    teamFactors: teamIndex.size,
    gameFactors: gameIndex.size,
    rivalFactors: rivalIndex.size,
  };
}

/**
 * The correlation the structure implies between two players.
 *
 * Not used by the sampler — the sampler gets correlation for free from the
 * factors — but it is what the tests assert against, and it is the only way to
 * state in one number what the loadings above actually mean. A model whose
 * implied correlations nobody can read is a model nobody can bound.
 */
export function impliedCorrelation(a: FactorAssignment, b: FactorAssignment): number {
  if (a.playerId === b.playerId) return 1;
  let rho = 0;
  if (a.teamFactor >= 0 && a.teamFactor === b.teamFactor) rho += a.team * b.team;
  if (a.gameFactor >= 0 && a.gameFactor === b.gameFactor) rho += a.game * b.game;
  if (a.rivalFactor >= 0 && a.rivalFactor === b.rivalFactor) {
    rho += a.rival * b.rival * a.rivalSign * b.rivalSign;
  }
  return Math.round(rho * 1000) / 1000;
}

/**
 * The ceiling every implied correlation must sit under.
 *
 * Asserted in the tests rather than enforced here, because enforcing it at
 * runtime would mean clamping a number the loadings had already produced — and
 * a clamp that fires is a table that is wrong, which a test should catch rather
 * than a `Math.min` should hide.
 */
export const MAX_IMPLIED_CORRELATION = 0.45;
