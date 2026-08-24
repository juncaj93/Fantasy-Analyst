/**
 * What a defence is worth this week, anchored on what the market expects its
 * opponent to score.
 *
 * ## Why this is not `defense.ts`
 *
 * `startsit/defense.ts` models a defence as an *obstacle*: what this unit gives
 * up to a deep receiver, so a receiver's score can be nudged. This models a
 * defence as an *asset*: what the unit itself is expected to be paid, in this
 * league's own points, so it can hold a DEF slot. They read different data,
 * answer different questions and would be wrong in each other's place — a
 * tendency index cannot tell you whether to start Seattle, and a fantasy
 * expectation cannot tell you whether to start a receiver against Seattle.
 *
 * ## The anchor, and why there is only one
 *
 * A defensive fantasy week is dominated by one thing: how many points the
 * offence across the field scores. Every table a league scores a defence on
 * bends around it — the shutout band, the yardage bands, and the game state
 * that produces sacks and interceptions. And the betting market prices exactly
 * that number, every week, better than any model in this repository could:
 *
 *     opponent implied total = total / 2 + spread / 2
 *
 * where `spread` is **this defence's own team's** handicap, negative when
 * favoured, taken from `GameContext` — the same convention `gameScript.ts`
 * uses, verified against it rather than assumed. A defence favoured by 7 in a
 * 44-point game faces an offence the market expects to score 18.5; the same
 * defence as a 7-point underdog faces one it expects to score 25.5.
 *
 * That is the mean. **It is the only mean.** Everything else in this module is
 * either a bounded residual or an explanation, and the reason is stated once
 * here because it governs every line below:
 *
 * > **If the market could already know it, the anchor already contains it.**
 *
 * The total is in the anchor, so it is not a second input. Defensive-unit
 * quality is in the anchor — a good defence is *why* the opponent's implied
 * total is low — so it is not an independent component. Pace is in the anchor.
 * Offensive-line quality is in the anchor. Adding any of them on top would be
 * paying twice for one fact, and the second payment is unvalidated.
 *
 * ## What is allowed on top, and how little
 *
 * Three residuals, each bounded, each answering "what does the market's number
 * *not* already say":
 *
 *  1. **game script** (±{@link DST_CAPS.gameScript}) — a defence with a big
 *     lead sees an opponent who must throw, which is a different distribution
 *     of sacks and interceptions from the same implied total reached by a close
 *     game. The implied total does not carry the *shape* of how it is reached.
 *  2. **a quarterback change** (±{@link DST_CAPS.quarterback}) — and only when
 *     the news is **newer than the line**. A backup announced on Wednesday is
 *     in Sunday's number already, and charging for it again is the double count
 *     this module is most likely to commit. Older than the line: zero, always.
 *  3. **home or road** (±{@link DST_CAPS.homeField}) — small enough to break a
 *     tie and never enough to decide one.
 *
 * Sacks, takeaways and defensive touchdowns are **not** on that list. They are
 * real points and they are scored here — a league that pays 1 a sack must have
 * sacks in the number — but the counts used are league-wide baselines, the same
 * for every defence, so they set the level of the scale rather than the order
 * of the defences on it. A per-team sack model would be a second input into the
 * mean, and the anchor already contains why one defence gets more of them than
 * another. They travel in {@link DstProjection.components} because a reader is
 * owed the arithmetic, and that is the whole of their job.
 *
 * ## Unknown stays unknown
 *
 * No total, no spread, no projection. Not a league average, not a replacement
 * defence, not zero. A defence nobody has priced is a gap in coverage, and a
 * defence projected 6.0 is a forecast, and the two must never look the same —
 * the same rule `projection.ts` enforces for everybody else. Likewise a league
 * whose defence scoring could not be read gets no number at all; see
 * `sleeper/dstScoring.ts`.
 */

import { expectedTierPoints, scoresDefences, type DstScoring, type ScoringTier } from '../sleeper/dstScoring.ts';
import type { GameContext } from './gameScript.ts';

/** Every bound this module is allowed to move a defence by, in fantasy points. */
export const DST_CAPS = {
  /** The residual for *how* an implied total is reached, not how big it is. */
  gameScript: 0.8,
  /** A quarterback change the line has not seen. Zero when it has. */
  quarterback: 1.0,
  /** Home or road. Deliberately almost nothing. */
  homeField: 0.3,
} as const;

