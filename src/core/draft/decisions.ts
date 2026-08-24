/**
 * Draft decision quality: the judgements a ranking alone cannot express.
 *
 * A ranked list answers "who is best available". It does not answer the
 * questions a person actually asks with a clock running:
 *
 *   - is the talent at this position about to fall off a cliff?
 *   - does the shape of what I have drafted change what I should do?
 *   - can this player wait until my next pick, or is he gone?
 *   - is there research telling me to stay away from him?
 *   - do I just want him?
 *
 * Every threshold those answers depend on lives in this file, deliberately. A
 * number scattered into a UI component is a number nobody can tune, and these
 * are exactly the numbers that will need tuning after a real draft.
 *
 * Pure functions only. Nothing here reads the database or makes a pick.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { NeedBreakdown, RosterCounts } from './need.ts';
import type { TierCliff } from './tiers.ts';

// --------------------------------------------------------------- thresholds

/**
 * Every tunable used by the decision layer.
 *
 * Grouped by the question it answers rather than by type, so changing "when do
 * we say AVOID" means editing one place and reading one comment.
 */
export const DECISION_THRESHOLDS = {
  avoid: {
    /**
     * Lifetime net tally at or below which a player is tagged AVOID.
     *
     * Reachable only because imported tally rows keep their real magnitude —
     * while an imported row was flattened to ±1 this threshold was decorative.
     */
    lifetimeNet: -5,
    /** Lifetime net at which the caution is considered maxed out. */
    saturation: -12,
    /** Recent net that earns a "trend improving" note beside the tag. */
    reversalNet: 3,
  },

  myGuy: {
    /**
     * Normalised scores per star level, before the component weight.
     *
     * Calibrated against the engine's own note that a point of ADP is worth
     * roughly 0.05 of contribution: ★ moves a player about two picks (a real
     * tiebreak), ★★ about five, ★★★ about ten — a modest reach, and nowhere
     * near enough to beat the 1.0 a thirty-pick faller scores on market value
     * alone. Wanting a player is allowed to matter; it is not allowed to
     * overrule the board.
     */
    score: { 1: 0.167, 2: 0.5, 3: 1 } as Record<number, number>,
    label: { 1: 'My Guy', 2: 'Strong My Guy', 3: 'Must-Have' } as Record<number, string>,
  },

  wait: {
    /** At or above this survival probability, say the player is likely to last. */
    likelyAvailable: 0.85,
    /** At or above this, the player can probably wait. */
    canWait: 0.6,
    /** Below this, waiting is a gamble worth naming. */
    risky: 0.35,
  },

  rosterAlerts: {
    /** Round from which an unfilled starting slot stops being "still early". */
    startersUrgentFromRound: 7,
    /** Round from which an unfilled starting slot is the loudest thing on screen. */
    startersCriticalFromRound: 10,
    /** Rostering this many more of one position than another counts as lopsided. */
    lopsidedGap: 3,
  },
} as const;

// -------------------------------------------------------------------- avoid

export interface AvoidTag {
  active: boolean;
  lifetimeNet: number;
  /** -1..0, folded into the ranking as a caution. */
  score: number;
  message: string;
  /** Set when recent evidence disagrees with the lifetime record. */
  trendNote: string | null;
}

/**
 * The automatic AVOID tag.
 *
 * Advisory, never a ban: the player stays on the board and stays rankable,
 * because a big enough fall past ADP can make anybody worth a look. What the
 * tag guarantees is that the conflict is impossible to miss.
 *
 * History is never erased. A player who was written about badly all offseason
 * keeps the tag even while the last month improves — the improvement is shown
 * beside it, not instead of it.
 */
export function assessAvoid(lifetimeNet: number, recentNet: number): AvoidTag {
  const { lifetimeNet: threshold, saturation, reversalNet } = DECISION_THRESHOLDS.avoid;
  const active = lifetimeNet <= threshold;

  if (!active) {
    return { active: false, lifetimeNet, score: 0, message: '', trendNote: null };
  }

  // Ramps from half a caution at the threshold to a full one at saturation, so
  // -11 reads louder than -5 without ever becoming a veto.
  const depth = clamp((lifetimeNet - threshold) / (saturation - threshold), 0, 1);
  const score = round3(-(0.5 + 0.5 * depth));

  return {
    active: true,
    lifetimeNet,
    score,
    message: `AVOID — lifetime tally ${lifetimeNet > 0 ? '+' : ''}${lifetimeNet}`,
    trendNote: recentNet >= reversalNet ? `Recent trend improving (+${recentNet} in the last 30 days)` : null,
  };
}

