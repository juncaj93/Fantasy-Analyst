/**
 * Roster need and positional scarcity.
 *
 * Both are computed from Sleeper league settings + the live draft state; nothing
 * about "typical" roster construction is hardcoded.
 */

import type { RosterShape } from '../sleeper/scoring.ts';

export interface RosterCounts {
  /** Canonical position -> number of players already rostered. */
  [position: string]: number;
}

export interface NeedBreakdown {
  position: string;
  /** Dedicated starting slots still unfilled. */
  startersUnfilled: number;
  /** Flex slots this position could still fill. */
  flexOpen: number;
  /** 0..1. 1 = a starting slot is empty; low = depth piece only. */
  score: number;
  reason: string;
}

/**
 * How badly each position is needed, given fixed starters, flex slots and what
 * is already rostered.
 */
export function computeNeed(shape: RosterShape, counts: RosterCounts): Record<string, NeedBreakdown> {
  const out: Record<string, NeedBreakdown> = {};
  const positions = new Set<string>([
    ...Object.keys(shape.starters),
    ...shape.flex.flatMap((f) => f.positions),
    ...Object.keys(counts),
  ]);

  // Players used to fill dedicated starting slots are not available for flex.
  const surplus: Record<string, number> = {};
  for (const pos of positions) {
    const required = shape.starters[pos] ?? 0;
    surplus[pos] = Math.max(0, (counts[pos] ?? 0) - required);
  }

  // Greedily fill flex slots with surplus players to see what remains open.
  let flexRemaining = 0;
  const flexEligibleFor: Record<string, number> = {};
  for (const flex of shape.flex) {
    let filled = false;
    for (const pos of flex.positions) {
      if ((surplus[pos] ?? 0) > 0) {
        surplus[pos] = (surplus[pos] ?? 0) - 1;
        filled = true;
        break;
      }
    }
    if (!filled) {
      flexRemaining++;
      for (const pos of flex.positions) {
        flexEligibleFor[pos] = (flexEligibleFor[pos] ?? 0) + 1;
      }
    }
  }

  for (const pos of positions) {
    const required = shape.starters[pos] ?? 0;
    const have = counts[pos] ?? 0;
    const startersUnfilled = Math.max(0, required - have);
    const flexOpen = flexEligibleFor[pos] ?? 0;

    let score: number;
    let reason: string;
    if (startersUnfilled > 0) {
      // An empty dedicated starting slot is the strongest need signal.
      score = Math.min(1, 0.8 + 0.2 * Math.min(1, startersUnfilled / Math.max(1, required)));
      reason = `${startersUnfilled} unfilled ${pos} starting slot${startersUnfilled > 1 ? 's' : ''}`;
    } else if (flexOpen > 0) {
      score = 0.55;
      reason = `can still fill ${flexOpen} flex slot${flexOpen > 1 ? 's' : ''}`;
    } else if (required > 0 || flexEligible(shape, pos)) {
      // Depth behind filled slots still has value, but much less.
      const depth = have - required;
      score = Math.max(0.1, 0.4 - depth * 0.08);
      reason = `starters filled; depth only (${have} rostered)`;
    } else {
      score = 0.05;
      reason = 'position not used by this league';
    }

    out[pos] = {
      position: pos,
      startersUnfilled,
      flexOpen,
      score: round3(score),
      reason,
    };
  }

  void flexRemaining;
  return out;
}

function flexEligible(shape: RosterShape, pos: string): boolean {
  return shape.flex.some((f) => f.positions.includes(pos));
}

export interface ScarcityInput {
  /** ADP values of all still-available players at this position, ascending. */
  availableAdps: number[];
  /** ADP of the player being evaluated. */
  playerAdp: number | null;
  /** Picks until the user's next selection. */
  picksUntilNext: number;
}

export interface ScarcityBreakdown {
  /** 0..1. Higher = the position dries up sooner. */
  score: number;
  /** Gap in ADP between this player and the next available one at the position. */
  tierGap: number | null;
  /** Players at this position expected to be gone before the user picks again. */
  expectedGoneBeforeNextPick: number;
  /** Players at this position likely left at the user's next pick. */
  expectedRemaining: number;
  reason: string;
}

/**
 * Positional scarcity via a simple tier-gap + depth model.
 *
 * `tierGap` measures the drop-off immediately after this player: a large gap
 * means the next man up is meaningfully worse, i.e. a real tier break.
 */
export function computeScarcity(input: ScarcityInput): ScarcityBreakdown {
  const sorted = [...input.availableAdps].filter((a) => Number.isFinite(a)).sort((a, b) => a - b);
  if (input.playerAdp == null || sorted.length === 0) {
    return {
      score: 0.3,
      tierGap: null,
      expectedGoneBeforeNextPick: 0,
      expectedRemaining: sorted.length,
      reason: 'insufficient ADP data for scarcity',
    };
  }

  const playerAdp = input.playerAdp;
  const idx = sorted.findIndex((a) => a > playerAdp);
  const next = idx === -1 ? null : sorted[idx]!;
  const tierGap = next == null ? null : round1(next - playerAdp);

  // Players at this position whose ADP falls inside the window before the
  // user's next pick are the ones likely to disappear.
  const windowEnd = playerAdp + input.picksUntilNext;
  const goneSoon = sorted.filter((a) => a > playerAdp && a <= windowEnd).length;
  const remaining = sorted.filter((a) => a > windowEnd).length;

  // A big tier gap or a thin remaining pool both raise scarcity.
  const gapScore = tierGap == null ? 0.3 : Math.min(1, tierGap / 25);
  const depthScore = remaining === 0 ? 1 : Math.min(1, 6 / (remaining + 1));
  const score = clamp(0.55 * gapScore + 0.45 * depthScore, 0, 1);

  return {
    score: round3(score),
    tierGap,
    expectedGoneBeforeNextPick: goneSoon,
    expectedRemaining: remaining,
    reason:
      tierGap != null && tierGap >= 12
        ? `tier break: next available is ${tierGap} picks later`
        : `${remaining} comparable player${remaining === 1 ? '' : 's'} expected past your next pick`,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
