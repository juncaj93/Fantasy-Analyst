/**
 * Buy low, sell high: value arbitrage, which is a different trade from an
 * upgrade.
 *
 * Every other path into the trade board starts from a hole — the lineup is
 * short somewhere and the question is who fills it. This one starts from a
 * **gap between what a player was expected to be and what he has actually
 * done**, and that gap is worth acting on whether or not there is a hole. The
 * two most expensive words in fantasy football are "my lineup is fine".
 *
 * ## The expectation, and why it is the preseason number
 *
 * Underperformance has to be measured against something that was written down
 * *before* the underperformance. There are two candidates in this app and only
 * one of them survives the question:
 *
 *   - **The weekly betting market.** Better, and unavailable: `player_props`
 *     keeps the current week's lines and one prior snapshot. There is no per-
 *     week historical market to compare a week 4 performance against, and
 *     building one would mean storing every refresh for the season.
 *   - **The preseason projection.** Stored once, never rewritten, keyed by the
 *     league's own scoring, and derived from betting markets in the first place
 *     — see `core/draft/preseasonPoints.ts`. It is the expectation that was
 *     actually held, which is precisely what an arbitrage read needs.
 *
 * So: preseason season-points divided by a season of games, against what he has
 * actually produced, week by week.
 *
 * ## Recency, because a bad September is not a bad November
 *
 * Alex's instruction, and it is the correct one: *a bad week 6 weeks ago
 * matters less than a bad week 2 weeks ago.* The residuals are combined under
 * {@link RECENCY_WEIGHTS} — the same weights the usage detector already uses,
 * imported rather than restated, so "recent" means one thing in this codebase.
 *
 * ## Why touchdowns are the sell signal and not the buy signal
 *
 * Also Alex's, and it is a real property rather than a heuristic: touchdown
 * rate is **non-sticky**. A receiver scoring on 12% of his catches is not a
 * receiver who will keep scoring on 12% of his catches. So a player whose
 * overperformance is *made of touchdowns* is the sell, and the same
 * overperformance made of yardage and volume is not — that is a player whose
 * role grew, and selling him is the mistake this module would otherwise cause.
 *
 * Quarterbacks included, since 29 September 2026. They used to be a full-
 * strength sell whatever the line was made of, beside a reason printed on the
 * card that called the same production a real gain. A passer's touchdowns are
 * already weighted at four points to six in the dependency read, and a passer
 * throwing 38 times a week has a workload like anyone else.
 *
 * The dependency read is `core/startsit/tdDependency.ts`, unchanged and
 * unreweighted. It already reconstructs production from stored volume and
 * already knows the difference between a goal-line role and a run of luck.
 *
 * ## What the tally does, and what it does not
 *
 * The newsletter tally — the `+N` beside a player everywhere else in the app —
 * is a **reinforcement**, never an origin. It cannot create a buy-low or a
 * sell-high read and it cannot veto one; it scales a read the production
 * residual has already established, within {@link ARBITRAGE.tallyInfluence}.
 *
 * It reinforces *both* directions, which looks wrong for one second and is
 * Alex's own reasoning: a declining tally on an underperformer is the rest of
 * the league writing him off, which is what makes him cheap; a declining tally
 * on an overperformer is the narrative turning before the production does,
 * which is what makes now the moment to sell. In both cases the tally is saying
 * the same thing — *the story is moving against him* — and in both cases that
 * is the trade.
 *
 * ## Safety
 *
 * Pure. It reads values and returns a reading. It proposes no trade, contacts
 * nobody, and — like every other module in this directory — never acts.
 */

import { EXPECTED_GAMES } from '../nfl/expectedGames.ts';
import { RECENCY_WEIGHTS, assessUsage } from '../startsit/usageTrend.ts';
import { TD_DEPENDENCY, assessTdDependency, type TdDependencyAssessment } from '../startsit/tdDependency.ts';
import type { PlayerSignal } from '../evidence/types.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { UsageWeek } from '../usage/role.ts';