// ------------------------------------------------------------------ my guy

export type MyGuyLevel = 0 | 1 | 2 | 3;

export interface MyGuyFlag {
  level: MyGuyLevel;
  label: string;
  stars: string;
  score: number;
}

/** The user's own preference, kept deliberately separate from the news tally. */
export function myGuy(level: MyGuyLevel): MyGuyFlag {
  if (level <= 0) return { level: 0, label: '', stars: '', score: 0 };
  return {
    level,
    label: DECISION_THRESHOLDS.myGuy.label[level] ?? 'My Guy',
    stars: '★'.repeat(level),
    score: DECISION_THRESHOLDS.myGuy.score[level] ?? 0,
  };
}

/** Read a stored level back safely; anything unexpected means "not flagged". */
export function toMyGuyLevel(value: unknown): MyGuyLevel {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 ? (n as MyGuyLevel) : 0;
}

// ------------------------------------------------------------- wait or take

export type WaitState = 'take_now' | 'risky_to_wait' | 'can_probably_wait' | 'likely_available_later' | 'unknown';

export interface WaitGuidance {
  state: WaitState;
  label: string;
  /** One sentence saying why, in the user's terms. */
  detail: string;
  survivalProbability: number | null;
}

const WAIT_LABEL: Record<WaitState, string> = {
  take_now: 'Take Now',
  risky_to_wait: 'Risky to Wait',
  can_probably_wait: 'Can Probably Wait',
  likely_available_later: 'Likely Available Later',
  unknown: 'Unknown',
};

export interface WaitInput {
  survivalProbability: number | null;
  cliff: TierCliff;
  needScore: number;
  /** Comparable players at the position expected past the user's next pick. */
  expectedRemaining: number;
  position: string;
  nextPick: number | null;
}

/**
 * Whether this player can wait until the user's next pick.
 *
 * The honest answer combines three things that can disagree: how likely he is
 * to last, whether his tier survives with him, and whether the user needs the
 * position at all. Survival leads, because it is the only one of the three that
 * is actually about this player — but a tier cliff at a position you need
 * overrides a comfortable-looking probability, which is the whole reason the
 * engine can prefer a slightly lower-ranked player who is about to disappear.
 */
export function assessWait(input: WaitInput): WaitGuidance {
  const p = input.survivalProbability;
  const { likelyAvailable, canWait, risky } = DECISION_THRESHOLDS.wait;

  if (p == null) {
    return {
      state: 'unknown',
      label: WAIT_LABEL.unknown,
      detail: 'No draft order for this player, so there is no way to say whether he lasts.',
      survivalProbability: null,
    };
  }

  const pct = Math.round(p * 100);
  const needed = input.needScore >= 0.5;
  const nextPickPhrase = input.nextPick == null ? 'your next pick' : `pick ${input.nextPick}`;

  // A cliff you need beats the probability: being 70% to last does not help if
  // the four players behind him are a tier worse.
  if (input.cliff.severity === 'last_in_tier' && needed) {
    return {
      state: 'take_now',
      label: WAIT_LABEL.take_now,
      detail: `${pct}% to reach ${nextPickPhrase}, but ${lower(input.cliff.message ?? '')} and you still need ${input.position}.`,
      survivalProbability: p,
    };
  }

  if (p < risky) {
    return {
      state: 'take_now',
      label: WAIT_LABEL.take_now,
      detail: `Only ${pct}% to reach ${nextPickPhrase}.`,
      survivalProbability: p,
    };
  }

  if (p < canWait || input.cliff.severity === 'thinning') {
    return {
      state: 'risky_to_wait',
      label: WAIT_LABEL.risky_to_wait,
      detail:
        input.cliff.severity === 'thinning'
          ? `${pct}% to reach ${nextPickPhrase}, and ${lower(input.cliff.message ?? '')}`
          : `${pct}% to reach ${nextPickPhrase} — borderline.`,
      survivalProbability: p,
    };
  }

  if (p >= likelyAvailable) {
    return {
      state: 'likely_available_later',
      label: WAIT_LABEL.likely_available_later,
      detail: `${pct}% to reach ${nextPickPhrase}.`,
      survivalProbability: p,
    };
  }

  return {
    state: 'can_probably_wait',
    label: WAIT_LABEL.can_probably_wait,
    detail: `${pct}% to reach ${nextPickPhrase}, and ${input.expectedRemaining} comparable ${input.position}${input.expectedRemaining === 1 ? '' : 's'} should still be there.`,
    survivalProbability: p,
  };
}

