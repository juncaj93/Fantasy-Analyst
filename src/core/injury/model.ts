/**
 * One normalized answer to "can he play", for every screen that asks.
 *
 * Before this, each surface read raw source strings for itself: the draft board
 * mapped Sleeper's `injury_status` to a badge, Start/Sit matched a stripped
 * uppercase key against a penalty table, and the trade engine did not look at
 * all. Three interpretations of one fact is how a player ends up Questionable on
 * one screen and fine on another, and there is no version of that a user should
 * have to reconcile.
 *
 * So: sources produce observations, this module turns observations into a state,
 * and the screens read the state.
 *
 * ## What is deliberately not here
 *
 * No medicine. This does not predict a return date, grade a severity, or decide
 * whether a hamstring is worse than an ankle. It reports what sources said, when
 * they said it, whether they agree, and how old it is — and it is explicit about
 * not knowing, because for most players on most days nobody has published
 * anything and "no designation" and "no information" are different sentences.
 */

/**
 * What the league host says about availability.
 *
 * `healthy` means a source looked and found no designation. `unknown` means
 * nothing looked, or nothing recognisable came back. The distinction matters:
 * one is evidence of health, the other is absence of evidence, and Start/Sit
 * treats them differently.
 */
export type Designation =
  | 'healthy'
  | 'questionable'
  | 'doubtful'
  | 'out'
  | 'ir'
  | 'pup'
  | 'suspended'
  | 'unknown';

/** How bad, in the only ordering that matters: can he play on Sunday. */
export const DESIGNATION_SEVERITY: Record<Designation, number> = {
  healthy: 0,
  unknown: 0,
  questionable: 1,
  doubtful: 2,
  out: 3,
  ir: 4,
  pup: 4,
  suspended: 4,
};

/** Designations that mean he is not playing, as a fact rather than a risk. */
export function isRuledOut(designation: Designation): boolean {
  return designation === 'out' || designation === 'ir' || designation === 'pup' || designation === 'suspended';
}

/**
 * The vocabulary, closed on purpose and shared by every source.
 *
 * Sleeper's `injury_status` and nflverse's `report_status` overlap but are not
 * identical, and both fall back to roster states — `Active`, `DNR`, `NA` — that
 * are not injury designations at all. Anything unrecognised comes back
 * `unknown` and is never printed raw: a badge reading `COV` on a draft board is
 * noise, and inventing a severity for a string nobody has seen is worse.
 */
const DESIGNATIONS: Record<string, Designation> = {
  // Real designations.
  QUESTIONABLE: 'questionable',
  Q: 'questionable',
  DOUBTFUL: 'doubtful',
  D: 'doubtful',
  OUT: 'out',
  O: 'out',
  IR: 'ir',
  'INJURED RESERVE': 'ir',
  'INJURED RESERVE DESIGNATED FOR RETURN': 'ir',
  PUP: 'pup',
  'PHYSICALLY UNABLE TO PERFORM': 'pup',
  NFI: 'pup',
  SUS: 'suspended',
  SUSP: 'suspended',
  SUSPENDED: 'suspended',
  // Roster states that mean "nothing is wrong with him".
  ACTIVE: 'healthy',
  HEALTHY: 'healthy',
  '': 'healthy',
};

export interface DesignationReading {
  designation: Designation;
  /** Exactly what the source said, kept for audit. */
  raw: string | null;
}

/**
 * Normalize whatever a source called it.
 *
 * `null`/absent is `unknown` rather than `healthy`: a missing field is a
 * question nobody asked. A source that explicitly says `Active` is the one that
 * earns `healthy`.
 */
export function normalizeDesignation(raw: string | null | undefined): DesignationReading {
  if (raw == null) return { designation: 'unknown', raw: null };
  const key = raw.trim().toUpperCase();
  if (key === '') return { designation: 'unknown', raw };
  return { designation: DESIGNATIONS[key] ?? 'unknown', raw };
}

// ------------------------------------------------------------ practice

