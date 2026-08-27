/**
 * The Matchup screen's one request, over this deployment's own data.
 *
 * The assembly itself is `core/matchup/build.ts` and is not repeated here. What
 * is left is the half that can only exist on a server: the D1 reads, the
 * Sleeper client, the forecast cache keyed by the database this request is
 * serving, and the calibration ledger. Everything this file does is satisfy
 * {@link MatchupSources} — which is also what Demo Mode does, from fixtures, so
 * the two cannot answer the same matchup differently.
 *
 * ## Two entry points, and the difference between them is the point
 *
 * {@link MatchupService.forLeague} answers the screen and writes nothing. It is
 * what `GET /api/leagues/:id/matchup` calls, and it passes no ledger, so no
 * amount of wiring below it can reach a write.
 *
 * {@link MatchupService.captureCalibration} and {@link
 * MatchupService.settleFinishedWeeks} are the ledger, and they are server-owned:
 * the worker's `scheduled()` calls them and nothing routed does. That split is
 * the repair for the audit's F-01. Before it, the ledger was written from inside
 * the GET — so a read mutated the database, method-based auth waved it through
 * as safe, and a browser in Demo Mode wrote rows to the live calibration table
 * by doing nothing worse than opening a screen.
 *
 * The division of labour the screen rests on — Sleeper owns the score, this app
 * owns the forecast, and availability is priced once rather than twice — is
 * documented where it is implemented, in `core/matchup/build.ts`.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { SleeperMatchup, LeagueRecord } from '../../core/sleeper/types.ts';
import {
  buildMatchupResponse,
  isWeekSettled,
  type MatchupLedger,
  type MatchupObservation,
  type MatchupResponse,
  type MatchupSources,
} from '../../core/matchup/build.ts';
import type { MatchupForecast } from '../../core/matchup/model.ts';
import type { PreviousInsightState } from '../../core/matchup/insights.ts';
import type { MatchupSide } from '../../core/matchup/types.ts';
import { LeagueRepo } from '../repos/league.ts';
import { MatchupRepo } from '../repos/matchup.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import type { Database } from '../db.ts';

/*
 * Re-exported so the endpoint, the tests and anything else that already imports
 * from this module keep working. The definitions are `core`'s.
 */
export {
  buildSlotSpecs,
  activeProjection,
  resolveWeek,
  isWeekSettled,
  type MatchupResponse,
} from '../../core/matchup/build.ts';

/**
 * Forecasts, keyed by the state that produced them.
 *
 * Module state keyed by the database object rather than a global, exactly like
 * the refresh orchestrator's dedupe: two deployments (or two tests) sharing a
 * process must not be able to serve each other's matchups. A Worker isolate
 * lives long enough to absorb a burst of polling and short enough that this
 * never becomes a store.
 */
const CACHE = new WeakMap<Database, { fingerprint: string; response: MatchupResponse }>();

/**
 * How many unsettled weeks one scheduled run will close.
 *
 * Weeks accrue at one a week, so in steady state this is never reached and the
 * cap costs nothing. It is here for the first run after this shipped, and for
 * the run after an outage, where the backlog is however many weeks went by —
 * and one Sleeper request per week is not something to do an unbounded number
 * of on a tick that also syncs a player dictionary. Four a run drains a full
 * season inside five days, and {@link MatchupService.settleFinishedWeeks}
 * reports what it left.
 */
export const SETTLE_WEEKS_PER_RUN = 4;

