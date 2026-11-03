/**
 * Alex's 10-point rule on Team (review S2, 3 November 2026).
 *
 * Projected underdog by 10 or more: Ceiling. Favorite by 10 or more: Floor.
 * Anything closer: Balanced. The rule was written (`core/startsit/modeSuggest.ts`)
 * but Team handed it the opponent's players with no position, so none could be
 * seated and it read "0% of the starting slots carry a projection" every week.
 * In this league (six points a passing touchdown) the missing position also
 * refused every opponent player Sleeper's published number.
 *
 * Read through the real lineup route on the trade league (Tony's Pizza
 * Fantasy's shape), with Sleeper's published week stored for the opponent.
 */

import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { MatchupRepo } from '../src/server/repos/matchup.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';
import { opponentSidePlayers } from '../src/server/services/decisionInputs.ts';
import { suggestMode, type SidePlayer } from '../src/core/startsit/modeSuggest.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { createTestDb } from './helpers/db.ts';
import { FETCHED_AT, LEAGUE, POSITIONS, THEIRS, envFor, seed } from './helpers/tradeLeague.ts';

type Json = Record<string, any>;

/** Alex's side in the trade league: QB 20, RB 15 and 7, WR 17, 15, 14, TE 9, FLEX 13 and 12.5. 122.5 in nine slots. */
async function teamRead(opponentPoints: (position: string, points: number) => number): Promise<Json> {
  const db = await createTestDb();
  await seed(db);
  /* The real league pays six for a passing touchdown. */
  const leagues = new LeagueRepo(db);
  const league = (await leagues.getLeague(LEAGUE))!;
  await leagues.upsertLeague({ ...league, scoringSettings: { ...league.scoringSettings, pass_td: 6 } });
  /* This week's pairing, the row Matchup writes: Alex (1) plays Dermot (2). */
  await new MatchupRepo(db).record({
    leagueId: LEAGUE,
    season: '2026',
    week: 5,
    rosterId: 1,
    matchupId: 1,
    opponentRosterId: 2,
    modelVersion: 'matchup-1.0.0',
    at: FETCHED_AT,
    phase: 'pregame',
    winProbability: 0.5,
    projectedFinal: 100,
    actual: 0,
    confidence: 'medium',
    fingerprint: 'f',
  });
  /* Sleeper's published week for Dermot's players; this app buys no lines for his roster. */
  await new SleeperProjectionsRepo(db).save(
    '2026',
    5,
    THEIRS.map(([id, position, points]) => {
      const p = opponentPoints(position, points);
      return { playerId: id, publisher: 'rotowire', points: { pts_std: p, pts_half_ppr: p, pts_ppr: p }, defense: null };
    }),
    FETCHED_AT,
  );
  const sleeper = new SleeperClient({ fetch: async () => new Response('null') });
  const response = await createApp()(new Request(`https://app.test/api/leagues/${LEAGUE}/lineup`), envFor(db, sleeper));
  return response.json();
}

describe('the 10-point rule on Team, through the lineup route', () => {
  it('seats the opponent: his slots carry Sleeper\'s published week', async () => {
    const lineup = await teamRead((_, points) => points);
    const s = lineup.modeSuggestion;
    expect(s.opponent.slotsPriced, s.detail).toBeGreaterThan(0);
    expect(s.opponent.coverage).toBeGreaterThanOrEqual(0.6);
    expect(s.detail).not.toMatch(/carry a projection/);
    expect(s.auto).toBe(true);
  });

  it('favorite by 10 or more: Floor', async () => {
    /* Dermot's published week as seeded: RBs 16, 15, 14, 13, WRs 9, 8, 7, TE 8. Alex well ahead. */
    const lineup = await teamRead((_, points) => points);
    expect(lineup.modeSuggestion.margin).toBeGreaterThanOrEqual(10);
    expect(lineup.modeSuggestion.mode).toBe('floor');
    expect(lineup.mode).toBe('floor');
  });

  it('underdog by 10 or more: Ceiling', async () => {
    const lineup = await teamRead((_, points) => points + 6);
    expect(lineup.modeSuggestion.margin).toBeLessThanOrEqual(-10);
    expect(lineup.modeSuggestion.mode).toBe('ceiling');
  });

  it('closer than 10: Balanced, chosen and not defaulted', async () => {
    const lineup = await teamRead((_, points) => points + 3);
    expect(Math.abs(lineup.modeSuggestion.margin)).toBeLessThan(10);
    expect(lineup.modeSuggestion.mode).toBe('balanced');
    expect(lineup.modeSuggestion.auto).toBe(true);
  });
});

describe('the opponent side as the rule reads it', () => {
  const SHAPE = buildRosterShape(POSITIONS);
  /* Nine slots each (no defence on either roster). */
  const side = (points: number[]): SidePlayer[] =>
    ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'RB', 'WR'].map((position, i) => ({
      playerId: `m${i}`,
      position,
      marketPoints: points[i]!,
    }));
  const opponent = (points: number[]) => {
    const ids = points.map((_, i) => `o${i}`);
    const positions = new Map(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'RB', 'WR'].map((p, i) => [`o${i}`, p] as const));
    return opponentSidePlayers(ids, positions, new Map(points.map((p, i) => [`o${i}`, p] as const)));
  };
  const even = (v: number) => Array.from({ length: 9 }, () => v);

  it('carries each player\'s position, so the slots fill', () => {
    const o = opponent(even(10));
    expect(o.map((p) => p.position)).toEqual(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'RB', 'WR']);
    expect(suggestMode({ mine: side(even(10)), opponent: o, shape: SHAPE }).opponent?.slotsPriced).toBe(9);
  });

  it('margin +30 with both sides fully priced: Floor', () => {
    /* 3 points a slot over 10 slots. */
    const s = suggestMode({ mine: side(even(13)), opponent: opponent(even(10)), shape: SHAPE });
    expect(s.margin).toBeCloseTo(30, 6);
    expect(s.mode).toBe('floor');
  });

  it('margin -12: Ceiling; margin +5: Balanced', () => {
    expect(suggestMode({ mine: side(even(10)), opponent: opponent(even(11.2)), shape: SHAPE }).mode).toBe('ceiling');
    expect(suggestMode({ mine: side(even(10.5)), opponent: opponent(even(10)), shape: SHAPE }).mode).toBe('balanced');
  });

  it('a player with no known position still cannot be seated (the old shape)', () => {
    const blind = opponentSidePlayers(['x'], new Map(), new Map([['x', 20]]));
    expect(blind[0]?.position).toBe('');
  });
});