// --------------------------------------------------------- roster alerts

export type AlertSeverity = 'info' | 'warn' | 'urgent';

export interface RosterAlert {
  key: string;
  severity: AlertSeverity;
  /** The headline, e.g. "Still need a starting TE". */
  message: string;
  /** Why it is being said, in the user's own draft's terms. */
  detail: string;
  /** Positions this alert argues for, used to explain a ranking nudge. */
  positions: string[];
}

export interface RosterAlertInput {
  shape: RosterShape;
  counts: RosterCounts;
  needs: Record<string, NeedBreakdown>;
  /** 1-based round currently being drafted. */
  round: number;
  totalRounds: number;
}

/**
 * What the shape of the roster is saying.
 *
 * The same fact means different things at different times: no tight end in
 * round three is a plan, and no tight end in round twelve is a problem. Urgency
 * is therefore a function of the round, not of the count alone — the engine
 * already knows what is missing, and this is what turns that into advice.
 */
export function rosterAlerts(input: RosterAlertInput): RosterAlert[] {
  const { startersUrgentFromRound, startersCriticalFromRound } = DECISION_THRESHOLDS.rosterAlerts;
  const alerts: RosterAlert[] = [];
  const roundsLeft = Math.max(0, input.totalRounds - input.round + 1);

  const quiet = quietPositions(input.shape);
  const allUnfilled = Object.values(input.needs).filter((n) => n.startersUnfilled > 0);
  const unfilled = allUnfilled
    .filter((n) => !quiet.has(n.position))
    .sort((a, b) => b.startersUnfilled - a.startersUnfilled || a.position.localeCompare(b.position));

  const severityFor = (): AlertSeverity =>
    input.round >= startersCriticalFromRound ? 'urgent' : input.round >= startersUrgentFromRound ? 'warn' : 'info';

  /*
   * Early on, almost every slot is unfilled, and saying so once per position
   * fills the screen with three identical notes that all end "no need to force
   * it". That is not advice, it is the scoreboard — so while it is still early
   * and nothing is urgent, the same fact is said once.
   */
  if (severityFor() === 'info' && unfilled.length > 2) {
    const open = unfilled.reduce((a, n) => a + n.startersUnfilled, 0);
    return [
      {
        key: 'starters:early',
        severity: 'info',
        message: `${open} starting slots still open`,
        detail: `Round ${input.round} — take the best players available; there is time to fill ${unfilled.map((n) => n.position).join(', ')}.`,
        positions: unfilled.map((n) => n.position),
      },
      ...lopsidedAlerts(input, quiet),
    ];
  }

  for (const need of unfilled) {
    const severity = severityFor();
    const superflex = input.shape.superflex && need.position === 'QB';
    alerts.push({
      key: `starter:${need.position}`,
      severity,
      message: superflex
        ? 'No QB yet in a superflex league'
        : `Still need a starting ${need.position}${need.startersUnfilled > 1 ? ` (${need.startersUnfilled})` : ''}`,
      detail:
        severity === 'urgent'
          ? `Round ${input.round} of ${input.totalRounds} — ${roundsLeft} pick${roundsLeft === 1 ? '' : 's'} left to fill it.`
          : severity === 'warn'
            ? `Round ${input.round}: starting slots usually fill by now.`
            : `Round ${input.round} — still early, no need to force it.`,
      positions: [need.position],
    });
  }

  /*
   * "Covered" is a claim about every slot, so it waits for every slot.
   *
   * `unfilled` has had the quiet positions taken out of it, and saying the
   * lineup is covered off that list would be telling a reader with an empty DEF
   * slot that every dedicated starting slot has somebody in it. That sentence
   * is false, and a false reassurance is worse than the pressure this whole
   * section exists to remove — so the quiet positions buy silence, not a claim.
   */
  if (allUnfilled.length === 0) {
    alerts.push({
      key: 'starters:covered',
      severity: 'info',
      message: 'Starting lineup is covered',
      detail: 'Every dedicated starting slot has somebody in it. Remaining picks are depth and upside.',
      positions: [],
    });
  }

  alerts.push(...lopsidedAlerts(input, quiet));

  return alerts;
}

