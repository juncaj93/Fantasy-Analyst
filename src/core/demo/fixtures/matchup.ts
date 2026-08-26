/**
 * One Sunday afternoon, from six different points in it.
 *
 * Everything a matchup scenario states is an *input*: what the market expected
 * of a player and what he has actually scored so far. Where the games are and
 * when they kick off is not stated here at all — that is `slate.ts`, which
 * every other week of the demo reads too, and moving it there is what stopped
 * week six being two different Sundays depending on which screen was open.
 *
 * Nothing here states a projection, a win probability, a phase, an insight or a
 * lineup verdict. Those are `core/matchup`'s, computed from the numbers below
 * by the same `buildMatchupResponse` the server calls — which is the whole
 * point of the scenarios: if the model changes its mind about a close game,
 * these screens change with it.
 *
 * ## How a scenario reaches a state
 *
 * The clock is fixed and the kickoffs belong to the slate, so the phase of each
 * player's game is arithmetic the distribution module does: before kickoff he
 * has not started, up to 185 minutes after it he is live with that share
 * elapsed, and past that he is final. A Sunday with games in all three states
 * is therefore not a flag — it is three kickoff times and one clock.
 */

import type { SleeperMatchup } from '../../sleeper/types.ts';
import type { DemoScenario } from '../types.ts';
import type { DemoInjurySpec } from './spec.ts';

/** The manager on the other side of the table for all six scenarios. */
export const MATCHUP_OPPONENT_ROSTER_ID = 2;

/**
 * The opponent's fourteen, pinned rather than dealt.
 *
 * The rest of the league is filled from the draft order, which is fine for a
 * roster nobody looks at. This one is looked at very closely — every starter's
 * game state, market number and score is on screen — so it is written down.
 *
 * Chosen so the two lineups are genuinely comparable and the afternoon has
 * somewhere to go: three of his starters are finished, four are playing, and
 * one is in the night game, which is the same shape as the reader's side.
 */
export const OPPONENT_ROSTER = [
  'p011', // QB  Gunnar Petrie (MIN)
  'p004', // RB  Trey Alcorn (PHI)
  'p006', // RB  Darius Whitten (GB)
  'p002', // WR  Deion Rackley (CIN)
  'p005', // WR  Cade Robinette (SF)
  'p024', // WR  Dax Merriweather (LAC)
  'p017', // TE  Brady Ferrante (ATL)
  'p021', // FLEX Bo Ashcroft (RB, LAR)
  'p007', // BN  Elijah Nunez (RB, MIA)
  'p026', // BN  Corbin Ledoux (RB, NO)
  'p012', // BN  Beau Callahan (QB, TB)
  'p014', // BN  Diego Marchand (QB, PIT)
  'p018', // BN  Isaiah Coker (TE, SEA)
  /*
   * Doubtful in the shared world, and benched here on purpose.
   *
   * An unresolved designation on a *starter* is an `act_now` insight, and the
   * ladder puts that tier above everything — which is correct, and which would
   * have made the same injury the hero of three of these five scenarios. He
   * stays on the roster, where the model still sees him as a bench option, and
   * the deliberate injury demonstration is `matchup-injury-swing`, on the
   * reader's own side, where it is actionable.
   */
  'p022', // BN  Cal Whitfield (WR, NYJ)
  /*
   * And a defence, because the league starts one.
   *
   * Baltimore is in the night game, on the same slate as the reader's own
   * Denver — so a matchup that comes down to the last window has a defence in
   * it on both sides, which is what a real one does and what the screen has to
   * be able to draw.
   */
  'd02', // DEF Baltimore
];

/** In lineup-slot order: QB, RB, RB, WR, WR, WR, TE, FLEX, DEF. */
export const OPPONENT_STARTERS = ['p011', 'p004', 'p006', 'p002', 'p005', 'p024', 'p017', 'p021', 'd02'];

/**
 * How each player's afternoon has actually gone.
 *
 * Sleeper's number, not this app's: `players_points` is the league's own
 * scoring applied to what happened on the field, and nothing downstream
 * recomputes it. A finished game's figure is his final; a live one's is what he
 * has banked so far and the model reasons about what is left; a game that has
 * not kicked off is zero because nothing has happened yet, which the model
 * distinguishes from a projection of zero.
 */
type Scores = Record<string, number>;

/** One point in it, with the reader's night game still to come. */
const CLOSE: Scores = {
  p001: 22.1, p003: 12.6, p016: 12.7, p023: 8.1, p009: 8.7, p025: 4.9,
  p004: 17.0, p002: 22.1, p017: 6.4, p011: 14.7, p006: 7.2, p005: 9.3, p021: 4.8,
};

/** The finished games went the reader's way, and the live ones are following. */
const LEADING: Scores = {
  p001: 27.1, p003: 15.2, p016: 13.6, p023: 8.6, p009: 7.9, p025: 2.7,
  p004: 13.2, p002: 19.6, p017: 5.1, p011: 14.8, p006: 8.4, p005: 8.2, p021: 4.9,
};

/** The mirror: nothing has landed, and the arithmetic is getting steep. */
const TRAILING: Scores = {
  p001: 14.4, p003: 8.6, p016: 7.9, p023: 6.2, p009: 7.4, p025: 4.8,
  p004: 17.8, p002: 22.4, p017: 7.6, p011: 12.4, p006: 6.8, p005: 8.2, p021: 4.1,
};

/**
 * Level enough that one lineup slot decides it.
 *
 * Slightly the reader's way, so the starter who has been ruled out of the night
 * game is the difference between a game he is favoured in and one he is not.
 * A ruled-out starter in a match already lost would be a true alert about
 * nothing, which is the opposite of what this scenario is for.
 */
