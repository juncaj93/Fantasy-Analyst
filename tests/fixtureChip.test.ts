/**
 * Four screens that were saying something untrue, and the chip that was missing.
 *
 * Alex, 15–16 September 2026, from the live app. Each of these is a sentence a
 * reader could read off the screen and be wrong about the app, rather than a
 * number being off:
 *
 *   - the Matchup said "Only 0% of your opponent's starters could be projected"
 *     when the truth was that the opponent had not picked a lineup;
 *   - a lineup row printed Jacksonville at `6.6` and "can't be scored this
 *     week" directly underneath it;
 *   - the Trades board produced nothing and gave no reason, in a week where
 *     the reason was simply that one game has been played;
 *   - and no row said who anybody was playing.
 */

import { describe, expect, it } from 'vitest';
import { buildForecast } from '../src/core/matchup/model.ts';
import { fixtureLabel, fixtureSpoken } from '../src/core/nfl/teams.ts';
import { fixtureOf } from '../src/core/startsit/lineup.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate } from './helpers/startsit.ts';
import { slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const PROFILE = buildScoringProfile({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'BN']);

describe('a fixture is written once, from the point of view of the row it is on', () => {
  it('says vs at home and @ on the road', () => {
    expect(fixtureLabel('BAL', true)).toBe('vs BAL');
    expect(fixtureLabel('BAL', false)).toBe('@ BAL');
  });

  it('names the team without inventing a venue when the side is unknown', () => {
    // "@ BAL" would be a road trip nobody reported. The bare code is true.
    expect(fixtureLabel('BAL', null)).toBe('BAL');
  });

  it('draws nothing at all on a bye', () => {
    expect(fixtureLabel(null, true)).toBeNull();
    expect(fixtureSpoken(null, true)).toBeNull();
  });

  it('speaks it in full for a screen reader, never as an abbreviation', () => {
    expect(fixtureSpoken('BAL', false)).toMatch(/away against .+/i);
    expect(fixtureSpoken('BAL', false)).not.toBe('@ BAL');
  });
});

describe('the chip carries the engine’s own verdict, not a second one', () => {
  const evaluate = (over: Parameters<typeof candidate>[4] = {}) =>
    evaluatePlayer({ ...candidate('wr1', 'Receiver One', 'WR', 12, over), opponent: 'BAL', home: false }, PROFILE);

  it('reports the rating the matchup component already used', () => {
    const evaluation = evaluate();
    const fixture = fixtureOf(evaluation)!;

    expect(fixture.rating).toBe(evaluation.matchup.rating);
    expect(fixture.note).toBe(evaluation.matchup.display);
    expect(fixture.sample).toBe(evaluation.matchup.sample);
  });

  it('says insufficient_data rather than guessing, which is September’s answer', () => {
    /*
     * No defence tendencies were built, because two weeks of football is not
     * enough to describe what a defence gives up to a role. The chip then names
     * the fixture and claims nothing — which is what the screen draws with no
     * colour at all.
     */
    const fixture = fixtureOf(evaluate())!;
    expect(fixture.rating).toBe('insufficient_data');
    expect(fixture.label).toBe('@ BAL');
  });

  it('is absent, rather than empty, when there is no opponent', () => {
    const bye = evaluatePlayer(candidate('wr2', 'Receiver Two', 'WR', 12), PROFILE);
    expect(bye.opponent).toBeNull();
    expect(fixtureOf(bye)).toBeNull();
  });
});

describe('an opponent who has not picked a lineup is told apart from one nobody could price', () => {
  const player = (id: string, side: 'mine' | 'theirs', projection: number | null): MatchupPlayerInput => ({
    playerId: id,
    name: id,
    position: 'WR',
    team: 'CIN',
    opponent: 'BAL',
    slot: 'WR',
    starting: true,
    side,
    projection,
    actual: 0,
    kickoff: '2026-09-20T17:00:00.000Z',
    roleBucket: 'unclassified',
    availability: 'high_confidence_active',
    ruledOut: false,
  });

  const forecast = (players: MatchupPlayerInput[]) =>
    buildForecast({
      leagueId: 'l1',
      season: '2026',
      week: 2,
      matchupId: 1,
      players,
      teams: {
        mine: { rosterId: 1, name: 'Mine', avatar: null, record: null },
        theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: null },
      },
      actualScores: { mine: 0, theirs: 0 },
      slots: slots(['WR', 'WR']),
      now: new Date('2026-09-16T12:00:00.000Z'),
    });

  it('says the opponent has not set a lineup when his side is empty', () => {
    /*
     * The reported defect. `coverage` divided by an empty side and produced 0,
     * which printed as "only 0% of your opponent's starters could be
     * projected" — sending the reader to look for a fault in this app when the
     * gap was in somebody else's team.
     */
    const result = forecast([player('a', 'mine', 12), player('b', 'mine', 11)]);

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toMatch(/opponent has not set a lineup/i);
    expect(result.degradedReason).not.toMatch(/0%/);
  });

  it('still says 0% when the starters are there and none could be priced', () => {
    // The other side of the branch: real starters, no numbers. That sentence
    // was always correct and must survive.
    const result = forecast([
      player('a', 'mine', 12),
      player('b', 'mine', 11),
      player('x', 'theirs', null),
      player('y', 'theirs', null),
    ]);

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toMatch(/0%/);
    expect(result.degradedReason).not.toMatch(/has not set a lineup/i);
  });

  it('tells the reader when it is his own lineup that is empty', () => {
    const result = forecast([player('x', 'theirs', 12), player('y', 'theirs', 11)]);
    expect(result.degradedReason).toMatch(/You have not set a lineup/i);
  });
});

describe('a silent arbitrage lane says which kind of silence it is', () => {
  it('blames the calendar in week 2, because the calendar is what is wrong', async () => {
    /*
     * The one I got wrong twice. A probe of production read the preseason
     * route with keys it does not return, printed "snapshots stored: 0", and I
     * reported buy-low and sell-high as shipped-inert for want of an import.
     * Production had a snapshot all along (154 players, captured 30 August).
     *
     * The real reason the lane is quiet in week 2 is `ARBITRAGE.minGames`: it
     * takes three games to tell a slump from one bad afternoon, and one has
     * been played. That is not a fault, and the screen should say so rather
     * than leaving a reader to guess at a broken feature.
     */
    const { ARBITRAGE, readArbitrage, playedGames } = await import('../src/core/trades/arbitrage.ts');
    const oneGame = [
      {
        week: 1,
        seasonType: 'REG' as const,
        passAttempts: null,
        carries: null,
        targets: 8,
        receptions: 5,
        targetShare: 0.22,
        wopr: 0.3,
        recYards: 40,
        recTds: 0,
      },
    ];

    expect(playedGames(oneGame)).toBe(1);
    expect(ARBITRAGE.minGames).toBe(3);
    // Which is exactly why nothing reads, and why the sentence is about weeks.
    expect(
      readArbitrage({
        playerId: 'p1',
        name: 'One Gamer',
        position: 'WR',
        preseasonPoints: 16 * 12,
        weeks: oneGame,
        signal: null,
      }),
    ).toBeNull();
  });
});
