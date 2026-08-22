/**
 * The moment a draft ends, as one continuous transition.
 *
 * A real best-ball draft finished at 14:10 on 22 August 2026 and the app came
 * apart along a seam nothing was testing: the navigation moved into its
 * post-draft shape — Matchup in the bar, Team out of draft mode — while the
 * roster underneath it was still the empty one Sleeper publishes *before* a
 * draft. The Team page said the user owned nobody, hours after they had taken
 * twenty-three players.
 *
 * Nothing about that was visible to a test that checked either half on its own.
 * The lifecycle was right, the roster read was right, the pick stream was right;
 * what was wrong was that one of them moved and the other did not, and the app
 * has no other place where two stored facts are supposed to change together.
 *
 * So this file drives the whole thing over the real router and a real database,
 * against a Sleeper that changes its answers exactly as Sleeper does: rosters
 * empty while the draft runs, populated the moment it completes. It asserts
 * player *continuity* — that the twenty-three names on the board before the last
 * pick are the twenty-three on the team sheet after it — rather than that a
 * screen rendered something.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SleeperSyncService } from '../src/server/services/sleeperSync.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { createTestDb } from './helpers/db.ts';

const LEAGUE = 'L-BB';
const DRAFT = 'D-BB';
const ME = 'user-me';
const THEM = 'user-them';
const MY_ROSTER = 1;
const THEIR_ROSTER = 2;

/** Two three-player squads, which is enough for a lineup and a head-to-head. */
const MY_PLAYERS = ['p1', 'p2', 'p3'];
const THEIR_PLAYERS = ['p4', 'p5', 'p6'];
const ROSTER_POSITIONS = ['QB', 'RB', 'WR', 'BN', 'BN', 'BN'];

function players() {
  const names: Record<string, [string, string]> = {
    p1: ['My Quarterback', 'QB'],
    p2: ['My Runner', 'RB'],
    p3: ['My Receiver', 'WR'],
    p4: ['Their Quarterback', 'QB'],
    p5: ['Their Runner', 'RB'],
    p6: ['Their Receiver', 'WR'],
  };
  return Object.entries(names).map(([id, [fullName, position]]) => ({
    id,
    sleeperPlayerId: id,
    fullName,
    firstName: fullName.split(' ')[0]!,
    lastName: fullName.split(' ').slice(1).join(' '),
    team: 'KC',
    position,
    status: null,
    active: true,
    normalizedName: fullName.toLowerCase(),
    aliases: [],
    externalIds: {},
    searchRank: 1,
    jerseyNumber: null,
    heightInches: null,
    weightPounds: null,
    age: null,
    yearsExp: 3,
  }));
}

/** One pick per player, alternating, in the order the room took them. */
const ALL_PICKS = [
  { pick_no: 1, roster_id: MY_ROSTER, picked_by: ME, player_id: 'p1' },
  { pick_no: 2, roster_id: THEIR_ROSTER, picked_by: THEM, player_id: 'p4' },
  { pick_no: 3, roster_id: THEIR_ROSTER, picked_by: THEM, player_id: 'p5' },
  { pick_no: 4, roster_id: MY_ROSTER, picked_by: ME, player_id: 'p2' },
  { pick_no: 5, roster_id: MY_ROSTER, picked_by: ME, player_id: 'p3' },
  { pick_no: 6, roster_id: THEIR_ROSTER, picked_by: THEM, player_id: 'p6' },
].map((p) => ({ ...p, draft_id: DRAFT, round: Math.ceil(p.pick_no / 2), draft_slot: p.roster_id }));

/**
 * Sleeper, as it actually behaves across a draft.
 *
 * The one property that matters: `rosters` answers with empty squads until
 * `complete` is set, and with the real ones afterwards. That is not a
 * convenience of the fixture — it is the documented behaviour this whole defect
 * turns on, and a fake that filled the rosters early would test nothing.
 */
class ScriptedSleeper {
  status: 'drafting' | 'complete' = 'drafting';
  picks = ALL_PICKS.slice(0, 3);
  /** Every roster fetch, so "did the app go back for them" is observable. */
  rosterFetches = 0;
  /** Set to keep answering with pre-draft rosters even once the draft is over. */
  staleRosters = false;
  /** Set to make the roster endpoint refuse, for the self-healing test. */
  failRosters = false;
  seasonType = 'pre';
  week = 2;

