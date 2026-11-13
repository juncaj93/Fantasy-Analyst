/**
 * Sunday's player-list download at game time, and never two on one Eastern date
 * (24 October 2026). Moved from 11:45 AM to 12:15 PM in Round 27 (13 November).
 *
 * A fake clock throughout: every instant is written in UTC with the Eastern
 * wall time beside it, on both sides of the change on Sunday 1 November.
 */

import { describe, expect, it } from 'vitest';
import {
  dailyPlayerListDue,
  isSundayPlayerListSlot,
  playerListDownloadedToday,
  sundayPlayerListDue,
} from '../src/core/sleeper/playerListClock.ts';

const at = (iso: string): number => Date.parse(iso);

describe('the daily 09:00 UTC tick', () => {
  it('Saturday is unchanged: it downloads', () => {
    // Saturday 24 October, 5:00 AM EDT; last success Friday 5:00 AM.
    expect(dailyPlayerListDue(at('2026-10-24T09:00:00Z'), '2026-10-23T09:00:40Z')).toBe(true);
  });

  it('Sunday morning does not download', () => {
    // Sunday 25 October, 5:00 AM EDT.
    expect(dailyPlayerListDue(at('2026-10-25T09:00:00Z'), '2026-10-24T09:00:40Z')).toBe(false);
  });

  it('Monday morning after a Sunday download is allowed, about 17 hours later', () => {
    // Monday 26 October, 5:00 AM EDT; Sunday's ran 12:15 PM EDT.
    expect(dailyPlayerListDue(at('2026-10-26T09:00:00Z'), '2026-10-25T16:15:30Z')).toBe(true);
  });

  it('never twice on one Eastern date', () => {
    // A manual sync at 2:00 AM EDT Tuesday already counts as Tuesday's one.
    expect(dailyPlayerListDue(at('2026-10-27T09:00:00Z'), '2026-10-27T06:00:00Z')).toBe(false);
  });

  it('after 1 November the tick is 4:00 AM EST and still the Eastern date it belongs to', () => {
    // Monday 2 November, 4:00 AM EST; Sunday's ran 12:15 PM EST.
    expect(dailyPlayerListDue(at('2026-11-02T09:00:00Z'), '2026-11-01T17:15:30Z')).toBe(true);
  });
});

describe('Sunday at game time (12:15 PM since Round 27)', () => {
  it('nothing before 12:15 PM, and 11:45 AM is no longer a slot', () => {
    // 11:45 AM EST (16:45 UTC) and 11:45 AM EDT (15:45 UTC): the old time.
    expect(isSundayPlayerListSlot(at('2026-11-15T16:45:00Z'))).toBe(false);
    expect(sundayPlayerListDue(at('2026-11-15T16:45:00Z'), '2026-11-14T09:00:40Z')).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T15:45:00Z'), '2026-10-24T09:00:40Z')).toBe(false);
    // 12:10 PM EST, and 11:00 AM EDT (the 15:00 UTC Sunday tick).
    expect(sundayPlayerListDue(at('2026-11-15T17:10:00Z'), '2026-11-14T09:00:40Z')).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T15:00:00Z'), '2026-10-24T09:00:40Z')).toBe(false);
  });

  it('12:15 PM EST is 17:15 UTC: it downloads, and 16:15 UTC does not', () => {
    // Sunday 15 November, this week's slate.
    expect(sundayPlayerListDue(at('2026-11-15T17:15:00Z'), '2026-11-14T09:00:40Z')).toBe(true);
    expect(isSundayPlayerListSlot(at('2026-11-15T16:15:00Z'))).toBe(false);
  });

  it('12:15 PM EDT is 16:15 UTC before November: it downloads, and 17:15 UTC does not', () => {
    expect(sundayPlayerListDue(at('2026-10-25T16:15:00Z'), '2026-10-24T09:00:40Z')).toBe(true);
    expect(isSundayPlayerListSlot(at('2026-10-25T17:15:00Z'))).toBe(false);
  });

  it('a failed 12:15 PM leaves the 12:30 PM retry due, then 12:45 PM, both before the 1 PM lock', () => {
    // A failure records no success, so the last one is still Saturday's.
    const saturday = '2026-11-14T09:00:40Z';
    expect(sundayPlayerListDue(at('2026-11-15T17:30:00Z'), saturday)).toBe(true);
    expect(sundayPlayerListDue(at('2026-11-15T17:45:00Z'), saturday)).toBe(true);
  });

  it('three attempts at most: nothing after 12:45 PM, and nothing between the slots', () => {
    const saturday = '2026-11-14T09:00:40Z';
    expect(sundayPlayerListDue(at('2026-11-15T17:50:00Z'), saturday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-11-15T17:20:00Z'), saturday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-11-15T18:00:00Z'), saturday)).toBe(false);
    // No extra looks for the later games: 3:15 PM and 7:15 PM EST are not slots.
    expect(isSundayPlayerListSlot(at('2026-11-15T20:15:00Z'))).toBe(false);
    expect(isSundayPlayerListSlot(at('2026-11-16T00:15:00Z'))).toBe(false);
  });

  it('one download per Eastern day: no attempt after a success the same day', () => {
    // 12:15 PM succeeded; the 12:30 PM and 12:45 PM slots skip.
    const sunday = '2026-11-15T17:15:30Z';
    expect(sundayPlayerListDue(at('2026-11-15T17:30:00Z'), sunday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-11-15T17:45:00Z'), sunday)).toBe(false);
  });

  it('not on a Saturday at the same hour', () => {
    expect(sundayPlayerListDue(at('2026-11-14T17:15:00Z'), '2026-11-13T09:00:40Z')).toBe(false);
  });
});

describe('the Eastern date of a success', () => {
  it('a download at 9:00 PM EDT Saturday (01:00 UTC Sunday) belongs to Saturday', () => {
    expect(playerListDownloadedToday(at('2026-10-25T15:45:00Z'), '2026-10-25T01:00:00Z')).toBe(false);
  });

  it('an unknown or unreadable last success never blocks', () => {
    expect(playerListDownloadedToday(at('2026-10-25T15:45:00Z'), null)).toBe(false);
    expect(playerListDownloadedToday(at('2026-10-25T15:45:00Z'), 'not a date')).toBe(false);
  });
});