/**
 * The football constants, in one table, so they can be argued with.
 *
 * Every one of these is a league-wide baseline rather than a per-team read, and
 * that is the anti-double-counting rule made structural: a constant cannot
 * reorder two defences, so nothing here can quietly become a second opinion
 * about which defence is better.
 */
export const DST_BASELINES = {
  /**
   * Standard deviation of an NFL team's score about its implied total.
   *
   * Team scores are famously wide around the number: the market can be right on
   * average and still see a 3 or a 38. Around ten points is the long-run figure
   * and it is what turns a point estimate into the band distribution the
   * points-allowed table is actually paid on. Too small a value would pay a
   * 17-point favourite's defence as though the shutout band were unreachable.
   */
  scoreSd: 9.6,
  /** Yards a team gains per point it scores, near the middle of the range. */
  yardsPerPoint: 14.5,
  /** Yards at a neutral 22.5-point implied total, for the affine fit. */
  neutralYards: 330,
  /** Spread of team yardage about that line. */
  yardsSd: 78,
  /** Sacks a defence takes in an average game. */
  sacks: 2.3,
  /** Interceptions in an average game. */
  interceptions: 0.75,
  /** Fumbles recovered in an average game. */
  fumbleRecoveries: 0.45,
  /** Fumbles forced in an average game. */
  forcedFumbles: 0.7,
  /** Defensive touchdowns in an average game. */
  defensiveTds: 0.13,
  /** Special-teams touchdowns in an average game. */
  specialTeamsTds: 0.04,
  /** Safeties in an average game. */
  safeties: 0.025,
  /** Blocked kicks in an average game. */
  blockedKicks: 0.045,
  /**
   * Two-point conversions returned in an average game.
   *
   * Vanishingly rare — a handful a decade — and priced anyway, because a
   * category the league pays for and the model silently drops is the exact
   * omission `dstScoring.ts` refuses a whole league over. The honest version of
   * "this is worth nothing" is a rate that rounds to nothing, not an absence.
   */
  twoPointReturns: 0.002,
  /**
   * The implied total a neutral game hands each side.
   *
   * Half of a 45-point game, matching `gameScript.ts` rather than being chosen
   * again here — two modules disagreeing about what neutral means would put the
   * game-script residual and the anchor on different centres.
   */
  neutralImpliedTotal: 22.5,
  /** Spread at which the game-script residual saturates, in points. */
  fullSpread: 9,
} as const;

/** One line of the arithmetic, for the card and for a person checking it. */
export interface DstComponent {
  key: string;
  label: string;
  /** Fantasy points this line contributes. */
  points: number;
  /** What it is, in words, including the count it was priced on. */
  detail: string;
}

export interface DstProjection {
  /**
   * Expected fantasy points, or null when there is not an honest number.
   *
   * Null on a missing market, on a league whose defence scoring could not be
   * read, and on a league that does not score defences at all. Never a default.
   */
  points: number | null;
  /** The opponent's implied team total — the anchor. Null when unpriced. */
  opponentImpliedTotal: number | null;
  components: DstComponent[];
  /** How much of the answer is actually known. */
  confidence: 'high' | 'medium' | 'low';
  /** Why it is not higher, in the reader's terms. */
  reasons: string[];
  /** The one sentence worth putting on a row. Null when there is no number. */
  driver: string | null;
}

/** No market, no league, no number. */
const UNKNOWN_BASE = {
  points: null,
  opponentImpliedTotal: null,
  components: [] as DstComponent[],
  confidence: 'low',
  driver: null,
} as const;

export interface DstProjectionInput {
  /** This defence's own team's game, from the same source everybody else reads. */
  game: GameContext | null;
  /** This league's defence scoring, from its own settings. */
  scoring: DstScoring;
  /**
   * A quarterback change on the opposing offence, when one is known.
   *
   * `observedAt` is load-bearing rather than decorative: the adjustment is zero
   * unless the news is newer than {@link lineAsOf}, because a line published
   * after the announcement has already priced it. Absent means no such news,
   * which is not the same as "the starter is playing" and is treated as no
   * adjustment either way.
   */
  opponentQuarterback?: { starterOut: boolean; observedAt: string | null } | null;
  /** When the game line this is anchored on was published. */
  lineAsOf?: string | null;
  /** True at home, false on the road, absent when the schedule is unknown. */
  home?: boolean | null;
}

