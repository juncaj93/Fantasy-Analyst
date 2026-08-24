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
import {
  fromStoredTendencies,
  toStoredTendencies,
  type ManagerTendencies,
  type StoredManagerTendencies,
} from '../../core/managers/managerTendencies.ts';

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

  /**
   * A manager's historical draft tendencies, filed against his current roster row.
   *
   * A third `kind` in the table that already holds the other two, rather than a
   * table of its own: it is the same fact about the same manager on the same
   * cadence, and it needs no column this one does not have. The Sleeper user id
   * travels *inside* the profile, so a row whose roster changed hands between
   * syncs is detectable rather than silently inherited by the new occupant.
   */
  async saveTendencies(leagueId: string, rosterId: number, tendencies: ManagerTendencies): Promise<void> {
    await this.save(leagueId, rosterId, 'tendency', {
      ownerName: tendencies.displayName,
      sample: tendencies.picksObserved,
      confident: tendencies.usable,
      seasons: tendencies.seasons,
      profile: toStoredTendencies(tendencies),
    });
  }

  async tendencyProfiles(leagueId: string, now = new Date()): Promise<Map<number, CachedProfile<ManagerTendencies>>> {
    const rows = await this.load<StoredManagerTendencies>(leagueId, 'tendency', now);
    const out = new Map<number, CachedProfile<ManagerTendencies>>();
    for (const [rosterId, cached] of rows) {
      out.set(rosterId, { ...cached, profile: fromStoredTendencies(cached.profile) });
    }
    return out;
  }

  private async save(
    leagueId: string,
    rosterId: number,
    kind: 'trade' | 'draft' | 'tendency',
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
