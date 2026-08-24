/**
 * Role change, graded by how many independent things say so — and by whether
 * any of them is newer than the number it would be correcting.
 *
 * ## Why a depth chart on its own buys nothing
 *
 * §7 of the handoff asks for four evidence states — `none`, `depth_only`,
 * `depth_plus_snaps`, `depth_plus_roster` — and says "only the strongest states
 * should qualify for a small C-type mean adjustment", and separately that "a
 * depth-only change must not create a large mean adjustment".
 *
 * This module reads that as: a depth-only change creates **no** mean adjustment
 * at all. Not a small one. The reasoning is about what the artefact is. An
 * nflverse depth chart is a scrape of a club's published two-deep, and clubs
 * publish those to satisfy a league requirement rather than to describe how they
 * intend to use anybody. They are re-ordered alphabetically, left stale for
 * weeks, and corrected in bulk. Arizona's live 2026 chart has a rookie back
 * listed first and James Conner third. Treating that as evidence that the market
 * has mispriced Conner would be treating a form-filling exercise as information
 * the betting market somehow missed.
 *
 * What a depth chart *is* good for is asking a question. A player who has moved
 * is a player worth checking against a source that measures behaviour, and the
 * two this app has are snap share — what his club actually did with him — and
 * the roster, which knows whether the player ahead of him is still there. When
 * the chart and one of those agree, something has happened. When only the chart
 * moved, a form was edited.
 *
 * ## And why "newer than the market" is a separate gate
 *
 * §20 allows a mean adjustment only when the signal "is plausibly newer than the
 * market snapshot", and this is the subtlety the whole double-counting design
 * turns on. A depth-chart change published on Wednesday and a betting line
 * priced on Thursday are not two facts; they are one fact and a number that
 * already contains it. Adjusting the Thursday line for the Wednesday news counts
 * it twice, and it does so in the direction that feels most like insight.
 *
 * So the timestamps are compared, and where the market's own timestamp is
 * unknown the adjustment is **declined** rather than assumed to be warranted.
 * That is the conservative direction and it is deliberately the direction that
 * makes Projection v2 look less different from the market, because §21 warns
 * against tuning to make it look different.
 */

import type { DepthRole } from '../nflverse/depthChart.ts';

/** §7's four states, in its own vocabulary. */
export type RoleChangeState = 'none' | 'depth_only' | 'depth_plus_snaps' | 'depth_plus_roster';

export type RoleChangeDirection = 'promotion' | 'demotion' | 'none';

/**
 * The cap on what a fresh-information adjustment may do, expressed two ways.
 *
 * Both bind, and the smaller wins. A flat points cap alone is wrong because 1.5
 * points is 7% of a starting quarterback and 37% of a streaming tight end, and a
 * proportional cap alone is wrong because 10% of a 30-point projection is three
 * points of movement out of a depth chart, which is more than this evidence can
 * carry however large the player.
 *
 * The numbers are chosen to be visibly smaller than the market signal they sit
 * beside rather than fitted to anything: §14 says "Do not tune to maximize
 * apparent movement", and a cap arrived at by seeing how much movement it
 * produced would be exactly that.
 */
export const FRESH_INFORMATION_CAP = {
  /** Maximum absolute points a C-class adjustment may move a central estimate. */
  points: 1.5,
  /** And never more than this share of the anchor it is adjusting. */
  shareOfAnchor: 0.1,
} as const;

/** One club's roster facts, as the crosswalk stores them. */
export interface RosterFact {
  gsisId: string;
  team: string | null;
  position: string;
  /** `ACT`, `RES`, `CUT`, `RET`, ... A roster state, never a health state. */
  status: string | null;
}

/** Snap share before and after, for the corroboration test. */
export interface SnapTrend {
  /** Recency-weighted snap share over the most recent games. */
  recent: number | null;
  /** The same over the games before them. */
  baseline: number | null;
  /** Games behind `recent`. Below two, nothing is claimed. */
  recentGames: number;
}