/**
 * Project one defence.
 *
 * Deterministic: the same inputs give the same number on every machine, with no
 * clock read and no randomness. Bounded: every term has a cap written beside it
 * above. Inspectable: `components` sums to `points` exactly, so the arithmetic
 * on a card is the arithmetic the engine did.
 */
export function projectDst(input: DstProjectionInput): DstProjection {
  const { scoring } = input;

  if (!scoring.supported) {
    return {
      ...UNKNOWN_BASE,
      reasons: [
        scoring.unsupported.length > 0
          ? `this league scores defences on rules this app cannot map (${scoring.unsupported.join(', ')})`
          : 'this league’s defence scoring could not be read',
      ],
    };
  }

  const total = input.game?.total ?? null;
  const spread = input.game?.spread ?? null;
  if (total == null || spread == null) {
    /*
     * Both, or neither. A total without a spread cannot say which side of it
     * this defence is on, and half of an anchor is not a cheaper anchor — it is
     * a different number wearing the same name.
     */
    return {
      ...UNKNOWN_BASE,
      reasons: [
        total == null && spread == null
          ? 'no game line for this defence'
          : total == null
            ? 'no game total for this defence'
            : 'no spread for this defence, so which side of the total is unknown',
      ],
    };
  }

  /*
   * The opponent's implied total.
   *
   * `spread` belongs to this defence's own team and is negative when favoured,
   * which is `gameScript.ts`'s convention and the one `startSitInputs.ts`
   * resolves against the stored `spreadTeam`. So the *other* side's share is
   * total/2 + spread/2, and the sign is read rather than guessed — a defence
   * priced with the handicap the wrong way round would rank the whole slate
   * backwards and look entirely plausible doing it.
   */
  const opponentImpliedTotal = round1(total / 2 + spread / 2);

  /*
   * A league that pays a defence for nothing gets no number for one.
   *
   * Checked here, ahead of every term, because the residuals below are
   * adjustments to a scale — and with no scale underneath them, a bounded
   * game-script nudge is the whole projection. That is how a defence in a
   * league with no defensive scoring at all came out at 0.8 points: a number
   * built entirely of a correction to nothing, which reads on a card as a
   * forecast that this unit scores almost nothing rather than as the truth,
   * which is that this league does not score it.
   */
  if (!scoresDefences(scoring)) {
    return { ...UNKNOWN_BASE, opponentImpliedTotal, reasons: ['this league does not score defences'] };
  }

  const components: DstComponent[] = [];
  const reasons: string[] = [];

  // ------------------------------------------------- the anchor, twice over

  const pointsAllowed = expectedTierPoints(scoring.pointsAllowed, (from, to) =>
    bandProbability(from, to, opponentImpliedTotal, DST_BASELINES.scoreSd),
  );
  if (scoring.pointsAllowed.length > 0) {
    components.push({
      key: 'points_allowed',
      label: 'Points allowed',
      points: round2(pointsAllowed),
      detail: `${opponentImpliedTotal} implied against, over this league’s bands`,
    });
  }

  const expectedYards = clamp(
    DST_BASELINES.neutralYards +
      (opponentImpliedTotal - DST_BASELINES.neutralImpliedTotal) * DST_BASELINES.yardsPerPoint,
    120,
    600,
  );
  const yardsAllowed = expectedTierPoints(scoring.yardsAllowed, (from, to) =>
    bandProbability(from, to, expectedYards, DST_BASELINES.yardsSd),
  );
  if (scoring.yardsAllowed.length > 0) {
    components.push({
      key: 'yards_allowed',
      label: 'Yards allowed',
      points: round2(yardsAllowed),
      detail: `about ${Math.round(expectedYards)} yards implied, over this league’s bands`,
    });
  }

  // ---------------------------------------------- the scale, not the order

  /*
   * The categories every defence is paid roughly the same for.
   *
   * Priced on league-wide baselines rather than on anything about this defence,
   * for the reason in the header: the anchor already contains why one unit gets
   * more sacks than another, and a per-team count would be that same fact
   * charged a second time. What these do is put the number on this league's
   * scale — a league paying 2 a sack projects its defences four points higher
   * than one paying nothing, and it should.
   */
  const events: { key: string; label: string; rate: number; per: number; unit: string }[] = [
    { key: 'sacks', label: 'Sacks', rate: DST_BASELINES.sacks, per: scoring.sack, unit: 'sacks' },
    { key: 'interceptions', label: 'Interceptions', rate: DST_BASELINES.interceptions, per: scoring.interception, unit: 'INTs' },
    { key: 'fumble_recoveries', label: 'Fumble recoveries', rate: DST_BASELINES.fumbleRecoveries, per: scoring.fumbleRecovery, unit: 'recoveries' },
    { key: 'forced_fumbles', label: 'Forced fumbles', rate: DST_BASELINES.forcedFumbles, per: scoring.forcedFumble, unit: 'forced fumbles' },
    { key: 'defensive_tds', label: 'Defensive TDs', rate: DST_BASELINES.defensiveTds, per: scoring.defensiveTd, unit: 'defensive TDs' },
    { key: 'special_teams_tds', label: 'Special-teams TDs', rate: DST_BASELINES.specialTeamsTds, per: scoring.specialTeamsTd, unit: 'return TDs' },
    { key: 'safeties', label: 'Safeties', rate: DST_BASELINES.safeties, per: scoring.safety, unit: 'safeties' },
    { key: 'blocked_kicks', label: 'Blocked kicks', rate: DST_BASELINES.blockedKicks, per: scoring.blockedKick, unit: 'blocks' },
    { key: 'two_point_returns', label: 'Two-point returns', rate: DST_BASELINES.twoPointReturns, per: scoring.twoPointReturn, unit: 'returns' },
  ];
  for (const event of events) {
    if (event.per === 0) continue;
    components.push({
      key: event.key,
      label: event.label,
      points: round2(event.rate * event.per),
      detail: `${event.rate} ${event.unit} × ${event.per} — a league baseline, the same for every defence`,
    });
  }

  // ---------------------------------------------------------- the residuals

  /*
   * Game script: the shape of the game, not its size.
   *
   * A defence favoured by ten and one favoured by three can face the same
   * implied total and not the same afternoon — the first spends the fourth
   * quarter against an offence that has to throw on every down, which is where
   * sacks and interceptions come from. That is genuinely not in the opponent's
   * implied total, which is a sum and carries no path.
   *
   * Bounded hard, because it is the term most likely to be an elaborate way of
   * re-reading the spread that is already inside the anchor.
   */
  const scriptStrength = clamp(-spread / DST_BASELINES.fullSpread, -1, 1);
  const gameScript = round2(scriptStrength * DST_CAPS.gameScript);
  if (gameScript !== 0) {
    components.push({
      key: 'game_script',
      label: 'Game script',
      points: gameScript,
      detail:
        spread < 0
          ? `favoured by ${Math.abs(spread)} — an opponent playing from behind throws`
          : `underdog by ${spread} — the opponent can run the clock out`,
    });
  }

  /*
   * A quarterback change, and only if the market has not seen it.
   *
   * The whole adjustment turns on one comparison, and it is the comparison the
   * anti-double-counting rule is really about: a line published *after* the
   * announcement has priced it into the total and the spread, which are already
   * the anchor, so charging again here would be counting one injury twice. The
   * timestamps come from the caller because only the caller knows when its own
   * line was drawn.
   */
  const qb = quarterbackAdjustment(input);
  if (qb.points !== 0) {
    components.push({ key: 'opponent_qb', label: 'Opponent quarterback', points: qb.points, detail: qb.detail });
  }
  if (qb.reason) reasons.push(qb.reason);

  if (input.home != null) {
    const homeField = round2((input.home ? 1 : -1) * DST_CAPS.homeField);
    components.push({
      key: 'home_field',
      label: input.home ? 'At home' : 'On the road',
      points: homeField,
      detail: 'a small, bounded edge — never enough to decide a start',
    });
  }

  // -------------------------------------------------------------- the answer

  const points = round2(components.reduce((a, c) => a + c.points, 0));

  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!scoring.anchorSensitive) {
    /*
     * The market has nothing to reach this league's defences through.
     *
     * With no points-allowed and no yards-allowed table, every defence in the
     * league projects the same baseline and the anchor is decorative. The
     * number is still the honest conversion of this league's rules, and saying
     * how little it distinguishes is the point of a confidence field.
     */
    confidence = 'low';
    reasons.push(
      'this league scores no points or yards allowed, so the market reaches its defences only through a capped game-script residual',
    );
  }
  if (scoring.pointsAllowed.length === 0 && scoring.yardsAllowed.length > 0 && confidence === 'high') {
    confidence = 'medium';
    reasons.push('scored on yards allowed but not points allowed');
  }

  return {
    points,
    opponentImpliedTotal,
    components,
    confidence,
    reasons,
    driver: driverFor(opponentImpliedTotal, spread),
  };
}