/** What he did at practice. The three states every report uses, plus not-known. */
export type PracticeStatus = 'dnp' | 'limited' | 'full' | 'unknown';

const PRACTICE: Record<string, PracticeStatus> = {
  DNP: 'dnp',
  'DID NOT PARTICIPATE IN PRACTICE': 'dnp',
  'DID NOT PRACTICE': 'dnp',
  LIMITED: 'limited',
  LP: 'limited',
  'LIMITED PARTICIPATION IN PRACTICE': 'limited',
  FULL: 'full',
  FP: 'full',
  'FULL PARTICIPATION IN PRACTICE': 'full',
};

export function normalizePractice(raw: string | null | undefined): PracticeStatus {
  if (!raw) return 'unknown';
  return PRACTICE[raw.trim().toUpperCase()] ?? 'unknown';
}

/** Where a week of practice reports is heading. */
export type PracticeTrend = 'improving' | 'worsening' | 'full_participant' | 'stable_limited' | 'not_practising' | 'unknown';

export interface PracticeReading {
  trend: PracticeTrend;
  /** The days that were actually reported, oldest first. */
  days: PracticeStatus[];
  /** The most recent one, which is the single most useful fact here. */
  latest: PracticeStatus;
  /** One short clause, or null when there is nothing worth saying. */
  label: string | null;
}

const LADDER: Record<Exclude<PracticeStatus, 'unknown'>, number> = { dnp: 0, limited: 1, full: 2 };

/**
 * Read a week of practice reports as a direction.
 *
 * Deliberately shallow. This compares the first known day with the last known
 * day and says which way it went; it does not fit a curve to three data points
 * or claim a player who went limited→full is 80% likely to play. Practice trend
 * is a confidence input, and a confidence input that pretends to be a
 * probability is worse than no input.
 *
 * One day is not a trend, and is reported as the state it is.
 */
export function practiceTrend(reports: (PracticeStatus | null | undefined)[]): PracticeReading {
  const days = reports.filter((d): d is PracticeStatus => d != null && d !== 'unknown');
  const latest = days.at(-1) ?? 'unknown';
  if (days.length === 0) return { trend: 'unknown', days, latest, label: null };

  if (days.every((d) => d === 'full')) {
    return { trend: 'full_participant', days, latest, label: 'practised fully' };
  }
  if (days.every((d) => d === 'dnp')) {
    return { trend: 'not_practising', days, latest, label: 'has not practised' };
  }
  if (days.length === 1) {
    return {
      trend: 'stable_limited',
      days,
      latest,
      label: latest === 'limited' ? 'limited in practice' : null,
    };
  }

  const first = LADDER[days[0] as Exclude<PracticeStatus, 'unknown'>];
  const last = LADDER[latest as Exclude<PracticeStatus, 'unknown'>];
  if (last > first) return { trend: 'improving', days, latest, label: describeTrend(days) };
  if (last < first) return { trend: 'worsening', days, latest, label: describeTrend(days) };
  return { trend: 'stable_limited', days, latest, label: 'limited all week' };
}

const SHORT: Record<PracticeStatus, string> = { dnp: 'DNP', limited: 'limited', full: 'full', unknown: '—' };

/** `DNP → limited → full`, which says more than the word "improving" does. */
function describeTrend(days: PracticeStatus[]): string {
  return days.map((d) => SHORT[d]).join(' → ');
}

// ----------------------------------------------------------- freshness

/**
 * How current an observation is, relative to when a decision is being made.
 *
 * The thresholds are about the NFL week rather than about time in general: an
 * injury report is written on a practice day, the picture changes on the next
 * practice day, and the final designations land on Friday. A Wednesday note read
 * on Sunday morning is not wrong, it is two reports out of date.
 */
export type Freshness = 'fresh' | 'recent' | 'stale' | 'unknown';

export const FRESHNESS_HOURS = { fresh: 30, recent: 96 } as const;

