/**
 * The draft board, sourced from the database.
 *
 * The assembly itself lives in `core/draft/boardBuilder.ts` — it is the
 * product's reasoning and has no business knowing what a table is. What is left
 * here is the half that does: repositories over D1, the injury and repair
 * services, the season the market snapshot should be read for, and the real
 * clock the Underdog file's age is measured from.
 *
 * The public surface is unchanged. `new DraftBoardService(db).build(draftId)`
 * means exactly what it always did, so every caller and every test that names
 * it is untouched by the split.
 */

import { buildDraftBoard, type DraftBoardSources } from '../../core/draft/boardBuilder.ts';
import { InjuryService } from './injuryService.ts';
import { RepairService } from './repairService.ts';
import { ManagerProfileRepo } from '../repos/managerProfiles.ts';
import type { ManagerTendencies } from '../../core/managers/managerTendencies.ts';
import { seasonFor } from './seasonMarketService.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import { PreseasonProjectionsRepo } from '../repos/preseasonProjections.ts';
import { scoringKey } from '../../core/startWho/scoring.ts';
import type { MyGuyLevel } from '../../core/draft/decisions.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { DraftQueueRepo } from '../repos/draftQueue.ts';
import { PlayerFlagsRepo } from '../repos/playerFlags.ts';
import { PlayerRepo } from '../repos/players.ts';

export {
  MAX_CANDIDATES,
  UNDERDOG_SOURCE_KEY,
  type BoardRecommendation,
  type DraftBoardSources,
  type DraftBoardState,
} from '../../core/draft/boardBuilder.ts';

/**
 * The repository-backed sources.
 *
 * Every method is a read. Two pieces of judgement live here rather than in the
 * assembly, and both are about the environment rather than about football:
 * which season's market snapshot to look in, and what time it is.
 */
export function draftBoardSourcesFromDatabase(db: Database): DraftBoardSources {
  const leagues = new LeagueRepo(db);
  const players = new PlayerRepo(db);
  const adp = new AdpRepo(db);
  const evidence = new EvidenceRepo(db);
  const seasonMarkets = new SeasonMarketsRepo(db);
  const projections = new PreseasonProjectionsRepo(db);

  return {
    leagues: {
      getDraft: (id) => leagues.getDraft(id),
      getLeague: (id) => leagues.getLeague(id),
      listRosters: (leagueId) => leagues.listRosters(leagueId),
      listPicks: (draftId) => leagues.listPicks(draftId),
    },
    players: { listAll: () => players.listAll() },
    adp: {
      get: (id) => adp.get(id),
      latestPlatformSnapshot: () => adp.latestPlatformSnapshot(),
      latestForSource: (source) => adp.latestForSource(source),
      valuesByPlayer: (snapshotId) => adp.valuesByPlayer(snapshotId),
    },
    evidence: { getSignals: (ids) => evidence.getSignals(ids) },
    /*
     * The two marks, composed: My Guy from the global table, the ★ queue from
     * this draft's own. They arrive as one map because the board reads them as
     * one thing per player, and they are stored apart because one of them is an
     * opinion about a player and the other is a bookmark inside a draft.
     */
    flags: async (draftId) => {
      const [levels, queue] = await Promise.all([
        new PlayerFlagsRepo(db).all(),
        new DraftQueueRepo(db).entries(draftId),
      ]);
      const out = new Map<string, { level: MyGuyLevel; queued: boolean; queueOrder: number | null }>();
      for (const [playerId, flag] of levels) {
        out.set(playerId, { level: flag.level, queued: false, queueOrder: null });
      }
      for (const entry of queue) {
        out.set(entry.playerId, {
          level: out.get(entry.playerId)?.level ?? 0,
          queued: true,
          queueOrder: entry.order,
        });
      }
      return out;
    },
    seasonMarkets: (ids) => seasonMarkets.latestForPlayers(seasonFor(), ids),
    /*
     * Scoped to the league's own scoring before anything else, so a snapshot
     * captured under other rules cannot reach the board at all. Empty is the
     * right answer there — not the nearest snapshot, which would be wrong by
     * fifty points on every quarterback and right on everybody else.
     */
    preseasonPoints: async (ids, scoring) => {
      const snapshot = await projections.latest(seasonFor(), scoringKey(scoring));
      if (!snapshot) return new Map<string, number>();
      return projections.pointsForSnapshot(snapshot.id, ids);
    },
    marketSnapshot: async () => {
      const snapshot = await seasonMarkets.latestSnapshot(seasonFor());
      return snapshot
        ? { provider: snapshot.provider, season: snapshot.season, fetchedAt: snapshot.fetchedAt }
        : null;
    },
    /*
     * Historical tendencies, straight from the profile cache.
     *
     * A read, never a sync: the previous-league chain costs several seasons of
     * Sleeper requests and is refreshed on its own weekly cadence by
     * `LeagueStrategyService`. A board that triggered that work would turn a
     * three-second draft poll into a multi-second one. Nothing cached yet means
     * an empty map, which the board reads as "no history" and not as an error.
     */
    managerTendencies: async (leagueId) => {
      const cached = await new ManagerProfileRepo(db).tendencyProfiles(leagueId);
      const out = new Map<number, ManagerTendencies>();
      for (const [rosterId, entry] of cached) out.set(rosterId, entry.profile);
      return out;
    },
    repairStatus: () => new RepairService(db).status(),
    injuryStates: (list) => new InjuryService(db).statesFor(list),
    now: () => new Date(),
  };
}

export class DraftBoardService {
  private readonly sources: DraftBoardSources;

  constructor(db: Database) {
    this.sources = draftBoardSourcesFromDatabase(db);
  }

  build(draftId: string, opts: { limit?: number; position?: string | null; queuedOnly?: boolean } = {}) {
    return buildDraftBoard(this.sources, draftId, opts);
  }
}