/**
 * The quarterback residual, which is usually zero and should be.
 *
 * Three ways to get nothing, and only one to get something: no news at all, no
 * timestamp on either side to compare, or news the line already saw. The
 * conservative branch is the default in every ambiguous case, because the cost
 * of a wrong zero is a slightly flat projection and the cost of a wrong
 * adjustment is a number that has counted one injury twice.
 */
function quarterbackAdjustment(input: DstProjectionInput): { points: number; detail: string; reason: string | null } {
  const news = input.opponentQuarterback;
  if (!news || !news.starterOut) return { points: 0, detail: '', reason: null };

  const observed = Date.parse(news.observedAt ?? '');
  const line = Date.parse(input.lineAsOf ?? '');
  if (!Number.isFinite(observed) || !Number.isFinite(line)) {
    return {
      points: 0,
      detail: '',
      reason: 'a quarterback change is known but cannot be dated against the line, so it is not counted twice',
    };
  }
  if (observed <= line) {
    return {
      points: 0,
      detail: '',
      reason: 'the opponent’s quarterback change is older than the line, so the market has already priced it',
    };
  }

  return {
    points: DST_CAPS.quarterback,
    detail: 'the opponent lost their starter after this line was published',
    reason: null,
  };
}

/** The one sentence a row gets, and it is always about the anchor. */
function driverFor(opponentImpliedTotal: number, spread: number): string {
  const environment =
    opponentImpliedTotal <= DST_BASELINES.neutralImpliedTotal - 3
      ? 'Facing a low-scoring offence'
      : opponentImpliedTotal >= DST_BASELINES.neutralImpliedTotal + 3
        ? 'Facing a high-scoring offence'
        : 'An ordinary offence across the field';
  const side = spread < 0 ? `favoured by ${Math.abs(spread)}` : spread > 0 ? `underdog by ${spread}` : 'pick’em';
  return `${environment} · ${opponentImpliedTotal} implied against, ${side}`;
}