export function freshnessOf(observedAt: string | null | undefined, now: Date): Freshness {
  if (!observedAt) return 'unknown';
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return 'unknown';
  const hours = (now.getTime() - at) / 3_600_000;
  // A clock disagreement should not read as prophecy.
  if (hours < -1) return 'unknown';
  if (hours <= FRESHNESS_HOURS.fresh) return 'fresh';
  if (hours <= FRESHNESS_HOURS.recent) return 'recent';
  return 'stale';
}

// ---------------------------------------------------------- the state

export type Confidence = 'high' | 'moderate' | 'low' | 'unknown';

export interface InjuryObservation {
  /** Where it came from, for the card and for the audit. */
  source: string;
  designation: Designation;
  /** What the source literally said, kept so a surprise can be traced. */
  raw: string | null;
  observedAt: string | null;
  practice?: PracticeStatus[];
  bodyPart?: string | null;
}

export interface InjuryState {
  designation: Designation;
  /** Which source the designation came from. */
  designationSource: string | null;
  /** `hamstring`, `knee` — as the source wrote it, never interpreted. */
  bodyPart: string | null;
  bodyPartSource: string | null;
  practice: PracticeReading;
  practiceSource: string | null;
  freshness: Freshness;
  observedAt: string | null;
  confidence: Confidence;
  /**
   * True when two sources give materially different designations.
   *
   * "Materially" is doing real work: Sleeper saying Questionable while the
   * practice report says he practised fully is not a contradiction, it is the
   * most useful thing either of them said. Two sources naming different
   * severities is.
   */
  conflict: boolean;
  conflictNote: string | null;
  /** Every observation that fed this, newest first. Nothing is discarded. */
  observations: InjuryObservation[];
}

export const NO_INJURY_INFORMATION: InjuryState = {
  designation: 'unknown',
  designationSource: null,
  bodyPart: null,
  bodyPartSource: null,
  practice: { trend: 'unknown', days: [], latest: 'unknown', label: null },
  practiceSource: null,
  freshness: 'unknown',
  observedAt: null,
  confidence: 'unknown',
  conflict: false,
  conflictNote: null,
  observations: [],
};

/**
 * Sources, in the order they are believed for a *designation*.
 *
 * Sleeper is first and it is not a close call: it is the league host, it is what
 * the user's own app shows, and it is what actually governs whether a player is
 * in their lineup. A practice report published on Friday is better at describing
 * the week and worse at describing Sunday.
 *
 * Body part and practice participation invert this — see `resolveInjury`.
 */
const DESIGNATION_PRIORITY = ['sleeper', 'nflverse'] as const;

function rank(source: string): number {
  const i = DESIGNATION_PRIORITY.indexOf(source as (typeof DESIGNATION_PRIORITY)[number]);
  return i === -1 ? DESIGNATION_PRIORITY.length : i;
}

/**
 * Combine what the sources said into one state.
 *
 * The rules, in full:
 *
 *  - the designation comes from the highest-priority source that has a real one;
 *  - the body part and the practice week come from whoever has them, because
 *    only the injury report publishes those and there is nothing to arbitrate;
 *  - freshness is measured against the observation the designation came from,
 *    not the newest one — a fresh practice note does not make a stale
 *    designation current;
 *  - disagreement lowers confidence and is surfaced, never averaged away.
 */