  client(): SleeperClient {
    return new SleeperClient({ fetch: async (url: string) => this.answer(url) });
  }

  private squads() {
    const settled = this.status === 'complete' && !this.staleRosters;
    return [
      {
        roster_id: MY_ROSTER,
        owner_id: ME,
        league_id: LEAGUE,
        players: settled ? MY_PLAYERS : [],
        starters: settled ? MY_PLAYERS : [],
        settings: { wins: 0, losses: 0 },
      },
      {
        roster_id: THEIR_ROSTER,
        owner_id: THEM,
        league_id: LEAGUE,
        players: settled ? THEIR_PLAYERS : [],
        starters: settled ? THEIR_PLAYERS : [],
        settings: { wins: 0, losses: 0 },
      },
    ];
  }

  private answer(url: string): Response {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.includes('/state/nfl')) {
      return json({ season: '2026', season_type: this.seasonType, week: this.week, leg: 0 });
    }
    if (url.includes(`/draft/${DRAFT}/picks`)) return json(this.picks);
    if (url.includes(`/draft/${DRAFT}`)) {
      return json({
        draft_id: DRAFT,
        league_id: LEAGUE,
        status: this.status,
        type: 'snake',
        season: '2026',
        settings: { rounds: 3, teams: 2, best_ball: 1 },
        slot_to_roster_id: { '1': MY_ROSTER, '2': THEIR_ROSTER },
      });
    }
    if (url.includes(`/league/${LEAGUE}/rosters`)) {
      this.rosterFetches++;
      if (this.failRosters) return new Response('upstream is having a moment', { status: 500 });
      return json(this.squads());
    }
    if (url.includes(`/league/${LEAGUE}/users`)) {
      return json([
        { user_id: ME, username: 'me', display_name: 'BigJuncer' },
        { user_id: THEM, username: 'them', display_name: 'Chaffyy' },
      ]);
    }
    if (url.includes(`/league/${LEAGUE}/drafts`)) {
      return json([{ draft_id: DRAFT, league_id: LEAGUE, status: this.status, type: 'snake', season: '2026', settings: { rounds: 3, teams: 2 } }]);
    }
    // Sleeper publishes a best-ball season's whole schedule up front, and the
    // pairings differ by week — which is what makes the wrong week a wrong
    // *opponent* rather than a harmless integer.
    const matchup = /\/league\/[^/]+\/matchups\/(\d+)/.exec(url);
    if (matchup) {
      const week = Number(matchup[1]);
      const squads = this.squads();
      return json(
        squads.map((r) => ({
          roster_id: r.roster_id,
          matchup_id: week,
          players: r.players,
          starters: r.starters,
          points: 0,
          players_points: {},
        })),
      );
    }
    if (url.includes(`/league/${LEAGUE}`)) {
      return json({
        league_id: LEAGUE,
        name: 'Sunday Morning Best Ball',
        season: '2026',
        status: 'in_season',
        total_rosters: 2,
        roster_positions: ROSTER_POSITIONS,
        scoring_settings: { rec: 0.5 },
        settings: { best_ball: 1 },
        draft_id: DRAFT,
      });
    }
    return json(null);
  }
}

interface OverviewBody {
  season: { phase: string; draftVisible: boolean };
  lifecycle: { lifecycle: string; draftVisible: boolean; matchupVisible: boolean; draftLive: boolean };
}

interface RosterBody {
  found: boolean;
  live: boolean;
  starters: { playerId: string; name: string }[];
  bench: { playerId: string }[];
  drafted: { playerId: string; pickNo: number | null }[];
  picksMade: number;
}

interface MatchupBody {
  week: number;
  found: boolean;
  reason: string | null;
  forecast: { teams: { mine: { rosterId: number; name: string }; theirs: { rosterId: number; name: string } } } | null;
}

