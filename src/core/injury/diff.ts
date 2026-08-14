/**
 * What actually changed, out of a file where almost nothing did.
 *
 * The season file is one row per player per week and it is *republished whole*
 * every time the NFL revises anything. So a Friday update to three players
 * arrives as four hundred rows, three hundred and ninety-seven of which are
 * byte-identical to what is already stored. Writing all four hundred would cost
 * a hundred and fifteen thousand D1 writes a day at a five-minute cadence — more
 * than the entire free-tier budget — to record three facts.
 *
 * So this compares before writing, and it compares *normalized* values rather
 * than raw ones. Three separate things are deliberately not conflated:
 *
 *   1. the **file** changed — a validator moved;
 *   2. a **player's row** changed — some field differs;
 *   3. a player's **state** changed — a field that alters a decision differs.
 *
 * Only the third earns a write. A file republished with reordered rows, a
 * revised spelling, or a new column is change of the first kind and produces
 * nothing at all.
 */

import { normalizeDesignation, type Designation, type PracticeStatus } from './model.ts';

/** The stored shape this compares against, narrowed to what matters. */
export interface ComparableInjury {
  playerId: string;
  season: string;
  week: number;
  reportStatus: string | null;
  primaryInjury: string | null;
  practiceStatus: PracticeStatus;
}

export type InjuryEventKind = 'designation' | 'practice' | 'body_part';

export interface InjuryEvent {
  /**
   * Deterministic and unique. Derived from the player, the week and the
   * transition — never from a clock — so re-ingesting the same file produces
   * the same key and the insert is a no-op rather than a duplicate.
   */
  eventKey: string;
  playerId: string;
  season: string;
  week: number;
  kind: InjuryEventKind;
  from: string | null;
  to: string | null;
}

export interface InjuryDiff {
  /** Rows to write: genuinely new, or genuinely different. */
  changed: ComparableInjury[];
  /** Transitions worth recording. Never produced for a first sighting. */
  events: InjuryEvent[];
  /** Players whose state moved, for targeted downstream recomputation. */
  changedPlayerIds: string[];
  /** How many incoming rows were examined, changed or not. */
  examined: number;
  /** Unchanged rows — the number this whole module exists to keep at zero cost. */
  unchanged: number;
}

/**
 * Compare an ingest against what is stored.
 *
 * `stored` is keyed by `${playerId}:${season}:${week}`. A key absent from it is
 * a first sighting: the row is written, and **no event is emitted** — "we had
 * not heard of him" is not a transition, and treating it as one would fire a
 * `→ Questionable` event for every player on the board the first time the
 * pipeline ever runs.
 */
export function diffInjuries(
  incoming: ComparableInjury[],
  stored: Map<string, ComparableInjury>,
): InjuryDiff {
  const changed: ComparableInjury[] = [];
  const events: InjuryEvent[] = [];
  const changedPlayerIds = new Set<string>();
  let unchanged = 0;

  for (const row of incoming) {
    const previous = stored.get(keyOf(row));

    if (!previous) {
      changed.push(row);
      changedPlayerIds.add(row.playerId);
      continue;
    }

    const transitions = meaningfulChanges(previous, row);
    if (transitions.length === 0) {
      unchanged++;
      continue;
    }

    changed.push(row);
    changedPlayerIds.add(row.playerId);
    for (const t of transitions) {
      events.push({
        eventKey: eventKey(row, t.kind, t.from, t.to),
        playerId: row.playerId,
        season: row.season,
        week: row.week,
        kind: t.kind,
        from: t.from,
        to: t.to,
      });
    }
  }

  return {
    changed,
    events,
    changedPlayerIds: [...changedPlayerIds].sort(),
    examined: incoming.length,
    unchanged,
  };
}

/**
 * The fields whose movement changes a decision.
 *
 * Designation and practice are compared **normalized**, so a source that starts
 * writing `DNP` where it used to write `Did Not Participate In Practice` is
 * correctly read as no change at all. The body part is compared
 * case-insensitively for the same reason.
 *
 * Everything else in the row — team, secondary injury, the raw practice string,
 * row order, file timestamp — is deliberately not compared. None of them alter
 * what the app would tell you to do.
 */
function meaningfulChanges(
  before: ComparableInjury,
  after: ComparableInjury,
): { kind: InjuryEventKind; from: string | null; to: string | null }[] {
  const out: { kind: InjuryEventKind; from: string | null; to: string | null }[] = [];

  const wasDesignation = designationOf(before);
  const isDesignation = designationOf(after);
  if (wasDesignation !== isDesignation) {
    out.push({ kind: 'designation', from: wasDesignation, to: isDesignation });
  }

  if (before.practiceStatus !== after.practiceStatus) {
    out.push({ kind: 'practice', from: before.practiceStatus, to: after.practiceStatus });
  }

  const wasPart = normalizePart(before.primaryInjury);
  const isPart = normalizePart(after.primaryInjury);
  if (wasPart !== isPart) {
    out.push({ kind: 'body_part', from: wasPart, to: isPart });
  }

  return out;
}

/**
 * A cleared designation is `healthy`, not `unknown`.
 *
 * The source writes an empty `report_status` for a player who is on the
 * practice report but carries no game designation. Read as "unknown" that would
 * make every clearing invisible — and a designation being *removed* on a
 * Saturday is exactly the news a lineup wants.
 */
function designationOf(row: ComparableInjury): Designation {
  const reading = normalizeDesignation(row.reportStatus);
  return reading.designation === 'unknown' && !row.reportStatus ? 'healthy' : reading.designation;
}

function normalizePart(value: string | null): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function keyOf(row: { playerId: string; season: string; week: number }): string {
  return `${row.playerId}:${row.season}:${row.week}`;
}

function eventKey(
  row: ComparableInjury,
  kind: InjuryEventKind,
  from: string | null,
  to: string | null,
): string {
  return `${row.playerId}:${row.season}:${row.week}:${kind}:${from ?? '-'}>${to ?? '-'}`;
}

/**
 * How much of the board would this ingest rewrite?
 *
 * A parser that breaks — a renamed column, a changed delimiter — does not fail
 * loudly. It reads every field as empty and produces a diff saying that all four
 * hundred players simultaneously became healthy with no injury and no practice
 * report. That is indistinguishable from a real mass update except by its size,
 * which is why size is what this checks.
 *
 * The threshold only applies once there is something to compare against; a first
 * run legitimately changes everything.
 */
export const ANOMALY = {
  /** Above this share of examined rows, an ingest is suspicious. */
  changedShare: 0.6,
  /** …but only once the store holds at least this many rows to compare with. */
  minStored: 50,
} as const;

export function looksAnomalous(diff: InjuryDiff, storedCount: number): boolean {
  if (storedCount < ANOMALY.minStored) return false;
  if (diff.examined === 0) return false;
  return diff.changed.length / diff.examined > ANOMALY.changedShare;
}