export function resolveInjury(observations: InjuryObservation[], now: Date): InjuryState {
  const usable = observations.filter((o) => o.designation !== 'unknown' || o.bodyPart || o.practice?.length);
  if (usable.length === 0) return NO_INJURY_INFORMATION;

  const sorted = [...usable].sort(
    (a, b) => rank(a.source) - rank(b.source) || (Date.parse(b.observedAt ?? '') || 0) - (Date.parse(a.observedAt ?? '') || 0),
  );

  const primary = sorted.find((o) => o.designation !== 'unknown') ?? null;
  const designation = primary?.designation ?? 'unknown';

  // Whoever has it. Only the injury report publishes a body part, so this is a
  // lookup rather than a judgement.
  const withBody = sorted.find((o) => (o.bodyPart ?? '').trim().length > 0) ?? null;
  const withPractice = sorted.find((o) => (o.practice ?? []).length > 0) ?? null;
  const practice = practiceTrend(withPractice?.practice ?? []);

  /*
   * Conflict is about severity, not about wording.
   *
   * Two sources that both say "he might play" agree, whatever words they used;
   * one saying Out and another saying Questionable is a disagreement a person
   * needs to see. Practice participation is never a conflict — it is the
   * texture the designation lacks.
   */
  const severities = new Set(
    sorted.filter((o) => o.designation !== 'unknown').map((o) => DESIGNATION_SEVERITY[o.designation]),
  );
  const conflict = severities.size > 1;
  const conflictNote = conflict
    ? sorted
        .filter((o) => o.designation !== 'unknown')
        .map((o) => `${o.source}: ${o.raw ?? o.designation}`)
        .join(' · ')
    : null;

  const freshness = freshnessOf(primary?.observedAt ?? null, now);
  return {
    designation,
    designationSource: primary?.source ?? null,
    bodyPart: withBody?.bodyPart?.trim() || null,
    bodyPartSource: withBody?.source ?? null,
    practice,
    practiceSource: withPractice?.source ?? null,
    freshness,
    observedAt: primary?.observedAt ?? null,
    confidence: confidenceOf({ freshness, conflict, corroborated: severities.size === 1 && sorted.length > 1, designation }),
    conflict,
    conflictNote,
    observations: sorted,
  };
}

/**
 * How much weight the rest of the app should put on this.
 *
 * Not a probability and not a score — four states, so that a caller has to
 * decide what to do about each rather than multiplying by a number.
 */
export function confidenceOf(input: {
  freshness: Freshness;
  conflict: boolean;
  corroborated: boolean;
  designation: Designation;
}): Confidence {
  if (input.designation === 'unknown') return 'unknown';
  if (input.conflict) return 'low';
  if (input.freshness === 'stale') return 'low';
  if (input.freshness === 'unknown') return 'low';
  if (input.freshness === 'fresh' && input.corroborated) return 'high';
  if (input.freshness === 'fresh') return 'moderate';
  return 'moderate';
}

// ------------------------------------------------------------ display

/** `Q`, `D`, `OUT` — short enough for a dense row. */
export const DESIGNATION_CODE: Record<Designation, string | null> = {
  healthy: null,
  unknown: null,
  questionable: 'Q',
  doubtful: 'D',
  out: 'OUT',
  ir: 'IR',
  pup: 'PUP',
  suspended: 'SUS',
};

export const DESIGNATION_LABEL: Record<Designation, string> = {
  healthy: 'No designation',
  unknown: 'Status unknown',
  questionable: 'Questionable',
  doubtful: 'Doubtful',
  out: 'Out',
  ir: 'Injured reserve',
  pup: 'Physically unable to perform',
  suspended: 'Suspended',
};

/**
 * One line for a card: `Q · hamstring · limited all week`.
 *
 * Every clause is omitted when it is not known, so this returns `null` for the
 * overwhelming majority of players rather than a row of placeholders. The body
 * part is printed as the source wrote it and never expanded into a sentence.
 */
export function injuryLine(state: InjuryState): string | null {
  const code = DESIGNATION_CODE[state.designation];
  if (!code) return null;
  const parts = [code];
  if (state.bodyPart) parts.push(state.bodyPart.toLowerCase());
  if (state.practice.label) parts.push(state.practice.label);
  return parts.join(' · ');
}

/**
 * Where it came from and how old it is — for the expanded card, never the row.
 *
 * Printed rather than merely stored, because a freshness the user cannot see is
 * a freshness they cannot judge.
 */
export function provenanceLine(state: InjuryState): string | null {
  if (!state.designationSource) return null;
  const bits = [`${state.designationSource} status`];
  if (state.practiceSource && state.practice.label) bits.push(`practice via ${state.practiceSource}`);
  const age = { fresh: 'current', recent: 'not the latest report', stale: 'out of date', unknown: 'undated' }[
    state.freshness
  ];
  return `${bits.join(' · ')} · ${age}`;
}
