/**
 * A whole Sunday, in the shape a real one arrives in.
 *
 * Every other matchup test holds one property against one contrived state. This
 * one walks a week: three early games, three late, one at night, and the side
 * read at seven points on the clock between them — which is the state the
 * screen is actually in when somebody opens it, and the state no fixture built
 * around a single phase can produce.
 *
 * Two things come out of that, and they are different kinds of claim. The
 * mixed-state and monotonicity assertions are a *confirmation*: the model
 * handles locked, running and unstarted players inside one lineup correctly,
 * and the win probability moves the way a person would expect it to. The
 * unattributed-points tests are a *defect*: with every game final the screen
 * could show ninety-two points scored and a projected final of seventy-eight.
 */

import { describe, expect, it } from 'vitest';
import { buildForecast } from '../src/core/matchup/model.ts';
import { player, slots } from './helpers/matchup.ts';

/** The league's slot specs, built once so player rows can key on them. */
const SPEC = slots();
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

/** The three windows a Sunday actually has. */
const EARLY = '2026-09-13T17:00:00Z';
const LATE = '2026-09-13T20:05:00Z';
const NIGHT = '2026-09-14T00:20:00Z';
const KICKOFFS = [EARLY, EARLY, EARLY, LATE, LATE, LATE, NIGHT];
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const PROJECTIONS = [20, 14, 11, 15, 12, 9, 11];

function side(which: 'mine' | 'theirs', actual: number[]): MatchupPlayerInput[] {
  return PROJECTIONS.map((projection, i) =>
    player({
      playerId: `${which}${i}`,
      side: which,
      position: SLOTS[i] === 'FLEX' ? 'WR' : SLOTS[i]!,
      slot: SPEC[i]!.key,
      starting: true,
      projection,
      actual: actual[i]!,
      kickoff: KICKOFFS[i]!,
    }),
  );
}

function forecast(opts: {
  now: string;
  mine: number[];
  theirs: number[];
  mineTotal?: number;
  theirsTotal?: number;
}) {
  const players = [...side('mine', opts.mine), ...side('theirs', opts.theirs)];
  const sum = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100;
  return buildForecast({
    leagueId: 'l1',
    season: '2026',
    week: 1,
    matchupId: 1,
    players,
    teams: {
      mine: { rosterId: 1, name: 'Mine', avatar: null, record: '0-0' },
      theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: '0-0' },
    },
    actualScores: { mine: opts.mineTotal ?? sum(opts.mine), theirs: opts.theirsTotal ?? sum(opts.theirs) },
    slots: slots(),
    now: new Date(opts.now),
  });
}

interface WeekState {
  label: string;
  now: string;
  mine: number[];
  theirs: number[];
}

/** The week as it actually ran, at seven points on the clock. */
const SUNDAY: WeekState[] = [
  { label: 'pregame', now: '2026-09-13T16:00:00Z', mine: [0, 0, 0, 0, 0, 0, 0], theirs: [0, 0, 0, 0, 0, 0, 0] },
  { label: 'early live', now: '2026-09-13T18:30:00Z', mine: [8, 6, 4, 0, 0, 0, 0], theirs: [9, 5, 5, 0, 0, 0, 0] },
  { label: 'early final', now: '2026-09-13T20:10:00Z', mine: [22, 15, 9, 0, 0, 0, 0], theirs: [18, 13, 12, 0, 0, 0, 0] },
  { label: 'late live', now: '2026-09-13T21:30:00Z', mine: [22, 15, 9, 7, 5, 3, 0], theirs: [18, 13, 12, 6, 6, 4, 0] },
  { label: 'late final', now: '2026-09-13T23:20:00Z', mine: [22, 15, 9, 16, 13, 8, 0], theirs: [18, 13, 12, 14, 11, 10, 0] },
  { label: 'night live', now: '2026-09-14T01:30:00Z', mine: [22, 15, 9, 16, 13, 8, 5], theirs: [18, 13, 12, 14, 11, 10, 4] },
  { label: 'all final', now: '2026-09-14T04:00:00Z', mine: [22, 15, 9, 16, 13, 8, 12], theirs: [18, 13, 12, 14, 11, 10, 9] },
];

