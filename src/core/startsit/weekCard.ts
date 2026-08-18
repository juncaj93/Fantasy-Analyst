/**
 * One of your players, this week, in as few lines as the decision allows.
 *
 * The Team screen's rows answer "who does the app recommend starting". Tapping
 * one asks a second question — *why him, and what would change it* — and the
 * temptation there is to answer with everything the engine knows. That is a
 * stat dump: eleven components, four assessments, a props table and an injury
 * report, none of which is wrong and all of which together is a screen nobody
 * reads on a Sunday morning with forty minutes to kickoff.
 *
 * So this is a filter, and the rule it applies is: **would this line change
 * what the reader does?** Role, matchup, the market's own number, availability
 * and the two drivers the score actually leaned on. Everything else stays where
 * it already lives — the full breakdown is still one tap further on in Compare,
 * and every number here came from there rather than being recomputed.
 *
 * Three properties hold it to that:
 *
 *  1. **It states the lineup's answer rather than a second one.** The verdict
 *     comes from where the optimiser put the player, passed in as context. A
 *     card that re-derived "start him" from his own score alone would sooner or
 *     later disagree with the row that opened it, and two answers is worse than
 *     the harder one.
 *  2. **A line that is unknown does not appear.** Not as "unknown", not as a
 *     dash, not as a zero — the card is short because it drops what it does not
 *     know, and what is missing is named once at the bottom instead.
 *  3. **It carries slots it cannot fill yet.** Expected points and points over
 *     expectation arrive with the intelligence pass; "what would change my
 *     recommendation" arrives after it. Both are read straight off the
 *     evaluation if they are there, and are silent if they are not, so merging
 *     that work lights this card up without touching this file.
 *
 * Pure, and structurally typed on purpose: the server's evaluation and the
 * browser's copy of it both satisfy the input, so there is one card builder
 * rather than one per side of the wire.
 */

/** A labelled line of the card. The value is already formatted for reading. */
export interface WeeklyLine {
  key: string;
  label: string;
  value: string;
  /** The half-sentence under it, when there is one worth the room. */
  detail?: string | null;
}

export type WeeklyVerdict = 'start' | 'bench' | 'not_playable' | 'unknown';

export interface WeeklyCard {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** The conclusion, in the words the lineup used to reach it. */
  headline: {
    verdict: WeeklyVerdict;
    label: string;
    detail: string | null;
    tone: 'take' | 'calm' | 'warn';
  };
  /** `high` / `medium` / `low`, as the engine reported it. */
  confidence: string;
  /** The projection this league's scoring produces, or null. */
  score: number | null;
  /** Who he faces, when the schedule is known. */
  opponent: string | null;
  /** At most five: role, matchup, market, availability, advanced. */
  lines: WeeklyLine[];
  /** The current prop lines, biggest contribution first. At most three. */
  props: WeeklyLine[];
  /** The two things that actually moved the score, biggest first. */
  drivers: string[];
  /** Where the evidence points different ways, said rather than averaged. */
  conflicts: string[];
  /** What would change the recommendation. Empty until that pass lands. */
  changes: string[];
  /** What is not known, named once rather than printed as blank rows. */
  pending: string[];
}

/**
 * The parts of a start/sit evaluation this card reads.
 *
 * Everything optional is optional because a deployment — or a branch — may not
 * have it yet. Absent is rendered as nothing, never as zero.
 */
export interface WeeklyEvaluationLike {
  playerId: string;
  name: string;
  position: string;
  team: string;
  score: number | null;
  confidence: string;
  statusFlag: string | null;
  ruledOut: boolean;
  opponent?: string | null;
  expectation?: {
    points: number | null;
    coverage: number;
    contributions?: { market: string; line: number | null; points: number; detail: string }[];
  };
  role?: { trend: string; label: string; detail: string; games: number };
  usage?: { display: string; unknown: boolean };
  matchup?: { display: string; unknown: boolean; rating: string };
  availability?: { label: string; detail: string | null; risky: boolean };
  injury?: { conflictNote?: string | null };
  lock?: { locked: boolean };
  movement?: { headline: string | null; direction: string };
  drivers?: string[];
  conflicts?: string[];
  /**
   * Expected points and points over expectation, once the intelligence pass
   * provides them. Read as given — this file does not compute either, and a
   * card that invented an xFP would be inventing the thing it is quoting.
   */
  advanced?: { key: string; label: string; value: string; detail?: string | null }[];
  /** The sensitivity pass, when it exists. Sentences, already written. */
  whatWouldChange?: string[];
}

/** Where the lineup put this player, which is what the card reports. */
export interface WeeklyContext {
  /** True when the optimiser has him in a starting slot. */
  starting: boolean;
  /** The slot he fills, when he is starting. */
  slot?: string | null;
  /** Whether Sleeper already has him there. */
  alreadyStarting?: boolean;
  /** His game has kicked off; nothing about him can be changed now. */
  locked?: boolean;
}

/** How many prop lines are worth the space. Three is one glance. */
export const MAX_WEEKLY_PROPS = 3;

/** How many drivers a card states. The rest are in the full breakdown. */
export const MAX_WEEKLY_DRIVERS = 2;

