/**
 * What a defence is worth *after* this Sunday.
 *
 * Every other question about a DST is a weekly one and the market answers it:
 * `dstProjection.ts` reads the opponent's implied total off a priced game and
 * stops. This module exists for the three questions that outlive the slate —
 * is the defence I hold worth holding through November, does the wire's better
 * defence stay better, and who should I be carrying into week 15 — and none of
 * them can be answered from a line, because no book has priced week 15 in
 * October and this app will not invent one.
 *
 * ## Two anchors, and the difference is stated rather than smoothed
 *
 * A future week is valued on whichever of these is available, best first:
 *
 *   - **`line`** — a real priced game. The market has reached that far ahead,
 *     usually one or two weeks, and when it has there is nothing better.
 *   - **`form`** — the opponent's **mean implied team total across the games
 *     the market has already priced**. That is a measurement of an offence, not
 *     a forecast of a fixture: it says "the market has been pricing Detroit at
 *     26 a week", which is a fact about Detroit, and it never claims to be a
 *     line for the game in question. Marked low confidence wherever it is used.
 *
 * And when neither exists the week is **unrated** and left out of the mean, the
 * same rule `roleStrength.ts` follows for a defence its tendency table cannot
 * describe. An unknown week is not a neutral week.
 *
 * ## A bye is a missing week, not a bad one
 *
 * Counted separately and excluded from the average, because averaging a zero
 * into an outlook invents a terrible opponent out of a week off. The weeks a
 * defence is actually available are reported alongside the per-week value, so a
 * caller choosing between a stash and a bench spot can multiply the two itself
 * — the same split `multiWeek.ts` makes for exactly the same reason.
 *
 * Nothing here is a projection and nothing here reaches a lineup. A schedule
 * three weeks out is not a reason to bench anybody this Sunday.
 */

import { outlookDst, DST_BASELINES } from '../startsit/dstProjection.ts';
import type { DstScoring } from '../sleeper/dstScoring.ts';
import type { ScheduleTeamWeek } from '../nfl/schedule.ts';

export const DST_OUTLOOK = {
  /**
   * Weeks of forward view behind a hold.
   *
   * Three rather than four. `multiWeek.ts` uses four for a skill player because
   * a role takes a month to settle; a defence has no role to settle and its
   * whole forward case is its next few opponents, which is a shorter and more
   * honest horizon than one padded to match a different position's.
   */
  horizon: 3,
  /**
   * Priced games a team needs before its mean implied total means anything.
   *
   * Two is not a form line; it is two afternoons. Below this the fallback
   * declines rather than averaging a fortnight into a season.
   */
  minFormGames: 3,
} as const;

/** One future week, and which anchor answered it. */
export interface DstOutlookWeek {
  week: number;
  opponent: string | null;
  bye: boolean;
  /** True at home, false away, null when the fixture list has not been read. */
  home: boolean | null;
  /** The anchor used, whatever it came from. Null on a bye or an unrated week. */
  opponentImpliedTotal: number | null;
  /** Where that number came from. Never presented as more than it is. */
  basis: 'line' | 'form' | 'unknown';
  /** This league's points for that anchor. Null when the week is unrated. */
  points: number | null;
}

export interface DstOutlook {
  team: string;
  weeks: DstOutlookWeek[];
  /** Mean points across the weeks that could be valued. Null when none could. */
  perWeek: number | null;
  /** Per-week value times the weeks he is actually there for. */
  total: number | null;
  /** Weeks valued off a real line, and off form. Both, so a caller can judge. */
  ratedFromLine: number;
  ratedFromForm: number;
  /** Weeks in the window with a fixture, i.e. excluding byes. */
  playable: number;
  byes: number[];
  confidence: 'medium' | 'low' | 'unknown';
  /** One phrase for a row. */
  display: string;
  notes: string[];
}

/** The team's average implied total across games the market has priced. */
export interface TeamForm {
  impliedTotal: number;
  games: number;
}

export function noDstOutlook(team: string, notes: string[] = []): DstOutlook {
  return {
    team,
    weeks: [],
    perWeek: null,
    total: null,
    ratedFromLine: 0,
    ratedFromForm: 0,
    playable: 0,
    byes: [],
    confidence: 'unknown',
    display: 'no outlook available',
    notes,
  };
}

/**
 * Rate a set of future weeks for one defence.
 *
 * `weeks` is given rather than derived because the two callers want genuinely
 * different windows — the next three for a hold, the league's own playoff weeks
 * for a stash — and a function that guessed which would be wrong for one of
 * them. Weeks the fixture list does not cover at all are dropped: a hole in an
 * ingest must not read as a bye, which is the one confusion `nfl_schedule`'s
 * upsert was designed to prevent and this is the read path that could reinstate
 * it.
 */