export class MatchupService {
  constructor(
    private readonly db: Database,
    private readonly deps: { sleeper: SleeperClient; now?: () => Date },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The current — or a named — week's matchup for the league's own roster.
   *
   * The week comes from Sleeper's `/state/nfl` unless the caller names one, and
   * it is never computed from the calendar: see `core/season/context.ts` for
   * the six copies of that arithmetic this app deleted.
   *
   * A read. Three arguments to `buildMatchupResponse` and no ledger, so this
   * call cannot write a row however many times it is made and whoever makes it.
   */
  async forLeague(leagueId: string, opts: { week?: number | null } = {}): Promise<MatchupResponse> {
    return buildMatchupResponse(this.sources(), leagueId, opts);
  }

  /**
   * The same sources, for a caller that means to record them.
   *
   * The support snapshot wraps these in a recording proxy and runs the identical
   * assembly, so the file it emits describes the forecast this service would
   * have produced. Exposed rather than rebuilt in the snapshot module for the
   * usual reason: a second construction of the same eight reads is a second
   * chance for them to differ.
   *
   * Still a read. There is no ledger on this object, so no caller of it can
   * write however many times it is called.
   */
  supportSources(): MatchupSources {
    return this.sources();
  }

  /** This deployment, as the assembly is allowed to see it. */
  private sources(): MatchupSources {
    const leagueRepo = new LeagueRepo(this.db);
    return {
      leagues: {
        getLeague: (id) => leagueRepo.getLeague(id),
        listRosters: (id) => leagueRepo.listRosters(id),
      },
      matchups: (league: LeagueRecord, week: number) =>
        this.deps.sleeper.getMatchups(league.sleeperLeagueId, week) as Promise<SleeperMatchup[]>,
      nflState: () => new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null),
      startSitInputs: (playerIds) => startSitInputsFor(this.db, playerIds),
      /*
       * Read from the database only. The fetch runs on the crons, so a matchup
       * request — which on a Sunday is one every thirty seconds — never waits on
       * Sleeper for a number it is allowed to show and not to reason with.
       *
       * No `positionOf` here, and that is a decision rather than an omission.
       * The tight-end-premium case it exists for needs a position per player and
       * this bag deliberately does not carry the evaluations — so in such a
       * league `sleeperScoringKey` refuses every unknown position and this path
       * yields no fallback at all, which is the safe direction. Every other
       * league is unaffected, because position only matters when there is a
       * premium.
       */
      publishedProjections: (opts) =>
        new SleeperProjectionService(this.db, this.deps.sleeper).publishedFor({
          season: opts.season,
          week: opts.week,
          playerIds: opts.playerIds,
          profile: opts.profile,
        }),
      previousForecast: (opts) => this.previousState(opts.leagueId, opts.season, opts.week, opts.rosterId),
      cached: () => CACHE.get(this.db) ?? null,
      remember: (entry) => CACHE.set(this.db, entry),
      now: () => this.now(),
    };
  }

  /** What the last stored forecast said, so "changed since" is answerable. */
  private async previousState(
    leagueId: string,
    season: string,
    week: number,
    rosterId: number,
  ): Promise<PreviousInsightState | null> {
    const stored = await new MatchupRepo(this.db)
      .latest({ leagueId, season, week, rosterId })
      .catch(() => null);
    const cached = CACHE.get(this.db);
    if (cached?.response.forecast) {
      return {
        fingerprint: cached.response.forecast.fingerprint,
        winProbability: cached.response.forecast.teams.mine.winProbability ?? 0.5,
        relevantSince: Object.fromEntries(
          cached.response.forecast.insights.map((i) => [i.key, i.relevantSince]),
        ),
      };
    }
    if (!stored?.fingerprint) return null;
    return {
      fingerprint: stored.fingerprint,
      winProbability: stored.winProbability ?? 0.5,
      relevantSince: {},
    };
  }

  // ------------------------------------------------------- the ledger, on a clock
  //
  // Everything below here writes, everything above it does not, and the line
  // between them is not a convention: nothing routed reaches past this comment.
  // The two callers are in `worker/index.ts`, on the scheduled handler.

