/**
 * One NFL season, and every demo week reads it.
 *
 * ## Why this file exists
 *
 * Week six used to be written down twice. The weekly fixtures gave every player
 * an opponent, a spread and a total; the matchup fixtures gave the same week its
 * own slate, its own kickoff windows and its own lines — and the two disagreed.
 * A reader stepping from `sunday-pregame` to `matchup-live-close` was told the
 * same Sunday twice, with a tight end on a bye in one of them and playing in the
 * other. Both were internally consistent and neither was the same week, which is
 * the exact "contradictory mixed-phase state" a demo has to be free of if
 * anybody is to reason about it.
 *
 * So the slate is one thing. A game states who is playing whom, when it kicks
 * off, who is at home and what the book made of it, and everything else in
 * `fixtures/` asks *this* file: the weekly market, the defence projections, the
 * matchup scoreboard, the schedule the DST outlook reads three weeks forward.
 *
 * ## What is stated and what is derived
 *
 * Stated: the games of weeks six and seven, because those two are the weeks the
 * demo is actually about and a reader has to be able to look at them and judge
 * whether the advice makes sense. Derived: every other week, from a rotation
 * over the thirty-two clubs with lines drawn from the same rotation — a
 * season's worth of fixtures without a season's worth of JSON, which is what
 * §15 asks for.
 *
 * That a derived week carries a line does not put one in front of the app. The
 * only market the app ever holds is the week it is being asked about — see
 * `futureLines` in `core/dst/assemble.ts`, which matches lines to fixtures out
 * of the current week's inputs — so the forward weeks a defence is judged over
 * still fall back to the opponent's own season form and still say that they
 * did. The fixture states a slate; what the app knows about it is the app's.
 *
 * Nothing here is a projection, a score or a recommendation.
 */

import type { ScheduleTeamWeek } from '../../nfl/schedule.ts';
import type { TeamForm } from '../../dst/outlook.ts';

/** The thirty-two clubs, in the order the rotation walks them. */
export const NFL_TEAMS = [
  'KC', 'BUF', 'CIN', 'SF', 'PHI', 'DAL', 'MIA', 'DET', 'BAL', 'GB',
  'LAR', 'HOU', 'MIN', 'SEA', 'NYJ', 'ATL', 'CHI', 'TB', 'PIT', 'CLE',
  'IND', 'JAX', 'LAC', 'DEN', 'NO', 'ARI', 'WAS', 'TEN', 'NE', 'NYG',
  'LV', 'CAR',
] as const;

/**
 * The five windows of an NFL week, at the wall-clock times they actually kick
 * off at.
 *
 * Written as real times rather than as offsets from a scenario's clock, which
 * is the change that made one slate possible: an offset belongs to whoever is
 * reading, and two readers of the same Sunday were producing two Sundays. A
 * kickoff belongs to the game.
 *
 * All five are needed, and each earns its place in a scenario:
 *
 *  - **`thursday`** — 8:15 Eastern on the Thursday. The first kickoff of the
 *    week, and therefore the deadline every piece of weekly advice is measured
 *    against: it is what makes a Tuesday waiver plan a decision about something
 *    two days away rather than five.
 *  - **`london`** — 9:30 Eastern. The reason a bench player can already be
 *    locked at lunchtime, which is exactly the state `late-injury-pivot` is
 *    about: a swap the reader cannot make, standing next to one they can.
 *  - **`early`** — 1:00 Eastern, and most of the slate.
 *  - **`late`** — 4:05 Eastern, so the live matchup scenarios have games in
 *    progress while others are finished.
 *  - **`night`** — 8:20 Eastern, which is what keeps a lineup slot changeable
 *    after the afternoon has decided most of the week.
 *
 * A game is final once 185 minutes have passed — see `GAME_MINUTES` — so at the
 * 5:20 Eastern the live matchup scenarios are read at, the morning and
 * afternoon games are over, the late window is about forty per cent through and
 * the night game has not started.
 */
export type SlateWindow = 'thursday' | 'london' | 'early' | 'late' | 'night';

