/**
 * "Check status": the books pulled his props close to kickoff (Round 33).
 *
 * A player ruled inactive for a 4 PM, Sunday night, Monday or Thursday game is
 * never seen before kickoff: Sleeper's player list is downloaded once a day and
 * the injury report never carries inactives (Round 29 audit, finding 9). The
 * sportsbooks do see it: they take a player's props down when he is ruled out
 * or in doubt. The odds job already records that, as a "gone" marker on every
 * market the books withdrew (`core/vegas/combineProps.ts`), and the screens'
 * props read already loads those rows. This turns them into one quiet warning.
 *
 * The rule, all of it:
 *
 *   - He had props on file this week, and at the newest look every one of his
 *     lines is gone (`pulledAt` is when the last one went). A player who never
 *     had props, or whose props were never posted yet, has no gone marker and
 *     never gets the chip.
 *   - Only from 3 hours before his kickoff until the game starts.
 *   - Not when he is already ruled out (Out, Doubtful, IR, his IR slot) or on a
 *     bye: the screen already says so, louder.
 *
 * It only warns. It never changes his number, his rank or a pick, and the app
 * never acts on it.
 */

/** How long before kickoff the chip may show. */
export const CHECK_STATUS_WINDOW_MS = 3 * 60 * 60 * 1000;

/** The chip's word. */
export const CHECK_STATUS_LABEL = 'Check status';

export interface CheckStatus {
  /** ISO time of the look at which his last line was pulled. */
  pulledAt: string;
}

export interface CheckStatusSource {
  /** From the props read: when his last line went, or absent. */
  propsPulledAt?: string | null;
  kickoff?: string | null;
  ruledOut?: boolean;
  onBye?: boolean;
}

export function checkStatusFor(source: CheckStatusSource, now: number | Date | string): CheckStatus | null {
  const pulledAt = source.propsPulledAt;
  if (!pulledAt || source.ruledOut || source.onBye) return null;
  const kickoff = source.kickoff ? Date.parse(source.kickoff) : Number.NaN;
  const at = typeof now === 'number' ? now : new Date(now).getTime();
  if (!Number.isFinite(kickoff) || !Number.isFinite(at)) return null;
  if (at >= kickoff || at < kickoff - CHECK_STATUS_WINDOW_MS) return null;
  if (!Number.isFinite(Date.parse(pulledAt))) return null;
  return { pulledAt };
}

/** `Props pulled at 3:42 PM`, Eastern, 12-hour clock. */
export function checkStatusReason(status: CheckStatus): string {
  const time = new Date(status.pulledAt).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Props pulled at ${time}`;
}
