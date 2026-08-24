/**
 * How the people at this table have drafted before.
 *
 * A league with returning managers knows something a market prior cannot: not
 * "what do drafters do with the sixty-first pick", but "what does *this* man do
 * with it". He took his quarterback in round fourteen two years running. She has
 * never let a tight end past round three. That is real information, it is
 * specific to the eleven people who pick before you, and Sleeper publishes the
 * drafts it can be read from.
 *
 * ## What this file is and is not
 *
 * It is a **measurement**. It reads completed historical picks and returns, per
 * manager and per position, a small signed number: positive means this manager
 * wants the position sooner than the room does, negative later, zero means
 * nothing is known. Every one of them carries the sample it was computed from.
 *
 * It is *not* the adjustment. It does not know what a draft looks like today,
 * which managers pick before the user, or what anybody's roster already holds.
 * `core/draft/nextpick/managerPrior.ts` owns that, and this module cannot reach
 * `Next%` except through it. The separation is the same one `draftProfile.ts`
 * draws and for the same reason: evidence and the use of evidence are different
 * jobs, and a file that does both tends to quietly start tuning the evidence.
 *
 * ## Identity is a user, never a roster
 *
 * `roster_id` is a slot in a league table and it gets reused. In the league this
 * was built against, roster 4 was three different people in three seasons —
 * Anthonyberardo, then Tupaz11, then a manager who joined in 2026 and had never
 * drafted in this league at all. Keying history by roster id would have handed
 * the newcomer a confident thirty-two-pick profile assembled from two strangers.
 *
 * So identity is Sleeper's `picked_by` user id, everywhere, in both directions:
 * a manager who moves between roster ids keeps his history, and a roster id that
 * changes hands does not pass one along. A pick with no `picked_by` is dropped
 * rather than guessed at.
 *
 * ## Two drafts is not two hundred
 *
 * Almost every real profile here rests on one or two drafts, so the shrinkage is
 * doing more work than the estimate is. Two things shrink an observation:
 *
 *   - **How much of it there is.** The usual `n / (n + k)`.
 *   - **How much it disagrees with itself.** A manager whose first quarterback
 *     went in rounds 4 and 4 has said something. One whose went in rounds 7 and
 *     16 has a mean of 11.5 and has said nothing at all, and the mean is the
 *     more dangerous of the two because it looks like an answer. Both have n=2,
 *     so sample size alone cannot tell them apart — the spread has to.
 *
 * Recency tilts the weighting modestly and is not allowed to erase anything: the
 * older season keeps most of its vote, because a manager who waited on
 * quarterback for three straight years is described by all three years.
 */

import type { HistoricalPick } from './draftProfile.ts';

export const TENDENCY = {
  /**
   * Shrinkage constant on draft count: an observation from `n` drafts keeps
   * `n / (n + k)` of itself.
   *
   * At k = 1.5 a single draft keeps 40% of its claim and two keeps 57%. Set
   * this low and one strange draft becomes a personality; set it high and a
   * league with two seasons of history — which is the common case, and the case
   * this was built against — says nothing at all and the feature is decorative.
   */
  draftShrink: 1.5,
  /**
   * How much self-disagreement costs, in rounds.
   *
   * The manager's own mean absolute deviation across drafts is divided by this
   * and added to the shrinkage denominator. At 3, a spread of three rounds
   * roughly halves the signal and a spread of zero costs nothing. Chosen
   * against real data: first-quarterback rounds of [4, 4] must survive and
   * [7, 16] must not.
   */
  spreadScale: 3,
  /** Per season of age, the weight an observation keeps. Modest on purpose. */
  recencyDecay: 0.85,
  /** However old, an observation never falls below this share of a vote. */
  recencyFloor: 0.6,
  /** Picks by one manager below which nothing at all is claimed. */
  minPicks: 12,
  /** Distinct drafts below which nothing at all is claimed. */
  minDrafts: 1,
  /** Round-bucket boundaries, as a share of the draft's length. */
  buckets: { earlyTo: 0.2, midTo: 0.5 },
  /** Picks in a bucket below which its rate is not reported. Descriptive only. */
  minBucketPicks: 6,
  /**
   * How far from the room a timing delta can push, per round of difference.
   *
   * A manager who takes his quarterback three rounds before the room, with a
   * clean sample, lands near the cap. Bounded hard here and again downstream.
   */
  timingGain: 0.06,
  /** How far a whole-draft rate difference can push, per unit of relative rate. */
  rateGain: 0.2,
  /** Shrinkage constant on a manager's pick count, for the rate reading. */
  rateShrink: 24,
  /** The signed tendency each position is finally clamped to. */
  bounds: { min: -0.35, max: 0.35 },
} as const;

