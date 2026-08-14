/**
 * Weekly decision quality: the things a projection alone does not say.
 *
 * A projection compares two players as if the week were a single moment. It is
 * not. Games kick off at different times, lines move between now and then, and
 * a player's role can be drifting under a stable-looking average. This module
 * covers the four questions that produces:
 *
 *   - has this player's game already started, so the decision is moot?
 *   - is the better player also the later one, and is the gap worth the risk?
 *   - has the market moved enough since the last look to matter?
 *   - is the player's role actually changing, or did he just have one big game?
 *
 * As with the draft layer, every threshold lives here rather than in a screen.
 *
 * Pure functions only. Nothing here writes a lineup — the app never does.
 */

import type { MarketKey } from '../vegas/types.ts';

// --------------------------------------------------------------- thresholds

export const WEEKLY_THRESHOLDS = {
  lateSwap: {
    /**
     * Hours after which a later kickoff counts as "late" relative to another.
     *
     * Three hours is the real gap between a 1pm slate and the late-afternoon
     * window; anything smaller is the same decision made twice.
     */
    minGapHours: 3,
    /**
     * Expected-points advantage above which a late, uncertain player is worth
     * waiting for anyway. Below it, a healthy early option is the safer play.
     */
    worthWaitingPoints: 3,
    /** Questionable is a coin flip worth naming; Doubtful is treated far harder. */
    riskByStatus: { QUESTIONABLE: 1, DOUBTFUL: 3 } as Record<string, number>,
  },

  movement: {
    /**
     * Movement below this is noise, per market.
     *
     * Normalised by what the market actually is: a yard of passing yardage is
     * nothing, a reception is a lot. These are the numbers the brief calls out
     * directly, and they are the ones most likely to need tuning in season.
     */
    minimum: {
      pass_yards: 15,
      pass_tds: 0.25,
      rush_yards: 8,
      receptions: 0.5,
      receiving_yards: 7,
      anytime_td: 0.07,
    } as Record<MarketKey, number>,
    /** Game-total movement that counts as the environment changing. */
    gameTotalPoints: 4,
    /** Markets moving the same way before it is called a broad move. */
    multiMarketCount: 2,
  },

  role: {
    /** Games in the recent window. */
    recentGames: 3,
    /** Fewer games than this in the baseline and the answer is "not enough data". */
    minBaselineGames: 3,
    /** Relative change below which the role is called stable. */
    minRelativeChange: 0.25,
    /** Relative change at which a single metric is emphatic on its own. */
    strongRelativeChange: 0.5,
    /**
     * Share of the recent window's total one game may hold before the move is
     * called a spike rather than a trend.
     *
     * Half of a three-game window in one game means the other two did nothing.
     */
    spikeShare: 0.5,
  },
} as const;

// ------------------------------------------------------------------- locked

export interface LockState {
  locked: boolean;
  /** ISO kickoff, or null when the schedule is unknown. */
  kickoff: string | null;
  reason: string;
}

/**
 * Has this player's game started?
 *
 * An unknown kickoff is never treated as locked: refusing to offer a swap
 * because the schedule could not be read would be the app inventing a
 * restriction the user does not have.
 */
export function lockState(kickoff: string | null | undefined, now: string | Date = new Date()): LockState {
  if (!kickoff) return { locked: false, kickoff: null, reason: 'kickoff time unknown' };
  const start = Date.parse(kickoff);
  if (!Number.isFinite(start)) return { locked: false, kickoff: null, reason: 'kickoff time unreadable' };
  const nowMs = new Date(now).getTime();
  return start <= nowMs
    ? { locked: true, kickoff, reason: 'game has started' }
    : { locked: false, kickoff, reason: 'game has not started' };
}

// --------------------------------------------------------------- late swap

export type LateSwapVerdict = 'no_risk' | 'worth_waiting' | 'consider_early_option' | 'unknown';

export interface LateSwapAssessment {
  verdict: LateSwapVerdict;
  label: string;
  detail: string;
  /** Hours the preferred player kicks off after the alternative. */
  gapHours: number | null;
  /** Expected-points advantage the later player holds. */
  advantage: number | null;
}

export interface LateSwapInput {
  /** The player the projection prefers. */
  preferred: { name: string; kickoff: string | null; status: string | null; score: number | null };
  /** The best alternative that locks earlier. */
  alternative: { name: string; kickoff: string | null; status: string | null; score: number | null } | null;
}

const LATE_SWAP_LABEL: Record<LateSwapVerdict, string> = {
  no_risk: 'No late-swap risk',
  worth_waiting: 'Worth waiting',
  consider_early_option: 'Late-swap risk',
  unknown: 'Late-swap risk unknown',
};

