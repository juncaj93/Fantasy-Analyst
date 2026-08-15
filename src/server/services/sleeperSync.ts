/**
 * Sleeper synchronisation service.
 *
 * Sleeper is the source of truth for players, leagues, rosters, drafts and
 * picks. Everything here is idempotent so a sync can be re-run safely.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import { draftStateFingerprint } from '../../core/sleeper/draftFingerprint.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import {
  toCanonicalPlayers,
  toDraftPickRecords,
  toDraftRecord,
  toLeagueRecord,
  toRosterRecords,
} from '../../core/sleeper/transform.ts';
import { nowIso, type Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

export interface SleeperUserSetting {
  userId: string;
  username: string;
  displayName: string | null;
}

export class SleeperSyncService {
  private readonly players: PlayerRepo;
  private readonly leagues: LeagueRepo;
  private readonly settings: SettingsRepo;

  constructor(
    db: Database,
    private readonly client: SleeperClient,
  ) {
    this.players = new PlayerRepo(db);
    this.leagues = new LeagueRepo(db);
    this.settings = new SettingsRepo(db);
  }

  /** Full player dictionary sync. Expensive (~5MB); run at most daily. */
  async syncPlayers(): Promise<{ written: number; total: number }> {
    const startedAt = nowIso();
    try {
      const raw = await this.client.getAllPlayers();
      const canonical = toCanonicalPlayers(raw);
      const { written } = await this.players.upsertMany(canonical);
      const total = await this.players.count();
      await this.settings.logSync('players', 'ok', `${written} players written`, startedAt);
      return { written, total };
    } catch (err) {
      await this.settings.logSync('players', 'error', String(err), startedAt);
      throw err;
    }
  }

  /** Resolve and remember the Sleeper account whose leagues we track. */
  async connectUser(username: string): Promise<SleeperUserSetting> {
    const user = await this.client.getUserByName(username);
    if (!user) throw new Error(`Sleeper user "${username}" not found`);
    const setting: SleeperUserSetting = {
      userId: user.user_id,
      username: user.username ?? username,
      displayName: user.display_name ?? null,
    };
    await this.settings.set(SETTING_KEYS.sleeperUser, setting);
    return setting;
  }

  async getUser(): Promise<SleeperUserSetting | null> {
    return this.settings.get<SleeperUserSetting | null>(SETTING_KEYS.sleeperUser, null);
  }

  /** Import every league the connected user belongs to for a season. */
  async syncLeagues(season: string): Promise<{ imported: number }> {
    const user = await this.getUser();
    if (!user) throw new Error('no Sleeper user connected');
    const startedAt = nowIso();
    const leagues = await this.client.getLeaguesForUser(user.userId, season);
    const now = nowIso();
    for (const league of leagues) {
      await this.leagues.upsertLeague(toLeagueRecord(league, now));
    }
    await this.syncNflState();
    await this.settings.logSync('leagues', 'ok', `${leagues.length} leagues for ${season}`, startedAt);
    return { imported: leagues.length };
  }

  /**
   * Read and remember where the NFL season is.
   *
   * Best effort on purpose: this is one small request beside work that matters
   * more, and a failure means the app keeps the state it already had. The
   * consequence of not knowing is that the Draft tab stays visible, which is
   * the safe direction to be wrong in.
   */
  async syncNflState(): Promise<NflState | null> {
    try {
      const state = await this.client.getState();
      if (!state) return null;
      const record: NflState = {
        season: state.season ?? null,
        seasonType: state.season_type ?? null,
        week: typeof state.week === 'number' ? state.week : null,
        leg: typeof state.leg === 'number' ? state.leg : null,
        fetchedAt: nowIso(),
      };
      await this.settings.set(SETTING_KEYS.nflState, record);
      return record;
    } catch {
      return null;
    }
  }

  async getNflState(): Promise<NflState | null> {
    return this.settings.get<NflState | null>(SETTING_KEYS.nflState, null);
  }

  /** Refresh a single league: settings, rosters and its drafts. */
  async syncLeague(leagueId: string): Promise<{ rosters: number; drafts: number }> {
    const user = await this.getUser();
    const startedAt = nowIso();
    const [league, rosters, users, drafts] = await Promise.all([
      this.client.getLeague(leagueId),
      this.client.getRosters(leagueId),
      this.client.getLeagueUsers(leagueId),
      this.client.getLeagueDrafts(leagueId),
    ]);
    if (!league) throw new Error(`Sleeper league ${leagueId} not found`);

    const now = nowIso();
    await this.leagues.upsertLeague(toLeagueRecord(league, now));
    await this.leagues.replaceRosters(leagueId, toRosterRecords(leagueId, rosters, users, user?.userId ?? null));
    for (const draft of drafts) {
      await this.leagues.upsertDraft(toDraftRecord(draft, now));
    }
    // Refreshing a league is also the moment to notice the season moved on.
    await this.syncNflState();
    await this.settings.logSync('league', 'ok', `${leagueId}: ${rosters.length} rosters`, startedAt);
    return { rosters: rosters.length, drafts: drafts.length };
  }

  /**
   * Poll draft state. Cheap enough to call on a short interval while a draft is
   * active; callers should back off when `status !== 'drafting'`.
   *
   * The `fingerprint` is what makes that short interval affordable. Writing the
   * picks is cheap and idempotent; *rebuilding the board* on top of them is not
   * — it is a Monte Carlo run per candidate — and during a live draft most
   * polls land on a draft where nobody has picked since the last one. Callers
   * compare this string to the one they already hold and only go on to rebuild
   * when it moved. See core/sleeper/draftFingerprint.ts for what "moved" means.
   */
  async syncDraft(draftId: string): Promise<{
    status: string;
    picks: number;
    lastPickNo: number;
    fingerprint: string;
  }> {
    const [draft, picks] = await Promise.all([
      this.client.getDraft(draftId),
      this.client.getDraftPicks(draftId),
    ]);
    if (!draft) throw new Error(`Sleeper draft ${draftId} not found`);

    const record = toDraftRecord(draft, nowIso());
    await this.leagues.upsertDraft(record);
    const pickRecords = toDraftPickRecords(draftId, picks, record.teams);
    await this.leagues.upsertPicks(pickRecords);

    return {
      status: record.status,
      picks: pickRecords.length,
      lastPickNo: pickRecords.length > 0 ? pickRecords[pickRecords.length - 1]!.pickNo : 0,
      fingerprint: draftStateFingerprint({
        draftId,
        status: record.status,
        picks: pickRecords.map((p) => ({
          pickNo: p.pickNo,
          playerId: p.playerId ?? p.sleeperPlayerId ?? null,
          rosterId: p.rosterId ?? null,
          pickedBy: p.pickedBy ?? null,
        })),
      }),
    };
  }

  /** Recommended poll interval in seconds, based on draft status. */
  static pollIntervalSeconds(status: string): number {
    switch (status) {
      case 'drafting':
        return 5;
      case 'paused':
        return 30;
      case 'pre_draft':
        return 60;
      default:
        return 0; // complete: stop polling
    }
  }
}
