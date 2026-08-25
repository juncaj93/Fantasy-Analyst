/**
 * The forward outlook: the first thing in this app to read the stored schedule.
 *
 * What is being protected here is the honesty of the anchor. A future week is
 * either priced, or measured from an opponent's own season, or unrated — and
 * the three must never be presented as the same thing, because the whole reason
 * this module exists is that nobody has priced week 15 in October.
 */

import { describe, expect, it } from 'vitest';
import { dstOutlook, teamFormFromGames, forwardWeeks, DST_OUTLOOK } from '../src/core/dst/outlook.ts';
import { outlookDst } from '../src/core/startsit/dstProjection.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING, DST_SCORING_CUSTOM } from '../src/core/demo/fixtures/dst.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

const SCORING = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS).dst;
const UNREADABLE = buildScoringProfile(DST_SCORING_CUSTOM as Record<string, number>, DST_ROSTER_POSITIONS).dst;

function week(w: number, opponent: string | null, home = true): ScheduleTeamWeek {
  return { season: '2026', week: w, team: 'BUF', opponent, home, kickoff: null, roof: null };
}

/** BUF plays weeks 10-13 with a bye in 12. */
const SCHEDULE = [week(10, 'NYJ'), week(11, 'MIA', false), week(12, null), week(13, 'NE')];

const FORM = teamFormFromGames([
  ...Array.from({ length: 4 }, () => ({ team: 'NYJ', impliedTotal: 17 })),
  ...Array.from({ length: 4 }, () => ({ team: 'MIA', impliedTotal: 27 })),
  ...Array.from({ length: 4 }, () => ({ team: 'NE', impliedTotal: 20 })),
]);

describe('outlookDst is the weekly model over a different anchor', () => {
  it('never claims high confidence, however good the league scoring is', () => {
    const read = outlookDst({ opponentImpliedTotal: 17, scoring: SCORING });

    expect(read.points).not.toBeNull();
    expect(read.confidence).not.toBe('high');
    expect(read.reasons.join(' ')).toMatch(/an outlook, not a projection/);
  });

  it('omits the game-script residual rather than pricing it at pick’em', () => {
    const read = outlookDst({ opponentImpliedTotal: 21, scoring: SCORING });

    expect(read.components.some((c) => c.key === 'game_script')).toBe(false);
  });

  it('is still monotone in the anchor', () => {
    const soft = outlookDst({ opponentImpliedTotal: 15, scoring: SCORING }).points!;
    const hard = outlookDst({ opponentImpliedTotal: 30, scoring: SCORING }).points!;

    expect(soft).toBeGreaterThan(hard);
  });

  it('refuses a league whose defence scoring could not be read', () => {
    const read = outlookDst({ opponentImpliedTotal: 17, scoring: UNREADABLE });

    expect(read.points).toBeNull();
  });

  it('keeps the home-field nudge, and keeps it tiny', () => {
    const at = outlookDst({ opponentImpliedTotal: 20, scoring: SCORING, home: true }).points!;
    const away = outlookDst({ opponentImpliedTotal: 20, scoring: SCORING, home: false }).points!;

    expect(at).toBeGreaterThan(away);
    expect(at - away).toBeLessThanOrEqual(0.61);
  });
});

describe('a future week is anchored on the best thing available, and says which', () => {
  it('prefers a real line where one exists', () => {
    const read = dstOutlook({
      team: 'BUF',
      scoring: SCORING,
      schedule: SCHEDULE,
      weeks: [10, 11],
      lines: new Map([[10, 14]]),
      form: FORM,
    });

    expect(read.weeks[0]?.basis).toBe('line');
    expect(read.weeks[0]?.opponentImpliedTotal).toBe(14);
    expect(read.weeks[1]?.basis).toBe('form');
  });

  it('falls back to the opponent’s own season and says so', () => {
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10, 11], form: FORM });

    expect(read.ratedFromLine).toBe(0);
    expect(read.ratedFromForm).toBe(2);
    expect(read.confidence).toBe('low');
    expect(read.notes.join(' ')).toMatch(/not on a line for that game/);
  });

  it('declines a fallback built on a fortnight of games', () => {
    const thin = teamFormFromGames([{ team: 'NYJ', impliedTotal: 17 }, { team: 'NYJ', impliedTotal: 18 }]);
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10], form: thin });

    expect(DST_OUTLOOK.minFormGames).toBeGreaterThan(2);
    expect(read.weeks[0]?.basis).toBe('unknown');
    expect(read.perWeek).toBeNull();
  });

  it('counts a bye as a missing week rather than a terrible opponent', () => {
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10, 11, 12], form: FORM });

    expect(read.byes).toEqual([12]);
    expect(read.playable).toBe(2);
    // The average is over the two games, not over three weeks one of which is 0.
    const rated = read.weeks.filter((w) => w.points != null).map((w) => w.points!);
    expect(read.perWeek).toBeCloseTo((rated[0]! + rated[1]!) / 2, 2);
  });

  it('multiplies value by weeks available rather than by weeks in the window', () => {
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10, 11, 12], form: FORM });

    expect(read.total).toBeCloseTo(read.perWeek! * 2, 2);
  });

  it('rates a soft run above a hard one', () => {
    const soft = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10], form: FORM });
    const hard = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [11], form: FORM });

    expect(soft.perWeek!).toBeGreaterThan(hard.perWeek!);
  });

  it('drops a week the fixture list does not cover instead of calling it a bye', () => {
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10, 99], form: FORM });

    expect(read.weeks.map((w) => w.week)).toEqual([10]);
    expect(read.byes).toEqual([]);
  });

  it('answers unknown for a team with no stored schedule at all', () => {
    const read = dstOutlook({ team: 'DEN', scoring: SCORING, schedule: SCHEDULE, weeks: [10], form: FORM });

    expect(read.confidence).toBe('unknown');
    expect(read.perWeek).toBeNull();
  });

  it('leaves an unrated week out of the mean rather than counting it ordinary', () => {
    const partial = teamFormFromGames(Array.from({ length: 4 }, () => ({ team: 'NYJ', impliedTotal: 17 })));
    const read = dstOutlook({ team: 'BUF', scoring: SCORING, schedule: SCHEDULE, weeks: [10, 11], form: partial });

    expect(read.weeks[1]?.points).toBeNull();
    expect(read.perWeek).toBe(read.weeks[0]?.points);
  });
});

describe('team form is a measurement, not a forecast', () => {
  it('averages the implied totals the market actually published', () => {
    const form = teamFormFromGames([
      { team: 'DET', impliedTotal: 26 },
      { team: 'DET', impliedTotal: 28 },
      { team: 'det', impliedTotal: 24 },
    ]);

    expect(form.get('DET')).toEqual({ impliedTotal: 26, games: 3 });
  });

  it('forward weeks start after the week in play, never on it', () => {
    expect(forwardWeeks(5, 3)).toEqual([6, 7, 8]);
  });
});