export function buildWeeklyCard(evaluation: WeeklyEvaluationLike, context: WeeklyContext): WeeklyCard {
  const locked = context.locked ?? evaluation.lock?.locked ?? false;
  const lines: WeeklyLine[] = [];
  const pending: string[] = [];

  /*
   * Role first, because it is the only line that describes a *direction*.
   *
   * A rising role is the single most useful thing a weekly card can say — it is
   * the reason to start somebody the projection has not caught up with yet —
   * and a role that has not moved is worth saying too, in three words.
   */
  if (evaluation.role && evaluation.role.trend !== 'insufficient_data') {
    lines.push({
      key: 'role',
      label: 'Role',
      value: evaluation.role.label,
      detail: evaluation.role.detail || null,
    });
  } else if (evaluation.usage && !evaluation.usage.unknown) {
    lines.push({ key: 'usage', label: 'Usage', value: evaluation.usage.display });
  } else {
    pending.push('role trend');
  }

  /*
   * Usage beside the trend, but only when it is saying something the trend did
   * not. Two lines both reading "he is getting the ball more" is the repetition
   * this card exists to avoid.
   */
  if (
    evaluation.usage &&
    !evaluation.usage.unknown &&
    !lines.some((l) => l.key === 'usage') &&
    !sameThing(evaluation.usage.display, lines[0]?.detail)
  ) {
    lines.push({ key: 'usage', label: 'Opportunity', value: evaluation.usage.display });
  }

  if (evaluation.matchup && !evaluation.matchup.unknown) {
    lines.push({
      key: 'matchup',
      label: 'Matchup',
      value: evaluation.matchup.display,
      detail: evaluation.opponent ? `vs ${evaluation.opponent}` : null,
    });
  } else if (evaluation.opponent) {
    lines.push({ key: 'matchup', label: 'Opponent', value: evaluation.opponent });
  } else {
    pending.push('opponent tendency');
  }

  /*
   * What the market expects, and whether it has moved since the last look.
   *
   * The movement is the half of this that a projection cannot carry: a number
   * that is the same as it was on Wednesday and a number that has climbed all
   * week are different facts about the same player.
   */
  const marketPoints = evaluation.expectation?.points ?? null;
  if (marketPoints != null) {
    lines.push({
      key: 'market',
      label: 'Market',
      value: `${marketPoints.toFixed(1)} pts`,
      detail: evaluation.movement?.headline ?? null,
    });
  } else {
    pending.push('Vegas expectation');
  }

  /*
   * Availability, and only when it is not the ordinary answer.
   *
   * A healthy player gets no line at all. The engine's own availability view is
   * preferred over the raw designation because it is the one that says the
   * useful thing: `Questionable · hamstring · practised fully` is a start, and
   * `Questionable · hamstring · did not practise` is not, and both of them are
   * "Questionable" to anything reading the status alone.
   */
  const availabilityLine = evaluation.availability?.detail ?? evaluation.statusFlag;
  if (availabilityLine) {
    lines.push({
      key: 'availability',
      label: 'Availability',
      value: evaluation.availability?.label ?? evaluation.statusFlag ?? '',
      detail: availabilityLine === evaluation.availability?.label ? null : availabilityLine,
    });
  }

  // Channel 3's numbers, when Channel 3 is here. Read, never derived.
  for (const extra of evaluation.advanced ?? []) {
    lines.push({ key: extra.key, label: extra.label, value: extra.value, detail: extra.detail ?? null });
  }
  if ((evaluation.advanced ?? []).length === 0) pending.push('expected points');

  const props = (evaluation.expectation?.contributions ?? [])
    .filter((c) => c.line != null)
    .slice()
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, MAX_WEEKLY_PROPS)
    .map((c) => ({ key: `prop-${c.market}`, label: c.market, value: formatLine(c.line), detail: c.detail }));

  const conflicts = [...(evaluation.conflicts ?? [])];
  if (evaluation.injury?.conflictNote) conflicts.push(`Sources disagree — ${evaluation.injury.conflictNote}`);

  return {
    playerId: evaluation.playerId,
    name: evaluation.name,
    position: evaluation.position,
    team: evaluation.team,
    headline: headlineFor(evaluation, context, locked),
    confidence: evaluation.confidence,
    score: evaluation.score,
    opponent: evaluation.opponent ?? null,
    lines,
    props,
    drivers: (evaluation.drivers ?? []).slice(0, MAX_WEEKLY_DRIVERS),
    conflicts: conflicts.slice(0, 1),
    changes: evaluation.whatWouldChange ?? [],
    pending,
  };
}

/**
 * The conclusion, which is the lineup's and not this card's.
 *
 * Ruled out comes first and is absolute: a player who is Out is not a start/sit
 * question, and printing "bench him" for somebody on injured reserve would be
 * treating a fact as an opinion.
 */
function headlineFor(
  evaluation: WeeklyEvaluationLike,
  context: WeeklyContext,
  locked: boolean,
): WeeklyCard['headline'] {
  if (evaluation.ruledOut) {
    return {
      verdict: 'not_playable',
      label: 'Not playable',
      detail: evaluation.statusFlag ?? evaluation.availability?.label ?? null,
      tone: 'warn',
    };
  }

  if (context.starting) {
    const slot = context.slot ? ` at ${context.slot}` : '';
    return {
      verdict: 'start',
      label: `Start${slot}`,
      detail: locked
        ? 'His game has kicked off — this spot is settled.'
        : context.alreadyStarting === false
          ? 'Not in your Sleeper lineup yet.'
          : null,
      tone: 'take',
    };
  }

  if (evaluation.score == null) {
    return {
      verdict: 'unknown',
      label: 'Not enough data to rank him',
      detail: 'He is left out of the comparison rather than assumed bad.',
      tone: 'calm',
    };
  }

  return {
    verdict: 'bench',
    label: 'Bench this week',
    detail: locked ? 'His game has kicked off.' : null,
    tone: 'calm',
  };
}

function formatLine(line: number | null): string {
  if (line == null) return '';
  return Number.isInteger(line) ? String(line) : line.toFixed(1);
}

/** Whether two strings are saying the same thing in different words. */
function sameThing(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalise = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const left = normalise(a);
  const right = normalise(b);
  return left === right || left.includes(right) || right.includes(left);
}