describe('a side whose players are in three different states at once', () => {
  it('reads every phase correctly inside one lineup', () => {
    // 21:30 UTC: the early three are over, the late three are running, the
    // night game has not kicked off. All in one side, all in one forecast.
    const week = forecast(SUNDAY[3]!);
    // Looked up by id rather than by row order: the board draws slots in the
    // league's own order, which is not the order this fixture lists them in.
    const byId = new Map(week.slots.flatMap((row) => (row.mine ? [[row.mine.playerId, row.mine] as const] : [])));
    const phaseOf = (i: number) => byId.get(`mine${i}`)?.phase;

    expect([0, 1, 2].map(phaseOf)).toEqual(['final', 'final', 'final']);
    expect([3, 4, 5].map(phaseOf)).toEqual(['live', 'live', 'live']);
    expect(phaseOf(6)).toBe('not_started');
  });

  it('never re-simulates a finished player, whatever else is running', () => {
    /*
     * §6, asked at the one moment it can actually be got wrong. A player whose
     * game is over is an addend; the two still running are the only uncertainty
     * left, and a model that kept drawing for the finished three would jitter a
     * win probability all afternoon on points that cannot change.
     */
    const week = forecast(SUNDAY[3]!);
    const finished = week.slots
      .flatMap((row) => [row.mine, row.theirs])
      .filter((view): view is NonNullable<typeof view> => view?.phase === 'final');

    expect(finished.length, 'the early window is six players across both sides').toBe(6);
    for (const view of finished) expect(view.projectedFinal).toBe(view.actual);
  });

  it('produces a forecast at every point on the clock, not just the tidy ones', () => {
    for (const state of SUNDAY) {
      const week = forecast(state);
      expect(week.degraded, `${state.label} should not be degraded`).toBe(false);
      expect(week.teams.mine.winProbability, state.label).not.toBeNull();
      expect(week.teams.mine.projectedFinal, state.label).not.toBeNull();
    }
  });
});

describe('and the win probability moves the way the afternoon does', () => {
  it('starts at a coin flip on two identical lineups', () => {
    const pregame = forecast(SUNDAY[0]!);
    expect(pregame.teams.mine.winProbability!).toBeGreaterThan(0.4);
    expect(pregame.teams.mine.winProbability!).toBeLessThan(0.6);
  });

  it('settles to certainty once nothing can change', () => {
    const done = forecast(SUNDAY[6]!);
    expect(done.teams.mine.winProbability).toBe(1);
    expect(done.teams.mine.projectedFinal).toBe(done.teams.mine.actual);
  });

  it('never projects a side below the points it has already banked', () => {
    // The property that makes a live projected total readable at all. It holds
    // trivially when every starter resolved; the case where it did not is the
    // next block.
    for (const state of SUNDAY) {
      const week = forecast(state);
      expect(week.teams.mine.projectedFinal!, state.label).toBeGreaterThanOrEqual(week.teams.mine.actual);
      expect(week.teams.theirs.projectedFinal!, state.label).toBeGreaterThanOrEqual(week.teams.theirs.actual);
    }
  });

  it('is more confident late in a lead than early in the same lead', () => {
    /*
     * Not a claim that it rises monotonically — it should not, and does not:
     * the opponent outscored this side in the early window and the number fell.
     * The claim is that the *same* margin is worth more with less football
     * left, which is the whole reason a live win probability is not a
     * comparison of two projected totals wearing a percentage sign.
     */
    const earlyLead = forecast(SUNDAY[2]!).teams.mine.winProbability!;
    const lateLead = forecast(SUNDAY[4]!).teams.mine.winProbability!;

    expect(earlyLead).toBeGreaterThan(0.5);
    expect(lateLead).toBeGreaterThan(earlyLead);
  });
});

