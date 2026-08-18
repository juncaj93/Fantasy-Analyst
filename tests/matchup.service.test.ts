/**
 * The Matchup endpoint, over the real router, the real engine and a real
 * database.
 *
 * The unit tests prove the model is right about a matchup handed to it. This
 * proves the *seam*: that Sleeper's payload is read the way Sleeper actually
 * sends it, that lineups land in the right slots, that a bye is a bye rather
 * than an error, and that the ledger which makes calibration possible actually
 * gets written.
 *
 * The Sleeper client is a fetch stub rather than a mock object, so the parsing
 * this depends on — including Sleeper's habit of sending the string `"0"` for
 * an empty lineup slot — is exercised end to end.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { MatchupRepo, MIN_CALIBRATION_SAMPLE } from '../src/server/repos/matchup.ts';
import { MATCHUP_MODEL_VERSION } from '../src/core/matchup/types.ts';
import { buildSlotSpecs, resolveWeek, isWeekSettled, activeProjection } from '../src/server/services/matchupService.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { UsageRepo } from '../src/server/repos/usage.ts';

/** The demo league starts QB, RB, RB, WR, WR, TE, FLEX. */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '0', '1007', '1011', '1017', '1019'];

interface MatchupRow {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: string[];
  players: string[];
  players_points: Record<string, number>;
}

function rows(over: Partial<{ mine: Partial<MatchupRow>; theirs: Partial<MatchupRow> }> = {}): MatchupRow[] {
  return [
    {
      roster_id: 1,
      matchup_id: 1,
      points: 0,
      starters: MINE,
      players: [...MINE, '1009', '1014'],
      players_points: {},
      ...over.mine,
    },
    {
      roster_id: 2,
      matchup_id: 1,
      points: 0,
      starters: THEIRS,
      players: ['1010', '1006', '1007', '1011', '1017', '1019', '1013', '1018'],
      players_points: {},
      ...over.theirs,
    },
  ];
}

/** A Sleeper that answers only the matchup endpoint, and 404s everything else. */
function sleeperServing(matchups: unknown): SleeperClient {
  return new SleeperClient({
    fetch: async (url) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname)
        ? new Response(JSON.stringify(matchups), { status: 200 })
        : new Response('null', { status: 200 }),
  });
}