describe('the transition out of a completed draft', () => {
  let db: NodeSqliteDatabase;
  let sleeper: ScriptedSleeper;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  const get = (path: string) => new Request(`https://app.test${path}`);
  const post = (path: string) => new Request(`https://app.test${path}`, { method: 'POST' });
  const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  const overview = async () => body<OverviewBody>(await app(get('/api/overview'), env));
  const roster = async () => body<RosterBody>(await app(get(`/api/leagues/${LEAGUE}/roster`), env));
  const matchup = async () => body<MatchupBody>(await app(get(`/api/leagues/${LEAGUE}/matchup`), env));
  const syncDraft = () => app(post(`/api/drafts/${DRAFT}/sync`), env);

  beforeEach(async () => {
    db = await createTestDb();
    sleeper = new ScriptedSleeper();
    env = {
      db,
      sleeper: sleeper.client(),
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      // The draft sync is a write, and this file is about what the write does
      // rather than about who is allowed to make it — the lock has its own tests.
      disableAuth: true,
    };
    app = createApp();

    await new PlayerRepo(db).upsertMany(players());
    await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, {
      userId: ME,
      username: 'me',
      displayName: 'BigJuncer',
    });
    // The app as it stands the day before: the league is selected and synced,
    // which is when Sleeper still reports every roster empty.
    const sync = new SleeperSyncService(db, sleeper.client());
    await sync.syncLeagues('2026').catch(() => undefined);
    await new LeagueRepo(db).upsertLeague({
      id: LEAGUE,
      sleeperLeagueId: LEAGUE,
      name: 'Sunday Morning Best Ball',
      season: '2026',
      totalRosters: 2,
      scoringSettings: { rec: 0.5 },
      rosterPositions: ROSTER_POSITIONS,
      leagueSettings: { best_ball: 1 },
      draftId: DRAFT,
      status: 'in_season',
      lastSyncedAt: '2026-08-21T00:00:00.000Z',
    });
    await new LeagueRepo(db).selectLeague(LEAGUE);
    await sync.syncLeague(LEAGUE);
    await sync.syncDraft(DRAFT);
  });

  it('is mid-draft to begin with: Draft in the bar, no Matchup, Team in draft mode', async () => {
    const ov = await overview();
    expect(ov.lifecycle.lifecycle).toBe('draft_live');
    expect(ov.lifecycle.draftVisible).toBe(true);
    expect(ov.lifecycle.matchupVisible).toBe(false);
    expect(ov.lifecycle.draftLive).toBe(true);

    const r = await roster();
    expect(r.live).toBe(true);
    // One pick of mine so far, reconstructed from the stream because Sleeper's
    // roster is still empty. This is the state the transition starts from.
    expect(r.drafted.map((p) => p.playerId)).toEqual(['p1']);
    expect(r.starters).toHaveLength(0);
  });

  it('hydrates Team from Sleeper the moment the last pick lands', async () => {
    // The board as the final pick lands — the twenty-three names, in miniature.
    // Still `drafting`, so this is the pick stream standing in for a roster
    // Sleeper has not filled yet.
    sleeper.picks = ALL_PICKS;
    await syncDraft();
    const midDraft = await roster();
    expect(midDraft.live).toBe(true);
    expect(midDraft.drafted.map((p) => p.playerId)).toEqual(MY_PLAYERS);
    expect(midDraft.starters).toHaveLength(0);

    // The last pick lands. This is the only automatic thing that happens: the
    // Draft screen's poll, which is what tells the app the draft is over.
    sleeper.status = 'complete';
    const before = sleeper.rosterFetches;
    const res = await syncDraft();
    expect(res.status).toBe(200);
    expect((await body<{ rostersAdopted: boolean }>(res)).rostersAdopted).toBe(true);
    expect(sleeper.rosterFetches).toBeGreaterThan(before);

    const ov = await overview();
    expect(ov.lifecycle.lifecycle).toBe('post_draft');
    expect(ov.lifecycle.matchupVisible).toBe(true);
    /*
     * The bar turns over on the final pick.
     *
     * Draft goes because the picks are made, and the phase stays preseason
     * because a draft ending does not start a season — the two facts travel
     * separately and both are asserted, because conflating them is the mistake
     * `core/sleeper/phase.ts` is written to avoid.
     */
    expect(ov.lifecycle.draftVisible).toBe(false);
    expect(ov.season.draftVisible).toBe(false);
    expect(ov.season.phase).toBe('preseason');

    const after = await roster();
    expect(after.found).toBe(true);
    expect(after.live).toBe(false);
    /*
     * Continuity, which is the whole assertion.
     *
     * The players on the team sheet are the players taken in the draft — not
     * "some players", not "a non-empty list". The bug this file exists for
     * produced a page that rendered perfectly with nobody on it.
     */
    expect(after.starters.map((p) => p.playerId).sort()).toEqual([...MY_PLAYERS].sort());
    expect(after.starters.map((p) => p.name)).toContain('My Quarterback');
    expect(new Set(after.starters.map((p) => p.playerId)).size).toBe(MY_PLAYERS.length);
    // Nobody else's players landed on my team sheet.
    for (const theirs of THEIR_PLAYERS) {
      expect(after.starters.map((p) => p.playerId)).not.toContain(theirs);
      expect(after.bench.map((p) => p.playerId)).not.toContain(theirs);
    }
  });

  it('resolves the same roster identity on Matchup, at the first week that is played', async () => {
    sleeper.picks = ALL_PICKS;
    sleeper.status = 'complete';
    await syncDraft();

    const m = await matchup();
    expect(m.found).toBe(true);
    expect(m.reason).toBeNull();
    /*
     * Week one, in preseason week two.
     *
     * Sleeper's `/state/nfl` counts *within* the season type, so through August
     * it reports the preseason week — and reading that as a fantasy week showed
     * the user week two, against the manager they play second.
     */
    expect(m.week).toBe(1);
    expect(m.forecast?.teams.mine.rosterId).toBe(MY_ROSTER);
    expect(m.forecast?.teams.mine.name).toBe('BigJuncer');
    expect(m.forecast?.teams.theirs.rosterId).toBe(THEIR_ROSTER);
  });

  it('takes Sleeper’s own week once the regular season is actually under way', async () => {
    sleeper.picks = ALL_PICKS;
    sleeper.status = 'complete';
    await syncDraft();

    sleeper.seasonType = 'regular';
    sleeper.week = 3;
    await new SleeperSyncService(db, sleeper.client()).syncNflState();

    expect((await matchup()).week).toBe(3);
    // And the seasonal slot has turned over: no Draft, Matchup stays.
    const ov = await overview();
    expect(ov.lifecycle.lifecycle).toBe('regular_season');
    expect(ov.lifecycle.draftVisible).toBe(false);
    expect(ov.lifecycle.matchupVisible).toBe(true);
  });

  it('cannot be blanked again by a stale pre-draft answer', async () => {
    sleeper.picks = ALL_PICKS;
    sleeper.status = 'complete';
    await syncDraft();
    expect((await roster()).starters).toHaveLength(MY_PLAYERS.length);

    /*
     * Sleeper starts answering with the empty pre-draft squads again — a cached
     * edge, a replayed response, a read that lost a race. The app has post-draft
     * truth and must not trade it for that.
     */
    sleeper.staleRosters = true;
    const res = await syncDraft();
    expect((await body<{ rostersAdopted: boolean }>(res)).rostersAdopted).toBe(false);

    const after = await roster();
    expect(after.starters.map((p) => p.playerId).sort()).toEqual([...MY_PLAYERS].sort());
    expect(after.live).toBe(false);
  });

  it('heals on a later poll when the roster fetch fails at the moment of completion', async () => {
    sleeper.picks = ALL_PICKS;
    sleeper.status = 'complete';

    /*
     * The transition, with Sleeper's roster endpoint refusing.
     *
     * The draft board itself must survive this: the picks are in hand and the
     * status is stored, so the poll succeeds and only the adoption fails.
     */
    sleeper.failRosters = true;
    const failed = await syncDraft();
    expect(failed.status).toBe(200);
    expect((await body<{ rostersAdopted: boolean }>(failed)).rostersAdopted).toBe(false);

    /*
     * The edge has now passed — the status is stored as complete — so an
     * implementation that repaired only on the *change* would leave the app
     * wedged in exactly the broken state this file is about.
     */
    expect((await roster()).starters).toHaveLength(0);
    expect((await overview()).lifecycle.lifecycle).toBe('post_draft');

    // The next ordinary poll, with Sleeper answering normally again.
    sleeper.failRosters = false;
    const res = await syncDraft();
    expect((await body<{ rostersAdopted: boolean }>(res)).rostersAdopted).toBe(true);
    expect((await roster()).starters.map((p) => p.playerId).sort()).toEqual([...MY_PLAYERS].sort());
  });

  it('costs nothing while the draft is still running', async () => {
    const before = sleeper.rosterFetches;
    await syncDraft();
    await syncDraft();
    // A live draft is polled every five seconds; it must not pull the league's
    // rosters on every tick.
    expect(sleeper.rosterFetches).toBe(before);
  });
});