export const ARBITRAGE = {
  /**
   * Regular-season games before any arbitrage claim is made.
   *
   * Three. Two games is one hot afternoon and one quiet one, which is the exact
   * sample this module must not trade on — and it is below
   * {@link TD_DEPENDENCY.minGames}, so a sell-high read cannot even ask its own
   * touchdown question at two.
   */
  minGames: 3,
  /**
   * Games of preseason expectation a season projection is spread over.
   *
   * Shared with `core/matchup/build.ts` since 15 September 2026, when the
   * Matchup screen started dividing the same season total for the same reason
   * — see `core/nfl/expectedGames.ts` for the number itself and for why
   * seventeen is the wrong one. Named here rather than re-derived so the two
   * cannot drift, and kept on this object so the constant reads the same at
   * every call site in this file.
   */
  expectedGames: EXPECTED_GAMES,
  /**
   * Points per game of shortfall at which a buy-low read is maxed out.
   *
   * Five. A flex player running five points a week under his own preseason
   * number has lost a tier, which is as far as this scale needs to go: past it
   * the read is already at full strength and the extra points say nothing new.
   */
  referenceResidual: 5,
  /** Per-game shortfall below which nothing is claimed in either direction. */
  minResidual: 1.5,
  /**
   * The most the newsletter tally may scale a read, either way.
   *
   * A quarter. Large enough that a story moving against a player is visible in
   * the ordering and small enough that it can never be the read: at zero
   * production residual the tally multiplies nothing, which is the property
   * that makes "reinforcement, never origin" true by arithmetic rather than by
   * assertion.
   */
  tallyInfluence: 0.25,
  /**
   * Net tally movement over 30 days treated as a full negative turn.
   *
   * Three. The tally is a count of newsletter mentions net of their direction,
   * so three net negative items inside a month is a story rather than an
   * article — and it is the point past which extra items say nothing new,
   * because the scale is clamped there.
   */
  tallyTurn: 3,
  /**
   * Strength below which a read is not worth a row.
   *
   * The scale is 0–1 and this is a third of it. Below that the residual is
   * inside the noise of a handful of games and surfacing it would be the
   * "manufacture filler" failure the trade board is written against.
   */
  minStrength: 0.34,
  /**
   * Usage score (−1 to 1, `assessUsage`) at which a workload backs the production.
   *
   * Half way from a streamer's volume to a full every-down role. Past it the
   * player is getting the touches or targets a starter gets, and production
   * built on that is a role rather than a streak.
   */
  roleSupported: 0.5,
  /**
   * What a real workload, or a real scoring role, does to a sell-high read.
   *
   * Halved for each, not zeroed: touchdown rate still regresses for a back
   * with a goal-line job, so the read survives when the touchdown share is
   * large. What it stops doing is calling a player whose usage explains his
   * line a sell at full strength. Alex, 29 September 2026, on Kenneth Walker:
   * outperforming expectations is not automatically "sell before it
   * disappears" when the usage supports it.
   */
  roleDiscount: 0.5,
  /**
   * Interceptions per pass attempt, for a week the league's own points do not
   * cover yet.
   *
   * The stored usage has no interception column, so a quarterback scored from
   * it alone would never lose the league's two points for one, and every
   * passer would read about 1.6 points a game better than he played. 2.3% is
   * the NFL's rate over recent seasons. Only a fallback: a week the stored
   * season points cover is read as the league scored it, interceptions and
   * fumbles included.
   */
  interceptionRate: 0.023,
} as const;

export type ArbitrageKind = 'buy_low' | 'sell_high';

/** One player's arbitrage reading, or the absence of one. */
export interface ArbitrageRead {
  playerId: string;
  kind: ArbitrageKind;
  /** 0–1. Comparable within one run and within one kind. */
  strength: number;
  /** Per-game points against the preseason expectation. Signed. */
  residualPerGame: number;
  /** Per-game points the preseason projection implied. */
  expectedPerGame: number;
  /** Per-game points actually produced, recency-weighted. */
  observedPerGame: number;
  games: number;
  /** The touchdown read behind a sell, carried so a card need not recompute it. */
  tdDependency: TdDependencyAssessment;
  /** What the tally did to the strength, as a multiplier applied. */
  tallyFactor: number;
  /** One sentence a screen prints, in the app's own voice. */
  headline: string;
  /** The two or three facts behind it, biggest first. */
  reasons: string[];
}

