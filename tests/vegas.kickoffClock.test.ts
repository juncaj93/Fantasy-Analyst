/**
 * The odds job's schedule, derived from stored kickoffs.
 *
 * ## The report this answers
 *
 * Alex saw Vegas lines update on Sunday and not on Monday. The weekly refresh
 * ran on two fixed clocks, Saturday 23:00 and Sunday 15:00 UTC, and had nothing
 * for a Thursday night, a Monday night, a holiday game on a Wednesday or a
 * Saturday, or a game the league moved. These tests are the cases that list
 * names, each driven from a stored kickoff and nothing else: not one of them
 * mentions a weekday to the code under test.
 *
 * The kickoffs for the week of 5 October 2026 below are the real ones, read
 * from nflverse's `games.csv` on 6 October (Eastern, converted: October is
 * daylight time, so 20:15 is 00:15 UTC the next day).
 */

import { describe, expect, it } from 'vitest';
import {
  CLOCK_TICK_MINUTES,
  KICKOFF_CHECKPOINT_HOURS,
  checkpointPending,
  checkpointsFor,
  gameDueOnClock,
  latestCheckpoint,
  nextPassAfter,
  plannedPasses,
  reconcileKickoff,
  tickFor,
  worstCaseWeeklyEntities,
} from '../src/core/vegas/kickoffClock.ts';
import { buildFetchPlan, type PlannedPlayer } from '../src/core/vegas/plan.ts';
import { BUDGET } from '../src/core/vegas/budget.ts';

const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const M = 60_000;

/** Week 5 of 2026, as published. 15 games, two teams on a bye. */
const THURSDAY_NIGHT = '2026-10-09T00:15:00.000Z'; // TB at DAL, Thu 8:15pm ET
const LONDON = '2026-10-11T13:30:00.000Z'; // PHI at JAX, Sun 9:30am ET
const EARLY = '2026-10-11T17:00:00.000Z'; // eight games, Sun 1:00pm ET
const LATE_A = '2026-10-11T20:05:00.000Z'; // DEN at LAC, 4:05pm ET
const LATE_B = '2026-10-11T20:25:00.000Z'; // DET at ARI and SF at SEA, 4:25pm ET
const SUNDAY_NIGHT = '2026-10-12T00:20:00.000Z'; // BAL at ATL, 8:20pm ET
const MONDAY_NIGHT = '2026-10-13T00:15:00.000Z'; // BUF at LA, Mon 8:15pm ET

const WEEK_5 = [THURSDAY_NIGHT, LONDON, ...Array(8).fill(EARLY), LATE_A, LATE_B, LATE_B, SUNDAY_NIGHT, MONDAY_NIGHT];

describe('a game\'s checkpoints', () => {
  it('are counted back from its own kickoff', () => {
    expect(checkpointsFor(THURSDAY_NIGHT).map((t) => new Date(t).toISOString())).toEqual([
      '2026-10-07T00:15:00.000Z',
      '2026-10-08T00:15:00.000Z',
      '2026-10-08T18:15:00.000Z',
      '2026-10-08T21:15:00.000Z',
      '2026-10-08T22:45:00.000Z',
      '2026-10-08T23:45:00.000Z',
    ]);
  });

  it('are six looks, so a game costs at most six entities a week', () => {
    expect(KICKOFF_CHECKPOINT_HOURS).toHaveLength(6);
    expect(worstCaseWeeklyEntities(10)).toBe(60);
  });

  it('each land in a different row of the staleness table', () => {
    // The point of the ladder is that it is not the staleness table run flat
    // out: 48h is the six-hour row, 24 to 3h the one-hour row, 1.5h and 0.5h
    // the fifteen-minute row.
    expect(KICKOFF_CHECKPOINT_HOURS).toEqual([48, 24, 6, 3, 1.5, 0.5]);
  });

  it('do not exist for a game with no kickoff', () => {
    expect(checkpointsFor(null)).toEqual([]);
    expect(checkpointsFor('not a date')).toEqual([]);
  });

  it('give the newest one that has passed, and nothing before the first', () => {
    expect(latestCheckpoint(THURSDAY_NIGHT, at('2026-10-06T12:00:00Z'))).toBeNull();
    expect(new Date(latestCheckpoint(THURSDAY_NIGHT, at('2026-10-08T20:00:00Z'))!).toISOString()).toBe(
      '2026-10-08T18:15:00.000Z',
    );
  });
});

