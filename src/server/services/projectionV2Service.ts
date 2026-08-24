/**
 * Projection v2, assembled from the live database and compared against what the
 * app actually shows — and nothing else.
 *
 * ## The one thing to check when reading this file
 *
 * It **calls** the live start/sit engine and it never **changes** it.
 * `evaluatePlayer` is invoked exactly as `GET /api/leagues/:id/team` invokes it,
 * with the same inputs from the same `startSitInputsFor`, so the
 * `marketProjection` this report prints in its comparison column is the same
 * number the Team screen prints — not a reconstruction of it. That is what makes
 * the comparison meaningful and it is also what makes the phase-1 boundary
 * checkable: the arrow points from the live engine into this report, and there
 * is no arrow back.
 *
 * §13: "prove no decision engine changes yet". `tests/projectionV2.boundary.
 * test.ts` asserts that no module under `core/startsit`, `core/matchup`,
 * `core/draft`, `core/trades` or `core/players` imports anything from
 * `core/projection` or `core/nflverse`, so the boundary is a fact about the
 * dependency graph rather than a promise in a comment.
 *
 * ## Degrading
 *
 * Every nflverse read here is wrapped and defaults to empty. With the crosswalk,
 * the snaps and the depth charts all absent — which is the true state of the
 * world in August, when `snap_counts_2026.csv` is a 404 — this produces
 * market-only projections with lowered confidence and a recorded reason, and the
 * report still renders. §26, and it is tested rather than asserted.
 */

import { evaluatePlayer } from '../../core/startsit/engine.ts';
import { marketProjection } from '../../core/startsit/projection.ts';
import { buildScoringProfile } from '../../core/sleeper/scoring.ts';
import { assessRoleChange, type SnapTrend } from '../../core/projection/roleEvidence.ts';
import { buildFeatures, teamWeekTotals, type SnapWeek } from '../../core/projection/features.ts';
import { projectV2, type ProjectionV2 } from '../../core/projection/v2.ts';
import { buildSideBySide, type SideBySideReport } from '../../core/projection/sideBySide.ts';
import { resolveIdentities, identityCoverage, type IdentityCoverage } from '../../core/nflverse/roster.ts';
import { DepthChartRepo, IdentityCrosswalkRepo, SnapCountRepo } from '../repos/nflverse.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PropsRepo } from '../repos/props.ts';
import { UsageRepo } from '../repos/usage.ts';
import { SleeperProjectionsRepo } from '../repos/sleeperProjections.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import { usageSeason } from './usageService.ts';
import type { Database } from '../db.ts';

/** Weeks of league-wide usage read to build the club denominators. */
const TEAM_TOTAL_LOOKBACK_WEEKS = 10;

export interface SideBySideOptions {
  leagueId: string;
  /** Defaults to the league's own roster for the connected user's team. */
  playerIds?: string[];
  season?: string;
  week?: number | null;
  now?: Date;
}

export interface SideBySideResult extends SideBySideReport {
  /** What the identity ladder achieved over the players in this report. */
  identity: IdentityCoverage;
  /** Which nflverse inputs were actually available. */
  inputs: { crosswalk: boolean; snaps: boolean; depthCharts: number };
}

export class ProjectionV2Service {
  constructor(private readonly db: Database) {}

  /**
   * The report §21 asks for, over a set of players.
   *
   * Read-only end to end. Nothing in this method writes a row, and the
   * projections it produces are returned to the caller rather than stored —
   * there is deliberately no `projection_v2` table for a recommendation to
   * discover.
   */
  async sideBySide(opts: SideBySideOptions): Promise<SideBySideResult> {
    const now = opts.now ?? new Date();
    const league = await new LeagueRepo(this.db).getLeague(opts.leagueId);
    if (!league) throw new Error(`unknown league ${opts.leagueId}`);
    const season = opts.season ?? league.season ?? usageSeason(now);
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);

    const playerIds = opts.playerIds ?? (await this.rosterPlayerIds(opts.leagueId));
    if (playerIds.length === 0) {
      return {
        generatedAt: now.toISOString(),
        season,
        week: opts.week ?? null,
        rows: [],
        summary: emptySummary(),
        identity: { players: 0, sleeperDirect: 0, rosterBridge: 0, unresolved: 0, withPfr: 0 },
        inputs: { crosswalk: false, snaps: false, depthCharts: 0 },
      };
    }

