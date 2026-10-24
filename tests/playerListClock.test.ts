/**
 * Sunday's player-list download at game time, and never two on one Eastern date
 * (24 October 2026).
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
    // Monday 26 October, 5:00 AM EDT; Sunday's ran 11:45 AM EDT.
    expect(dailyPlayerListDue(at('2026-10-26T09:00:00Z'), '2026-10-25T15:45:30Z')).toBe(true);
  });

  it('never twice on one Eastern date', () => {
    // A manual sync at 2:00 AM EDT Tuesday already counts as Tuesday's one.
    expect(dailyPlayerListDue(at('2026-10-27T09:00:00Z'), '2026-10-27T06:00:00Z')).toBe(false);
  });

  it('after 1 November the tick is 4:00 AM EST and still the Eastern date it belongs to', () => {
    // Monday 2 November, 4:00 AM EST; Sunday's ran 11:45 AM EST.
    expect(dailyPlayerListDue(at('2026-11-02T09:00:00Z'), '2026-11-01T16:45:30Z')).toBe(true);
  });
});

describe('Sunday at game time', () => {
  it('nothing before 11:45 AM', () => {
    // 11:40 AM EDT, and 11:00 AM EDT (the 15:00 UTC Sunday tick).
    expect(sundayPlayerListDue(at('2026-10-25T15:40:00Z'), '2026-10-24T09:00:40Z')).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T15:00:00Z'), '2026-10-24T09:00:40Z')).toBe(false);
  });

  it('11:45 AM EDT is 15:45 UTC: it downloads, and 16:45 UTC does not', () => {
    expect(sundayPlayerListDue(at('2026-10-25T15:45:00Z'), '2026-10-24T09:00:40Z')).toBe(true);
    expect(isSundayPlayerListSlot(at('2026-10-25T16:45:00Z'))).toBe(false);
  });

  it('11:45 AM EST is 16:45 UTC after 1 November: it downloads, and 15:45 UTC does not', () => {
    expect(sundayPlayerListDue(at('2026-11-01T16:45:00Z'), '2026-10-31T09:00:40Z')).toBe(true);
    expect(isSundayPlayerListSlot(at('2026-11-01T15:45:00Z'))).toBe(false);
  });

  it('a failed 11:45 AM leaves the 12:15 PM retry due, then 12:30 PM', () => {
    // A failure records no success, so the last one is still Saturday's.
    const saturday = '2026-10-24T09:00:40Z';
    expect(sundayPlayerListDue(at('2026-10-25T16:15:00Z'), saturday)).toBe(true);
    expect(sundayPlayerListDue(at('2026-10-25T16:30:00Z'), saturday)).toBe(true);
  });

  it('three attempts at most: nothing after 12:30 PM, and nothing between the slots', () => {
    const saturday = '2026-10-24T09:00:40Z';
    expect(sundayPlayerListDue(at('2026-10-25T16:35:00Z'), saturday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T16:00:00Z'), saturday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T17:45:00Z'), saturday)).toBe(false);
  });

  it('no attempt after a success the same day', () => {
    // 11:45 AM succeeded; the 12:15 PM and 12:30 PM slots skip.
    const sunday = '2026-10-25T15:45:30Z';
    expect(sundayPlayerListDue(at('2026-10-25T16:15:00Z'), sunday)).toBe(false);
    expect(sundayPlayerListDue(at('2026-10-25T16:30:00Z'), sunday)).toBe(false);
  });

  it('not on a Saturday at the same hour', () => {
    expect(sundayPlayerListDue(at('2026-10-24T15:45:00Z'), '2026-10-23T09:00:40Z')).toBe(false);
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