function env(db: NodeSqliteDatabase, matchups: unknown): AppEnv {
  return {
    db,
    sleeper: sleeperServing(matchups),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

function get(path: string): Request {
  return new Request(`https://app.test${path}`);
}

describe('GET /api/leagues/:id/matchup', () => {
  let db: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('reads the pairing, the lineups and the score from Sleeper', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    expect(body.found).toBe(true);
    expect(body.week).toBe(1);
    expect(body.season).toBe('2026');
    expect(body.forecast.slots).toHaveLength(7);
    expect(body.forecast.slots.map((s: { slot: string }) => s.slot)).toEqual([
      'QB',
      'RB',
      'RB',
      'WR',
      'WR',
      'TE',
      'FLEX',
    ]);
    expect(body.forecast.slots[0].mine.playerId).toBe('1003');
    expect(body.forecast.slots[0].theirs.playerId).toBe('1010');
  });

  /**
   * Sleeper sends `"0"` for a slot nobody is filling.
   *
   * Treated as an id it would produce a phantom starter with no name and a
   * projection of nothing, which would then be counted in the opponent's total.
   */
  it('reads an empty lineup slot as empty rather than as a player', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    const secondRb = body.forecast.slots[2];
    expect(secondRb.slot).toBe('RB');
    expect(secondRb.theirs).toBeNull();
    expect(secondRb.mine.playerId).toBe('1008');
  });

  it('uses Sleeper’s team totals rather than re-adding the players', async () => {
    const body = await (
      await app(
        get('/api/leagues/demo-league/matchup'),
        env(db, rows({ mine: { points: 88.44, players_points: { '1003': 20.1 } }, theirs: { points: 61.2 } })),
      )
    ).json();
    expect(body.forecast.teams.mine.actual).toBe(88.44);
    expect(body.forecast.teams.theirs.actual).toBe(61.2);
    // ...and the per-player number is Sleeper's too.
    expect(body.forecast.slots[0].mine.actual).toBe(20.1);
  });

  it('separates the bench from the starters', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    expect(body.forecast.bench.mine.map((p: { playerId: string }) => p.playerId).sort()).toEqual(['1009', '1014']);
    for (const player of body.forecast.bench.mine) expect(player.starting).toBe(false);
  });

  it('carries a ready-made player card for everybody it could score', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    expect(Object.keys(body.cards).length).toBeGreaterThan(10);
    expect(body.cards['1003'].name).toBe('Trey Halloran');
    expect(body.cards['1003'].headline.verdict).toBe('start');
  });

  it('says plainly when the league has no matchup for the week', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup?week=7'), env(db, []))).json();
    expect(body.found).toBe(false);
    expect(body.week).toBe(7);
    expect(body.reason).toMatch(/no week 7 matchup/i);
    expect(body.forecast).toBeNull();
  });

  it('says plainly when there is no opponent', async () => {
    const bye = rows();
    bye[0]!.matchup_id = null;
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, bye))).json();
    expect(body.found).toBe(false);
    expect(body.reason).toMatch(/no opponent/i);
  });

  it('serves an unchanged state from cache rather than resimulating', async () => {
    const appEnv = env(db, rows());
    const first = await (await app(get('/api/leagues/demo-league/matchup'), appEnv)).json();
    const second = await (await app(get('/api/leagues/demo-league/matchup'), appEnv)).json();
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.forecast.fingerprint).toBe(first.forecast.fingerprint);
    expect(second.forecast.computedAt).toBe(first.forecast.computedAt);
  });

  it('recomputes when a score actually moves', async () => {
    const appEnv = env(db, rows());
    const before = await (await app(get('/api/leagues/demo-league/matchup'), appEnv)).json();
    const after = await (
      await app(
        get('/api/leagues/demo-league/matchup'),
        env(db, rows({ mine: { points: 21.4, players_points: { '1003': 21.4 } } })),
      )
    ).json();
    expect(after.cached).toBe(false);
    expect(after.forecast.fingerprint).not.toBe(before.forecast.fingerprint);
  });

  /**
   * The same player reads the same on both screens.
   *
   * The Team screen's cards gain the expected-points line through
   * `weeklyIntelligence`; these are built on a different path, and the only
   * thing stopping the two from drifting is that both ask `assessXfp`.
   */
  it('carries the expected-points line the Team screen’s cards carry', async () => {
    // Seeded here for the same reason the lineup test seeds it: usage arrives
    // from nflverse in production and the demo league predates it.
    const season = String(new Date().getUTCFullYear());
    await new UsageRepo(db).saveWeeks(
      Array.from({ length: 7 }, (_, i) => ({
        playerId: '1001',
        season,
        week: i + 1,
        seasonType: 'REG',
        team: 'KC',
        position: 'RB',
        passAttempts: null,
        carries: 17,
        targets: 4,
        receptions: 3,
        targetShare: 0.1,
        wopr: 0.3,
        rushYards: 74,
        rushTds: 0.5,
        recYards: 22,
        recTds: 0,
        gsisId: 'gsis-1001',
        source: 'test',
        publishedAt: '2025-10-01T00:00:00.000Z',
        fetchedAt: '2025-10-01T00:00:00.000Z',
      })),
    );

    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    const cards = body.cards as Record<string, { lines: { key: string; value: string }[]; pending: string[] }>;
    const line = cards['1001']!.lines.find((l) => l.key === 'xfp');
    expect(line?.value).toMatch(/pts\/gm$/);
    // A player with no stored usage says so rather than printing a zero.
    expect(cards['1002']!.lines.some((l) => l.key === 'xfp')).toBe(false);
    expect(cards['1002']!.pending).toContain('expected points');
  });

  /**
   * The mode suggestion is the app's existing one, carried rather than remade.
   *
   * Asserted against `suggestMode`'s own vocabulary — `auto`, `state`, `detail`,
   * `reasons` — because that is what fails if this screen ever grows a private
   * reading of the same question off its own win probability.
   */
  it('carries the Team screen’s mode suggestion rather than forming its own', async () => {
    const body = await (await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).json();
    const suggestion = body.forecast.suggestedMode;
    expect(['floor', 'balanced', 'ceiling']).toContain(suggestion.mode);
    expect(typeof suggestion.auto).toBe('boolean');
    expect(['substantial_favourite', 'close', 'substantial_underdog', 'unknown']).toContain(suggestion.state);
    expect(suggestion.detail).toBeTruthy();
    expect(Array.isArray(suggestion.reasons)).toBe(true);
    // Balanced-with-a-reason is a refusal, not a choice; the two are distinguishable.
    if (!suggestion.auto) expect(suggestion.mode).toBe('balanced');
  });

  it('is a read that needs no passphrase', async () => {
    expect((await app(get('/api/leagues/demo-league/matchup'), env(db, rows()))).status).toBe(200);
  });

  it('404s an unknown league rather than inventing one', async () => {
    expect((await app(get('/api/leagues/nope/matchup'), env(db, rows()))).status).toBe(404);
  });
});