  /**
   * Write down what the model believes about this week, now.
   *
   * The calibration sample this app exists to eventually be graded on. One row
   * per roster per week: the first forecast is written once by the database
   * itself (`ON CONFLICT DO NOTHING`) and the latest columns move on every
   * later capture, so running this on three clocks a day accumulates no
   * duplicate observations — repeating it is a no-op on the sample and an
   * update on the running commentary.
   *
   * **Why a clock rather than the screen.** It used to ride the Matchup GET,
   * which made two different things wrong at once. The auditable one is that a
   * read wrote to the database and the method-based write guard could not see
   * it. The quieter one is that it made the calibration sample a function of
   * browsing: `first_phase` recorded when somebody first *looked*, so a week
   * nobody opened before kickoff produced no pregame sample at all and a week
   * first opened at half-time produced one graded as live. A cron looks every
   * day, whether or not anybody does, which is the only way `first_phase =
   * 'pregame'` means what the calibration report says it means.
   *
   * Never served from the request cache — {@link buildMatchupResponse} refuses
   * the short-circuit whenever a ledger is present — and it does not warm that
   * cache either, so a capture is invisible to the screen in both directions.
   */
  async captureCalibration(
    leagueId: string,
    opts: { week?: number | null } = {},
  ): Promise<{ recorded: boolean; week: number | null; phase: string | null }> {
    const observed: MatchupObservation[] = [];
    const ledger: MatchupLedger = {
      record: async (observation) => {
        observed.push(observation);
        await this.record(observation);
      },
    };
    const response = await buildMatchupResponse(this.captureSources(), leagueId, opts, ledger);
    const seen = observed[0] ?? null;
    return {
      recorded: seen != null,
      week: response.week,
      phase: seen?.forecast.phase ?? null,
    };
  }

  /**
   * Fill in the outcome of every week that can no longer change.
   *
   * The half of the ledger that has nothing to do with the model: who won is a
   * fact from Sleeper, so this reads the scores and writes them, and never
   * simulates anything to learn a final score it can be told.
   *
   * It exists because settlement used to be a side effect too — the old
   * recorder closed a week out only when a GET happened to land while the
   * forecast read `final`, which is a window of a few hours between the last
   * whistle and Sleeper rolling the week over. A week nobody looked at in that
   * window kept its forecasts forever and never got an outcome, and a forecast
   * with no outcome is excluded from every calibration band — the sample was
   * collected and then thrown away. On a clock it closes whether anybody looked
   * or not, and it closes the backlog an outage left behind.
   *
   * Bounded per run, oldest first, and it reports what is still outstanding
   * afterwards — weeks past the cap, and weeks it tried and could not close
   * because Sleeper had no scores for them. A cap that reports nothing reads as
   * "there was nothing left".
   */
  async settleFinishedWeeks(
    leagueId: string,
    opts: { limit?: number } = {},
  ): Promise<{ settled: { season: string; week: number; rosters: number }[]; pending: number }> {
    const limit = opts.limit ?? SETTLE_WEEKS_PER_RUN;
    const repo = new MatchupRepo(this.db);
    const league = await new LeagueRepo(this.db).getLeague(leagueId);
    if (!league) return { settled: [], pending: 0 };

    const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const currentWeek = state?.week ?? null;
    const seasonType = state?.seasonType ?? null;

    /*
     * A week is closeable when the season has moved past it.
     *
     * Two different questions, because `isWeekSettled` compares week numbers and
     * is therefore only meaningful inside the season Sleeper is currently
     * reporting. Any earlier season is over by arithmetic — its week seventeen
     * cannot still be playing while this season is under way — so it is settled
     * without asking, which is also what makes a backlog from a previous year
     * closeable at all.
     */
    const closeable = (await repo.unsettledWeeks(leagueId)).filter((row) =>
      row.season < league.season ? true : row.season === league.season && isWeekSettled(currentWeek, row.week, seasonType),
    );

    const settled: { season: string; week: number; rosters: number }[] = [];
    for (const target of closeable.slice(0, limit)) {
      const rosters = await this.settleWeek(repo, league, target.season, target.week);
      if (rosters > 0) settled.push({ ...target, rosters });
    }
    /*
     * Everything closeable this run did not close, not merely everything past
     * the cap. A week attempted while Sleeper had no scores for it is still
     * waiting, and counting only the untried ones would report zero outstanding
     * on a run that closed nothing at all.
     */
    return { settled, pending: Math.max(0, closeable.length - settled.length) };
  }

