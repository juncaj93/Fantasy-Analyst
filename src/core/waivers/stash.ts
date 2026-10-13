/**
 * Whether an injured free agent is worth holding, and until when.
 *
 * A stash is a bet that he is back and starting before the fantasy playoffs.
 * On 13 October 2026 the screen offered De'Von Achane as "Out now, worth a
 * starting spot when back" while Sleeper had him on IR with `Knee - ACL`,
 * `Surgery`: he is out for the season. Three rules:
 *
 * 1. **Season-ending is never a stash.** Read from Sleeper's injury status,
 *    body part and note, the only injury text Sleeper's public player file
 *    carries: a torn ACL or Achilles, or the words season-ending or "for the
 *    season".
 * 2. **He has to be back before the playoffs** (week {@link STASH_RULES.playoffStart}
 *    in this league). A return after week {@link STASH_RULES.lastReturnWeek}
 *    is never recommended.
 * 3. **An unknown return is a Watch list name**, labelled `return unknown`,
 *    never "Worth considering". Sleeper's file almost never carries a date,
 *    so this is the common case for anyone on IR.
 *
 * A plain `Out` (a one-game designation, not IR) is expected back next week.
 */

export const STASH_RULES = {
  playoffStart: 15,
  lastReturnWeek: 14,
} as const;

/** What Sleeper's player file says about one injured player. */
export interface InjuryNote {
  /** `IR`, `Out`, `PUP`, `Questionable`... as Sleeper writes it. */
  status: string | null;
  /** `Knee - ACL`, `Foot`. */
  bodyPart: string | null;
  /** `Surgery`, `Sprain`. Occasionally a timeline. */
  notes: string | null;
  /** ISO date, when Sleeper has one. */
  startDate?: string | null;
}

export type StashVerdict =
  | { kind: 'season_ending'; label: string }
  | { kind: 'back_by'; week: number; label: string }
  | { kind: 'too_late'; week: number; label: string }
  | { kind: 'unknown'; label: string };

const SEASON_ENDING = [/\bACL\b/i, /achilles/i, /season[- ]ending/i, /for the season/i, /out for season/i];

/**
 * The verdict for one injured player. `designation` is the app's own (`out`,
 * `ir`, `pup`); `week` is the current NFL week.
 */
export function stashVerdict(opts: { designation: string; note: InjuryNote | null; week: number }): StashVerdict {
  const text = [opts.note?.bodyPart, opts.note?.notes].filter(Boolean).join(' · ');
  if (SEASON_ENDING.some((re) => re.test(text))) {
    return { kind: 'season_ending', label: `out for the season (${text})` };
  }
  const timeline = parseTimeline(opts.note?.notes ?? null);
  if (timeline != null) {
    const week = opts.week + timeline;
    return week > STASH_RULES.lastReturnWeek
      ? { kind: 'too_late', week, label: `back around week ${week}, after the playoffs start` }
      : { kind: 'back_by', week, label: `back around week ${week}` };
  }
  const status = (opts.note?.status ?? opts.designation ?? '').toLowerCase();
  if (status === 'out' && opts.designation === 'out') {
    const week = opts.week + 1;
    return week > STASH_RULES.lastReturnWeek
      ? { kind: 'too_late', week, label: `back week ${week} at the earliest, after the playoffs start` }
      : { kind: 'back_by', week, label: `Out this week, expected back soon` };
  }
  return { kind: 'unknown', label: 'return unknown' };
}

/** `4-6 weeks`, `out 3 weeks`: the longer end, in weeks. Null when the note has no timeline. */
export function parseTimeline(notes: string | null): number | null {
  if (!notes) return null;
  const range = notes.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*weeks?/i);
  if (range) return Number(range[2]);
  const single = notes.match(/(\d+)\s*weeks?/i);
  return single ? Number(single[1]) : null;
}