/** Where in a draft a pick falls. Derived from the draft's own length. */
export type RoundBucket = 'early' | 'mid' | 'late';

export interface PositionTendency {
  position: string;
  /**
   * Signed appetite relative to the room. Positive means sooner/more often.
   *
   * This is not a multiplier and not a probability — it is an input to one, and
   * `managerPrior.ts` decides what a unit of it is worth.
   */
  lift: number;
  /** Median round this manager first took the position. Null when he never did. */
  medianFirstRound: number | null;
  /** The room's median, for the same position, over the same drafts. */
  roomMedianFirstRound: number | null;
  /** Manager's share of his picks at this position, by bucket. Null below sample. */
  rateByBucket: Partial<Record<RoundBucket, number | null>>;
  /** Drafts in which he took at least one. */
  draftsWithPosition: number;
  /** Mean absolute deviation of his first-round observations, in rounds. */
  spread: number | null;
  /** Total weight behind `lift`, in [0,1]. 0 means "nothing known". */
  confidence: number;
}

export interface ManagerTendencies {
  /** Sleeper user id. The only stable cross-season identity. */
  userId: string;
  displayName: string | null;
  draftsObserved: number;
  picksObserved: number;
  seasons: string[];
  /** True when there is enough history to claim anything at all. */
  usable: boolean;
  byPosition: Map<string, PositionTendency>;
  /** Plain sentences, for the developer-facing breakdown. Never user copy. */
  notes: string[];
}

/** Nothing known. A new manager, an unmatched identity, an empty history. */
export function neutralTendencies(userId: string, displayName: string | null = null): ManagerTendencies {
  return {
    userId,
    displayName,
    draftsObserved: 0,
    picksObserved: 0,
    seasons: [],
    usable: false,
    byPosition: new Map(),
    notes: ['no usable draft history'],
  };
}

export interface TendencyInput {
  /** Every historical pick available, all managers, all seasons. */
  picks: HistoricalPick[];
  /** Positions the current league starts. Nothing else is measured. */
  positions: string[];
  /** Rounds in the historical drafts, for bucketing. Defaults to what is seen. */
  rounds?: number;
  /** The newest season in the chain, for recency weighting. */
  latestSeason?: string;
  displayNames?: Map<string, string | null>;
}

/**
 * Read every returning manager's tendencies out of the league's draft history.
 *
 * Pure and deterministic: the same picks produce the same numbers, which is what
 * lets the diagnostics be checked against a real league rather than believed.
 */