/**
 * Positions the draft has decided not to argue about.
 *
 * A defence, and in the ordinary league only a defence. The reasoning is
 * already settled and is written down in `draft/engine.ts` beside
 * `DEFENCE_WEIGHTS`: no news rule reads a defence, no published draft order
 * this app imports ranks one, no Vegas market covers one and no preseason
 * projection includes one. The board therefore ranks them on ADP alone and
 * appends them after the field.
 *
 * These alerts were the last place that decision had not reached. The board
 * would decline to move a defence up on roster need and then, above it, print
 * "Still need a starting DEF" in the same red the reader learned to trust for a
 * missing running back — pressure the ranking underneath it explicitly refuses
 * to act on. A screen that argues with itself is worse than either half.
 *
 * **The exception is objective and is not a league-name special case.** A
 * league starting two or more defences has made one a real roster requirement:
 * you cannot field a lineup without them, they will not both be there in the
 * last round, and a reader in that league is owed the same warning as anybody
 * else. So the quiet applies to the shape this app has an opinion about — one
 * defence, drafted last, forgotten — and to nothing else.
 */
export function quietPositions(shape: RosterShape): Set<string> {
  const quiet = new Set<string>();
  if ((shape.starters['DEF'] ?? 0) === 1) quiet.add('DEF');
  return quiet;
}

/**
 * Lopsided depth, measured against what the league actually starts.
 *
 * Five wide receivers is not lopsided in a league that starts three of them,
 * and one running back is not fine in a league that starts two — so the
 * comparison is on the surplus over each position's own requirement, which is
 * the only version of "too many" that means anything across league shapes.
 */
function lopsidedAlerts(input: RosterAlertInput, quiet: ReadonlySet<string>): RosterAlert[] {
  const { startersUrgentFromRound, lopsidedGap } = DECISION_THRESHOLDS.rosterAlerts;
  const alerts: RosterAlert[] = [];
  /*
   * A quiet position cannot be the thing that is "becoming more important".
   *
   * This alert names `least` and argues for it, and an empty defence slot is
   * the reliable minimum for eleven rounds of any draft — so left in, it would
   * reintroduce the exact sentence the section above removes, in different
   * words and with a depth argument behind it. Excluded from the candidates
   * rather than filtered from the output, so the alert that does fire names the
   * genuinely thinnest position a reader can act on.
   */
  const startable = Object.keys(input.shape.starters).filter(
    (p) => (input.shape.starters[p] ?? 0) > 0 && !quiet.has(p),
  );
  const surpluses = startable
    .map((position) => ({
      position,
      n: input.counts[position] ?? 0,
      surplus: (input.counts[position] ?? 0) - (input.shape.starters[position] ?? 0),
    }))
    .sort((a, b) => b.surplus - a.surplus || a.position.localeCompare(b.position));
  const most = surpluses[0];
  const least = surpluses[surpluses.length - 1];
  if (most && least && most.position !== least.position && most.surplus - least.surplus >= lopsidedGap) {
    alerts.push({
      key: `lopsided:${most.position}:${least.position}`,
      severity: input.round >= startersUrgentFromRound ? 'warn' : 'info',
      message: `${most.n} ${most.position}s already — ${least.position} depth is becoming more important`,
      detail:
        `You have ${most.n} ${most.position}${most.n === 1 ? '' : 's'} for ${input.shape.starters[most.position] ?? 0} starting slot${(input.shape.starters[most.position] ?? 0) === 1 ? '' : 's'}, ` +
        `and ${least.n} ${least.position}${least.n === 1 ? '' : 's'} for ${input.shape.starters[least.position] ?? 0}.`,
      positions: [least.position],
    });
  }

  return alerts;
}

// ------------------------------------------------------------------ helpers

function lower(sentence: string): string {
  const trimmed = sentence.replace(/\.$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