/**
 * Whether the better player being the later player is a problem.
 *
 * The trade is always the same shape: a bigger expected score against the
 * chance of getting nothing at all. What makes it decidable is that the
 * alternative locks first — once the early game kicks off, the choice is gone
 * whether or not the news has arrived. So the question is not "who is better"
 * but "is the gap big enough to spend the option on".
 *
 * Doubtful is treated far harder than Questionable, because it is a different
 * kind of statement: Questionable is genuinely uncertain, Doubtful is a soft no.
 */
export function assessLateSwap(input: LateSwapInput, now: string | Date = new Date()): LateSwapAssessment {
  const { preferred, alternative } = input;
  const status = (preferred.status ?? '').toUpperCase();
  const risk = WEEKLY_THRESHOLDS.lateSwap.riskByStatus[status] ?? 0;

  if (risk === 0) {
    return {
      verdict: 'no_risk',
      label: LATE_SWAP_LABEL.no_risk,
      detail: `${preferred.name} carries no injury designation.`,
      gapHours: null,
      advantage: null,
    };
  }

  if (!alternative || !preferred.kickoff || !alternative.kickoff) {
    return {
      verdict: 'unknown',
      label: LATE_SWAP_LABEL.unknown,
      detail: !alternative
        ? `${preferred.name} is ${titleCase(status)}, and there is no eligible alternative to fall back on.`
        : 'Kickoff times are unknown, so late-swap risk cannot be judged.',
      gapHours: null,
      advantage: null,
    };
  }

  const preferredStart = Date.parse(preferred.kickoff);
  const alternativeStart = Date.parse(alternative.kickoff);
  const gapHours = round1((preferredStart - alternativeStart) / 3_600_000);

  // Only a genuinely later kickoff creates the problem. If the alternative
  // plays at the same time or later, waiting costs nothing.
  if (!(gapHours >= WEEKLY_THRESHOLDS.lateSwap.minGapHours)) {
    return {
      verdict: 'no_risk',
      label: LATE_SWAP_LABEL.no_risk,
      detail: `${alternative.name} does not lock meaningfully earlier, so there is nothing to decide before kickoff.`,
      gapHours,
      advantage: null,
    };
  }

  // If the alternative has already locked, the option is spent.
  if (lockState(alternative.kickoff, now).locked) {
    return {
      verdict: 'unknown',
      label: LATE_SWAP_LABEL.unknown,
      detail: `${alternative.name} has already kicked off, so the swap is no longer available.`,
      gapHours,
      advantage: null,
    };
  }

  const advantage =
    preferred.score == null || alternative.score == null ? null : round1(preferred.score - alternative.score);

  if (advantage == null) {
    return {
      verdict: 'unknown',
      label: LATE_SWAP_LABEL.unknown,
      detail: `${preferred.name} is ${titleCase(status)} and plays ${gapHours} hours later, but there is not enough projection data to say whether waiting is worth it.`,
      gapHours,
      advantage: null,
    };
  }

  // Doubtful raises the bar for waiting; Questionable leaves it where it is.
  const bar = WEEKLY_THRESHOLDS.lateSwap.worthWaitingPoints * risk;
  if (advantage >= bar) {
    return {
      verdict: 'worth_waiting',
      label: LATE_SWAP_LABEL.worth_waiting,
      detail: `${preferred.name} is ${titleCase(status)} and plays ${gapHours} hours later, but projects ${advantage} points higher — enough to justify the availability risk.`,
      gapHours,
      advantage,
    };
  }

  return {
    verdict: 'consider_early_option',
    label: LATE_SWAP_LABEL.consider_early_option,
    detail:
      `${preferred.name} is ${titleCase(status)} and plays ${gapHours} hours after ${alternative.name}, ` +
      `who trails by only ${Math.abs(advantage)} points. Consider starting ${alternative.name} unless the status improves before kickoff.`,
    gapHours,
    advantage,
  };
}

// --------------------------------------------------------- market movement

export type MovementDirection = 'up' | 'down' | 'flat';

export interface MarketMovement {
  market: MarketKey | 'game_total';
  direction: MovementDirection;
  from: number;
  to: number;
  delta: number;
  /** True when the move cleared the threshold for this market. */
  significant: boolean;
  display: string;
}

export interface MovementSummary {
  movements: MarketMovement[];
  /** Only the ones worth showing. */
  significant: MarketMovement[];
  direction: MovementDirection;
  /** One compact line, or null when nothing moved enough to say. */
  headline: string | null;
}

const MARKET_LABEL: Record<MarketKey | 'game_total', string> = {
  pass_yards: 'Passing yards',
  pass_tds: 'Passing TDs',
  rush_yards: 'Rushing yards',
  receptions: 'Receptions',
  receiving_yards: 'Receiving yards',
  anytime_td: 'TD probability',
  game_total: 'Game total',
};