    /*
     * The live engine's own inputs, then the live engine. Identical to the Team
     * route, which is the whole reason the comparison column means anything.
     */
    const startSitInputs = await startSitInputsFor(this.db, playerIds);
    const evaluations = startSitInputs.map((input) => ({
      input,
      evaluation: evaluatePlayer(input, profile),
    }));

    const usageRepo = new UsageRepo(this.db);
    const snapRepo = new SnapCountRepo(this.db);
    const depthRepo = new DepthChartRepo(this.db);
    const crosswalkRepo = new IdentityCrosswalkRepo(this.db);

    const [crosswalk, snapWeeks, captures, marketFreshness, leagueWeeks] = await Promise.all([
      crosswalkRepo.forSeason(season).catch(() => []),
      snapRepo.weeksFor(playerIds, season).catch(() => new Map()),
      depthRepo.captures(season).catch(() => [] as string[]),
      new PropsRepo(this.db).freshness().catch(() => ({ fetchedAt: null, provider: null, events: 0 })),
      this.leagueWeeksForTotals(usageRepo, season),
    ]);

    const [currentRoles, previousRoles] = await Promise.all([
      captures[0] ? depthRepo.rolesAt(season, captures[0]).catch(() => new Map()) : Promise.resolve(new Map()),
      captures[1] ? depthRepo.rolesAt(season, captures[1]).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);

    const identities = resolveIdentities(
      evaluations.map(({ input }) => ({ id: input.player.id, externalIds: input.player.externalIds ?? null })),
      crosswalk,
    );
    const rosterByGsis = new Map(
      crosswalk.map((link) => [
        link.gsisId,
        { gsisId: link.gsisId, team: link.team, position: link.position, status: link.status },
      ]),
    );

    const totals = teamWeekTotals(leagueWeeks);
    const published = await this.publishedProjections(season, opts.week ?? null, playerIds);

    const projections: { projection: ProjectionV2; marketProjection: number | null; rotowireProjection: number | null }[] =
      [];

    for (const { input, evaluation } of evaluations) {
      const identity = identities.get(input.player.id);
      const gsisId = identity?.gsisId ?? null;
      const snaps = (snapWeeks.get(input.player.id) ?? []) as SnapWeek[];

      const features = buildFeatures(input.player.position, input.usageWeeks ?? [], {
        snaps,
        teamTotals: totals,
        team: input.player.team ?? null,
      });

      const current = gsisId ? (currentRoles.get(gsisId) ?? null) : null;
      const previous = gsisId ? (previousRoles.get(gsisId) ?? null) : null;
      const previouslyAhead =
        current && previous && captures[1]
          ? await depthRepo
              .aheadOf(season, captures[1], previous.team, previous.position, previous.rank)
              .catch(() => [])
          : [];

      const roleChange = assessRoleChange({
        current,
        previous,
        observedAt: captures[0] ?? null,
        snaps: snapTrend(snaps),
        roster: gsisId ? (rosterByGsis.get(gsisId) ?? null) : null,
        previouslyAhead,
        rosterByGsis,
        marketAsOf: marketFreshness.fetchedAt,
      });

      const missingInputs: string[] = [];
      if (crosswalk.length === 0) missingInputs.push('nflverse identity crosswalk');
      if (snaps.length === 0) missingInputs.push('snap counts');
      if (captures.length === 0) missingInputs.push('depth chart');

      const projection = projectV2({
        playerId: input.player.id,
        name: input.player.fullName,
        position: input.player.position,
        team: input.player.team ?? null,
        expectation: evaluation.expectation,
        features,
        profile,
        roleChange,
        identity: identity?.resolution ?? 'unresolved',
        tdDependence: evaluation.tdDependency.share,
        /*
         * From this app's own injury pipeline, through the evaluation that
         * already carries it. §8: nflverse current injuries are not a live
         * source and this consumes the existing signal rather than duplicating
         * it — `nflverse_identity.status` is a roster state and is never read
         * here.
         */
        availabilityUncertain: evaluation.availability.risky,
        outsideFieldedSpots: current ? !current.isStarter : false,
        marketAsOf: marketFreshness.fetchedAt,
        usageAsOf: input.usageWeeks?.length ? season : null,
        depthChartAsOf: captures[0] ?? null,
        sources: sourcesUsed(input.usageWeeks?.length ?? 0, snaps.length, captures.length, crosswalk.length),
        missingInputs,
        now,
      });

      projections.push({
        projection,
        marketProjection: marketProjection(evaluation),
        rotowireProjection: published.get(input.player.id) ?? null,
      });
    }

    const report = buildSideBySide(projections, {
      season,
      week: opts.week ?? null,
      generatedAt: now.toISOString(),
    });

    return {
      ...report,
      identity: identityCoverage(identities.values()),
      inputs: { crosswalk: crosswalk.length > 0, snaps: snapWeeks.size > 0, depthCharts: captures.length },
    };
  }

