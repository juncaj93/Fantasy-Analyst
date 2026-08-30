/**
 * The morning of a real draft, with the Draft tab gone.
 *
 * Reported on 30 August 2026, hours before an in-person draft: the Draft tab
 * had disappeared from the toolbar, Matchup had appeared in its place, and the
 * Team screen was drawing a lineup of eight `Nobody eligible yet` rows for a
 * league in which not one pick had been made.
 *
 * Three separate things had to be true for that screen, and all three were:
 *
 *  1. `/state/nfl` said `season_type: regular`, `week: 1` eleven days before
 *     `season_start_date`, so the toolbar believed the season was under way.
 *  2. An untimed draft — no start time, entered by hand after the room breaks
 *     up — sits at `pre_draft` and never at `drafting`, so the one rule that
 *     outranked the calendar never covered it.
 *  3. `buildLiveRoster` treated `pre_draft` as a finished draft, so Sleeper's
 *     empty roster was read as authoritative.
 *
 * These hold all three, and then hold the way out: a room that is not on
 * Sleeper entering its own picks.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { resolveLifecycle } from '../src/core/season/lifecycle.ts';
import { buildLiveRoster } from '../src/core/draft/liveRoster.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { nextManualPick, slotForPick, isManualPick, ManualPickRefused } from '../src/core/draft/manualPick.ts';

/**
 * `/state/nfl`, as Sleeper actually answered on the morning in question.
 *
 * Quoted rather than invented, and the whole point of this fixture is the pair
 * `week: 1` with a `seasonStartDate` eleven days out.
 */
const AUG_30_2026 = {
  season: '2026',
  seasonType: 'regular',
  week: 1,
  seasonStartDate: '2026-09-09',
  leg: 1,
  fetchedAt: '2026-08-30T13:00:00.000Z',
} as const;

const DRAFT_DAY = '2026-08-30T14:00:00Z';

function makeEnv(db: NodeSqliteDatabase, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    disableAuth: true,
    ...overrides,
  };
}

const get = (path: string) => new Request(`https://app.test${path}`);
const post = (path: string, body?: unknown) =>
  new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });

describe('the toolbar, eleven days before kickoff, with the draft still to come', () => {
  it('keeps Draft and withholds Matchup for a draft nobody has opened', () => {
    const resolved = resolveLifecycle({
      state: AUG_30_2026,
      league: { season: '2026', status: 'pre_draft' },
      draft: { status: 'pre_draft' },
      now: DRAFT_DAY,
    });

    expect(resolved.lifecycle).toBe('draft_open');
    expect(resolved.draftVisible, 'the Draft tab is the whole point').toBe(true);
    // The other half of the report: Matchup had taken Draft's place, which is a
    // projection of a team that does not exist yet.
    expect(resolved.matchupVisible).toBe(false);
  });

  /** The same state, with the draft in every other unfinished shape. */
  it('keeps Draft whether the draft is waiting, paused or taking picks', () => {
    for (const status of ['pre_draft', 'paused', 'drafting']) {
      const resolved = resolveLifecycle({
        state: AUG_30_2026,
        league: { season: '2026', status: 'pre_draft' },
        draft: { status },
        now: DRAFT_DAY,
      });
      expect(resolved.draftVisible, `draft status ${status}`).toBe(true);
      expect(resolved.matchupVisible, `draft status ${status}`).toBe(false);
    }
  });

  /** And still hands the slot over the moment the picks are actually in. */
  it('gives the slot to Matchup once the draft is complete', () => {
    const resolved = resolveLifecycle({
      state: AUG_30_2026,
      league: { season: '2026', status: 'pre_draft' },
      draft: { status: 'complete' },
      now: DRAFT_DAY,
    });
    expect(resolved.lifecycle).toBe('post_draft');
    expect(resolved.draftVisible).toBe(false);
    expect(resolved.matchupVisible).toBe(true);
  });
});

describe('the Team screen, before a pick has been made', () => {
  const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'FLEX', 'BN', 'BN']);

  /*
   * The reported symptom: every starting slot reading `Nobody eligible yet`.
   *
   * `live` is the single flag the Team screen hangs all of that furniture on —
   * the recommended-starters heading, the bench, the waiver scan, the defence
   * line. False before a draft meant a league with an empty roster was drawn as
   * a team that had lost its players.
   */
  it('is in draft mode for a draft that has not started', () => {
    const roster = buildLiveRoster({
      picks: [],
      rosterId: 1,
      ownerId: 'me',
      sleeperPlayerIds: [],
      byId: new Map(),
      shape,
      draftStatus: 'pre_draft',
    });
    expect(roster.live).toBe(true);
    expect(roster.players).toHaveLength(0);
    // What it draws instead: the slots still to fill.
    expect(roster.openStarters.length).toBeGreaterThan(0);
  });

  it('leaves draft mode when the picks are in', () => {
    const roster = buildLiveRoster({
      picks: [],
      rosterId: 1,
      ownerId: 'me',
      sleeperPlayerIds: [],
      byId: new Map(),
      shape,
      draftStatus: 'complete',
    });
    expect(roster.live).toBe(false);
  });
});