/** Is this much movement worth a word? Normalised per market. */
export function isSignificantMove(market: MarketKey | 'game_total', delta: number): boolean {
  const threshold =
    market === 'game_total'
      ? WEEKLY_THRESHOLDS.movement.gameTotalPoints
      : (WEEKLY_THRESHOLDS.movement.minimum[market] ?? Number.POSITIVE_INFINITY);
  return Math.abs(delta) >= threshold;
}

/**
 * Compare two snapshots of the same player's markets.
 *
 * Reads only markets present in both: a line that appeared or disappeared
 * between snapshots has not moved, it has changed availability, and reporting
 * that as a move would invent a number nobody quoted.
 */
export function compareMarkets(
  earlier: { market: MarketKey | 'game_total'; line: number | null }[],
  later: { market: MarketKey | 'game_total'; line: number | null }[],
): MovementSummary {
  const before = new Map(earlier.filter((m) => m.line != null).map((m) => [m.market, m.line!]));
  const movements: MarketMovement[] = [];

  for (const entry of later) {
    if (entry.line == null) continue;
    const from = before.get(entry.market);
    if (from == null) continue;
    const to = entry.line;
    const delta = round2(to - from);
    const direction: MovementDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    movements.push({
      market: entry.market,
      direction,
      from,
      to,
      delta,
      significant: delta !== 0 && isSignificantMove(entry.market, delta),
      display: `${MARKET_LABEL[entry.market]}: ${from} → ${to}`,
    });
  }

  const significant = movements.filter((m) => m.significant);
  const ups = significant.filter((m) => m.direction === 'up').length;
  const downs = significant.filter((m) => m.direction === 'down').length;
  const direction: MovementDirection = ups > downs ? 'up' : downs > ups ? 'down' : 'flat';

  let headline: string | null = null;
  if (significant.length >= WEEKLY_THRESHOLDS.movement.multiMarketCount && direction !== 'flat') {
    headline = `Multiple markets ${direction === 'up' ? 'rising' : 'falling'}`;
  } else if (significant.length === 1) {
    const only = significant[0]!;
    headline =
      only.market === 'game_total'
        ? `Game environment ${only.direction === 'up' ? 'rising' : 'falling'}`
        : `Market ${only.direction === 'up' ? 'rising' : 'falling'}`;
  }

  return { movements, significant, direction, headline };
}

// ------------------------------------------------------------ role change

export type RoleTrend =
  | 'rising_high'
  | 'rising_moderate'
  | 'stable'
  | 'falling_moderate'
  | 'falling_high'
  | 'spike'
  | 'insufficient_data';

export interface RoleMetric {
  /** e.g. 'targets', 'carries', 'routes', 'pass_attempts'. */
  key: string;
  label: string;
  /** Per-game values, oldest first. */
  perGame: number[];
}

export interface RoleAssessment {
  trend: RoleTrend;
  label: string;
  detail: string;
  /** Per-metric baseline vs recent, for the expandable view. */
  metrics: {
    key: string;
    label: string;
    baseline: number;
    recent: number;
    relativeChange: number;
    direction: MovementDirection;
  }[];
  /** How many games the judgement rests on. */
  games: number;
}

const ROLE_LABEL: Record<RoleTrend, string> = {
  rising_high: 'Role rising — high confidence',
  rising_moderate: 'Role rising — moderate confidence',
  stable: 'Role stable',
  falling_moderate: 'Role falling — moderate confidence',
  falling_high: 'Role falling — high confidence',
  spike: 'One-game spike; broader role stable',
  insufficient_data: 'Insufficient data',
};

/**
 * Is this player's opportunity actually changing?
 *
 * Two failure modes are worth more than the feature itself, and both are
 * guarded here. The first is calling a trend off one big game — fourteen
 * targets after averaging five is a game, not a role, so a recent window
 * dominated by one game is reported as a spike and explicitly not as a trend.
 * The second is calling it off one metric: targets rising while routes stay
 * flat is a weaker claim than both rising together, so high confidence needs
 * agreement across metrics rather than a bigger number in one of them.
 *
 * With no usage series at all the answer is "insufficient data". The app does
 * not have a per-game usage source connected, and inventing one from what it
 * does have would be exactly the fabrication the product rules forbid.
 */