export function readManagerTendencies(input: TendencyInput): Map<string, ManagerTendencies> {
  const out = new Map<string, ManagerTendencies>();
  const picks = input.picks.filter((p) => p.userId && p.position);
  if (picks.length === 0) return out;

  const rounds = input.rounds ?? Math.max(1, ...picks.map((p) => p.round));
  const latestSeason = input.latestSeason ?? [...picks.map((p) => p.season)].sort().at(-1) ?? '';

  // The room, over exactly the same picks the managers are measured against —
  // so a manager's "earlier than the room" cannot be an artefact of the two
  // being computed over different drafts.
  const roomFirstRound = new Map<string, number | null>();
  const roomBucketRate = new Map<string, Map<RoundBucket | 'all', number>>();
  for (const position of input.positions) {
    /*
     * The room's median is over *managers*, not over drafts.
     *
     * "When does the first quarterback leave the board" and "when does a typical
     * manager take his quarterback" are different questions with very different
     * answers — the first is a minimum over twelve people and lands several
     * rounds earlier. Comparing a manager against the minimum would score
     * everybody except the single earliest drafter as a quarterback-waiter, and
     * the one manager who reached would define the baseline he is measured
     * against.
     */
    roomFirstRound.set(position, median(firstRoundsByManagerAndDraft(picks, position).map((r) => r.round)));
  }
  for (const position of input.positions) {
    const byPos = new Map<RoundBucket | 'all', number>();
    byPos.set('all', picks.length > 0 ? picks.filter((p) => p.position === position).length / picks.length : 0);
    for (const bucket of ['early', 'mid', 'late'] as const) {
      const inBucket = picks.filter((p) => bucketOf(p.round, rounds) === bucket);
      byPos.set(
        bucket,
        inBucket.length > 0 ? inBucket.filter((p) => p.position === position).length / inBucket.length : 0,
      );
    }
    roomBucketRate.set(position, byPos);
  }

  const byUser = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    const list = byUser.get(pick.userId!);
    if (list) list.push(pick);
    else byUser.set(pick.userId!, [pick]);
  }

  for (const [userId, mine] of byUser) {
    const displayName = input.displayNames?.get(userId) ?? null;
    const drafts = new Set(mine.map((p) => p.draftId));
    const seasons = [...new Set(mine.map((p) => p.season))].sort();

    if (mine.length < TENDENCY.minPicks || drafts.size < TENDENCY.minDrafts) {
      const thin = neutralTendencies(userId, displayName);
      thin.draftsObserved = drafts.size;
      thin.picksObserved = mine.length;
      thin.seasons = seasons;
      thin.notes = [
        `${mine.length} pick(s) across ${drafts.size} draft(s) — below the ${TENDENCY.minPicks}-pick minimum, so no tendency is claimed`,
      ];
      out.set(userId, thin);
      continue;
    }

    const byPosition = new Map<string, PositionTendency>();
    const notes: string[] = [];

    for (const position of input.positions) {
      const tendency = positionTendency({
        mine,
        position,
        rounds,
        latestSeason,
        roomMedian: roomFirstRound.get(position) ?? null,
        roomRates: roomBucketRate.get(position) ?? new Map<RoundBucket | 'all', number>(),
      });
      byPosition.set(position, tendency);

      if (Math.abs(tendency.lift) >= 0.05 && tendency.medianFirstRound != null && tendency.roomMedianFirstRound != null) {
        const delta = tendency.roomMedianFirstRound - tendency.medianFirstRound;
        notes.push(
          `${position}: first one in round ${tendency.medianFirstRound} against the room's ${tendency.roomMedianFirstRound} ` +
            `(${delta > 0 ? `${round2(delta)} earlier` : `${round2(-delta)} later`}, ` +
            `${tendency.draftsWithPosition} draft(s), spread ${tendency.spread ?? 0}, confidence ${round2(tendency.confidence)})`,
        );
      }
    }

    out.set(userId, {
      userId,
      displayName,
      draftsObserved: drafts.size,
      picksObserved: mine.length,
      seasons,
      usable: true,
      byPosition,
      notes: notes.length > 0 ? notes : ['history is usable but sits close to the room at every position'],
    });
  }

  return out;
}

/**
 * One position, one manager.
 *
 * Two independent readings, added rather than multiplied so that neither can
 * silently zero the other out, and so the sample behind each stays visible:
 *
 *   - **When he takes his first one**, against when the room takes its first.
 *     This is the reading that carries the QB-in-round-fourteen manager, and it
 *     is the one people actually recognise in each other.
 *   - **How much of the current stretch of the draft he spends there**, against
 *     how much the room does. This is what catches "fills receiver aggressively"
 *     and "always has a defence by round twelve" — habits with no single first
 *     pick to point at.
 */