describe('placing a pick entered by hand', () => {
  const base = {
    draftId: 'd',
    teams: 12,
    type: 'snake',
    rounds: 15,
    slotToRosterId: {},
    myRosterId: 7,
    mine: false,
  };

  /** The snake, and it must agree with `pickNumbersForSlot`'s inverse. */
  it('reverses every even round, and never in a linear draft', () => {
    expect(slotForPick(1, 12, 'snake')).toBe(1);
    expect(slotForPick(12, 12, 'snake')).toBe(12);
    expect(slotForPick(13, 12, 'snake')).toBe(12);
    expect(slotForPick(24, 12, 'snake')).toBe(1);
    expect(slotForPick(13, 12, 'linear')).toBe(1);
  });

  it('appends after the highest pick already stored, not after the count', () => {
    // A stream with a gap in it: counting would write over pick 4.
    const pick = nextManualPick({ ...base, existing: [{ pickNo: 1, playerId: 'a' }, { pickNo: 4, playerId: 'b' }], playerId: 'c' });
    expect(pick.pickNo).toBe(5);
    expect(pick.round).toBe(1);
    expect(pick.draftSlot).toBe(5);
  });

  it('marks its own rows so an undo can tell them from Sleeper’s', () => {
    const pick = nextManualPick({ ...base, existing: [], playerId: 'a' });
    expect(isManualPick(pick.raw)).toBe(true);
    expect(isManualPick('{}')).toBe(false);
    expect(isManualPick(null)).toBe(false);
  });

  /*
   * The attribution, in the two rooms this has to work in.
   *
   * A seated draft has Sleeper's own map and needs nothing from the reader; an
   * unseated one has nothing else, which is why the screen asks.
   */
  it('takes the seat map where Sleeper published one', () => {
    const pick = nextManualPick({ ...base, slotToRosterId: { '3': 42 }, existing: [{ pickNo: 1, playerId: 'a' }, { pickNo: 2, playerId: 'b' }], playerId: 'c' });
    expect(pick.draftSlot).toBe(3);
    expect(pick.rosterId).toBe(42);
  });

  it('takes the reader’s word in a draft Sleeper never seated', () => {
    const pick = nextManualPick({ ...base, existing: [], playerId: 'a', mine: true });
    expect(pick.rosterId, 'so the Team screen knows it is his').toBe(7);
  });

  it('stores no owner rather than guessing one', () => {
    const pick = nextManualPick({ ...base, existing: [], playerId: 'a' });
    expect(pick.rosterId).toBeNull();
  });

  it('refuses a draft with no seat count, where the order is undefined', () => {
    expect(() => nextManualPick({ ...base, teams: 0, existing: [], playerId: 'a' })).toThrow(ManualPickRefused);
  });

  it('refuses a player already taken, and a draft already full', () => {
    expect(() => nextManualPick({ ...base, existing: [{ pickNo: 1, playerId: 'a' }], playerId: 'a' })).toThrow(
      /already been taken/,
    );
    expect(() =>
      nextManualPick({ ...base, rounds: 1, existing: Array.from({ length: 12 }, (_, i) => ({ pickNo: i + 1, playerId: `p${i}` })), playerId: 'z' }),
    ).toThrow(/every one of its 12 picks is in/);
  });
});