export function assessRole(metrics: RoleMetric[], now = WEEKLY_THRESHOLDS.role): RoleAssessment {
  const usable = metrics.filter((m) => m.perGame.length >= now.recentGames + now.minBaselineGames);

  if (usable.length === 0) {
    return {
      trend: 'insufficient_data',
      label: ROLE_LABEL.insufficient_data,
      detail:
        metrics.length === 0
          ? 'No per-game usage is connected, so role changes cannot be detected yet.'
          : `Fewer than ${now.recentGames + now.minBaselineGames} games of usage, which is not enough to tell a role change from a normal week.`,
      metrics: [],
      games: Math.max(0, ...metrics.map((m) => m.perGame.length)),
    };
  }

  const rows = usable.map((metric) => {
    const recentValues = metric.perGame.slice(-now.recentGames);
    const baselineValues = metric.perGame.slice(0, -now.recentGames);
    const recent = mean(recentValues);
    const baseline = mean(baselineValues);
    const relativeChange = baseline === 0 ? (recent === 0 ? 0 : 1) : round3((recent - baseline) / baseline);
    return {
      key: metric.key,
      label: metric.label,
      baseline: round1(baseline),
      recent: round1(recent),
      relativeChange,
      direction: (relativeChange > 0 ? 'up' : relativeChange < 0 ? 'down' : 'flat') as MovementDirection,
      recentValues,
    };
  });

  const moved = rows.filter((r) => Math.abs(r.relativeChange) >= now.minRelativeChange);
  const games = Math.max(...usable.map((m) => m.perGame.length));

  /**
   * One-game spike protection, checked before anything else is said.
   *
   * This runs ahead of the stable check on purpose. The case the brief names —
   * a season average of 6, a recent average of 7, and one game of 14 — barely
   * moves the average at all, so a threshold test alone would call it "stable"
   * and say nothing. Stable is not wrong, but it is not what the user needs to
   * hear when they are looking at a 14-target game: the useful sentence is that
   * the fourteen happened and the role did not change.
   *
   * Rises only. A fall is not characterised by one enormous game, it is
   * characterised by several small ones, so the same share test would not mean
   * the same thing pointed downwards.
   */
  const risen = rows.filter((r) => r.recent > r.baseline);
  const spiky =
    risen.length > 0 &&
    risen.every((row) => {
      const total = row.recentValues.reduce((a, b) => a + b, 0);
      if (total <= 0) return false;
      return Math.max(...row.recentValues) / total > now.spikeShare;
    });
  if (spiky) {
    const led = risen.sort((a, b) => b.relativeChange - a.relativeChange)[0]!;
    return {
      trend: 'spike',
      label: ROLE_LABEL.spike,
      detail: `${led.label} averaged ${led.recent} over the last ${now.recentGames} against a baseline of ${led.baseline}, but one game carries most of it.`,
      metrics: rows.map(strip),
      games,
    };
  }

  if (moved.length === 0) {
    return {
      trend: 'stable',
      label: ROLE_LABEL.stable,
      detail: `Usage over the last ${now.recentGames} games is in line with the ${games - now.recentGames}-game baseline.`,
      metrics: rows.map(strip),
      games,
    };
  }

  const rising = moved.filter((r) => r.direction === 'up');
  const falling = moved.filter((r) => r.direction === 'down');
  const direction = rising.length > falling.length ? 'up' : falling.length > rising.length ? 'down' : null;
  if (!direction) {
    return {
      trend: 'stable',
      label: ROLE_LABEL.stable,
      detail: 'Opportunity metrics disagree about which way the role is moving, so neither is trusted.',
      metrics: rows.map(strip),
      games,
    };
  }

  const agreeing = direction === 'up' ? rising : falling;
  // High confidence wants agreement across metrics, or one emphatic metric with
  // nothing contradicting it.
  const emphatic = agreeing.some((r) => Math.abs(r.relativeChange) >= now.strongRelativeChange);
  const high = agreeing.length >= 2 || (emphatic && (direction === 'up' ? falling : rising).length === 0);
  const trend: RoleTrend =
    direction === 'up' ? (high ? 'rising_high' : 'rising_moderate') : high ? 'falling_high' : 'falling_moderate';

  const led = agreeing.sort((a, b) => Math.abs(b.relativeChange) - Math.abs(a.relativeChange))[0]!;
  return {
    trend,
    label: ROLE_LABEL[trend],
    detail:
      `${led.label} ${direction === 'up' ? 'up' : 'down'} from ${led.baseline} to ${led.recent} per game over the last ${now.recentGames}` +
      (agreeing.length > 1 ? `, with ${agreeing.length - 1} other metric${agreeing.length > 2 ? 's' : ''} agreeing.` : '.'),
    metrics: rows.map(strip),
    games,
  };
}

/** The points a rising or falling role is worth in a close start/sit call. */
export function rolePoints(trend: RoleTrend): number {
  switch (trend) {
    case 'rising_high':
      return 1;
    case 'rising_moderate':
      return 0.5;
    case 'falling_moderate':
      return -0.5;
    case 'falling_high':
      return -1;
    default:
      return 0;
  }
}

// ------------------------------------------------------------------ helpers

function strip(row: {
  key: string;
  label: string;
  baseline: number;
  recent: number;
  relativeChange: number;
  direction: MovementDirection;
}) {
  return {
    key: row.key,
    label: row.label,
    baseline: row.baseline,
    recent: row.recent,
    relativeChange: row.relativeChange,
    direction: row.direction,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