/**
 * Hours (UTC) after the Sunday's midnight that each window kicks off.
 *
 * `thursday` is negative because the week starts three days before its Sunday,
 * and that is not a detail: the *first* kickoff of a week is the deadline the
 * whole week's advice has to be acted on before, so a Tuesday waiver run is
 * planning against Thursday night rather than against Sunday afternoon. Without
 * a Thursday game in the fixture, every demo waiver scenario sat outside the
 * defence planner's action window and the DEF row went quiet — not because the
 * planner was wrong, but because the fixture had described a week that does not
 * exist.
 */
const WINDOW_KICKOFF_UTC: Record<SlateWindow, number> = {
  thursday: -72 + 20 + 15 / 60,
  london: 13.5,
  early: 17,
  late: 20 + 5 / 60,
  night: 24 + 20 / 60,
};

/** The Sunday of week six, which is what every other week is measured from. */
const WEEK_SIX_SUNDAY = Date.UTC(2026, 9, 11);
const WEEK_SIX = 6;
const WEEK_MS = 7 * 24 * 3_600_000;

/** One game, written from the home side. `spread` is the home team's. */
export interface DemoGame {
  home: string;
  away: string;
  /** The home team's spread. Negative is favoured. Null where nobody has priced it. */
  spread: number | null;
  total: number | null;
  window: SlateWindow;
}

/** What one team's week looks like, from that team's point of view. */
export interface DemoTeamWeek {
  week: number;
  team: string;
  opponent: string;
  home: boolean;
  /** This team's own spread. Negative is favoured. */
  spread: number | null;
  total: number | null;
  window: SlateWindow;
  kickoff: string;
  /** Hours from the given instant to kickoff. Negative means already started. */
  kickoffInHours: number;
}

/**
 * Week six, in full.
 *
 * Twenty-eight clubs play and four are on a bye, which is what an October
 * Sunday looks like. The lines are the ones the matchup scenarios were built
 * around and are unchanged by the move into this file — every projected final,
 * win probability and hero insight in those five scenarios is computed from
 * these numbers, so moving them would have been quietly rewriting five
 * screens.
 *
 * The byes are chosen to land on the **wire** rather than on either roster in
 * the matchup: a free agent whose team is not playing is a real waiver state
 * that a scan has to decline to recommend, and putting a bye on a starter in
 * the one week the demo runs a matchup through would have taken the lineup
 * argument away to demonstrate a different thing.
 */
const WEEK_SIX_GAMES: DemoGame[] = [
  { home: 'JAX', away: 'CLE', spread: -1.5, total: 39, window: 'thursday' },
  { home: 'NYJ', away: 'PIT', spread: 1.5, total: 38.5, window: 'london' },
  { home: 'KC', away: 'IND', spread: -6.5, total: 47.5, window: 'early' },
  { home: 'BUF', away: 'CIN', spread: -1.5, total: 51, window: 'early' },
  { home: 'DAL', away: 'PHI', spread: 3, total: 44.5, window: 'early' },
  { home: 'ATL', away: 'NO', spread: -2, total: 42, window: 'early' },
  { home: 'TEN', away: 'ARI', spread: 1.5, total: 40, window: 'early' },
  { home: 'NE', away: 'CAR', spread: -3, total: 39.5, window: 'early' },
  { home: 'MIN', away: 'GB', spread: 1, total: 45.5, window: 'late' },
  { home: 'HOU', away: 'TB', spread: -3.5, total: 43, window: 'late' },
  { home: 'SF', away: 'LAR', spread: -4.5, total: 46, window: 'late' },
  { home: 'CHI', away: 'MIA', spread: 2.5, total: 41.5, window: 'late' },
  { home: 'BAL', away: 'DET', spread: -2.5, total: 49.5, window: 'night' },
  { home: 'WAS', away: 'SEA', spread: 1, total: 44, window: 'night' },
  { home: 'DEN', away: 'LAC', spread: -1, total: 40.5, window: 'night' },
];

