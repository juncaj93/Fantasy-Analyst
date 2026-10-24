/**
 * The Rams are `LA` in the fixture file and `LAR` everywhere else (23 October 2026).
 *
 * Found by the "numbers agree" probe on Alex's week 7: Tyler Higbee read 8.19
 * on Team, Waivers, Trades and Compare and 0 on the Matchup card, because the
 * bye test looked for `LAR` in a list that only said `LA`. Matchup then
 * offered KC Concepcion over him at FLEX for +11% win chance on a 0.5-point gap.
 */

import { describe, expect, it } from 'vitest';
import { byeWeeks, homeByTeam, indoorByTeam, isOnBye, parseSchedule, playingTeams, type ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

/** Week 7 of 2026 as the file writes it: twenty-six teams, the Rams in Las Vegas as `LA`. */
const GAMES: [string, string, string][] = [
  ['PIT', 'NO', 'dome'], ['SF', 'ATL', 'closed'], ['CIN', 'BAL', 'outdoors'], ['TB', 'CAR', 'outdoors'],
  ['NYG', 'HOU', 'closed'], ['IND', 'MIN', 'dome'], ['MIA', 'NYJ', 'outdoors'], ['CLE', 'TEN', 'outdoors'],
  ['DEN', 'ARI', 'closed'], ['GB', 'DET', 'dome'], ['LA', 'LV', 'dome'], ['KC', 'SEA', 'outdoors'],
  ['DAL', 'PHI', 'outdoors'],
];
const CSV = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,home_team,roof',
  ...GAMES.map(([away, home, roof]) => `2026_07_${away}_${home},2026,REG,7,2026-10-25,Sunday,16:25,${away},${home},${roof}`),
  '',
].join('\n');

/** The same week as rows stored before the fix, with `LA` in them. */
const STORED: ScheduleTeamWeek[] = GAMES.flatMap(([away, home, roof]) => [
  { season: '2026', week: 7, team: home, opponent: away, home: true, kickoff: '2026-10-25T20:25:00.000Z', roof },
  { season: '2026', week: 7, team: away, opponent: home, home: false, kickoff: '2026-10-25T20:25:00.000Z', roof },
]) as ScheduleTeamWeek[];

describe('the Rams on the fixture list', () => {
  it('a parsed file names them LAR, home and away', () => {
    const { rows } = parseSchedule(CSV, { season: '2026' });
    const rams = rows.find((r) => r.week === 7 && (r.team === 'LAR' || r.team === 'LA'));
    expect(rams?.team).toBe('LAR');
    expect(rows.find((r) => r.team === 'LV')?.opponent).toBe('LAR');
  });

  it('a Rams player is not on a bye in a week the Rams play, from a fresh parse or from stored LA rows', () => {
    for (const fixtures of [parseSchedule(CSV, { season: '2026' }).rows, STORED]) {
      const playing = playingTeams(fixtures);
      expect(isOnBye('LAR', playing)).toBe(false);
      expect(byeWeeks(fixtures, 'LAR', { from: 7, to: 7 })).toEqual([]);
      expect(homeByTeam(fixtures).get('LAR')).toBe(false);
      expect(indoorByTeam(fixtures).get('LAR')).toBe(true);
      /* A team with no game that week still is. */
      expect(isOnBye('WAS', playing)).toBe(true);
    }
  });
});