describe('Thursday night', () => {
  it('is looked at from Tuesday evening, which no weekend clock ever did', () => {
    const passes = plannedPasses([THURSDAY_NIGHT], at('2026-10-06T17:30:00Z'), at('2026-10-09T00:15:00Z'));
    expect(passes.map((p) => p.at)).toEqual([
      '2026-10-07T00:15:00.000Z', // Tue 8:15pm ET
      '2026-10-08T00:15:00.000Z', // Wed 8:15pm ET
      '2026-10-08T18:15:00.000Z',
      '2026-10-08T21:15:00.000Z',
      '2026-10-08T22:45:00.000Z',
      '2026-10-08T23:45:00.000Z',
    ]);
  });

  it('buys lines that are old when the first checkpoint arrives, and not lines bought since', () => {
    const now = at('2026-10-07T00:20:00Z'); // just after the 48-hour mark
    const old = { kickoff: THURSDAY_NIGHT, lastFetchedAt: at('2026-10-06T12:00:00Z') };
    expect(gameDueOnClock(old, now)).toEqual({ due: true, reason: 'checkpoint passed since the last fetch' });

    const fresh = { kickoff: THURSDAY_NIGHT, lastFetchedAt: at('2026-10-07T00:10:00Z') };
    // Bought at 00:10 is before the 00:15 checkpoint, but only five minutes
    // old: under the six-hour wait for a game this far out, so not bought again.
    expect(gameDueOnClock(fresh, now)).toEqual({ due: false, reason: 'under the staleness wait' });

    const since = { kickoff: THURSDAY_NIGHT, lastFetchedAt: at('2026-10-07T00:18:00Z') };
    expect(gameDueOnClock(since, now).reason).toBe('already fetched since the last checkpoint');
  });
});

describe('Monday night', () => {
  it('has passes on the Monday itself, which is the report', () => {
    const passes = plannedPasses([MONDAY_NIGHT], at('2026-10-12T01:00:00Z'), at('2026-10-13T00:15:00Z'));
    expect(passes.map((p) => p.at)).toEqual([
      '2026-10-12T18:15:00.000Z', // Mon 2:15pm ET
      '2026-10-12T21:15:00.000Z',
      '2026-10-12T22:45:00.000Z',
      '2026-10-12T23:45:00.000Z',
    ]);
  });

  it('is due at its half-hour checkpoint and then never again once it has started', () => {
    const lastLook = at('2026-10-12T23:46:00Z');
    expect(gameDueOnClock({ kickoff: MONDAY_NIGHT, lastFetchedAt: at('2026-10-12T22:50:00Z') }, lastLook).due).toBe(true);
    const after = at('2026-10-13T00:20:00Z');
    expect(gameDueOnClock({ kickoff: MONDAY_NIGHT, lastFetchedAt: at('2026-10-12T22:50:00Z') }, after)).toEqual({
      due: false,
      reason: 'kicked off',
    });
  });
});

describe('a holiday game on a Wednesday or a Saturday', () => {
  // Nothing below knows what day it is. Those are the weekdays the old clocks
  // would have missed one of, so they are the ones worth saying out loud.
  const WEDNESDAY_NIGHT = '2026-12-24T01:00:00.000Z'; // Wed 23 Dec, 8:00pm ET
  const SATURDAY_AFTERNOON = '2026-12-19T21:30:00.000Z'; // Sat 19 Dec, 4:30pm ET

  it('get the same six looks as any other game', () => {
    for (const kickoff of [WEDNESDAY_NIGHT, SATURDAY_AFTERNOON]) {
      const passes = plannedPasses([kickoff], at(kickoff) - 3 * 24 * H, at(kickoff));
      expect(passes).toHaveLength(6);
    }
  });

  it('start from the right day', () => {
    const wednesday = plannedPasses([WEDNESDAY_NIGHT], at('2026-12-20T00:00:00Z'), at(WEDNESDAY_NIGHT));
    // 48 hours before Wednesday 8pm ET is Monday 8pm ET.
    expect(wednesday[0]!.at).toBe('2026-12-22T01:00:00.000Z');

    const saturday = plannedPasses([SATURDAY_AFTERNOON], at('2026-12-15T00:00:00Z'), at(SATURDAY_AFTERNOON));
    // 48 hours before Saturday 4:30pm ET is Thursday 4:30pm ET.
    expect(saturday[0]!.at).toBe('2026-12-17T21:30:00.000Z');
  });

  it('are due in the hours before them, on the Saturday and on the Wednesday', () => {
    const lastFetch = at('2026-12-18T12:00:00Z');
    expect(gameDueOnClock({ kickoff: SATURDAY_AFTERNOON, lastFetchedAt: lastFetch }, at('2026-12-19T15:35:00Z')).due).toBe(true);
    expect(
      gameDueOnClock({ kickoff: WEDNESDAY_NIGHT, lastFetchedAt: at('2026-12-23T00:00:00Z') }, at('2026-12-23T19:05:00Z')).due,
    ).toBe(true);
  });
});

