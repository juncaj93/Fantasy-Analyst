/**
 * A bench player is worth what he is worth to hold, not what he projects on Sunday.
 *
 * `held.ts` used to fill `restOfSeasonValue` and `fourWeekValue` with the same
 * number — `evaluation.score`, this week's projection — under two field names
 * that promise a season and a month. The consequence, measured on production on
 * 16 September 2026: a receiver taken 39.8th overall, questionable for week 2,
 * was the named drop in three of the four suggested waiver claims, because his
 * week projected near zero and therefore his standing worth was near zero.
 *
 * These pin the shape Alex asked for rather than today's arithmetic: preseason
 * carrying the early weeks, in-season evidence taking over as it accumulates,
 * and one bad afternoon never being enough to empty a player out.
 */

import { describe, expect, it } from 'vitest';
import {
  durableValue,
  scoreUsageWeek,
  DURABLE_FULL_WEIGHT_GAMES,
  RECENT_WINDOW_GAMES,
} from '../src/core/roster/durableValue.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';

/** This league: half PPR, six-point passing touchdowns. */
const PROFILE = buildScoringProfile({
  rec: 0.5,
  rec_yd: 0.1,
  rush_yd: 0.1,
  pass_yd: 0.04,
  pass_td: 6,
  rush_td: 6,
  rec_td: 6,
  pass_int: -2,
  fum_lost: -2,
});

function week(no: number, over: Partial<UsageWeek> = {}): UsageWeek {
  return {
    week: no,
    seasonType: 'REG',
    passAttempts: 0,
    carries: 0,
    targets: 5,
    receptions: 3,
    targetShare: 0.15,
    wopr: 0.3,
    recYards: 40,
    recTds: 0,
    ...over,
  };
}

describe('scoring a stored week under this league', () => {
  it('reads the league profile rather than a standard table', () => {
    const line = week(1, { receptions: 6, recYards: 80, recTds: 1 });
    /* 6 * 0.5 + 80 * 0.1 + 6 = 17 */
    expect(scoreUsageWeek(line, PROFILE)).toBeCloseTo(17, 2);
  });

  it('pays six for a passing touchdown in a league that pays six', () => {
    const line = week(1, { receptions: null, recYards: null, passYards: 250, passTds: 2 });
    /* 250 * 0.04 + 2 * 6 = 22 */
    expect(scoreUsageWeek(line, PROFILE)).toBeCloseTo(22, 2);
  });

  it('returns null for a row with nothing scoreable on it, rather than zero', () => {
    const empty = week(1, { receptions: null, recYards: null, recTds: null });
    expect(scoreUsageWeek(empty, PROFILE)).toBeNull();
  });
});

describe('early in the season, preseason carries it', () => {
  it('uses the capture divided by a healthy starter’s games when nothing has been played', () => {
    const value = durableValue({
      preseasonSeasonPoints: 160.1,
      weeks: [],
      profile: PROFILE,
      weekProjection: 0.4,
    });

    expect(value.gamesPlayed).toBe(0);
    expect(value.inSeasonWeight).toBe(0);
    expect(value.restOfSeason).toBeCloseTo(160.1 / EXPECTED_GAMES, 1);
    expect(value.basis).toBe('preseason');
  });

  it('does not let one bad afternoon empty out a notable pick', () => {
    const preseason = 160.1;
    const perGame = preseason / EXPECTED_GAMES;

    const value = durableValue({
      preseasonSeasonPoints: preseason,
      weeks: [week(1, { receptions: 1, recYards: 8, recTds: 0 })],
      profile: PROFILE,
      /* Questionable, so the lineup optimiser has him at almost nothing. */
      weekProjection: 0.4,
    });

    /*
     * The number that matters is not its exact value but where it sits: well
     * clear of the bad week and of the week projection, and still most of the
     * way to the August expectation. The old behaviour put it at 0.4.
     */
    expect(value.restOfSeason!).toBeGreaterThan(perGame * 0.7);
    expect(value.restOfSeason!).toBeLessThan(perGame);
    expect(value.restOfSeason!).toBeGreaterThan(5);
  });

  it('weights one game as a quarter of a four-game form reading', () => {
    const value = durableValue({
      preseasonSeasonPoints: 160.1,
      weeks: [week(1, { receptions: 1, recYards: 8 })],
      profile: PROFILE,
      weekProjection: 0.4,
    });

    /* The faster half still leans preseason, because three of its four weeks
     * do not exist yet. */
    expect(value.fourWeek!).toBeGreaterThan(value.inSeasonPerGame!);
  });
});