export interface RoleChangeEvidence {
  state: RoleChangeState;
  direction: RoleChangeDirection;
  /**
   * When the newest supporting evidence was captured.
   *
   * The depth chart's own `dt` where the current schema supplies one. Null
   * means the evidence has no timestamp, which under §20 means it cannot
   * authorise a mean adjustment however strong it looks.
   */
  observedAt: string | null;
  /** True only when `observedAt` is known and strictly after the market snapshot. */
  newerThanMarket: boolean;
  /** Whether all three gates passed: corroborated, timestamped, newer. */
  qualifiesForMeanAdjustment: boolean;
  /** 0–1. How far he moved, not how much he is worth. */
  strength: number;
  previousRank: number | null;
  currentRank: number | null;
  reasons: string[];
}

export const NO_ROLE_CHANGE: RoleChangeEvidence = {
  state: 'none',
  direction: 'none',
  observedAt: null,
  newerThanMarket: false,
  qualifiesForMeanAdjustment: false,
  strength: 0,
  previousRank: null,
  currentRank: null,
  reasons: [],
};

/**
 * How much snap share must move before it corroborates anything.
 *
 * Ten points of share. A back going from 42% to 48% has not been promoted; he
 * has had two different afternoons. Below this the snaps are treated as saying
 * nothing rather than as saying "no" — silence and disagreement are different
 * answers and only one of them should downgrade a state.
 */
export const SNAP_CORROBORATION_DELTA = 0.1;

/**
 * Grade one player's role change.
 *
 * Every input is optional and every absence costs exactly what it should: no
 * previous chart means no change can be detected at all, no snaps means the
 * strongest state reachable is `depth_plus_roster`, and no market timestamp
 * means nothing reaches the mean.
 */
export function assessRoleChange(input: {
  current: DepthRole | null | undefined;
  previous: DepthRole | null | undefined;
  /** The `dt` of the chart `current` came from. */
  observedAt?: string | null;
  snaps?: SnapTrend | null;
  /** The player's own roster row now, and the club's chart as it was. */
  roster?: RosterFact | null;
  /** Everyone who was ranked above him on the previous chart, by `gsis_id`. */
  previouslyAhead?: { gsisId: string; rank: number }[] | null;
  /** Their roster rows now, keyed by `gsis_id`. */
  rosterByGsis?: Map<string, RosterFact> | null;
  /** When the market lines this would adjust were captured. */
  marketAsOf?: string | null;
}): RoleChangeEvidence {
  const { current, previous } = input;
  if (!current || !previous) return NO_ROLE_CHANGE;
  // A chart is only comparable with itself: same club, same position, same
  // personnel grouping. §7's "compare within same team/pos group/slot".
  if (current.team !== previous.team || current.position !== previous.position) return NO_ROLE_CHANGE;
  if ((current.group ?? '') !== (previous.group ?? '')) return NO_ROLE_CHANGE;
  if (current.rank === previous.rank) return NO_ROLE_CHANGE;

  const direction: RoleChangeDirection = current.rank < previous.rank ? 'promotion' : 'demotion';
  const moved = Math.abs(current.rank - previous.rank);
  /*
   * Strength is scaled against the spots the club actually fields, not against
   * the length of the chart. Moving from fourth to third among three fielded
   * receivers is the whole story; moving from ninth to eighth is not a story.
   */
  const denominator = Math.max(1, current.starterSlots + 1);
  const strength = round2(Math.min(1, moved / denominator));

  const reasons: string[] = [
    `depth chart moved him from ${previous.rank} to ${current.rank} at ${current.position} for ${current.team}`,
  ];

  // ---- corroboration 1: did his club's snap usage move the same way? -------
  let snapAgrees = false;
  const snaps = input.snaps;
  if (snaps && snaps.recent != null && snaps.baseline != null && snaps.recentGames >= 2) {
    const delta = snaps.recent - snaps.baseline;
    if (Math.abs(delta) >= SNAP_CORROBORATION_DELTA) {
      snapAgrees = (delta > 0 && direction === 'promotion') || (delta < 0 && direction === 'demotion');
      if (snapAgrees) {
        reasons.push(
          `snap share ${delta > 0 ? 'rose' : 'fell'} from ${pct(snaps.baseline)} to ${pct(snaps.recent)} over ${snaps.recentGames} games`,
        );
      } else {
        reasons.push(
          `snap share moved the other way, from ${pct(snaps.baseline)} to ${pct(snaps.recent)}, so the chart is not corroborated`,
        );
      }
    }
  }

  // ---- corroboration 2: did somebody ahead of him leave the roster? --------
  let rosterAgrees = false;
  if (direction === 'promotion' && input.previouslyAhead && input.rosterByGsis) {
    for (const ahead of input.previouslyAhead) {
      if (ahead.rank >= previous.rank) continue;
      const fact = input.rosterByGsis.get(ahead.gsisId);
      // Absent from the roster entirely, or on it in a state that is not active.
      const gone = !fact || (fact.status ?? '').toUpperCase() !== 'ACT';
      if (gone) {
        rosterAgrees = true;
        reasons.push(
          fact
            ? `a player ranked ${ahead.rank} ahead of him is listed ${fact.status} rather than active`
            : `a player ranked ${ahead.rank} ahead of him is no longer on the club's roster`,
        );
        break;
      }
    }
  }

  const state: RoleChangeState = snapAgrees
    ? 'depth_plus_snaps'
    : rosterAgrees
      ? 'depth_plus_roster'
      : 'depth_only';

  const observedAt = input.observedAt ?? null;
  const marketAsOf = input.marketAsOf ?? null;
  const newerThanMarket = observedAt != null && marketAsOf != null && isAfter(observedAt, marketAsOf);

  const corroborated = state === 'depth_plus_snaps' || state === 'depth_plus_roster';
  const qualifies = corroborated && newerThanMarket;

  if (!corroborated) {
    reasons.push(
      'the depth chart moved and nothing else did, so this changes the uncertainty and not the projection',
    );
  } else if (observedAt == null) {
    reasons.push('the chart carries no capture time, so it cannot be shown to be newer than the market');
  } else if (marketAsOf == null) {
    reasons.push('the market snapshot has no timestamp, so this cannot be shown to be new information');
  } else if (!newerThanMarket) {
    reasons.push(
      `the chart was captured ${observedAt} and the market was priced ${marketAsOf}, so the market already had this`,
    );
  }

  return {
    state,
    direction,
    observedAt,
    newerThanMarket,
    qualifiesForMeanAdjustment: qualifies,
    strength,
    previousRank: previous.rank,
    currentRank: current.rank,
    reasons,
  };
}