  /** Every player on the connected user's roster in this league. */
  private async rosterPlayerIds(leagueId: string): Promise<string[]> {
    const rosters = await new LeagueRepo(this.db).listRosters(leagueId).catch(() => []);
    const mine = rosters.find((r) => r.isMine) ?? rosters[0];
    return mine?.playerIds ?? [];
  }

  /**
   * League-wide usage, for the club denominators carry share needs.
   *
   * Bounded to a ten-week look-back rather than the whole season: the feature
   * window is eight games and a denominator from September has no bearing on a
   * share computed over November.
   */
  private async leagueWeeksForTotals(repo: UsageRepo, season: string) {
    const coverage = await repo.coverage(season).catch(() => ({ latestWeek: null as number | null }));
    const latest = coverage.latestWeek ?? 0;
    const from = Math.max(1, latest - TEAM_TOTAL_LOOKBACK_WEEKS);
    return repo.leagueWeeksSince(season, from).catch(() => []);
  }

  /**
   * Rotowire's published weekly numbers, read from the database only.
   *
   * The fetch runs on the crons; a diagnostics request never waits on Sleeper.
   * An empty map is an ordinary state — the column simply reads as absent.
   */
  private async publishedProjections(
    season: string,
    week: number | null,
    playerIds: string[],
  ): Promise<Map<string, number>> {
    if (week == null) return new Map();
    const stored = await new SleeperProjectionsRepo(this.db).forWeek(season, week).catch(() => new Map());
    const wanted = new Set(playerIds);
    const out = new Map<string, number>();
    for (const [playerId, row] of stored) {
      if (!wanted.has(playerId)) continue;
      if (row.points != null && Number.isFinite(row.points)) out.set(playerId, row.points);
    }
    return out;
  }
}

/**
 * Recent snap share against the games before it.
 *
 * Two and three: the smallest split that can say anything, matching the role
 * detector's own three-recent-against-baseline shape. Null whenever either half
 * is too thin, so a corroboration test cannot be passed by one afternoon.
 */
function snapTrend(snaps: SnapWeek[]): SnapTrend | null {
  const regular = snaps
    .filter((s) => (s.gameType ?? 'REG').toUpperCase() === 'REG' && s.offenseShare != null)
    .sort((a, b) => a.week - b.week);
  if (regular.length < 4) return null;
  const recent = regular.slice(-2);
  const baseline = regular.slice(-5, -2);
  if (baseline.length < 2) return null;
  return {
    recent: mean(recent.map((s) => s.offenseShare!)),
    baseline: mean(baseline.map((s) => s.offenseShare!)),
    recentGames: recent.length,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
}

function sourcesUsed(usageWeeks: number, snaps: number, captures: number, crosswalk: number): string[] {
  const out: string[] = [];
  if (usageWeeks > 0) out.push('nflverse weekly player stats');
  if (snaps > 0) out.push('PFR snap counts');
  if (captures > 0) out.push('nflverse depth charts');
  if (crosswalk > 0) out.push('nflverse seasonal rosters');
  return out;
}

function emptySummary(): SideBySideReport['summary'] {
  return {
    players: 0,
    byBasis: { market: 0, market_plus_model: 0, model: 0, none: 0 },
    byConfidence: { high: 0, medium: 0, low: 0 },
    meanAbsoluteDifferenceStrongMarket: null,
    meanAbsoluteDifferencePartialMarket: null,
    newlyProjectable: 0,
    lostProjections: 0,
    withFreshInformation: 0,
    largestDifference: null,
  };
}
