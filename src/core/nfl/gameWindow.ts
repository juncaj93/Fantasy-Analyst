/**
 * Whether football is being played right now, from the kickoffs themselves.
 *
 * Two surfaces need the same answer and must not each invent one. The schedule
 * ingest uses it to decide how often to re-check the fixture list, and the
 * three screens with a pull-to-refresh use it to say whether refreshing is
 * likely to change anything. A backend that thinks it is Sunday afternoon
 * while the screen thinks it is Tuesday is the two-definitions failure this
 * repository keeps writing leaves like this one to avoid.
 *
 * ## Why kickoffs rather than a clock
 *
 * The obvious implementation is a table of US Eastern wall-clock ranges —
 * Sunday 13:00, Thursday 20:15, Monday 20:15 — converted to UTC. It is also
 * wrong four different ways, and every one of them is the kind of wrongness
 * that looks right in September and fails in December:
 *
 *   - **Daylight saving.** The season spans the first Sunday in November, so
 *     the same fixture is 17:00 UTC for nine weeks and 18:00 UTC for nine
 *     more. A fixed table is an hour out for half the season.
 *   - **International games.** London kicks off at 09:30 Eastern, and Munich
 *     and São Paulo each have their own slot. None is in the table.
 *   - **Flex scheduling and Saturday football.** December adds Saturday
 *     doubleheaders the league announces weeks out; the table does not know.
 *   - **Holidays.** Thanksgiving is three games on a Thursday afternoon.
 *
 * So this reads the kickoffs this app has already stored, which are published
 * by the league, already carry every one of those cases, and are already in
 * hand on all three read paths — `StartSitContext.schedule` holds them, so the
 * screens cost no extra query at all. The ingest pays one indexed read for the
 * week, and only on the ticks where the answer could change what it does.
 *
 * ## The window a kickoff opens
 *
 * From the whistle to {@link GAME_LENGTH_HOURS} after it. An NFL game runs
 * about three hours and ten minutes; three and a half covers overtime and the
 * minutes after a final whistle when the numbers are still settling, and stops
 * well short of running one slot into the next. It deliberately does *not*
 * extend before kickoff: the hour before a game is when injury news moves, and
 * that is already on a five-minute check of its own.
 */

/** How long after kickoff a game is still counted as being played. */
export const GAME_LENGTH_HOURS = 3.5;

const GAME_LENGTH_MS = GAME_LENGTH_HOURS * 3_600_000;

export interface GameWindow {
  /** True when at least one kickoff is inside its window right now. */
  live: boolean;
  /**
   * When the current window closes, ISO, or null when nothing is live.
   *
   * The latest finish among the games in progress, so a one-o'clock slate that
   * overlaps a four-o'clock one reports the later of the two.
   */
  until: string | null;
  /**
   * The next kickoff after now, ISO, or null when none is known.
   *
   * Null on a bye week, out of season, and wherever the fixture list has not
   * been stored — three different things that are the same thing to a caller,
   * which is why this says "no kickoff known" rather than guessing a date.
   */
  next: string | null;
}

const NOTHING: GameWindow = { live: false, until: null, next: null };

/**
 * The window, from whatever kickoffs the caller has.
 *
 * Tolerant of the input on purpose. Callers hand it a `schedule` map, a week
 * of fixture rows or a list of events, and any of those can carry a null or an
 * unparseable kickoff for a game nobody has timed yet. Those are skipped
 * rather than treated as the epoch — a fixture with no time is a fixture this
 * app cannot place, and placing it at 1970 would report every week as over.
 */
export function gameWindowFrom(kickoffs: Iterable<string | null | undefined>, now: Date = new Date()): GameWindow {
  const at = now.getTime();
  if (!Number.isFinite(at)) return NOTHING;

  let until: number | null = null;
  let next: number | null = null;

  for (const raw of kickoffs) {
    if (raw == null) continue;
    const start = Date.parse(raw);
    if (!Number.isFinite(start)) continue;

    const end = start + GAME_LENGTH_MS;
    if (start <= at && at < end) {
      if (until == null || end > until) until = end;
    } else if (start > at) {
      if (next == null || start < next) next = start;
    }
  }

  return {
    live: until != null,
    until: until == null ? null : new Date(until).toISOString(),
    next: next == null ? null : new Date(next).toISOString(),
  };
}