describe('points Sleeper counts that this app could not attribute', () => {
  /**
   * The defect, in the numbers it was wrong by.
   *
   * `actual` is Sleeper's own team total and `projectedFinal` is summed from
   * the starters this app resolved. A roster spot the player table could not
   * map leaves points inside the first number and outside the second — and with
   * every game final that read as a team projected to finish *below* what it
   * had already scored.
   */
  const FINAL = SUNDAY[6]!;
  const banked = FINAL.mine.reduce((a, b) => a + b, 0);

  it('does not project a finished team below its own scoreboard', () => {
    const week = forecast({ ...FINAL, mineTotal: banked + 14 });

    expect(week.teams.mine.actual).toBe(banked + 14);
    expect(week.teams.mine.projectedFinal, 'this read 78 against a scoreboard of 92').toBe(banked + 14);
  });

  it('counts them in the win probability too, not only in the display', () => {
    /*
     * The quieter half. The simulation totals a side from its resolved
     * starters, so the manager holding the unattributed points was being
     * under-credited in the forecast as well as misdrawn on the card.
     */
    const midGame = { ...SUNDAY[3]! };
    const without = forecast(midGame).teams.mine.winProbability!;
    const withGap = forecast({
      ...midGame,
      mineTotal: midGame.mine.reduce((a, b) => a + b, 0) + 14,
    }).teams.mine.winProbability!;

    expect(withGap).toBeGreaterThan(without);
  });

  it('adds them as truth rather than modelling them', () => {
    // They are banked points Sleeper computed under the league's own scoring.
    // Fourteen more points must move the projected total by exactly fourteen.
    const plain = forecast(SUNDAY[3]!).teams.mine.projectedFinal!;
    const gapped = forecast({
      ...SUNDAY[3]!,
      mineTotal: SUNDAY[3]!.mine.reduce((a, b) => a + b, 0) + 14,
    }).teams.mine.projectedFinal!;

    expect(gapped - plain).toBeCloseTo(14, 5);
  });

  it('never subtracts, when the disagreement runs the other way', () => {
    /*
     * A team total *below* the sum of the starters means this app is counting a
     * starter Sleeper is not — a disagreement about the lineup rather than a
     * gap in it. Subtracting modelled points to smooth that over would hide the
     * one case worth investigating, so it is clamped and left alone.
     */
    const plain = forecast(SUNDAY[3]!).teams.mine.projectedFinal!;
    const under = forecast({
      ...SUNDAY[3]!,
      mineTotal: SUNDAY[3]!.mine.reduce((a, b) => a + b, 0) - 10,
    }).teams.mine.projectedFinal!;

    expect(under).toBe(plain);
  });

  it('leaves a healthy matchup byte-identical', () => {
    // The gap is zero whenever every starter mapped, which is the ordinary
    // state, and a zero constant changes nothing.
    for (const state of SUNDAY) {
      const week = forecast(state);
      const sum = state.mine.reduce((a, b) => a + b, 0);
      expect(week.teams.mine.actual, state.label).toBe(sum);
    }
    expect(forecast(SUNDAY[3]!).fingerprint).toBe(forecast(SUNDAY[3]!).fingerprint);
  });
});

describe('the freshness report still speaks for the gaps it can see', () => {
  it('counts an unprojected starter rather than hiding him in a total', () => {
    const players = [...side('mine', [0, 0, 0, 0, 0, 0, 0]), ...side('theirs', [0, 0, 0, 0, 0, 0, 0])].map(
      (p, i) => (i === 3 ? { ...p, projection: null } : p),
    );
    const week = buildForecast({
      leagueId: 'l1',
      season: '2026',
      week: 1,
      matchupId: 1,
      players,
      teams: {
        mine: { rosterId: 1, name: 'Mine', avatar: null, record: '0-0' },
        theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: '0-0' },
      },
      actualScores: { mine: 0, theirs: 0 },
      slots: slots(),
      now: new Date('2026-09-13T16:00:00Z'),
    });

    expect(week.freshness.missingProjection).toBeGreaterThan(0);
  });

  it('still refuses a comparison between two differently-covered sides', () => {
    // Unchanged by any of the above: an opponent priced three of seven is a
    // team modelled as three players, and the 98% that produces is a confident
    // wrong answer rather than a cautious one.
    const theirs = side('theirs', [0, 0, 0, 0, 0, 0, 0]).map((p, i) => (i < 4 ? { ...p, projection: null } : p));
    const week = buildForecast({
      leagueId: 'l1',
      season: '2026',
      week: 1,
      matchupId: 1,
      players: [...side('mine', [0, 0, 0, 0, 0, 0, 0]), ...theirs],
      teams: {
        mine: { rosterId: 1, name: 'Mine', avatar: null, record: '0-0' },
        theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: '0-0' },
      },
      actualScores: { mine: 0, theirs: 0 },
      slots: slots(),
      now: new Date('2026-09-13T16:00:00Z'),
    });

    expect(week.degraded).toBe(true);
    expect(week.teams.mine.winProbability).toBeNull();
  });
});
