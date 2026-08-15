/**
 * How much of one NFL offence you already own.
 *
 * Two rules that look like the same rule and are opposites:
 *
 *   - A quarterback and his receiver score the same touchdown. Owning both is
 *     a **stack**, and it is a good thing: one drive pays twice.
 *   - A running back and his receiver split the same touchdown. Owning both is
 *     **concentration**, and it is a mild problem: the offence has a finite
 *     number of scores and carries to hand out, and a bad Sunday for that team
 *     is a bad Sunday for two of your slots at once.
 *
 * So this is not "diversify your roster". It is one narrow claim about
 * non-quarterback skill players sharing a finite pool of touches, and an
 * explicit exemption for the one pairing that shares the *same* touches to your
 * benefit.
 *
 * ## Bounded, and deliberately small
 *
 * At its strongest — a fourth non-quarterback from an offence you already own
 * three of — the penalty is {@link CONCENTRATION.weight}, about three picks of
 * ADP. That is a tiebreaker with teeth and nothing more. A player who has fallen
 * two rounds past his ADP is worth a full point of market value and will out-run
 * this comfortably, which is the intended behaviour: the rule is a preference,
 * not a ban, and a genuine bargain is still a genuine bargain.
 *
 * There is no hard block anywhere in this file. Nothing here can remove a player
 * from the board, and the user can draft five Bengals if they want to.
 *
 * Pure and deterministic.
 */

/** Positions that compete for the same touches. Quarterback is not one of them. */
export const SKILL_POSITIONS: ReadonlySet<string> = new Set(['RB', 'WR', 'TE']);

export const CONCENTRATION = {
  /**
   * The component's ceiling, in composite points. About three picks of ADP.
   *
   * Small on purpose: this is the softest signal on the board, it is a matter
   * of taste rather than of measurement, and the brief asks for a tiebreaker.
   */
  weight: 0.15,

  /**
   * The penalty for the Nth same-team non-quarterback, before context.
   *
   * Index by how many you already own. One is a shrug — plenty of good rosters
   * own two players from a good offence. Two is worth saying. Three means the
   * roster's week now rides on one team's game script, and the curve steepens
   * to say so rather than continuing in a straight line.
   */
  penaltyByCount: [0, -0.35, -0.75, -1] as const,

  /**
   * What a quarterback you already own is worth to his receiver.
   *
   * Positive, and smaller than the concentration penalty it can offset,
   * because a stack is a preference the user expressed rather than a
   * measurement anybody made. It is enough to keep a stack from being quietly
   * discouraged and not enough to build one on purpose out of worse players.
   */
  stackBonus: 0.5,

  /**
   * The second pass-catcher in a stack is worth less than the first.
   *
   * Owning the quarterback and two of his receivers is a real strategy and a
   * volatile one. The bonus is halved rather than withdrawn.
   */
  secondStackBonus: 0.25,

  /**
   * How much of the penalty applies in round one, ramping to all of it late.
   *
   * The same shape as `needUrgency`, and for the same reason: in the first two
   * rounds the best player available is the whole strategy and roster texture
   * is a luxury, while in round eleven you are choosing between players the
   * board rates identically and texture is most of what is left to choose on.
   */
  earlyRoundFloor: 0.4,
} as const;

/** A player already on the user's roster, as this module needs him. */
export interface RosteredPlayer {
  position: string;
  /** NFL team abbreviation. Blank or unknown teams are ignored, never guessed. */
  team: string;
}

export interface ConcentrationInput {
  position: string;
  team: string;
  /** Everyone already drafted by the user. */
  roster: RosteredPlayer[];
  /** 1-based round on the clock. */
  round: number;
  /** Total rounds in the draft, for the early-round ramp. */
  totalRounds: number;
}

export interface ConcentrationResult {
  /** Net score in [-1, 1]: negative is concentration, positive is a stack. */
  score: number;
  /** Same-team non-quarterbacks already rostered. */
  skillCount: number;
  /** True when the user already owns this team's quarterback. */
  hasQuarterback: boolean;
  /** True when this pick would itself be the quarterback of players owned. */
  isQuarterbackOfOwned: boolean;
  /** The line the breakdown shows. Never a bare label. */
  display: string;
  /** The bullet, when the effect is big enough to be worth one. Else null. */
  driver: string | null;
}

const NEUTRAL: ConcentrationResult = {
  score: 0,
  skillCount: 0,
  hasQuarterback: false,
  isQuarterbackOfOwned: false,
  display: 'no overlap with an NFL offence you already own',
  driver: null,
};

/**
 * Score the overlap between this player and the roster.
 *
 * Reads the roster the user actually has, which is why it lives here rather
 * than in the tier or need layer: those describe the board, and this describes
 * the team being built on it.
 */