function positionTendency(args: {
  mine: HistoricalPick[];
  position: string;
  rounds: number;
  latestSeason: string;
  roomMedian: number | null;
  roomRates: Map<RoundBucket | 'all', number>;
}): PositionTendency {
  const { mine, position, rounds, latestSeason, roomMedian, roomRates } = args;

  const firsts = firstRoundPerManagerDraft(mine, position);
  const managerMedian = median(firsts.map((f) => f.round));
  const spread = meanAbsoluteDeviation(firsts.map((f) => f.round));
  /*
   * The centre the lift is actually computed from.
   *
   * A recency-weighted mean rather than the median, because recency has to
   * reach the *estimate* to mean anything: weighting only the sample count
   * leaves two managers with the same two seasons in a different order
   * producing identical numbers, which is not a weighting at all.
   *
   * The usual reason to prefer a median — one strange draft dragging the centre
   * — is already handled, and handled better, by the spread term below: an
   * outlier widens the spread and shrinks the whole claim toward the room,
   * rather than being silently discarded. `medianFirstRound` is still reported,
   * because it is the number a person can check against a real draft board.
   */
  const managerCentre = recencyWeightedMean(firsts, latestSeason);

  /*
   * The weight this manager's timing claim carries, in [0,1).
   *
   * `n / (n + k + spread/scale)` — the two shrinkages in one denominator. A
   * spread of zero reduces to the plain sample-size form; a manager who
   * disagrees with himself by five rounds is pushed most of the way back to the
   * room however many drafts he has.
   */
  const n = weightedDraftCount(firsts, latestSeason);
  const timingConfidence =
    firsts.length === 0 ? 0 : n / (n + TENDENCY.draftShrink + (spread ?? 0) / TENDENCY.spreadScale);

  // Positive = takes it sooner than the room.
  const timingLift =
    managerCentre != null && roomMedian != null
      ? TENDENCY.timingGain * (roomMedian - managerCentre) * timingConfidence
      : 0;

  /*
   * How much of his draft he spends at this position, against how much the room
   * spends — the *quantity* habit, as opposed to the timing one.
   *
   * Measured over the whole draft rather than per round bucket, and that is a
   * correction rather than a simplification. A per-bucket rate is anti-correlated
   * with timing for any position a manager takes once: a manager who takes his
   * quarterback in round three necessarily has no quarterback left to take in
   * rounds nine to sixteen, so his late-bucket rate reads as *distaste* for
   * quarterbacks and cancels the early-timing signal that is the whole point.
   * A real league made the failure plain — a manager whose first quarterback
   * went two and a half rounds ahead of the room came out with negative
   * quarterback demand.
   *
   * A whole-draft share has no such conflict: taking a quarterback early does
   * not reduce how many you end with. It is also the reading §3 actually asks
   * for under "second QB / second TE" and "RB-heavy / WR-heavy construction" —
   * how many, not when, which timing already answers.
   *
   * What is genuinely bucket-shaped — "his quarterback appetite right now is
   * lower because he already has one" — is not history at all. It is the live
   * roster, and `managerPrior.ts` reads it from the real pick stream, which is
   * strictly better evidence than a two-season average of the same thing.
   */
  const rateByBucket: Partial<Record<RoundBucket, number | null>> = {};
  for (const bucket of ['early', 'mid', 'late'] as const) {
    const inBucket = mine.filter((p) => bucketOf(p.round, rounds) === bucket);
    rateByBucket[bucket] =
      inBucket.length < TENDENCY.minBucketPicks
        ? null
        : round3(inBucket.filter((p) => p.position === position).length / inBucket.length);
  }

  const myRate = mine.filter((p) => p.position === position).length / mine.length;
  const roomRate = roomRates.get('all') ?? 0;
  const rateShrink = mine.length / (mine.length + TENDENCY.rateShrink);
  const rateLift =
    roomRate > 0
      ? (TENDENCY.rateGain * (myRate - roomRate) * rateShrink) / Math.max(roomRate, 0.08)
      : 0;
  const rateWeight = roomRate > 0 ? rateShrink : 0;

  const lift = clamp(timingLift + rateLift, TENDENCY.bounds.min, TENDENCY.bounds.max);

  return {
    position,
    lift: round3(lift),
    medianFirstRound: managerMedian,
    roomMedianFirstRound: roomMedian,
    rateByBucket,
    draftsWithPosition: firsts.length,
    spread: spread == null ? null : round2(spread),
    confidence: round3(Math.max(timingConfidence, rateWeight > 0 ? 0.35 : 0)),
  };
}

/**
 * The round each manager first took the position, once per manager per draft.
 *
 * The population the room's own median is taken over. Twelve managers across two
 * drafts contribute up to twenty-four observations, which is what makes the
 * median describe a typical manager rather than the earliest one.
 */