  /**
   * One week, closed out from Sleeper's own totals.
   *
   * Both scores or neither. A roster whose opponent is missing from the payload
   * — a bye, a mid-season roster removal, a week Sleeper answers empty — is left
   * unsettled rather than graded against a zero it never played, because a
   * fabricated loss in a calibration band is worse than a missing sample.
   */
  private async settleWeek(
    repo: MatchupRepo,
    league: LeagueRecord,
    season: string,
    week: number,
  ): Promise<number> {
    const rows = await this.deps.sleeper
      .getMatchups(league.sleeperLeagueId, week)
      .catch(() => [] as SleeperMatchup[]);
    const points = new Map<number, number>();
    for (const row of rows) {
      if (row.points == null || !Number.isFinite(row.points)) continue;
      points.set(row.roster_id, row.points);
    }
    if (points.size === 0) return 0;

    const at = this.now().toISOString();
    let closed = 0;
    for (const { rosterId, opponentRosterId } of await repo.unsettledRosters({ leagueId: league.id, season, week })) {
      if (opponentRosterId == null) continue;
      const mine = points.get(rosterId);
      const theirs = points.get(opponentRosterId);
      if (mine == null || theirs == null) continue;
      await repo.settle({
        leagueId: league.id,
        season,
        week,
        rosterId,
        finalScore: mine,
        opponentFinalScore: theirs,
        at,
      });
      closed++;
    }
    return closed;
  }

  /**
   * This deployment, for a capture rather than for a screen.
   *
   * The same reads, with the request memo taken out at both ends. `cached`
   * answers null so a capture is never served a response it did not compute
   * (belt to `buildMatchupResponse`'s braces, which already refuses the
   * short-circuit for a ledger-carrying call), and `remember` drops the result
   * so a cron's forecast never becomes the response a phone is handed.
   */
  private captureSources(): MatchupSources {
    return { ...this.sources(), cached: () => null, remember: () => undefined };
  }

  /**
   * Write the forecast to the calibration ledger, and close the week if it is
   * over.
   *
   * Both sides are recorded. A calibration set built only from the user's own
   * roster would be exactly half the samples available and would carry whatever
   * bias the user's own roster has; the opponent's forecast is the same model's
   * prediction and is worth just as much.
   */
  private async record(opts: {
    leagueId: string;
    season: string;
    week: number;
    forecast: MatchupForecast;
    mineRosterId: number;
    theirsRosterId: number;
    matchupId: number | null;
    at: string;
  }): Promise<void> {
    const repo = new MatchupRepo(this.db);
    const { forecast } = opts;
    const sides: { side: MatchupSide; rosterId: number; opponentRosterId: number }[] = [
      { side: 'mine', rosterId: opts.mineRosterId, opponentRosterId: opts.theirsRosterId },
      { side: 'theirs', rosterId: opts.theirsRosterId, opponentRosterId: opts.mineRosterId },
    ];

    for (const { side, rosterId, opponentRosterId } of sides) {
      const team = forecast.teams[side];
      await repo.record({
        leagueId: opts.leagueId,
        season: opts.season,
        week: opts.week,
        rosterId,
        matchupId: opts.matchupId,
        opponentRosterId,
        modelVersion: forecast.modelVersion,
        phase: forecast.phase,
        winProbability: team.winProbability,
        projectedFinal: team.projectedFinal,
        actual: team.actual,
        confidence: forecast.freshness.level,
        fingerprint: forecast.fingerprint,
        at: opts.at,
      });
    }

    if (forecast.phase !== 'final') return;
    for (const { side, rosterId } of sides) {
      const other = side === 'mine' ? 'theirs' : 'mine';
      await repo.settle({
        leagueId: opts.leagueId,
        season: opts.season,
        week: opts.week,
        rosterId,
        finalScore: forecast.teams[side].actual,
        opponentFinalScore: forecast.teams[other].actual,
        at: opts.at,
      });
    }
  }
}