/**
 * The points a qualifying role change may move a central estimate.
 *
 * Returns 0 for everything that does not qualify, which is most things. The
 * magnitude is the strength of the move times the flat cap, then bound again by
 * the proportional cap — so the largest possible promotion on the largest
 * possible projection still moves by 1.5 points, and on a small projection by
 * a tenth of it.
 */
export function freshInformationAdjustment(
  evidence: RoleChangeEvidence,
  anchorPoints: number | null,
): { points: number; capped: boolean; reason: string | null } {
  if (!evidence.qualifiesForMeanAdjustment || anchorPoints == null) {
    return { points: 0, capped: false, reason: null };
  }
  const sign = evidence.direction === 'demotion' ? -1 : 1;
  const raw = sign * evidence.strength * FRESH_INFORMATION_CAP.points;
  const proportional = Math.abs(anchorPoints) * FRESH_INFORMATION_CAP.shareOfAnchor;
  const bounded = Math.sign(raw) * Math.min(Math.abs(raw), FRESH_INFORMATION_CAP.points, proportional);
  const capped = Math.abs(bounded) < Math.abs(raw) - 1e-9;
  return {
    points: round2(bounded),
    capped,
    reason:
      `${evidence.state} role change, newer than the market snapshot: ` +
      `${bounded >= 0 ? '+' : ''}${round2(bounded)} pts` +
      (capped ? ` (capped from ${round2(raw)})` : ''),
  };
}

/**
 * Compare two ISO timestamps without trusting either to be well formed.
 *
 * A source that starts writing a timestamp this module cannot parse must make
 * the answer "no", never "yes": an unparseable date that compared greater would
 * turn the safety gate into an open door.
 */
function isAfter(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return left > right;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