/**
 * The chance a normally-distributed outcome lands in `[from, to)`.
 *
 * The logistic approximation to the normal CDF — `Φ(z) ≈ 1/(1+e^(−1.702z))` —
 * which is within about 0.01 of the real thing across the whole range and, more
 * importantly here, is **strictly monotone** and needs no error function. Both
 * properties are load-bearing: monotonicity is what makes the projection
 * monotone in the implied total, which is asserted in the tests rather than
 * assumed, and staying inside the standard library is what keeps this runnable
 * in a Worker without a dependency.
 *
 * Bands are half-open so they tile without overlap, and the tail band's
 * `Infinity` falls out of the same arithmetic rather than needing a case.
 */
export function bandProbability(from: number, to: number, mean: number, sd: number): number {
  const upper = to === Infinity ? 1 : normalCdf((to - mean) / sd);
  const lower = from === -Infinity ? 0 : normalCdf((from - mean) / sd);
  return Math.max(0, upper - lower);
}

function normalCdf(z: number): number {
  return 1 / (1 + Math.exp(-1.702 * z));
}

/**
 * What the model expects a defence to allow, for a caller that wants the
 * football rather than the points.
 *
 * Exported because the schedule and streaming work in the next lane needs the
 * same curve without re-deriving it, and two derivations of one curve is how
 * two screens end up disagreeing about the same defence.
 */
export function expectedYardsAllowed(opponentImpliedTotal: number): number {
  return clamp(
    DST_BASELINES.neutralYards +
      (opponentImpliedTotal - DST_BASELINES.neutralImpliedTotal) * DST_BASELINES.yardsPerPoint,
    120,
    600,
  );
}

/** The tier a number falls in, for a caller checking a band table by hand. */
export function tierFor(tiers: readonly ScoringTier[], value: number): ScoringTier | null {
  return tiers.find((t) => value >= t.from && value < t.to) ?? null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