export interface ArbitrageInput {
  playerId: string;
  name: string;
  position: string;
  /** Preseason season-points projection, in this league's scoring. */
  preseasonPoints: number | null;
  /** Stored weekly usage: which weeks he played, and a week's production when the league's points do not cover it. */
  weeks: UsageWeek[];
  /**
   * The league's scoring, the same rules the preseason number is written in.
   *
   * Both sides of the subtraction have to be scored the same way. Until
   * 3 November 2026 production was scored with no catch points and 4-point
   * passing touchdowns against a preseason number in half PPR with 6-point
   * passing touchdowns, so every pass catcher and every quarterback read as
   * "buy low" (45 of 46 reads; review T2).
   */
  scoring: ScoringProfile;
  /**
   * What he actually scored in this league, week by week (index 0 is week 1),
   * from the stored season row (`sleeper.seasonPoints.<season>`). Null when the
   * row is not stored. A week inside `leaguePointsThrough` is read from here.
   */
  leaguePoints?: readonly number[] | null;
  /** The last week the stored season row covers. */
  leaguePointsThrough?: number;
  /** The newsletter tally, for the reinforcement term. Null is neutral. */
  signal: PlayerSignal | null;
}

/**
 * Read one player for arbitrage, in whichever direction the evidence points.
 *
 * Returns null far more often than not, and that is the intended behaviour: the
 * ordinary state of a player is "roughly what he was expected to be", and a
 * module that found a story in every roster would be a module finding stories
 * in noise.
 */
export function readArbitrage(input: ArbitrageInput): ArbitrageRead | null {
  const position = (input.position ?? '').toUpperCase();
  const games = regularWeeks(input.weeks);
  if (games.length < ARBITRAGE.minGames) return null;
  if (input.preseasonPoints == null || !(input.preseasonPoints > 0)) return null;

  const expectedPerGame = round2(input.preseasonPoints / ARBITRAGE.expectedGames);
  const observedPerGame = weightedRecent(
    games.map((w) => leagueWeekPoints(w.week, input) ?? productionOf(w, input.scoring, position)),
  );
  if (observedPerGame == null) return null;

  const residualPerGame = round2(observedPerGame - expectedPerGame);
  if (Math.abs(residualPerGame) < ARBITRAGE.minResidual) return null;

  const td = assessTdDependency(position, input.weeks);
  const tally = tallyFactorOf(input.signal);

  const base = clamp01(Math.abs(residualPerGame) / ARBITRAGE.referenceResidual);
  const kind: ArbitrageKind = residualPerGame < 0 ? 'buy_low' : 'sell_high';

  /*
   * The touchdown gate, and it applies to exactly one direction.
   *
   * Overperforming *on touchdowns* is the sell this module exists for, and
   * overperforming on yardage and volume is a player whose role grew, which is
   * the opposite of a sell. Every position, quarterback included. `stickiness` is that distinction as a multiplier,
   * and at 0 there is no sell-high read at all.
   *
   * Buy-low never reads it. A player underperforming his expectation is cheap
   * however the shortfall is composed, and asking "but was it touchdowns" of a
   * player who has not scored any would be asking nothing.
   */
  const usage = assessUsage(position, input.weeks);
  const roleBacked = kind === 'sell_high' && !usage.unknown && usage.score >= ARBITRAGE.roleSupported;
  const stickiness =
    kind === 'sell_high' ? regressionRisk(position, td) * (roleBacked ? ARBITRAGE.roleDiscount : 1) : 1;
  const strength = round2(clamp01(base * stickiness * tally.factor));
  if (strength < ARBITRAGE.minStrength) return null;

  return {
    playerId: input.playerId,
    kind,
    strength,
    residualPerGame,
    expectedPerGame,
    observedPerGame: round2(observedPerGame),
    games: games.length,
    tdDependency: td,
    tallyFactor: tally.factor,
    headline: headlineFor({ kind, name: input.name, residualPerGame, expectedPerGame, td, position }),
    reasons: reasonsFor({
      kind,
      residualPerGame,
      expectedPerGame,
      games: games.length,
      td,
      tally,
      position,
      role: roleBacked ? usage.display : null,
    }),
  };
}

