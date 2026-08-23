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
 * The division of labour the screen rests on — Sleeper owns the score, this app
 * owns the forecast, and availability is priced once rather than twice — is
 * documented where it is implemented, in `core/matchup/build.ts`.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { SleeperMatchup, LeagueRecord } from '../../core/sleeper/types.ts';
import {
  buildMatchupResponse,
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
   */
  async forLeague(leagueId: string, opts: { week?: number | null } = {}): Promise<MatchupResponse> {
    return buildMatchupResponse(this.sources(), leagueId, opts);
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
      record: (opts) => this.record(opts),
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