/**
 * Week seven, the week the Tuesday waiver run is bidding into.
 *
 * Different pairings, because a season is not the same Sunday repeated, and
 * four deliberate byes: Detroit and Tampa Bay take two of the reader's own
 * starters off the board, which is what makes a wire urgent rather than
 * pleasant, and Washington takes the bench tight end's game away so the roster
 * still carries a player the app cannot score and therefore will not offer as a
 * cut.
 *
 * It is also the week the defence question is asked in. The reader's own unit
 * draws a road trip to the best offence on the slate and one of the wire's
 * unrostered defences is a five-and-a-half-point home favourite, so the gap
 * between them is a real one — and the planner, not this file, decides whether
 * it is worth a roster move.
 */
const WEEK_SEVEN_GAMES: DemoGame[] = [
  { home: 'KC', away: 'DEN', spread: -7.5, total: 45.5, window: 'early' },
  { home: 'CIN', away: 'CLE', spread: -4.5, total: 44, window: 'early' },
  { home: 'BUF', away: 'NYJ', spread: -6, total: 42.5, window: 'early' },
  { home: 'PHI', away: 'NYG', spread: -5.5, total: 43.5, window: 'early' },
  { home: 'IND', away: 'JAX', spread: -1.5, total: 46.5, window: 'early' },
  { home: 'NO', away: 'CAR', spread: -3, total: 40, window: 'early' },
  { home: 'MIA', away: 'NE', spread: -2.5, total: 41, window: 'early' },
  { home: 'MIN', away: 'CHI', spread: -3.5, total: 41.5, window: 'late' },
  { home: 'LAR', away: 'ARI', spread: -4, total: 45, window: 'late' },
  { home: 'HOU', away: 'LV', spread: -4.5, total: 42.5, window: 'late' },
  { home: 'SF', away: 'PIT', spread: -3, total: 42, window: 'late' },
  { home: 'GB', away: 'BAL', spread: 1.5, total: 47, window: 'night' },
  { home: 'LAC', away: 'DAL', spread: 2, total: 47.5, window: 'night' },
  { home: 'TEN', away: 'ATL', spread: 3.5, total: 41, window: 'thursday' },
];

const STATED: Record<number, DemoGame[]> = {
  [WEEK_SIX]: WEEK_SIX_GAMES,
  [WEEK_SIX + 1]: WEEK_SEVEN_GAMES,
};

/**
 * Every other week, from a rotation rather than from a file.
 *
 * The league is cut at a different point each week and then folded in half:
 * first against last, second against second-last. That pairs every club with
 * somebody, never with itself, and gives a different set of fixtures every
 * week. The four clubs at the cut sit the week out, so byes move through the
 * league the way they do in a real season instead of always falling on the same
 * four.
 *
 * The lines come off the same rotation, so a generated December week is a
 * plausible slate rather than an empty one — and stays identical on every
 * machine, because every value is a function of the index and the week.
 */
function generatedGames(week: number): DemoGame[] {
  const teams = [...NFL_TEAMS];
  const rotated = teams.map((_, i) => teams[(i + week * 5) % teams.length]!);
  const playing = rotated.slice(4);

  const games: DemoGame[] = [];
  for (let i = 0; i < playing.length / 2; i++) {
    const swing = ((i * 3 + week) % 9) - 4;
    games.push({
      home: playing[i]!,
      away: playing[playing.length - 1 - i]!,
      /* Home teams are favoured slightly more often than not, as they are. */
      spread: swing - 1,
      total: 40 + ((i * 5 + week * 3) % 7) * 1.5,
      /* Windows still vary, so a generated week is still a week. */
      window: i === 0 ? 'thursday' : i % 3 === 1 ? 'late' : i % 3 === 2 ? 'night' : 'early',
    });
  }
  return games;
}

const GENERATED = new Map<number, DemoGame[]>();

export function gamesFor(week: number): DemoGame[] {
  const stated = STATED[week];
  if (stated) return stated;
  const memo = GENERATED.get(week);
  if (memo) return memo;
  const built = generatedGames(week);
  GENERATED.set(week, built);
  return built;
}