/**
 * How much a touchdown-driven overperformance is expected to give back.
 *
 * It rises with the share of production that came from the end zone, because
 * that share is the part of a line that does not carry forward. The same rule
 * for every position: a quarterback used to read 1 here whatever his line was
 * made of. Below {@link TD_DEPENDENCY.independent} it is zero: a receiver
 * running hot on yardage and volume is not a sell, he is a player whose role
 * grew, and this module has no business suggesting he be moved.
 *
 * `td_driven_with_role` is not exempted the way the start/sit component
 * exempts it, and it is not charged in full either. The scoring rate of a
 * goal-line back regresses however repeatable his role is, which is why he
 * stays a candidate; a back who scores in most games *with* the volume to do it
 * is also a worse candidate than a receiver who caught two long ones, which is
 * why it is halved ({@link ARBITRAGE.roleDiscount}). Until 29 September 2026
 * the two were charged the same.
 *
 * Unmeasured is zero. The touchdown read needs four games and a sell-high read
 * starts at three, and for that week the read used to survive at 0.4 with no
 * reason behind it: "running over expectation, sell into it". That is the
 * "outperforming is not a sell" case exactly, so it now waits a week for the
 * number that says why.
 */
export function regressionRisk(_position: string, td: TdDependencyAssessment): number {
  if (td.share == null) return 0;
  if (td.share <= TD_DEPENDENCY.independent) return 0;
  const risk = clamp01((td.share - TD_DEPENDENCY.independent) / (TD_DEPENDENCY.dependent - TD_DEPENDENCY.independent));
  return round2(td.profile === 'td_driven_with_role' ? risk * ARBITRAGE.roleDiscount : risk);
}

/**
 * What the newsletter tally does to a read it did not create.
 *
 * Reinforcement in one direction only. A tally turning negative scales a read
 * **up** — for a buy-low that is the league writing him off, for a sell-high it
 * is the narrative turning before the production does — and a tally that is
 * positive or flat leaves the read exactly where the residual put it rather
 * than scaling it down.
 *
 * That asymmetry is deliberate and is the conservative choice: a rising tally
 * on an underperformer is a reason somebody else may already have noticed him,
 * not a reason to doubt the shortfall, and shrinking the read for it would be
 * inventing a second opinion out of a first.
 *
 * `last30` rather than lifetime, because the question is about a story that is
 * moving. A player with a strongly positive career tally and three bad weeks of
 * coverage is precisely the buy-low this reinforces.
 */
export function tallyFactorOf(signal: PlayerSignal | null): { factor: number; net: number; items: number } {
  const net = signal?.last30.net ?? 0;
  const items = signal?.last30.items ?? 0;
  if (items === 0 || net >= 0) return { factor: 1, net, items };
  const turn = clamp01(-net / ARBITRAGE.tallyTurn);
  return { factor: round2(1 + ARBITRAGE.tallyInfluence * turn), net, items };
}

/**
 * One week as the league scored it, when the stored season row covers it.
 *
 * The best number there is: Sleeper's own stat line times the league's own
 * values, interceptions, fumbles and bonuses included (checked against
 * Sleeper's matchups to the hundredth, see `core/sleeper/weekPoints.ts`).
 */
function leagueWeekPoints(week: number, input: ArbitrageInput): number | null {
  const points = input.leaguePoints;
  const through = input.leaguePointsThrough ?? 0;
  if (!points || week < 1 || week > through) return null;
  const value = points[week - 1];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Production for one week, scored with the league's own rules.
 *
 * The fallback for a week the stored season points do not cover. Yards,
 * touchdowns and catches at the league's values (half PPR here, plus any tight
 * end bonus), so the number is in the same scoring as the preseason
 * expectation it is compared with. Interceptions are not in the stored usage,
 * so a passer is charged the league-average rate per attempt
 * ({@link ARBITRAGE.interceptionRate}).
 *
 * Exported so a test can state the reconstruction rather than infer it.
 */
export function productionOf(week: UsageWeek, scoring: ScoringProfile, position = ''): number {
  const yards =
    (week.passYards ?? 0) * scoring.pointsPerPassYard +
    (week.rushYards ?? 0) * scoring.pointsPerRushYard +
    (week.recYards ?? 0) * scoring.pointsPerRecYard;
  const tds = (week.rushTds ?? 0) * scoring.rushTd + (week.recTds ?? 0) * scoring.recTd + (week.passTds ?? 0) * scoring.passTd;
  const perCatch = scoring.ppr + (position.toUpperCase() === 'TE' ? scoring.teBonus : 0);
  const catches = (week.receptions ?? 0) * perCatch;
  const picks = (week.passAttempts ?? 0) * ARBITRAGE.interceptionRate * scoring.interception;
  return yards + tds + catches + picks;
}