describe('a flexed game', () => {
  // The league moves Baltimore at Atlanta out of Sunday night into the 4:25
  // window. The schedule file moves first; the provider's event row still has
  // the old time until something buys the game again.
  const OLD = SUNDAY_NIGHT;
  const NEW = LATE_B;
  const fixtures = [NEW, MONDAY_NIGHT]; // the team's stored kickoffs now

  it('takes its kickoff from the schedule, not from the stale event', () => {
    expect(reconcileKickoff(OLD, fixtures, at('2026-10-09T12:00:00Z'))).toBe(NEW);
  });

  it('moves its checkpoints with it', () => {
    const oldPasses = plannedPasses([OLD], at('2026-10-09T00:00:00Z'), at('2026-10-13T00:00:00Z')).map((p) => p.at);
    const newPasses = plannedPasses([NEW], at('2026-10-09T00:00:00Z'), at('2026-10-13T00:00:00Z')).map((p) => p.at);
    expect(newPasses).not.toEqual(oldPasses);
    expect(newPasses.at(-1)).toBe('2026-10-11T19:55:00.000Z'); // 30 min before 4:25pm ET
  });

  it('is owed a look straight away when the move puts a checkpoint behind it', () => {
    // Flexed about four hours earlier. At 15:00 UTC the new time's six-hour
    // mark (14:25) has passed and the old time's (18:20) has not, and the lines
    // were last bought at 10:00. Under the stale time nothing would be owed.
    const now = at('2026-10-11T15:00:00Z');
    const lastFetchedAt = at('2026-10-11T10:00:00Z');
    expect(gameDueOnClock({ kickoff: NEW, lastFetchedAt }, now)).toEqual({
      due: true,
      reason: 'checkpoint passed since the last fetch',
    });
    expect(gameDueOnClock({ kickoff: OLD, lastFetchedAt }, now).due).toBe(false);
  });

  it('is not bought at the old time\'s checkpoints once it has moved later', () => {
    // Moved from Sunday 1:00pm to Monday night. At 11:05 UTC Sunday the old
    // time's six-hour mark has passed; the new time's has not.
    const now = at('2026-10-11T11:05:00Z');
    const lastFetch = at('2026-10-11T09:00:00Z');
    expect(gameDueOnClock({ kickoff: EARLY, lastFetchedAt: lastFetch }, now).due).toBe(true);
    expect(gameDueOnClock({ kickoff: MONDAY_NIGHT, lastFetchedAt: lastFetch }, now).due).toBe(false);
  });

  it('keeps the provider\'s time once the game has started by its own clock', () => {
    // The schedule\'s next fixture for the team is next week\'s game, and must
    // not be mistaken for this one.
    const now = at('2026-10-11T18:00:00Z');
    expect(reconcileKickoff(EARLY, ['2026-10-18T17:00:00.000Z'], now)).toBe(EARLY);
  });

  it('keeps the provider\'s time when no stored fixture is anywhere near it', () => {
    expect(reconcileKickoff(EARLY, ['2026-10-25T17:00:00.000Z'], at('2026-10-09T00:00:00Z'))).toBe(EARLY);
  });

  it('uses the schedule when the event has no kickoff at all', () => {
    expect(reconcileKickoff(null, ['2026-10-04T17:00:00.000Z', EARLY], at('2026-10-09T00:00:00Z'))).toBe(EARLY);
  });
});

describe('a bye-heavy week', () => {
  // Four games, six teams idle. Fewer kickoffs, so fewer passes, and nothing
  // for a team with no game: a bye is the absence of a kickoff, not a case.
  const SPARSE = [EARLY, EARLY, LATE_B, MONDAY_NIGHT];

  it('has proportionally fewer passes', () => {
    const sparse = plannedPasses(SPARSE, at('2026-10-06T17:30:00Z'), at('2026-10-13T00:15:00Z'));
    const full = plannedPasses(WEEK_5, at('2026-10-06T17:30:00Z'), at('2026-10-13T00:15:00Z'));
    expect(sparse.length).toBeLessThan(full.length);
    // Three distinct slots, six looks each.
    expect(sparse).toHaveLength(18);
  });

  it('puts two games in the same slot into one pass, not two', () => {
    const passes = plannedPasses(SPARSE, at('2026-10-06T17:30:00Z'), at('2026-10-13T00:15:00Z'));
    const sixHour = passes.find((p) => p.at === '2026-10-11T11:00:00.000Z');
    expect(sixHour?.games.filter((g) => g.kickoff === EARLY)).toHaveLength(2);
  });

  it('is entirely idle when there is nothing to play', () => {
    expect(plannedPasses([], at('2026-10-06T17:30:00Z'), at('2026-10-13T00:15:00Z'))).toEqual([]);
    expect(nextPassAfter([], at('2026-10-06T17:30:00Z'))).toBeNull();
  });
});

