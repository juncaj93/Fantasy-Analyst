/**
 * Round 32, audit finding 10: checking an offer Alex received took 10 to 11
 * taps (Trades, Check, pick the team, then each player through a list). Check
 * now takes typed names for both sides, and an offer card opens Check with
 * both sides filled. Part C: a quiet "Deadline Mon Nov 23" chip while trades
 * are open.
 *
 * The verdict is untouched: the same request and the same shared function.
 */

import { describe, expect, it } from 'vitest';
import {
  addToCheck,
  CHECK_MAX_SIDE,
  checkFromOffer,
  checkMatches,
  checkPool,
  type CheckState,
} from '../src/web/components/trades2/checkSearch.ts';
import { deadlineChip } from '../src/web/components/trades2/deadline.ts';
import { TradeScreensService } from '../src/server/services/tradeScreensService.ts';
import type { ScreensTeams } from '../src/core/trades/screensWire.ts';
import { createTestDb } from './helpers/db.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';

const TEAMS: ScreensTeams = {
  league: { id: 'L', name: "Tony's Pizza" },
  teams: [
    {
      rosterId: 1,
      label: 'Alex',
      isMine: true,
      players: [
        { playerId: 'a1', name: "Ja'Marr Chase", position: 'WR', team: 'CIN' },
        { playerId: 'a2', name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
        { playerId: 'a3', name: 'Sam LaPorta', position: 'TE', team: 'DET' },
        { playerId: 'a4', name: 'Rhys Donnelly', position: 'QB', team: 'NYJ' },
      ],
    },
    {
      rosterId: 2,
      label: 'Dermot',
      isMine: false,
      players: [
        { playerId: 'd1', name: 'Amon-Ra St. Brown', position: 'WR', team: 'DET' },
        { playerId: 'd2', name: 'Brian Robinson', position: 'RB', team: 'WAS' },
      ],
    },
    {
      rosterId: 3,
      label: 'Priya',
      isMine: false,
      players: [{ playerId: 'p1', name: 'Breece Hall', position: 'RB', team: 'NYJ' }],
    },
  ],
};

const EMPTY: CheckState = { partnerId: null, give: [], get: [] };
const pool = checkPool(TEAMS);
const find = (text: string, state: CheckState = EMPTY) => checkMatches(pool, text, state);

describe('typed names, both sides, no team picked first', () => {
  it('finds a player by the app’s one search: apostrophes, hyphens and a typo', () => {
    expect(find('jamarr')[0]?.playerId).toBe('a1');
    expect(find('amon ra')[0]?.playerId).toBe('d1');
    expect(find('robnson').map((p) => p.playerId).sort()).toEqual(['a2', 'd2']);
  });

  it('lists nothing under two letters', () => {
    expect(find('b')).toEqual([]);
  });

  it('your player goes to "You give"; theirs to "You get", and his manager becomes the partner', () => {
    let state = addToCheck(EMPTY, find('bijan')[0]!);
    expect(state).toEqual({ partnerId: null, give: ['a2'], get: [] });
    state = addToCheck(state, find('st brown')[0]!);
    expect(state).toEqual({ partnerId: 2, give: ['a2'], get: ['d1'] });
  });

  it('a 1-for-1 received offer is two picks: a name, then the other name', () => {
    const one = addToCheck(EMPTY, find('chase')[0]!);
    const two = addToCheck(one, find('breece')[0]!);
    expect(two).toEqual({ partnerId: 3, give: ['a1'], get: ['p1'] });
  });

  it('another manager’s player starts a new "You get" with him, as changing the team always has', () => {
    const withDermot: CheckState = { partnerId: 2, give: ['a1'], get: ['d1', 'd2'] };
    expect(addToCheck(withDermot, find('breece')[0]!)).toEqual({ partnerId: 3, give: ['a1'], get: ['p1'] });
  });

  it('leaves out players already in the trade, and a full side', () => {
    const state: CheckState = { partnerId: 2, give: ['a1'], get: ['d1'] };
    expect(find('chase', state)).toEqual([]);
    expect(find('st brown', state)).toEqual([]);
    const full: CheckState = { partnerId: 2, give: ['a1', 'a2', 'a3'], get: [] };
    expect(full.give.length).toBe(CHECK_MAX_SIDE);
    expect(find('donnelly', full)).toEqual([]);
    expect(addToCheck(full, pool.find((p) => p.playerId === 'a4')!)).toBe(full);
  });
});

describe('"Check this offer" fills both sides', () => {
  it('takes the partner and both sides from the card', () => {
    const offer = { partner: { rosterId: 2 }, give: [{ playerId: 'a1' }, { playerId: 'a3' }], get: [{ playerId: 'd1' }] };
    expect(checkFromOffer(offer)).toEqual({ partnerId: 2, give: ['a1', 'a3'], get: ['d1'] });
  });

  it('on the preview league, the card’s trade checks to the same verdict word the card shows', async () => {
    const service = new TradeScreensService(null as never, null as never, 'normal');
    const offers = await service.offers(null);
    expect(offers.offers.length).toBeGreaterThan(0);
    for (const offer of offers.offers) {
      const state = checkFromOffer(offer);
      const verdict = await service.verdict({ partner: state.partnerId!, give: state.give, get: state.get });
      expect(verdict.summary?.word, offer.id).toBe(offer.label);
    }
  });
});

describe('the deadline chip', () => {
  it('reads the deadline week’s last game day, Eastern: Monday night is Mon Nov 23', () => {
    expect(deadlineChip({ week: 11, weeksLeft: 1, closes: '2026-11-24T01:15:00.000Z' })).toBe('Deadline Mon Nov 23');
  });

  it('is hidden once trades close, with no deadline, or with no date', () => {
    expect(deadlineChip({ week: 11, weeksLeft: 0, closes: '2026-11-24T01:15:00.000Z' })).toBeNull();
    expect(deadlineChip({ week: null, weeksLeft: null, closes: null })).toBeNull();
    expect(deadlineChip({ week: 11, weeksLeft: 2 })).toBeNull();
    expect(deadlineChip(null)).toBeNull();
  });
});

describe('the deadline date comes from the stored schedule', () => {
  it('is week 11’s last kickoff while trades are open, and nothing once they close', async () => {
    const db = await createTestDb();
    const row = (team: string, opponent: string, kickoff: string) => ({ season: '2026', week: 11, team, opponent, home: true, kickoff, roof: null });
    await new NflScheduleRepo(db).save(
      [row('CIN', 'PIT', '2026-11-22T18:00:00.000Z'), row('PIT', 'CIN', '2026-11-22T18:00:00.000Z'), row('DAL', 'NYG', '2026-11-24T01:15:00.000Z')],
      new Date().toISOString(),
    );
    const service = new TradeScreensService(db, null as never, null) as unknown as {
      deadline: (season: string, h: { deadlineWeek: number | null; weeksToDeadline: number | null }) => Promise<{ closes?: string | null }>;
    };
    const open = await service.deadline('2026', { deadlineWeek: 11, weeksToDeadline: 1 });
    expect(open.closes).toBe('2026-11-24T01:15:00.000Z');
    expect(deadlineChip({ week: 11, weeksLeft: 1, ...open })).toBe('Deadline Mon Nov 23');
    const closed = await service.deadline('2026', { deadlineWeek: 11, weeksToDeadline: 0 });
    expect(closed.closes).toBeNull();
  });
});