describe('the calibration ledger', () => {
  let db: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('records both sides of the matchup, with the model version', async () => {
    await app(get('/api/leagues/demo-league/matchup'), env(db, rows()));
    const stored = await db.prepare('SELECT * FROM matchup_forecasts ORDER BY roster_id').all<Record<string, unknown>>();
    expect(stored.results).toHaveLength(2);
    for (const row of stored.results) {
      expect(row['model_version']).toBe(MATCHUP_MODEL_VERSION);
      expect(row['season']).toBe('2026');
      expect(row['week']).toBe(1);
      expect(row['first_win_probability']).not.toBeNull();
      expect(row['latest_fingerprint']).toBeTruthy();
    }
  });

  /**
   * The first forecast is the calibration sample and is written once.
   *
   * A model graded on its latest forecast would be graded at
   * kickoff-minus-a-minute and would score suspiciously well.
   */
  it('never overwrites the first forecast, and does move the latest one', async () => {
    await app(get('/api/leagues/demo-league/matchup'), env(db, rows()));
    const first = await db
      .prepare('SELECT first_win_probability AS p, latest_win_probability AS l FROM matchup_forecasts WHERE roster_id = 1')
      .first<{ p: number; l: number }>();

    await app(
      get('/api/leagues/demo-league/matchup'),
      env(db, rows({ theirs: { points: 61.2, players_points: { '1010': 61.2 } } })),
    );
    const after = await db
      .prepare('SELECT first_win_probability AS p, latest_win_probability AS l FROM matchup_forecasts WHERE roster_id = 1')
      .first<{ p: number; l: number }>();

    expect(after!.p).toBe(first!.p);
    expect(after!.l).not.toBe(first!.l);
  });

  it('reports its sample honestly and withholds a rate below the threshold', async () => {
    await app(get('/api/leagues/demo-league/matchup'), env(db, rows()));
    const report = await (await app(get('/api/diagnostics/matchup-calibration'), env(db, rows()))).json();
    expect(report.minSample).toBe(MIN_CALIBRATION_SAMPLE);
    expect(report.buckets).toHaveLength(10);
    for (const bucket of report.buckets) {
      if (bucket.sample < MIN_CALIBRATION_SAMPLE) expect(bucket.observed).toBeNull();
    }
  });

  it('reports a rate once a band has enough settled weeks', async () => {
    const repo = new MatchupRepo(db);
    // Thirty forecasts in the 70-80 band, twenty-two of which won: 73%, which
    // is what a calibrated model at 74% should look like.
    for (let i = 0; i < 30; i++) {
      await repo.record({
        leagueId: 'l',
        season: '2026',
        week: i + 1,
        rosterId: 1,
        matchupId: 1,
        opponentRosterId: 2,
        modelVersion: MATCHUP_MODEL_VERSION,
        phase: 'pregame',
        winProbability: 0.74,
        projectedFinal: 120,
        actual: 0,
        confidence: 'high',
        fingerprint: `f${i}`,
        at: '2026-09-01T00:00:00.000Z',
      });
      await repo.settle({
        leagueId: 'l',
        season: '2026',
        week: i + 1,
        rosterId: 1,
        finalScore: i < 22 ? 130 : 90,
        opponentFinalScore: 100,
        at: '2026-09-02T00:00:00.000Z',
      });
    }

    const report = await repo.calibration(MATCHUP_MODEL_VERSION);
    const band = report.buckets.find((b) => b.band === '70-80')!;
    expect(band.sample).toBe(30);
    expect(band.predicted).toBeCloseTo(0.74, 2);
    expect(band.observed).toBeCloseTo(22 / 30, 2);
  });

  it('grades only what was forecast before kickoff', async () => {
    const repo = new MatchupRepo(db);
    for (let i = 0; i < 25; i++) {
      await repo.record({
        leagueId: 'l',
        season: '2026',
        week: i + 1,
        rosterId: 1,
        matchupId: 1,
        opponentRosterId: 2,
        modelVersion: MATCHUP_MODEL_VERSION,
        // First seen at half-time: not a pregame prediction.
        phase: 'live',
        winProbability: 0.95,
        projectedFinal: 120,
        actual: 80,
        confidence: 'high',
        fingerprint: `f${i}`,
        at: '2026-09-01T00:00:00.000Z',
      });
      await repo.settle({
        leagueId: 'l',
        season: '2026',
        week: i + 1,
        rosterId: 1,
        finalScore: 130,
        opponentFinalScore: 100,
        at: '2026-09-02T00:00:00.000Z',
      });
    }
    const report = await repo.calibration(MATCHUP_MODEL_VERSION);
    expect(report.sample).toBe(0);
    for (const bucket of report.buckets) expect(bucket.sample).toBe(0);
  });

  it('settles a week once, with both scores, and never twice', async () => {
    const repo = new MatchupRepo(db);
    const base = {
      leagueId: 'l',
      season: '2026',
      week: 3,
      rosterId: 1,
      matchupId: 1,
      opponentRosterId: 2,
      modelVersion: MATCHUP_MODEL_VERSION,
      phase: 'pregame',
      winProbability: 0.6,
      projectedFinal: 110,
      actual: 0,
      confidence: 'high',
      fingerprint: 'f',
      at: '2026-09-01T00:00:00.000Z',
    };
    await repo.record(base);
    await repo.settle({ ...base, finalScore: 120, opponentFinalScore: 100, at: '2026-09-02T00:00:00.000Z' });
    await repo.settle({ ...base, finalScore: 5, opponentFinalScore: 400, at: '2026-09-03T00:00:00.000Z' });

    const row = await db
      .prepare('SELECT final_score AS f, opponent_final_score AS o, won FROM matchup_forecasts WHERE week = 3')
      .first<{ f: number; o: number; won: number }>();
    expect(row).toEqual({ f: 120, o: 100, won: 1 });
  });

  /** A tie is a fact about a league's rules, not a win or a loss. */
  it('records a tie as neither', async () => {
    const repo = new MatchupRepo(db);
    const base = {
      leagueId: 'l',
      season: '2026',
      week: 4,
      rosterId: 1,
      matchupId: 1,
      opponentRosterId: 2,
      modelVersion: MATCHUP_MODEL_VERSION,
      phase: 'pregame',
      winProbability: 0.5,
      projectedFinal: 110,
      actual: 0,
      confidence: 'high',
      fingerprint: 'f',
      at: '2026-09-01T00:00:00.000Z',
    };
    await repo.record(base);
    await repo.settle({ ...base, finalScore: 100, opponentFinalScore: 100, at: '2026-09-02T00:00:00.000Z' });
    const row = await db
      .prepare('SELECT won, final_score AS f FROM matchup_forecasts WHERE week = 4')
      .first<{ won: number | null; f: number }>();
    expect(row!.won).toBeNull();
    expect(row!.f).toBe(100);
  });

  /** Week 16 of one season must never collide with week 16 of another. */
  it('keeps two seasons’ week sixteens apart', async () => {
    const repo = new MatchupRepo(db);
    for (const season of ['2026', '2027']) {
      await repo.record({
        leagueId: 'l',
        season,
        week: 16,
        rosterId: 1,
        matchupId: 1,
        opponentRosterId: 2,
        modelVersion: MATCHUP_MODEL_VERSION,
        phase: 'pregame',
        winProbability: season === '2026' ? 0.2 : 0.9,
        projectedFinal: 110,
        actual: 0,
        confidence: 'high',
        fingerprint: season,
        at: `${season}-12-20T00:00:00.000Z`,
      });
    }
    const stored = await db
      .prepare('SELECT season, first_win_probability AS p FROM matchup_forecasts WHERE week = 16 ORDER BY season')
      .all<{ season: string; p: number }>();
    expect(stored.results).toEqual([
      { season: '2026', p: 0.2 },
      { season: '2027', p: 0.9 },
    ]);
  });
});