export function dstOutlook(opts: {
  team: string;
  scoring: DstScoring;
  /** This team's stored fixture list. */
  schedule: readonly ScheduleTeamWeek[];
  /** The weeks to rate, in any order. */
  weeks: readonly number[];
  /** Opponent implied totals off priced games, by week, when the market has one. */
  lines?: ReadonlyMap<number, number>;
  /** Mean implied total by team, over games already played. The fallback. */
  form?: ReadonlyMap<string, TeamForm>;
}): DstOutlook {
  const team = opts.team.toUpperCase();
  const wanted = [...new Set(opts.weeks)].sort((a, b) => a - b);
  if (wanted.length === 0) return noDstOutlook(team, ['no weeks to look at']);

  const byWeek = new Map<number, ScheduleTeamWeek>();
  for (const row of opts.schedule) {
    if (row.team.toUpperCase() === team) byWeek.set(row.week, row);
  }
  if (byWeek.size === 0) return noDstOutlook(team, [`no stored schedule for ${team}`]);

  const lines = opts.lines ?? new Map<number, number>();
  const form = opts.form ?? new Map<string, TeamForm>();
  const notes: string[] = [];

  const weeks: DstOutlookWeek[] = [];
  for (const week of wanted) {
    const fixture = byWeek.get(week);
    /*
     * A week the fixture list does not mention is not a bye.
     *
     * The stored schedule is upserted per `(season, week, team)`, so a
     * truncated read leaves a hole rather than a wrong row — and a hole here
     * looks exactly like a week off. It is dropped from the window instead,
     * which costs coverage and never invents a rest week.
     */
    if (!fixture) continue;

    if (!fixture.opponent) {
      weeks.push({ week, opponent: null, bye: true, home: null, opponentImpliedTotal: null, basis: 'unknown', points: null });
      continue;
    }

    const opponent = fixture.opponent.toUpperCase();
    const priced = lines.get(week) ?? null;
    const seasonForm = form.get(opponent) ?? null;
    const anchor =
      priced != null
        ? { value: priced, basis: 'line' as const }
        : seasonForm && seasonForm.games >= DST_OUTLOOK.minFormGames
          ? { value: seasonForm.impliedTotal, basis: 'form' as const }
          : null;

    if (!anchor) {
      weeks.push({
        week,
        opponent,
        bye: false,
        home: fixture.home,
        opponentImpliedTotal: null,
        basis: 'unknown',
        points: null,
      });
      continue;
    }

    const projection = outlookDst({ opponentImpliedTotal: anchor.value, scoring: opts.scoring, home: fixture.home });
    weeks.push({
      week,
      opponent,
      bye: false,
      home: fixture.home,
      opponentImpliedTotal: projection.opponentImpliedTotal,
      basis: anchor.basis,
      points: projection.points,
    });
  }

  if (weeks.length === 0) return noDstOutlook(team, [`the stored schedule does not cover week${wanted.length === 1 ? '' : 's'} ${wanted.join(', ')}`]);

  const byes = weeks.filter((w) => w.bye).map((w) => w.week);
  const rated = weeks.filter((w) => w.points != null);
  const ratedFromLine = rated.filter((w) => w.basis === 'line').length;
  const ratedFromForm = rated.filter((w) => w.basis === 'form').length;
  const playable = weeks.filter((w) => !w.bye).length;

  const perWeek = rated.length === 0 ? null : round2(rated.reduce((a, w) => a + (w.points ?? 0), 0) / rated.length);
  const availableWeeks = playable;

  const confidence: DstOutlook['confidence'] =
    rated.length === 0 ? 'unknown' : ratedFromForm === 0 ? 'medium' : 'low';

  if (ratedFromForm > 0) {
    notes.push(
      `${ratedFromForm} of these weeks are rated on the opponent’s average implied total so far this season, not on a line for that game`,
    );
  }
  const unrated = weeks.filter((w) => !w.bye && w.points == null).length;
  if (unrated > 0) notes.push(`${unrated} week(s) could not be rated at all and were left out rather than counted as ordinary`);
  if (byes.length > 0) notes.push(`bye in week ${byes.join(', ')} — ${availableWeeks} of these ${weeks.length} weeks are playable`);

  return {
    team,
    weeks,
    perWeek,
    total: perWeek == null ? null : round2(perWeek * availableWeeks),
    ratedFromLine,
    ratedFromForm,
    playable,
    byes,
    confidence,
    display: displayFor(perWeek, rated.length, weeks.length),
    notes,
  };
}

/**
 * The opponents' implied totals a caller can reach without a line.
 *
 * Built from the games the market **has** priced: every stored event with both
 * a total and a placeable spread contributes one implied total to each side,
 * and a team's mean across them is what this returns. It is deliberately a mean
 * over that team's own games rather than anything opponent-adjusted — an
 * adjustment would be a model, and a mean is a measurement.
 */
export function teamFormFromGames(
  games: readonly { team: string; impliedTotal: number }[],
): Map<string, TeamForm> {
  const totals = new Map<string, { sum: number; games: number }>();
  for (const game of games) {
    const team = game.team.toUpperCase();
    if (!Number.isFinite(game.impliedTotal)) continue;
    const entry = totals.get(team) ?? { sum: 0, games: 0 };
    entry.sum += game.impliedTotal;
    entry.games += 1;
    totals.set(team, entry);
  }
  const out = new Map<string, TeamForm>();
  for (const [team, entry] of totals) {
    out.set(team, { impliedTotal: round2(entry.sum / entry.games), games: entry.games });
  }
  return out;
}

/**
 * How favourable a stretch reads, in the app's existing vocabulary.
 *
 * Against the same neutral implied total the projection is built around rather
 * than against the rest of the league, because a mean across the league would
 * need every defence rated to say anything and this is asked about one.
 */
function displayFor(perWeek: number | null, rated: number, total: number): string {
  if (perWeek == null) return 'no outlook available';
  const coverage = rated === total ? '' : ` (${rated} of ${total} weeks rated)`;
  return `${perWeek.toFixed(1)} pts a week over the next ${total}${coverage}`;
}

/** Weeks after `fromWeek`, for the ordinary forward window. */
export function forwardWeeks(fromWeek: number, horizon = DST_OUTLOOK.horizon): number[] {
  return Array.from({ length: horizon }, (_, i) => fromWeek + i + 1);
}

/** Whether an implied total is a favourable one to be facing. */
export function facingLowScoring(opponentImpliedTotal: number | null): boolean {
  return opponentImpliedTotal != null && opponentImpliedTotal <= DST_BASELINES.neutralImpliedTotal - 3;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
