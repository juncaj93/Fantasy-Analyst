/**
 * One Sunday afternoon, from five different points in it.
 *
 * Everything a matchup scenario states is an *input*: which game a player is
 * in, when it kicked off, what the market expected of him, and what he has
 * actually scored so far. Sleeper's own matchup rows carry the last of those,
 * exactly as they do live, and the app reads them exactly as it does live.
 *
 * Nothing here states a projection, a win probability, a phase, an insight or a
 * lineup verdict. Those are `core/matchup`'s, computed from the numbers below
 * by the same `buildMatchupResponse` the server calls — which is the whole
 * point of the five scenarios: if the model changes its mind about a close
 * game, these screens change with it.
 *
 * ## How a scenario reaches a state
 *
 * The clock is fixed and every kickoff is written as an offset from it, so the
 * phase of each player's game is arithmetic the distribution module does:
 * before kickoff he has not started, up to 185 minutes after it he is live with
 * that share elapsed, and past that he is final. A Sunday with games in all
 * three states is therefore not a flag — it is three kickoff times.
 */

import type { SleeperMatchup } from '../../sleeper/types.ts';
import type { DemoScenario } from '../types.ts';
import type { DemoWeekSpec } from './spec.ts';

/** The manager on the other side of the table for all five scenarios. */
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
  'p011', // QB  Emil Draeger (MIN)
  'p004', // RB  Roshan Villiers (PHI)
  'p006', // RB  Silas Mbeki (GB)
  'p002', // WR  Devin Okafor (CIN)
  'p005', // WR  Owen Fitzgerald (SF)
  'p024', // WR  Dax Merriweather (LAC)
  'p017', // TE  Miles Barrowman (ATL)
  'p021', // FLEX Bo Ashworth (RB, LAR)
  'p007', // BN  Julian Reyes (RB, MIA)
  'p026', // BN  Corbin Ledoux (RB, NO)
  'p012', // BN  Jonah Priestley (QB, TB)
  'p014', // BN  Ruben Castellanos (QB, PIT)
  'p018', // BN  Teo Ferreira (TE, SEA)
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
];

/** In lineup-slot order: QB, RB, RB, WR, WR, WR, TE, FLEX. */
export const OPPONENT_STARTERS = ['p011', 'p004', 'p006', 'p002', 'p005', 'p024', 'p017', 'p021'];

/**
 * The three windows of an NFL Sunday, as offsets from the scenario clock.
 *
 * A game is final once 185 minutes have passed — see `GAME_MINUTES` — so 3.6
 * hours ago is comfortably over, 1.1 hours ago is a little over a third
 * through, and the night game has not kicked off. Every team on either roster
 * is in exactly one of them, which is what stops a demo Sunday from being a
 * slate where everything happens at once.
 */
type Window = 'early' | 'late' | 'night';

const WINDOW_KICKOFF: Record<Window, number> = { early: -3.6, late: -1.1, night: 3.75 };

const TEAM_WINDOW: Record<string, Window> = {
  KC: 'early', BUF: 'early', DAL: 'early', PHI: 'early', CIN: 'early', ATL: 'early', IND: 'early', NO: 'early',
  MIN: 'late', HOU: 'late', TB: 'late', GB: 'late', SF: 'late', LAR: 'late', CHI: 'late', MIA: 'late',
  BAL: 'night', DET: 'night', NYJ: 'night', PIT: 'night', WAS: 'night', DEN: 'night', SEA: 'night', LAC: 'night',
};

/** The slate itself: who is playing whom, and what the book made of it. */
const GAME: Record<string, { opponent: string; spread: number; total: number }> = {
  KC: { opponent: 'IND', spread: -6.5, total: 47.5 },
  IND: { opponent: 'KC', spread: 6.5, total: 47.5 },
  BUF: { opponent: 'CIN', spread: -1.5, total: 51 },
  CIN: { opponent: 'BUF', spread: 1.5, total: 51 },
  DAL: { opponent: 'PHI', spread: 3, total: 44.5 },
  PHI: { opponent: 'DAL', spread: -3, total: 44.5 },
  ATL: { opponent: 'NO', spread: -2, total: 42 },
  NO: { opponent: 'ATL', spread: 2, total: 42 },
  MIN: { opponent: 'GB', spread: 1, total: 45.5 },
  GB: { opponent: 'MIN', spread: -1, total: 45.5 },
  HOU: { opponent: 'TB', spread: -3.5, total: 43 },
  TB: { opponent: 'HOU', spread: 3.5, total: 43 },
  SF: { opponent: 'LAR', spread: -4.5, total: 46 },
  LAR: { opponent: 'SF', spread: 4.5, total: 46 },
  CHI: { opponent: 'MIA', spread: 2.5, total: 41.5 },
  MIA: { opponent: 'CHI', spread: -2.5, total: 41.5 },
  BAL: { opponent: 'DET', spread: -2.5, total: 49.5 },
  DET: { opponent: 'BAL', spread: 2.5, total: 49.5 },
  NYJ: { opponent: 'PIT', spread: 1.5, total: 38.5 },
  PIT: { opponent: 'NYJ', spread: -1.5, total: 38.5 },
  WAS: { opponent: 'SEA', spread: 1, total: 44 },
  SEA: { opponent: 'WAS', spread: -1, total: 44 },
  DEN: { opponent: 'LAC', spread: -1, total: 40.5 },
  LAC: { opponent: 'DEN', spread: 1, total: 40.5 },
};