/**
 * How many games this player has actually produced in, by this module's rules.
 *
 * Exported so the service can say *why* the lane is silent rather than only
 * that it is. In week 2 every player has one game, {@link ARBITRAGE.minGames}
 * is three, and so every read correctly returns null — a state that is
 * indistinguishable from "the market is quiet" unless somebody counts.
 */
export function playedGames(weeks: UsageWeek[]): number {
  return regularWeeks(weeks).length;
}

/** Regular-season weeks only, oldest first, bounded to the recency window. */
function regularWeeks(weeks: UsageWeek[]): UsageWeek[] {
  return weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .filter((w) => hasAnyProduction(w))
    .sort((a, b) => a.week - b.week);
}

/**
 * A week with nothing recorded at all is a week he did not play.
 *
 * Counting it as a zero is the single most effective way to manufacture a
 * buy-low candidate out of an injury — which is not arbitrage, it is the
 * app recommending that Alex buy a player who is hurt because he is hurt.
 * A week where every volume and yardage field is blank is dropped; a week he
 * played and did nothing is kept, because that one is real.
 */
function hasAnyProduction(week: UsageWeek): boolean {
  const fields = [
    week.passAttempts,
    week.carries,
    week.targets,
    week.receptions,
    week.passYards,
    week.rushYards,
    week.recYards,
  ];
  return fields.some((v) => v != null);
}

/**
 * The recency-weighted mean, newest game heaviest.
 *
 * {@link RECENCY_WEIGHTS} is stated newest-first, so the series is reversed
 * before it is zipped. Divided by the weights actually used, so three games and
 * eight games are both averages — a shorter history produces a less certain
 * number, not a smaller one.
 */
function weightedRecent(values: number[]): number | null {
  if (values.length === 0) return null;
  const newestFirst = [...values].reverse();
  let total = 0;
  let weights = 0;
  newestFirst.forEach((value, index) => {
    const weight = RECENCY_WEIGHTS[index] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1] ?? 1;
    total += value * weight;
    weights += weight;
  });
  return weights === 0 ? null : total / weights;
}

function headlineFor(args: {
  kind: ArbitrageKind;
  name: string;
  residualPerGame: number;
  expectedPerGame: number;
  td: TdDependencyAssessment;
  position: string;
}): string {
  const gap = Math.abs(args.residualPerGame).toFixed(1);
  if (args.kind === 'buy_low') {
    return `${args.name} is running ${gap} pts a game under what he was drafted to be. The price should reflect that, and the production probably will not stay there.`;
  }
  const share = args.td.share == null ? null : Math.round(args.td.share * 100);
  return share == null
    ? `${args.name} is running ${gap} pts a game over expectation. Sell into it.`
    : `${args.name} is running ${gap} pts a game over expectation with ${share}% of it from touchdowns, the part of a ${args.position} line that does not repeat.`;
}

function reasonsFor(args: {
  kind: ArbitrageKind;
  residualPerGame: number;
  expectedPerGame: number;
  games: number;
  td: TdDependencyAssessment;
  tally: { factor: number; net: number; items: number };
  position: string;
  /** The usage line when a real workload discounted the sell, else null. */
  role?: string | null;
}): string[] {
  const out: string[] = [];
  const direction = args.kind === 'buy_low' ? 'under' : 'over';
  out.push(
    `${Math.abs(args.residualPerGame).toFixed(1)} pts a game ${direction} his preseason ${args.expectedPerGame.toFixed(1)}, over ${args.games} games, weighted toward the recent ones.`,
  );

  if (args.kind === 'sell_high') {
    if (args.td.share != null) {
      out.push(
        `${Math.round(args.td.share * 100)}% of his production came from ${round1(args.td.touchdowns)} scores in ${args.td.scoringGames} of ${args.td.games} games, and touchdown rate does not carry forward at his position.`,
      );
    }
    if (args.role) {
      out.push(`His workload backs part of it (${args.role}), so this is a weaker sell than the touchdowns alone suggest.`);
    }
  }

  if (args.tally.factor > 1) {
    out.push(
      `The newsletter tally is ${args.tally.net} over ${args.tally.items} item(s) in the last 30 days. The story is moving against him, which is ${args.kind === 'buy_low' ? 'what makes him cheap' : 'why now rather than later'}.`,
    );
  }

  return out;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
