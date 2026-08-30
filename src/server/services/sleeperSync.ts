/**
 * Sleeper synchronisation service.
 *
 * Sleeper is the source of truth for players, leagues, rosters, drafts and
 * picks. Everything here is idempotent so a sync can be re-run safely.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import { draftStateFingerprint } from '../../core/sleeper/draftFingerprint.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { isDraftComplete } from '../../core/season/lifecycle.ts';
import {
  toCanonicalPlayers,
  toDraftPickRecords,
  toDraftRecord,
  toLeagueRecord,
  toRosterRecords,
} from '../../core/sleeper/transform.ts';
import type { DraftRecord } from '../../core/sleeper/types.ts';
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
        /*
         * The one field that dates week one.
         *
         * `season_type` flips to `regular` more than a week before any game is
         * played and `week` reads 1 from that moment, so without this the app
         * cannot tell "week one is next" from "week one is happening" — and it
         * did not, which is what took the Draft tab away from leagues still to
         * draft in 2026. See core/sleeper/phase.ts.
         */
        seasonStartDate: state.season_start_date ?? null,
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
    /** True when this sync also went back for the rosters the draft produced. */
    rostersAdopted: boolean;
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

    const rostersAdopted = await this.adoptCompletedDraftRosters(record);

    return {
      status: record.status,
      picks: pickRecords.length,
      lastPickNo: pickRecords.length > 0 ? pickRecords[pickRecords.length - 1]!.pickNo : 0,
      rostersAdopted,
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

  /**
   * The rosters a finished draft produced, fetched in the same breath as the
   * status that finished it.
   *
   * **The draft's status and the roster it produced are one fact, and this is
   * where they stop being able to disagree.** Sleeper's roster endpoint reports
   * empty squads until a draft ends and becomes authoritative the moment it
   * does — see core/draft/liveRoster.ts — so the pre-draft rows this app stores
   * are correct right up until the last pick lands and wrong for ever
   * afterwards. Nothing used to go back for them: `replaceRosters` is only
   * reached through {@link syncLeague}, which runs when a league is selected or
   * when somebody pulls down on the Team screen, and neither of those is "a
   * draft ended". The nightly cron syncs players, statistics and the NFL's own
   * state, and no league at all.
   *
   * Meanwhile *this* method's write is exactly what flips the app into its
   * post-draft state: `/api/overview` reads the stored draft's status to put
   * Matchup in the toolbar, and the Team screen reads it to leave draft mode.
   * So the app announced a finished draft, took away the drafted-players list
   * that was standing in for the roster, and put in its place a lineup built
   * from roster rows that were still empty — a Team page that says you own
   * nobody, hours after a draft in which you took twenty-three players.
   *
   * Adopting them here makes the transition atomic in the only sense that
   * matters to a reader: no request can observe the completed status without
   * the roster behind it having been fetched too.
   *
   * **Written as a state check rather than an edge.** "The status just changed
   * to complete" would fire once and never again, so a Sleeper outage during
   * that one poll would stitch the app permanently into the broken state this
   * exists to prevent. Asking instead whether the stored rosters still look
   * pre-draft means every later sync re-offers the repair, and the app heals
   * itself on the next poll, the next app open, or the next league that needs
   * it. When there is nothing to heal it costs one indexed read, and during a
   * live draft — the only time this is called often — it costs nothing at all,
   * because the status check fails first.
   *
   * Failure is swallowed on purpose and logged. A draft board that already has
   * its picks must not go dark because the league endpoint was briefly
   * unavailable, and the next sync will try again.
   */
  private async adoptCompletedDraftRosters(draft: DraftRecord): Promise<boolean> {
    if (!isDraftComplete(draft.status) || !draft.leagueId) return false;

    /*
     * The pre-draft signature: not one roster in the league holds a player.
     *
     * A completed draft has put players on every squad, so this is unambiguous
     * — and it is deliberately asked of the whole league rather than of the
     * user's own roster, because the opponent names the Matchup screen prints
     * and the ownership the waiver board reads come from the same rows.
     */
    const rosters = await this.leagues.listRosters(draft.leagueId);
    if (rosters.some((r) => r.playerIds.length > 0)) return false;

    const startedAt = nowIso();
    try {
      await this.syncLeague(draft.leagueId);
      return true;
    } catch (err) {
      await this.settings
        .logSync('league', 'error', `post-draft roster adoption failed: ${String(err)}`, startedAt)
        .catch(() => undefined);
      return false;
    }
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