/**
 * What the market expected of each man in the matchup, in this league's points.
 *
 * A target the expander turns into the lines a book would publish; the number
 * the screen shows is the engine's reading of those lines, not this figure.
 * Everybody on either roster has one, because a matchup where half a lineup is
 * unpriced is a *degraded* matchup and the model says so — which is a state
 * worth demonstrating deliberately and not by accident.
 */
const EXPECTED: Record<string, number> = {
  // The reader's starters.
  p010: 21.0, p001: 18.5, p023: 13.1, p003: 16.2, p009: 14.8, p008: 15.5, p016: 9.6, p025: 12.4,
  // The reader's bench.
  p013: 17.2, p028: 9.1, p030: 7.4, p031: 11.8, p037: 12.9, p019: 6.3,
  // The opponent's starters.
  p011: 20.2, p004: 17.9, p006: 15.4, p002: 17.1, p005: 16.6, p024: 14.2, p017: 10.3, p021: 13.8,
  // The opponent's bench.
  p007: 11.4, p026: 8.7, p012: 16.1, p014: 14.9, p018: 5.8, p022: 12.2,
};

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
  p004: 15.8, p002: 22.1, p017: 6.4, p011: 13.4, p006: 7.2, p005: 9.3, p021: 4.8,
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
 * The clock each scenario is read at.
 *
 * Three of them share the same instant, because "close", "ahead" and "behind"
 * are three different Sundays at the same time of day rather than three times
 * of day. `matchup-final` is read on the Monday, after everything including the
 * night game has finished.
 */
export const MATCHUP_CLOCKS: Record<string, string> = {
  'matchup-live-close': '2026-10-11T20:15:00.000Z',
  'matchup-live-leading': '2026-10-11T20:15:00.000Z',
  'matchup-live-trailing': '2026-10-11T20:15:00.000Z',
  'matchup-injury-swing': '2026-10-11T20:15:00.000Z',
  'matchup-final': '2026-10-12T06:30:00.000Z',
};

export function isMatchupScenario(id: string): boolean {
  return id in MATCHUP_CLOCKS;
}

const SCORES: Record<string, Scores> = {
  'matchup-live-close': CLOSE,
  'matchup-live-leading': LEADING,
  'matchup-live-trailing': TRAILING,
  'matchup-injury-swing': INJURY_SWING,
  'matchup-final': FINAL,
};

/** Everybody in the matchup, which is what has to be priced. */
export function matchupPlayerIds(mine: string[]): string[] {
  return [...new Set([...mine, ...OPPONENT_ROSTER])];
}

/**
 * The week's market for everybody in the matchup.
 *
 * Built from the slate rather than written out per player: the kickoff, the
 * opponent and the line are properties of the *game*, and stating them
 * twenty-eight times is twenty-eight chances for the two sides of one game to
 * disagree about who is favoured.
 *
 * `matchup-final` shifts every kickoff back by the ten and a quarter hours
 * between the two clocks, so the same slate reads as finished rather than being
 * a second slate that happens to be over.
 */
export function matchupWeek(
  scenario: DemoScenario,
  players: { id: string; team: string }[],
  base: Record<string, DemoWeekSpec>,
): Record<string, DemoWeekSpec> {
  const ids = new Set(matchupPlayerIds(Object.keys(EXPECTED)));
  const settled = scenario.id === 'matchup-final';
  const out: Record<string, DemoWeekSpec> = {};

  for (const player of players) {
    if (!ids.has(player.id)) continue;
    const points = EXPECTED[player.id];
    if (points == null) continue;

    const window = TEAM_WINDOW[player.team];
    const game = GAME[player.team];
    /*
     * A player whose team is not on this slate has no market at all, which is
     * the bye state and is passed through as absent rather than invented.
     */
    if (!window || !game) {
      out[player.id] = { points: null, kickoffInHours: null, opponent: null };
      continue;
    }

    out[player.id] = {
      points,
      // Roughly last week's line, so movement is real rather than flat.
      previousPoints: Math.round((points * 0.94 + 0.6) * 10) / 10,
      kickoffInHours: WINDOW_KICKOFF[window] - (settled ? 10.25 : 0),
      opponent: game.opponent,
      spread: game.spread,
      total: game.total,
      // The usage series the shared world already carries for him, when it does:
      // a role read is about the season, not about this afternoon.
      ...(base[player.id]?.usage ? { usage: base[player.id]!.usage } : {}),
    };
  }

  /*
   * The starter who leaves the lineup, and the only fixture difference between
   * `matchup-injury-swing` and `matchup-live-close`.
   *
   * He is in the night game, so his slot is still changeable — which is what
   * makes this an alert rather than a regret, and is why the insight engine can
   * price the swap in win probability instead of merely reporting it.
   */
  if (scenario.id === 'matchup-injury-swing') {
    const hurt = out['p008'];
    if (hurt) {
      out['p008'] = {
        ...hurt,
        injury: {
          designation: 'Out',
          bodyPart: 'ankle',
          practice: ['DNP', 'DNP', 'DNP'],
          reportHoursAgo: 0.6,
          sleeperSays: 'Out',
        },
      };
    }
  }

  return out;
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
