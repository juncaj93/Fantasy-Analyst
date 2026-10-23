/**
 * The same player, the same number, on every screen (23 October 2026).
 *
 * The point of the "numbers agree" round. One seeded league, read through the
 * real endpoints of Team, Matchup, Waivers, Trades and Compare, and every
 * player's number put side by side. Before the round a Questionable starter
 * read full value on Team, 0.616 of it on Matchup and 0.8 of it on Waivers and
 * Trades; a Doubtful one read −1 on Compare and 0 on Team.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { DOUBTFUL, HEALTHY, QUESTIONABLE, SLEEPER_ONLY, readEveryScreen, type CrossScreen } from './helpers/crossScreen.ts';

let screens: CrossScreen;
beforeAll(async () => {
  screens = await readEveryScreen();
}, 60_000);

function expectAgree(playerId: string, expected: number): void {
  const n = screens.numbers(playerId);
  expect(n, playerId).toEqual({ team: expected, matchup: expected, waivers: expected, trades: expected, compare: expected });
}

describe('one number per player across Team, Matchup, Waivers, Trades and Compare', () => {
  it('a healthy priced player', () => {
    expectAgree(HEALTHY, 17);
  });

  it('a Questionable player counts at full value everywhere, and keeps his chip', () => {
    expectAgree(QUESTIONABLE, 14);
    const team = [...screens.lineup.starters, ...screens.lineup.bench].find((e: { playerId: string }) => e.playerId === QUESTIONABLE);
    expect(team.statusFlag).toMatch(/^Questionable/);
    const card = screens.matchup.forecast.slots.map((s: { mine: { playerId: string; statusFlag: string | null } | null }) => s.mine).find((p: { playerId: string } | null) => p?.playerId === QUESTIONABLE);
    expect(card.statusFlag).toBe('Q');
  });

  it('a Doubtful player is his number less six, never below zero, everywhere', () => {
    expectAgree(DOUBTFUL, 0);
  });

  it('a Sleeper-only player shows his undocked number everywhere', () => {
    expectAgree(SLEEPER_ONLY, 16);
  });
});