describe('the pieces the service resolves for itself', () => {
  it('builds slot specs in the league’s own order, with the bench removed', () => {
    const specs = buildSlotSpecs(['QB', 'RB', 'RB', 'WR', 'FLEX', 'BN', 'BN', 'IR']);
    expect(specs.map((s) => s.slot)).toEqual(['QB', 'RB', 'RB', 'WR', 'FLEX']);
    // Two RB rows, and they are not the same slot.
    expect(specs[1]!.key).not.toBe(specs[2]!.key);
    expect(specs[4]!.accepts).toEqual(['RB', 'WR', 'TE']);
  });

  it('takes the week from Sleeper and refuses one outside the season', () => {
    expect(resolveWeek(null, 12)).toBe(12);
    expect(resolveWeek(5, 12)).toBe(5);
    // The preseason dead zone: Sleeper reports week 0, and week one is the
    // schedule anybody looking in August actually wants.
    expect(resolveWeek(null, 0)).toBe(1);
    expect(resolveWeek(99, 12)).toBe(12);
    expect(resolveWeek(null, null)).toBe(1);
  });

  it('treats a week Sleeper has moved past as settled', () => {
    expect(isWeekSettled(12, 11, 'regular')).toBe(true);
    expect(isWeekSettled(12, 12, 'regular')).toBe(false);
    expect(isWeekSettled(1, 18, 'post')).toBe(true);
    expect(isWeekSettled(null, 3, 'regular')).toBe(false);
  });
});