/** When a window kicks off, in a given week. */
export function kickoffIso(week: number, window: SlateWindow): string {
  const sunday = WEEK_SIX_SUNDAY + (week - WEEK_SIX) * WEEK_MS;
  return new Date(sunday + WINDOW_KICKOFF_UTC[window] * 3_600_000).toISOString();
}

/**
 * One team's week, from that team's own point of view.
 *
 * Null on a bye, which is the state the whole app has language for: no market,
 * no projection, and never a zero.
 */
export function teamWeek(week: number, team: string, now: Date): DemoTeamWeek | null {
  const upper = team.toUpperCase();
  const game = gamesFor(week).find((g) => g.home === upper || g.away === upper);
  if (!game) return null;
  const home = game.home === upper;
  const kickoff = kickoffIso(week, game.window);
  return {
    week,
    team: upper,
    opponent: home ? game.away : game.home,
    home,
    /* A spread belongs to a side, and flipping it is the whole of "away". */
    spread: game.spread == null ? null : home ? game.spread : -game.spread,
    total: game.total,
    window: game.window,
    kickoff,
    /*
     * Exact, not rounded. The scenario turns this back into an instant when it
     * builds the engine's inputs, and rounding to the nearest minute here would
     * put the kickoff a few seconds away from the one the schedule states — two
     * answers to "when does this game start" inside one fixture.
     */
    kickoffInHours: (new Date(kickoff).getTime() - now.getTime()) / 3_600_000,
  };
}

/** The clubs not playing in a week — the ones a scan has to decline to advise on. */
export function byeTeams(week: number): string[] {
  const playing = new Set(gamesFor(week).flatMap((g) => [g.home, g.away]));
  return NFL_TEAMS.filter((t) => !playing.has(t));
}

/**
 * The stored fixture list, in the shape the schedule repository returns it.
 *
 * Two rows per game, one per club, exactly as `nfl/schedule.ts` parses a real
 * file into — so the DST outlook walks a demo season through the same code it
 * walks a real one through.
 */
export function scheduleRows(season: string, weeks: number[]): ScheduleTeamWeek[] {
  const out: ScheduleTeamWeek[] = [];
  for (const week of weeks) {
    for (const game of gamesFor(week)) {
      const kickoff = kickoffIso(week, game.window);
      out.push({ season, week, team: game.home, opponent: game.away, home: true, kickoff, roof: 'outdoors' });
      out.push({ season, week, team: game.away, opponent: game.home, home: false, kickoff, roof: 'outdoors' });
    }
    /*
     * A bye is a row whose opponent is absent, not a missing row.
     *
     * `dstOutlook` counts byes as weeks a defence cannot be played, and it can
     * only do that if the week is present and empty. A file that simply omitted
     * the club would be indistinguishable from a schedule that had not been
     * imported that far.
     */
    for (const team of byeTeams(week)) {
      out.push({ season, week, team, opponent: null, home: false, kickoff: null, roof: null });
    }
  }
  return out;
}

/**
 * What each offence has been priced at, on average, this season.
 *
 * The fallback anchor `dstOutlook` uses for a week nobody has put a line up
 * for. Derived from the club's position in the list rather than written out
 * thirty-two times: the spread is what matters — a handful of offences the
 * market rates in the high twenties, a handful it rates in the high teens, and
 * a mass in the middle — and the values are a function of the index, so they
 * are identical on every machine and in every run.
 *
 * `games` is the count behind the average, which is what lets the outlook say
 * how much the number is worth rather than presenting it as a line.
 */
export function teamForm(week: number): Map<string, TeamForm> {
  const out = new Map<string, TeamForm>();
  NFL_TEAMS.forEach((team, i) => {
    /* 17.4 to 27.0, spread evenly and deterministically across the league. */
    const impliedTotal = Math.round((17.4 + ((i * 7) % 32) * 0.31) * 10) / 10;
    out.set(team, { impliedTotal, games: Math.max(1, week - 1) });
  });
  return out;
}