describe('every game has kicked off', () => {
  const NOW = at('2026-10-13T03:00:00Z'); // after Monday night

  it('buys nothing, whatever the lines\' age', () => {
    for (const kickoff of WEEK_5) {
      expect(gameDueOnClock({ kickoff, lastFetchedAt: at('2026-10-01T00:00:00Z') }, NOW)).toEqual({
        due: false,
        reason: 'kicked off',
      });
    }
  });

  it('buys nothing even for a game that was never fetched', () => {
    expect(gameDueOnClock({ kickoff: MONDAY_NIGHT, lastFetchedAt: null }, NOW).due).toBe(false);
  });

  it('plans nothing, so the job does nothing', () => {
    const plan = buildFetchPlan(
      WEEK_5.map((kickoff, i): PlannedPlayer => ({
        playerId: `p${i}`,
        position: 'WR',
        eventId: `e${i}`,
        kickoff,
        starter: true,
        status: null,
        contested: true,
        ageMinutes: 60 * 24,
      })),
      { now: NOW, thresholdMinutes: () => 15, kickoffClock: true },
    );
    expect(plan.events).toEqual([]);
    expect(plan.estimatedEntities).toBe(0);
  });

  it('has no pass left to wake for, and nothing pending', () => {
    expect(nextPassAfter(WEEK_5, NOW)).toBeNull();
    expect(checkpointPending(WEEK_5, '2026-10-12T00:00:00Z', NOW)).toBe(false);
    expect(checkpointPending(WEEK_5, null, NOW)).toBe(false);
  });
});

describe('a game that was never fetched', () => {
  it('is always fetched, even a week out, before any checkpoint', () => {
    expect(gameDueOnClock({ kickoff: MONDAY_NIGHT, lastFetchedAt: null }, at('2026-10-06T12:00:00Z'))).toEqual({
      due: true,
      reason: 'never fetched',
    });
  });

  it('is fetched when its kickoff is not known either', () => {
    expect(gameDueOnClock({ kickoff: null, lastFetchedAt: null }, at('2026-10-06T12:00:00Z')).due).toBe(true);
  });

  it('is planned even when the planner would otherwise call everything fresh', () => {
    const plan = buildFetchPlan(
      [
        {
          playerId: 'new',
          position: 'RB',
          eventId: 'e-new',
          kickoff: MONDAY_NIGHT,
          starter: true,
          status: null,
          contested: false,
          ageMinutes: null,
        },
      ],
      { now: at('2026-10-06T12:00:00Z'), thresholdMinutes: () => 360, kickoffClock: true },
    );
    expect(plan.events.map((e) => e.eventId)).toEqual(['e-new']);
  });

  it('is left alone afterwards, when its kickoff is unknown and it has lines', () => {
    expect(gameDueOnClock({ kickoff: null, lastFetchedAt: at('2026-10-06T00:00:00Z') }, at('2026-10-06T12:00:00Z')).due).toBe(false);
  });
});

describe('the planner, with and without the clock', () => {
  const player = (kickoff: string, ageMinutes: number | null): PlannedPlayer => ({
    playerId: 'p',
    position: 'WR',
    eventId: 'e',
    kickoff,
    starter: true,
    status: null,
    contested: true,
    ageMinutes,
  });

  it('is unchanged when the clock is not asked for', () => {
    // 90 minutes to kickoff, lines 20 minutes old, the table says 15: due. With
    // no clock option the pass is exactly what it was.
    const now = at('2026-10-11T15:30:00Z');
    const plan = buildFetchPlan([player(EARLY, 20)], { now, thresholdMinutes: () => 15 });
    expect(plan.events).toHaveLength(1);
  });

  it('skips a game with no new checkpoint, however old the lines are by the table', () => {
    // Four hours to kickoff: the table says an hour is old, so the lines (two
    // hours) are stale by it, but the 3-hour checkpoint was at 14:00 and they
    // were bought at 14:30. Nothing new has happened.
    const now = at('2026-10-11T13:00:00Z');
    const plan = buildFetchPlan([player(EARLY, 90)], { now, thresholdMinutes: () => 60, kickoffClock: true });
    expect(plan.events).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('kickoff clock');
  });

  it('buys it when the checkpoint has passed since', () => {
    const now = at('2026-10-11T14:05:00Z');
    const plan = buildFetchPlan([player(EARLY, 180)], { now, thresholdMinutes: () => 60, kickoffClock: true });
    expect(plan.events).toHaveLength(1);
  });
});