describe('entering the room’s picks over the real router', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const { createTestDb } = await import('./helpers/db.ts');
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();

    // The league as it actually was: no picks, and a draft nobody has opened.
    const leagues = new LeagueRepo(db);
    const draft = await leagues.getDraft('demo-draft');
    await leagues.upsertDraft({ ...draft!, status: 'pre_draft' });
    await leagues.deletePick('demo-draft', 1);
    await leagues.deletePick('demo-draft', 2);
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, AUG_30_2026);
  });

  it('puts Draft back in the toolbar and keeps Matchup out of it', async () => {
    const body = (await (await app(get('/api/overview'), env)).json()) as {
      season: { draftVisible: boolean };
      lifecycle: { lifecycle: string; matchupVisible: boolean };
    };
    expect(body.season.draftVisible).toBe(true);
    expect(body.lifecycle.matchupVisible).toBe(false);
    expect(body.lifecycle.lifecycle).toBe('draft_open');
  });

  it('records a pick, advances the clock and takes the player off the board', async () => {
    const before = (await (await app(get('/api/drafts/demo-draft/board?limit=40'), env)).json()) as {
      currentPick: number;
      recommendations: { playerId: string }[];
    };
    expect(before.currentPick).toBe(1);
    const taken = before.recommendations[0]!.playerId;

    const res = await app(post('/api/drafts/demo-draft/picks', { playerId: taken }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pickNo: 1, round: 1, draftSlot: 1 });

    const after = (await (await app(get('/api/drafts/demo-draft/board?limit=40'), env)).json()) as {
      currentPick: number;
      recommendations: { playerId: string }[];
    };
    expect(after.currentPick, 'the clock moved on').toBe(2);
    expect(after.recommendations.map((r) => r.playerId), 'and he is gone').not.toContain(taken);
  });

  it('puts a pick the reader claims onto their own team', async () => {
    const board = (await (await app(get('/api/drafts/demo-draft/board?limit=40'), env)).json()) as {
      recommendations: { playerId: string }[];
    };
    const mine = board.recommendations[0]!.playerId;
    await app(post('/api/drafts/demo-draft/picks', { playerId: mine, mine: true }), env);

    const roster = (await (await app(get('/api/leagues/demo-league/roster'), env)).json()) as {
      live: boolean;
      drafted: { playerId: string; draftPick: string }[];
    };
    expect(roster.live, 'and the Team screen is in draft mode').toBe(true);
    expect(roster.drafted.map((p) => p.playerId)).toContain(mine);
  });

  it('undoes the last hand-entered pick', async () => {
    const board = (await (await app(get('/api/drafts/demo-draft/board?limit=40'), env)).json()) as {
      recommendations: { playerId: string }[];
    };
    const wrong = board.recommendations[0]!.playerId;
    await app(post('/api/drafts/demo-draft/picks', { playerId: wrong }), env);

    const undo = await app(post('/api/drafts/demo-draft/picks/undo', {}), env);
    expect(undo.status).toBe(200);
    expect(await undo.json()).toMatchObject({ undone: 1, playerId: wrong });

    const after = (await (await app(get('/api/drafts/demo-draft/board?limit=40'), env)).json()) as {
      currentPick: number;
      recommendations: { playerId: string }[];
    };
    expect(after.currentPick).toBe(1);
    expect(after.recommendations.map((r) => r.playerId)).toContain(wrong);
  });

  /**
   * The one thing an undo must never do.
   *
   * A row Sleeper published is the record of what happened in the room. If the
   * commissioner types the afternoon into Sleeper and a sync lands, those rows
   * are not this control's to remove — and it must refuse rather than skip past
   * them to find a hand-entered pick underneath, which would delete a pick the
   * reader was not looking at.
   */
  it('refuses to undo a pick that came from Sleeper', async () => {
    await new LeagueRepo(db).upsertPicks([
      {
        draftId: 'demo-draft',
        pickNo: 1,
        round: 1,
        pickInRound: 1,
        draftSlot: 1,
        sleeperPlayerId: '1001',
        playerId: '1001',
        rosterId: 1,
        pickedBy: 'demo-user',
        raw: '{"pick_no":1}',
      },
    ]);

    const res = await app(post('/api/drafts/demo-draft/picks/undo', {}), env);
    expect(res.status).toBe(409);
    expect(await new LeagueRepo(db).listPicks('demo-draft')).toHaveLength(1);
  });

  it('refuses a pick on a draft that is already finished', async () => {
    const leagues = new LeagueRepo(db);
    const draft = await leagues.getDraft('demo-draft');
    await leagues.upsertDraft({ ...draft!, status: 'complete' });

    const res = await app(post('/api/drafts/demo-draft/picks', { playerId: '1001' }), env);
    expect(res.status).toBe(409);
  });

  it('refuses a player nobody has heard of', async () => {
    const res = await app(post('/api/drafts/demo-draft/picks', { playerId: 'nobody' }), env);
    expect(res.status).toBe(404);
  });

  /**
   * A rehearsal must not be able to put a pick in the real draft.
   *
   * The guard is method-based and already at the top of the router, so this
   * route inherited it without a line being written — but the real draft did
   * not accept picks at all until now, and a guard nobody has checked against
   * the thing it is guarding is a guard nobody has checked. Both routes, both
   * markers.
   */
  it('refuses a pick and an undo from a browser running a mock draft, or a demo', async () => {
    for (const cookie of ['fa_mock=1', 'fa_demo=1']) {
      for (const path of ['/api/drafts/demo-draft/picks', '/api/drafts/demo-draft/picks/undo']) {
        const req = new Request(`https://app.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ playerId: '1001' }),
        });
        const res = await app(req, env);
        expect(res.status, `${cookie} ${path}`).toBe(403);
      }
    }
    expect(await new LeagueRepo(db).listPicks('demo-draft'), 'and nothing was written').toHaveLength(0);
  });
});