export function assessConcentration(input: ConcentrationInput): ConcentrationResult {
  const team = normalizeTeam(input.team);
  const position = input.position.toUpperCase();
  // An unknown team cannot overlap with anything. Free agents, practice-squad
  // call-ups and rows the player list has not filled in yet all land here, and
  // guessing a team for them would invent a penalty out of a blank field.
  if (!team) return NEUTRAL;

  const sameTeam = input.roster.filter((p) => normalizeTeam(p.team) === team);
  const skillCount = sameTeam.filter((p) => SKILL_POSITIONS.has(p.position.toUpperCase())).length;
  const hasQuarterback = sameTeam.some((p) => p.position.toUpperCase() === 'QB');

  const ramp = roundRamp(input.round, input.totalRounds);

  /*
   * A quarterback joining his own pass-catchers.
   *
   * The stack works in both directions and the board has to know it, or a user
   * who took the receiver first would find the quarterback quietly unrewarded
   * for completing exactly the pairing this rule is supposed to like. The
   * running back on that roster is irrelevant here: a quarterback does not
   * compete with his running back for carries, he hands them over.
   */
  if (position === 'QB') {
    const catchers = sameTeam.filter((p) => ['WR', 'TE'].includes(p.position.toUpperCase())).length;
    if (catchers === 0) return { ...NEUTRAL, skillCount, hasQuarterback };
    const score = round3(
      Math.min(CONCENTRATION.stackBonus + (catchers - 1) * CONCENTRATION.secondStackBonus, 1),
    );
    return {
      score,
      skillCount,
      hasQuarterback,
      isQuarterbackOfOwned: true,
      display: `stack benefit · completes QB + ${catchers === 1 ? 'WR/TE' : `${catchers} pass-catchers`} from ${team}`,
      driver: `Stack benefit · QB + ${catchers === 1 ? 'WR/TE' : 'pass-catchers'} from ${team}`,
    };
  }

  if (!SKILL_POSITIONS.has(position)) return { ...NEUTRAL, skillCount, hasQuarterback };

  /*
   * The penalty, and then the stack credit that may partly undo it.
   *
   * Order matters. A receiver joining a roster that has the quarterback and
   * nothing else is a clean stack and comes out positive. The same receiver
   * joining a roster that has the quarterback *and the running back* comes out
   * near zero: the stack is still worth something and the offence is now
   * carrying three of your slots, which is the case the brief describes.
   */
  const raw = CONCENTRATION.penaltyByCount[Math.min(skillCount, CONCENTRATION.penaltyByCount.length - 1)] ?? -1;
  const penalty = raw * ramp;

  const stack =
    hasQuarterback && (position === 'WR' || position === 'TE')
      ? existingCatchers(sameTeam) === 0
        ? CONCENTRATION.stackBonus
        : CONCENTRATION.secondStackBonus
      : 0;

  const score = round3(Math.max(-1, Math.min(1, penalty + stack)));
  if (score === 0) {
    return {
      ...NEUTRAL,
      skillCount,
      hasQuarterback,
      display:
        skillCount === 0
          ? 'no overlap with an NFL offence you already own'
          : `${describeRostered(sameTeam)} from ${team} already rostered, and the stack offsets it`,
    };
  }

  return {
    score,
    skillCount,
    hasQuarterback,
    isQuarterbackOfOwned: false,
    display: describe(score, sameTeam, team, ramp),
    driver: driverOf(score, sameTeam, team),
  };
}

/**
 * How much of the penalty this round is allowed to apply.
 *
 * Returns 1 when the draft length is unknown rather than guessing at a shape —
 * the full (and already small) penalty is the safe default.
 */
export function roundRamp(round: number, totalRounds: number): number {
  if (!Number.isFinite(totalRounds) || totalRounds <= 1) return 1;
  const progress = Math.min(1, Math.max(0, (round - 1) / (totalRounds - 1)));
  return round3(CONCENTRATION.earlyRoundFloor + (1 - CONCENTRATION.earlyRoundFloor) * progress);
}

function existingCatchers(sameTeam: RosteredPlayer[]): number {
  return sameTeam.filter((p) => ['WR', 'TE'].includes(p.position.toUpperCase())).length;
}

/** `RB + WR from DET`, in the order the roster was built. */
function describeRostered(sameTeam: RosteredPlayer[]): string {
  const skill = sameTeam
    .map((p) => p.position.toUpperCase())
    .filter((p) => SKILL_POSITIONS.has(p) || p === 'QB');
  return skill.join(' + ');
}

function describe(score: number, sameTeam: RosteredPlayer[], team: string, ramp: number): string {
  if (score > 0) return `stack benefit · you already own the ${team} quarterback`;
  const size = score <= -0.6 ? 'Concentration penalty' : 'Small concentration penalty';
  return (
    `${size.toLowerCase()} · already rostered ${describeRostered(sameTeam)} from ${team}` +
    (ramp < 1 ? ' (discounted this early in the draft)' : '')
  );
}

function driverOf(score: number, sameTeam: RosteredPlayer[], team: string): string | null {
  if (Math.abs(score) < 0.3) return null;
  if (score > 0) return `Stack benefit · QB + ${team} pass-catcher`;
  const size = score <= -0.6 ? 'Concentration penalty' : 'Small concentration penalty';
  return `${size} · already rostered ${describeRostered(sameTeam)} from ${team}`;
}

/**
 * Teams compared as the player list spells them, with whitespace and case
 * removed. No alias table: this app has exactly one source of team codes and
 * inventing a second mapping here is how `LA` and `LAR` become two franchises.
 */
function normalizeTeam(team: string | null | undefined): string {
  return (team ?? '').trim().toUpperCase();
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}