describe('the gate', () => {
  it('rounds a checkpoint up to the tick that first sees it', () => {
    expect(CLOCK_TICK_MINUTES).toBe(5);
    expect(new Date(tickFor(at('2026-10-11T19:57:00Z'))).toISOString()).toBe('2026-10-11T20:00:00.000Z');
    expect(new Date(tickFor(at('2026-10-11T20:00:00Z'))).toISOString()).toBe('2026-10-11T20:00:00.000Z');
  });

  it('sleeps until the next checkpoint of any game', () => {
    const next = nextPassAfter(WEEK_5, at('2026-10-06T17:30:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-10-07T00:15:00.000Z');
  });

  it('has a checkpoint pending only if one fell after the last one processed', () => {
    const kickoffs = [THURSDAY_NIGHT];
    expect(checkpointPending(kickoffs, '2026-10-07T00:20:00Z', at('2026-10-07T12:00:00Z'))).toBe(false);
    expect(checkpointPending(kickoffs, '2026-10-07T00:20:00Z', at('2026-10-08T00:16:00Z'))).toBe(true);
  });

  it('treats an unknown mark as "look now" for any game still to be played', () => {
    expect(checkpointPending([THURSDAY_NIGHT], null, at('2026-10-06T12:00:00Z'))).toBe(true);
    expect(checkpointPending([THURSDAY_NIGHT], 'garbage', at('2026-10-06T12:00:00Z'))).toBe(true);
  });
});

describe('the week of 5 October 2026, end to end', () => {
  const FROM = at('2026-10-06T17:30:00Z');
  const TO = at('2026-10-13T00:15:00Z');
  const passes = plannedPasses(WEEK_5, FROM, TO);

  it('has a pass for every kickoff slot the league plays, Thursday and Monday included', () => {
    const slots = new Set(passes.flatMap((p) => p.games.map((g) => g.kickoff)));
    expect(slots).toEqual(new Set([THURSDAY_NIGHT, LONDON, EARLY, LATE_A, LATE_B, SUNDAY_NIGHT, MONDAY_NIGHT]));
  });

  it('is seven slots and six looks, so forty-two passes, none of them on a fixed weekday', () => {
    expect(passes).toHaveLength(42);
  });

  it('fires at no instant the old two clocks would have', () => {
    // Saturday 23:00 UTC and Sunday 15:00 UTC.
    const instants = new Set(passes.map((p) => p.at));
    expect(instants.has('2026-10-10T23:00:00.000Z')).toBe(false);
    expect(instants.has('2026-10-11T15:00:00.000Z')).toBe(false);
  });

  it('costs at most 60 entities in a week for a roster that spans ten of its games', () => {
    // The roster the stored events show on 6 October: Tampa Bay on Thursday,
    // six of the 1:00pm games, Chargers, Lions and Falcons. Ten games.
    expect(worstCaseWeeklyEntities(10)).toBe(60);
  });

  it('stays far inside the month\'s allowance with a person\'s own taps added', () => {
    const rosterGames = 12; // the planner\'s own cap on one pass
    const weeksPerMonth = 4.35;
    const clock = worstCaseWeeklyEntities(rosterGames) * weeksPerMonth;
    const discovery = 12 * weeksPerMonth; // every covered team asked about once a week
    const manualTaps = 100; // the last full month of taps was 255, mostly one defect
    const month = Math.ceil(clock + discovery + manualTaps);
    expect(month).toBeLessThan(BUDGET.monthlyEntities * BUDGET.cautionAt);
    expect(month / BUDGET.monthlyEntities).toBeLessThan(0.2);
  });
});

describe('time arithmetic', () => {
  it('has no five-minute tick between a checkpoint and the half-hour mark that skips a game', () => {
    // A kickoff on a :05 or :25 boundary still lands on a tick, because every
    // checkpoint is a whole number of half hours from it.
    for (const kickoff of [LATE_A, LATE_B, THURSDAY_NIGHT, SUNDAY_NIGHT]) {
      for (const checkpoint of checkpointsFor(kickoff)) expect(checkpoint % (5 * M)).toBe(0);
    }
  });
});