const INJURY_SWING: Scores = {
  p001: 23.2, p003: 13.7, p016: 12.9, p023: 8.2, p009: 9.4, p025: 4.7,
  p004: 14.2, p002: 19.8, p017: 5.9, p011: 12.1, p006: 6.4, p005: 8.6, p021: 4.2,
};

/**
 * Every game over, and the two totals a point and a half apart.
 *
 * The night game's players carry real figures here rather than zeroes, because
 * a settled week is one where everybody has played — and the bench figures are
 * what let the "what would have won it" reading be about a real alternative.
 */
const FINAL: Scores = {
  p001: 21.4, p003: 9.8, p016: 12.1, p023: 11.7, p009: 15.2, p025: 8.6, p010: 24.1, p008: 9.4,
  p013: 19.8, p028: 6.2, p030: 4.1, p031: 16.9, p037: 21.3, p019: 3.7,
  p004: 14.6, p002: 22.8, p017: 5.4, p011: 19.4, p006: 9.8, p005: 13.1, p021: 8.2, p024: 20.5,
  p007: 12.6, p026: 5.4, p012: 13.8, p014: 11.1, p018: 2.9, p022: 9.7,
};

/**
 * Nothing has kicked off yet.
 *
 * `sunday-pregame` is a matchup as well as a lineup, and the empty scoreboard
 * is the whole of what makes it one: two rosters, a full slate ahead, and a
 * forecast built entirely out of what the market expects rather than partly out
 * of what has happened. It is the one live phase the other five did not cover,
 * and it is the phase in which a lineup change is still worth anything.
 */
const PREGAME: Scores = {};

/**
 * The clock each scenario is read at.
 *
 * Four of them share the same instant, because "close", "ahead" and "behind"
 * are three different Sundays at the same time of day rather than three times
 * of day. `sunday-pregame` is read in the morning, before anything has
 * happened, and `matchup-final` on the Monday after the night game.
 *
 * Every one of them is a *clock*, not a schedule: what has finished, what is
 * running and what is still to come is the slate's kickoffs measured from here.
 */
export const MATCHUP_CLOCKS: Record<string, string> = {
  'sunday-pregame': '2026-10-11T15:40:00.000Z',
  'matchup-live-close': '2026-10-11T21:20:00.000Z',
  'matchup-live-leading': '2026-10-11T21:20:00.000Z',
  'matchup-live-trailing': '2026-10-11T21:20:00.000Z',
  'matchup-injury-swing': '2026-10-11T21:20:00.000Z',
  'matchup-final': '2026-10-12T06:30:00.000Z',
};

export function isMatchupScenario(id: string): boolean {
  return id in MATCHUP_CLOCKS;
}

const SCORES: Record<string, Scores> = {
  'sunday-pregame': PREGAME,
  'matchup-live-close': CLOSE,
  'matchup-live-leading': LEADING,
  'matchup-live-trailing': TRAILING,
  'matchup-injury-swing': INJURY_SWING,
  'matchup-final': FINAL,
};

/**
 * The starter ruled out of the night game.
 *
 * The only fixture difference between `matchup-injury-swing` and
 * `matchup-live-close`, and it is stated as what the two sources said rather
 * than as a conclusion: `resolveInjury` decides what a DNP week and an `Out`
 * designation add up to, and `core/matchup/decision.ts` decides what the swap
 * is worth. He is in the night game, so his slot is still changeable — which is
 * what makes this an alert rather than a regret.
 */
export const MATCHUP_INJURY: Record<string, { injury: DemoInjurySpec }> = {
  p008: {
    injury: {
      designation: 'Out',
      bodyPart: 'ankle',
      practice: ['DNP', 'DNP', 'DNP'],
      reportHoursAgo: 0.6,
      sleeperSays: 'Out',
    },
  },
};

/** Everybody in the matchup, which is what has to be priced. */
export function matchupPlayerIds(mine: string[]): string[] {
  return [...new Set([...mine, ...OPPONENT_ROSTER])];
}

/**
 * Sleeper's two rows for the week, which are the scoreboard.
 *
 * Written in Sleeper's own shape — `starters` positional against the league's
 * starting slots, `players` for the whole roster, `players_points` per man —
 * because the assembly reads them through the same code path a live league goes
 * through. A demo row that was already in this app's vocabulary would be
 * skipping the translation the screen actually depends on.
 */
export function matchupRows(
  scenario: DemoScenario,
  opts: { mineRosterId: number; minePlayers: string[]; mineStarters: string[] },
): SleeperMatchup[] {
  const scores = SCORES[scenario.id] ?? {};
  const pointsFor = (ids: string[]): Record<string, number> =>
    Object.fromEntries(ids.map((id) => [id, scores[id] ?? 0]));
  const total = (ids: string[]): number =>
    Math.round(ids.reduce((sum, id) => sum + (scores[id] ?? 0), 0) * 100) / 100;

  return [
    {
      roster_id: opts.mineRosterId,
      matchup_id: 1,
      points: total(opts.mineStarters),
      players: opts.minePlayers,
      starters: opts.mineStarters,
      players_points: pointsFor(opts.minePlayers),
    },
    {
      roster_id: MATCHUP_OPPONENT_ROSTER_ID,
      matchup_id: 1,
      points: total(OPPONENT_STARTERS),
      players: OPPONENT_ROSTER,
      starters: OPPONENT_STARTERS,
      players_points: pointsFor(OPPONENT_ROSTER),
    },
  ];
}