function firstRoundsByManagerAndDraft(
  picks: HistoricalPick[],
  position: string,
): { round: number }[] {
  const first = new Map<string, number>();
  for (const pick of picks) {
    if (pick.position !== position || !pick.userId) continue;
    const key = `${pick.draftId}:${pick.userId}`;
    const seen = first.get(key);
    if (seen == null || pick.round < seen) first.set(key, pick.round);
  }
  return [...first.values()].map((round) => ({ round }));
}

/**
 * A manager's own first-round observations, averaged with recent ones counting
 * for more.
 *
 * The same decay and the same floor as `weightedDraftCount`, so "how much does
 * this season count" has exactly one answer in this file.
 */
function recencyWeightedMean(
  observations: { season: string; round: number }[],
  latestSeason: string,
): number | null {
  if (observations.length === 0) return null;
  const latest = Number(latestSeason);
  let weighted = 0;
  let total = 0;
  for (const o of observations) {
    const season = Number(o.season);
    const age = Number.isFinite(latest) && Number.isFinite(season) ? Math.max(0, latest - season) : 0;
    const weight = Math.max(TENDENCY.recencyFloor, TENDENCY.recencyDecay ** age);
    weighted += weight * o.round;
    total += weight;
  }
  return total > 0 ? round2(weighted / total) : null;
}

/**
 * The round this manager first took the position, once per draft he played.
 *
 * Per draft rather than pooled, because "round four" means the same thing in
 * every season and a pooled minimum would just report his single earliest ever.
 */
function firstRoundPerManagerDraft(
  picks: HistoricalPick[],
  position: string,
): { draftId: string; season: string; round: number }[] {
  const first = new Map<string, { draftId: string; season: string; round: number }>();
  for (const pick of picks) {
    if (pick.position !== position) continue;
    const seen = first.get(pick.draftId);
    if (!seen || pick.round < seen.round) {
      first.set(pick.draftId, { draftId: pick.draftId, season: pick.season, round: pick.round });
    }
  }
  return [...first.values()].sort((a, b) => a.season.localeCompare(b.season));
}

/**
 * Drafts counted with recent ones weighing a little more.
 *
 * Floored so that an old season is worth less than a new one and never worth
 * nothing — three consecutive years of the same habit is a stronger statement
 * than this year's alone, and a decay without a floor would say the opposite.
 */
function weightedDraftCount(
  observations: { season: string }[],
  latestSeason: string,
): number {
  const latest = Number(latestSeason);
  let total = 0;
  for (const o of observations) {
    const season = Number(o.season);
    const age = Number.isFinite(latest) && Number.isFinite(season) ? Math.max(0, latest - season) : 0;
    total += Math.max(TENDENCY.recencyFloor, TENDENCY.recencyDecay ** age);
  }
  return total;
}

/** Which third of the draft a round falls in. Derived, so any length works. */
export function bucketOf(round: number, rounds: number): RoundBucket {
  const share = rounds > 0 ? round / rounds : 0;
  if (share <= TENDENCY.buckets.earlyTo) return 'early';
  if (share <= TENDENCY.buckets.midTo) return 'mid';
  return 'late';
}

/** Mean |x - mean|. Null below two observations, where spread is meaningless. */
function meanAbsoluteDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  return round2(values.reduce((a, v) => a + Math.abs(v - mean), 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a != null && b != null ? round2((a + b) / 2) : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The wire and storage form.
 *
 * `byPosition` is a `Map` in memory because every read of it is a lookup, and a
 * list on the way to a database because `JSON.stringify` turns a `Map` into
 * `{}` — silently, and the failure would look like "every manager is neutral"
 * rather than like a bug. Converting explicitly at the boundary is the cheapest
 * way to make that impossible.
 */
export interface StoredManagerTendencies extends Omit<ManagerTendencies, 'byPosition'> {
  byPosition: PositionTendency[];
}

export function toStoredTendencies(t: ManagerTendencies): StoredManagerTendencies {
  return { ...t, byPosition: [...t.byPosition.values()] };
}

export function fromStoredTendencies(stored: StoredManagerTendencies): ManagerTendencies {
  return {
    ...stored,
    seasons: stored.seasons ?? [],
    notes: stored.notes ?? [],
    byPosition: new Map((stored.byPosition ?? []).map((p) => [p.position, p])),
  };
}
