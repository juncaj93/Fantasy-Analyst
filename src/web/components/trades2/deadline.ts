import type { ScreensOffers } from '../../../core/trades/screensWire.ts';

/**
 * "Deadline Mon Nov 23" (Round 32): the deadline week's last game day,
 * Eastern, while trades are still open. Null once they close, or when the
 * league has no deadline or the date is not known.
 */
export function deadlineChip(deadline: ScreensOffers['deadline'] | undefined): string | null {
  if (!deadline?.closes || deadline.weeksLeft == null || deadline.weeksLeft <= 0) return null;
  const at = Date.parse(deadline.closes);
  if (!Number.isFinite(at)) return null;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(at))
    .replace(/,/g, '');
  return `Deadline ${day}`;
}