describe('as the season accumulates, in-season takes over', () => {
  const preseason = 160.1;

  function afterGames(n: number, points: { receptions: number; recYards: number }) {
    return durableValue({
      preseasonSeasonPoints: preseason,
      weeks: Array.from({ length: n }, (_, i) => week(i + 1, points)),
      profile: PROFILE,
      weekProjection: 9,
    });
  }

  it('moves monotonically towards what he is actually producing', () => {
    const poor = { receptions: 1, recYards: 8 };
    const values = [1, 2, 3, 4, 5, 6].map((n) => afterGames(n, poor).restOfSeason!);

    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  it('is entirely in-season once the full-weight game count is reached', () => {
    const value = afterGames(DURABLE_FULL_WEIGHT_GAMES, { receptions: 1, recYards: 8 });
    expect(value.inSeasonWeight).toBe(1);
    expect(value.restOfSeason).toBeCloseTo(value.inSeasonPerGame!, 2);
  });

  it('credits a player only for games he actually played', () => {
    /* Four stored weeks after eight weeks of season: half a reading, not a full one. */
    const value = durableValue({
      preseasonSeasonPoints: preseason,
      weeks: [week(1), week(2), week(5), week(8)],
      profile: PROFILE,
      weekProjection: 9,
    });
    expect(value.gamesPlayed).toBe(4);
    expect(value.inSeasonWeight).toBeCloseTo(4 / DURABLE_FULL_WEIGHT_GAMES, 3);
  });

  it('reads recent form over the last four games and not the whole season', () => {
    const cold = Array.from({ length: 4 }, (_, i) => week(i + 1, { receptions: 1, recYards: 8 }));
    const hot = Array.from({ length: RECENT_WINDOW_GAMES }, (_, i) =>
      week(i + 5, { receptions: 8, recYards: 110, recTds: 1 }),
    );

    const value = durableValue({
      preseasonSeasonPoints: preseason,
      weeks: [...cold, ...hot],
      profile: PROFILE,
      weekProjection: 9,
    });

    expect(value.fourWeek!).toBeGreaterThan(value.restOfSeason!);
  });
});

describe('what it refuses to invent', () => {
  it('uses in-season alone when the league has no preseason capture for him', () => {
    const value = durableValue({
      preseasonSeasonPoints: null,
      weeks: [week(1, { receptions: 6, recYards: 80 })],
      profile: PROFILE,
      weekProjection: 5.47,
    });

    expect(value.basis).toBe('in_season');
    expect(value.restOfSeason).toBeCloseTo(value.inSeasonPerGame!, 2);
  });

  it('falls back to the week projection when neither source exists at all', () => {
    const value = durableValue({
      preseasonSeasonPoints: null,
      weeks: [],
      profile: PROFILE,
      weekProjection: 5.47,
    });

    expect(value.basis).toBe('week_projection');
    expect(value.restOfSeason).toBe(5.47);
    expect(value.fourWeek).toBe(5.47);
  });

  it('stays null rather than guessing when there is nothing anywhere', () => {
    const value = durableValue({
      preseasonSeasonPoints: null,
      weeks: [],
      profile: PROFILE,
      weekProjection: null,
    });

    expect(value.basis).toBe('unknown');
    expect(value.restOfSeason).toBeNull();
  });

  it('ignores postseason rows, which are not this season’s evidence', () => {
    const value = durableValue({
      preseasonSeasonPoints: 160.1,
      weeks: [week(1, { seasonType: 'POST', receptions: 12, recYards: 200 })],
      profile: PROFILE,
      weekProjection: 9,
    });

    expect(value.gamesPlayed).toBe(0);
    expect(value.basis).toBe('preseason');
  });
});
