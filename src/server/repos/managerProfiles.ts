/**
 * Cached manager and room profiles.
 *
 * Derived data, cached because deriving it costs several seasons of Sleeper
 * requests across the previous-league chain to produce two sentences. The
 * sample size and the computation time are stored as columns rather than buried
 * in the JSON so that a caller can decide whether to trust a profile without
 * parsing it, and so a stale one is visibly stale.
 */

import { nowIso, parseJson, toJson, type Database } from '../db.ts';
import type { ManagerTradeProfile } from '../../core/managers/tradeProfile.ts';
import type { DraftProfile } from '../../core/managers/draftProfile.ts';

/**
 * How long a profile stands before it is recomputed.
 *
 * A week. Trades and drafts are rare events measured over seasons, and a
 * profile that changes between two page loads would be describing noise.
 */
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedProfile<T> {
  profile: T;
  sample: number;
  confident: boolean;
  computedAt: string;
  stale: boolean;
}

export class ManagerProfileRepo {
  constructor(private readonly db: Database) {}

  async saveTradeProfile(leagueId: string, profile: ManagerTradeProfile): Promise<void> {
    await this.save(leagueId, profile.rosterId, 'trade', {
      ownerName: profile.ownerName,
      sample: profile.sample,
      confident: profile.confident,
      seasons: profile.seasonsObserved,
      profile,
    });
  }

  async saveDraftProfile(leagueId: string, profile: DraftProfile): Promise<void> {
    if (profile.rosterId == null) return;
    await this.save(leagueId, profile.rosterId, 'draft', {
      ownerName: profile.ownerName,
      sample: profile.picksObserved,
      confident: profile.confident,
      seasons: profile.seasons,
      profile,
    });
  }

  private async save(
    leagueId: string,
    rosterId: number,
    kind: 'trade' | 'draft',
    data: { ownerName: string | null; sample: number; confident: boolean; seasons: string[]; profile: unknown },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO manager_profiles (
           league_id, roster_id, kind, owner_name, sample, confident, seasons_json, profile_json, computed_at
         ) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(league_id, roster_id, kind) DO UPDATE SET
           owner_name = excluded.owner_name,
           sample = excluded.sample,
           confident = excluded.confident,
           seasons_json = excluded.seasons_json,
           profile_json = excluded.profile_json,
           computed_at = excluded.computed_at`,
      )
      .bind(
        leagueId,
        rosterId,
        kind,
        data.ownerName,
        data.sample,
        data.confident ? 1 : 0,
        toJson(data.seasons),
        toJson(data.profile),
        nowIso(),
      )
      .run();
  }

  async tradeProfiles(leagueId: string, now = new Date()): Promise<Map<number, CachedProfile<ManagerTradeProfile>>> {
    return this.load<ManagerTradeProfile>(leagueId, 'trade', now);
  }

  async draftProfiles(leagueId: string, now = new Date()): Promise<Map<number, CachedProfile<DraftProfile>>> {
    return this.load<DraftProfile>(leagueId, 'draft', now);
  }

  private async load<T>(leagueId: string, kind: string, now: Date): Promise<Map<number, CachedProfile<T>>> {
    const rows = await this.db
      .prepare('SELECT * FROM manager_profiles WHERE league_id = ? AND kind = ?')
      .bind(leagueId, kind)
      .all<Record<string, unknown>>();

    const out = new Map<number, CachedProfile<T>>();
    for (const row of rows.results) {
      const computedAt = String(row['computed_at']);
      out.set(Number(row['roster_id']), {
        profile: parseJson<T>(row['profile_json'], {} as T),
        sample: Number(row['sample'] ?? 0),
        confident: Number(row['confident'] ?? 0) === 1,
        computedAt,
        stale: now.getTime() - Date.parse(computedAt) > PROFILE_TTL_MS,
      });
    }
    return out;
  }

  async saveRoomProfile(leagueId: string, profile: DraftProfile): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO league_draft_profiles (
           league_id, drafts_observed, picks_observed, confident, seasons_json, profile_json, computed_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(league_id) DO UPDATE SET
           drafts_observed = excluded.drafts_observed,
           picks_observed = excluded.picks_observed,
           confident = excluded.confident,
           seasons_json = excluded.seasons_json,
           profile_json = excluded.profile_json,
           computed_at = excluded.computed_at`,
      )
      .bind(
        leagueId,
        profile.draftsObserved,
        profile.picksObserved,
        profile.confident ? 1 : 0,
        toJson(profile.seasons),
        toJson(profile),
        nowIso(),
      )
      .run();
  }

  async roomProfile(leagueId: string, now = new Date()): Promise<CachedProfile<DraftProfile> | null> {
    const row = await this.db
      .prepare('SELECT * FROM league_draft_profiles WHERE league_id = ?')
      .bind(leagueId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const computedAt = String(row['computed_at']);
    return {
      profile: parseJson<DraftProfile>(row['profile_json'], {} as DraftProfile),
      sample: Number(row['picks_observed'] ?? 0),
      confident: Number(row['confident'] ?? 0) === 1,
      computedAt,
      stale: now.getTime() - Date.parse(computedAt) > PROFILE_TTL_MS,
    };
  }
}