describe('availability is charged once, not twice', () => {
  /**
   * The engine prices a Questionable designation as points off the score; this
   * model prices the same fact as a probability of not playing. The projection
   * handed to the model therefore has the engine's penalty removed — otherwise
   * the same designation is charged twice, which §3 forbids.
   */
  const component = (key: string, value: number, unknown = false) => ({
    key,
    label: key,
    display: '',
    value,
    baseValue: value,
    modeWeight: 1,
    unknown,
  });

  it('strips the availability component out of the engine’s score', () => {
    const evaluation = {
      score: 12.5,
      expectation: { points: 14 },
      components: [component('vegas', 14), component('status', -1.5)],
    } as never;
    expect(activeProjection(evaluation)).toBe(14);
  });

  it('leaves a healthy player’s score exactly as it was', () => {
    const evaluation = {
      score: 14,
      expectation: { points: 14 },
      components: [component('vegas', 14), component('status', 0, true)],
    } as never;
    expect(activeProjection(evaluation)).toBe(14);
  });

  it('recovers the projection of a player who has been ruled out', () => {
    // The engine gates him at -99 so nothing can recommend him; the model needs
    // the number underneath that gate, because it is what he *would* have
    // scored — and what the lineup loses by leaving him in.
    const evaluation = {
      score: -87,
      expectation: { points: 12 },
      components: [component('vegas', 12), component('status', -99)],
    } as never;
    expect(activeProjection(evaluation)).toBe(12);
  });

  it('keeps unknown as unknown rather than as zero', () => {
    expect(activeProjection(undefined)).toBeNull();
    expect(activeProjection({ score: null, expectation: { points: null }, components: [] } as never)).toBeNull();
  });

  /**
   * The one that was silently wrong.
   *
   * A Doubtful player nobody has priced still gets a non-null score from the
   * engine — the availability penalty on its own is a known component — and
   * subtracting that penalty back out produced a projection of about zero. On a
   * card that reads as "expected to score nothing", when the truth is "nobody
   * has priced him". Without a market number there is no projection.
   */
  it('refuses to turn an availability penalty into a projection of zero', () => {
    const evaluation = {
      score: -6,
      expectation: { points: null },
      components: [component('vegas', 0, true), component('status', -6)],
    } as never;
    expect(activeProjection(evaluation)).toBeNull();
  });
});
