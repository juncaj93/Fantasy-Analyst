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
import { seasonFor } from './seasonMarketService.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
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
    flags: () => new PlayerFlagsRepo(db).all(),
    seasonMarkets: (ids) => seasonMarkets.latestForPlayers(seasonFor(), ids),
    marketSnapshot: async () => {
      const snapshot = await seasonMarkets.latestSnapshot(seasonFor());
      return snapshot
        ? { provider: snapshot.provider, season: snapshot.season, fetchedAt: snapshot.fetchedAt }
        : null;
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
