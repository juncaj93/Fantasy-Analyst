/**
 * The third projection tier, and what it is allowed to cost.
 *
 * Alex, 15 September 2026: *fall back to preseason average ÷ games played when
 * neither market nor Rotowire has a number. Same principle as before: a rough
 * number beats a hard zero.*
 *
 * The principle is the one that let the second tier in ten days ago, and it is
 * arithmetic rather than taste. `buildDistribution` settles an unprojected
 * player as truth-only, so a null projection does not make the model cautious —
 * it makes the player contribute **zero** to his side's total, and a side with
 * a confident zero in it is a worse forecast than one with a stale estimate.
 *
 * Three things are tested, and the third is the one that would sink this
 * feature quietly:
 *
 *  1. **The arithmetic**, including the reading of the instruction that was
 *     *not* taken. "÷ games played" has an obvious meaning that is wrong in the
 *     direction that ships: a season total over one game played is a week-one
 *     projection of three hundred points.
 *  2. **The order and the labelling.** Market, then Rotowire, then this, and a
 *     figure from the third tier may never wear the second's mark.
 *  3. **The cost.** This screen polls every thirty seconds while games are on.
 *     The obvious implementation — read the snapshot for every player on both
 *     rosters, every poll — is about two thousand rows a poll against a quota
 *     this repo has exhausted before. Both the call count and the query plan
 *     are asserted, because an assertion about the answer passes just as
 *     happily against the scan.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';
import { candidate } from './helpers/startsit.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PreseasonProjectionsRepo } from '../src/server/repos/preseasonProjections.ts';
import type { LeagueRecord, RosterRecord, SleeperMatchup } from '../src/core/sleeper/types.ts';
import type { Database } from '../src/server/db.ts';

const LEAGUE: LeagueRecord = {
  id: 'l1',
  sleeperLeagueId: 's1',
  name: 'Tony’s Pizza',
  season: '2026',
  scoringSettings: { rec: 0.5 },
  rosterPositions: ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'],
  leagueSettings: {},
  draftId: null,
  totalRosters: 12,
  lastSyncedAt: '2026-09-17T14:00:00Z',
};

const MINE = ['qb1', 'rb1', 'wr1', 'te1'];
const THEIRS = ['qb2', 'rb2', 'wr2', 'te2'];

const roster = (rosterId: number, isMine: boolean, ids: string[]): RosterRecord => ({
  leagueId: 'l1',
  rosterId,
  ownerId: `o${rosterId}`,
  ownerName: `Owner ${rosterId}`,
  playerIds: ids,
  starterIds: ids,
  reserveIds: [],
  isMine,
});

const matchupRows = (): SleeperMatchup[] => [
  { roster_id: 1, matchup_id: 7, points: 0, players: MINE, starters: MINE, players_points: {} } as SleeperMatchup,
  { roster_id: 2, matchup_id: 7, points: 0, players: THEIRS, starters: THEIRS, players_points: {} } as SleeperMatchup,
];

interface Fixture {
  /** Market points by id, null for a player nobody has priced. */
  market?: Map<string, number | null>;
  /** Rotowire's week by id. */
  published?: Map<string, number>;
  /** Preseason **season totals** by id — what the snapshot actually stores. */
  preseason?: Map<string, number>;
  /** Set when the preseason bag should throw rather than answer. */
  preseasonThrows?: boolean;
  /** Filled in with every call the bag received, for the cost assertions. */
  asked?: string[][];
}

function sources(fixture: Fixture = {}): MatchupSources {
  const { market, published, preseason, preseasonThrows, asked } = fixture;
  return {
    leagues: {
      getLeague: async () => LEAGUE,
      listRosters: async () => [roster(1, true, MINE), roster(2, false, THEIRS)],
    },
    matchups: async () => matchupRows(),
    nflState: async () => ({ season: '2026', seasonType: 'regular', week: 2 }),
    startSitInputs: async (ids) =>
      ids.map((id) => candidate(id, `Player ${id}`, id.slice(0, 2).toUpperCase(), market?.get(id) ?? null)),
    previousForecast: async () => null,
    publishedProjections: async () => published ?? new Map(),
    preseasonProjections: async ({ playerIds }) => {
      asked?.push([...playerIds]);
      if (preseasonThrows) throw new Error('snapshot unavailable');
      return new Map([...(preseason ?? new Map<string, number>())].filter(([id]) => playerIds.includes(id)));
    },
    cached: () => null,
    remember: () => {},
    now: () => new Date('2026-09-17T15:00:00Z'),
  };
}

/** Every player in the response, starters and bench, both sides. */
function playersOf(response: Awaited<ReturnType<typeof buildMatchupResponse>>) {
  const forecast = response.forecast!;
  return [
    ...forecast.slots.flatMap((row) => [row.mine, row.theirs]),
    ...forecast.bench.mine,
    ...forecast.bench.theirs,
  ].filter((p): p is NonNullable<typeof p> => p != null);
}

/** Twelve a game, as a season total — the shape the snapshot stores. */
const SEASON_TOTALS = new Map([...MINE, ...THEIRS].map((id) => [id, 12 * EXPECTED_GAMES]));

/*
 * A second fixture with the real league's starting seven.
 *
 * `MAX_COVERAGE_GAP` is 0.2, and on four starters one missing man is a gap of
 * 0.25 — the forecast degrades and there is no total left to compare. Seven is
 * what Tony's Pizza actually starts, and six of seven is 0.143: inside the
 * threshold, so both sides of the comparison produce a number and the
 * assertion is about the number rather than about the refusal.
 */
const SEVEN = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const SEVEN_MINE = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
const SEVEN_THEIRS = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
const POSITION_OF = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR'];

function sevenSources(fixture: Fixture = {}): MatchupSources {
  const { market, published, preseason, asked } = fixture;
  const wide: LeagueRecord = { ...LEAGUE, rosterPositions: SEVEN };
  return {
    ...sources(fixture),
    leagues: {
      getLeague: async () => wide,
      listRosters: async () => [roster(1, true, SEVEN_MINE), roster(2, false, SEVEN_THEIRS)],
    },
    matchups: async () =>
      [
        {
          roster_id: 1,
          matchup_id: 7,
          points: 0,
          players: SEVEN_MINE,
          starters: SEVEN_MINE,
          players_points: {},
        },
        {
          roster_id: 2,
          matchup_id: 7,
          points: 0,
          players: SEVEN_THEIRS,
          starters: SEVEN_THEIRS,
          players_points: {},
        },
      ] as SleeperMatchup[],
    startSitInputs: async (ids) =>
      ids.map((id) => {
        const index = Number(id.slice(1)) - 1;
        return candidate(id, `Player ${id}`, POSITION_OF[index] ?? 'WR', market?.get(id) ?? null);
      }),
    publishedProjections: async () => published ?? new Map(),
    preseasonProjections: async ({ playerIds }) => {
      asked?.push([...playerIds]);
      return new Map([...(preseason ?? new Map<string, number>())].filter(([id]) => playerIds.includes(id)));
    },
  };
}

describe('the arithmetic, and the reading of it that was not taken', () => {
  it('spreads a season total over the games a healthy starter plays', async () => {
    const response = await buildMatchupResponse(sources({ preseason: SEASON_TOTALS }), 'l1');
    const wr = playersOf(response).find((p) => p.playerId === 'wr1')!;

    expect(wr.projectedFinal).toBe(12);
    expect(wr.projectionEstimated).toBe(true);
  });

  it('does not divide by the games he has played, which is week one at three hundred points', async () => {
    /*
     * The instruction said "÷ games played" and this is the one place the
     * implementation deliberately departs from its wording. Two games in, the
     * literal reading gives a 288-point season total a 144-point week; the one
     * taken gives it eighteen. There is no fixture that distinguishes those two
     * by accident, so it is asserted directly.
     */
    const response = await buildMatchupResponse(sources({ preseason: SEASON_TOTALS }), 'l1');
    const wr = playersOf(response).find((p) => p.playerId === 'wr1')!;

    expect(EXPECTED_GAMES).toBe(16);
    expect(wr.projectedFinal).toBeLessThan(30);
    expect(wr.projectedFinal).toBe(Math.round((12 * EXPECTED_GAMES) / EXPECTED_GAMES));
  });

  it('refuses a stored zero rather than passing it on as a projection of nothing', async () => {
    // A zero in the snapshot is a player the import could not price, not a
    // player somebody projected for nothing, and 0.0 in the column would
    // relabel a gap as a forecast. The dash is the honest answer.
    const zeros = new Map([...MINE, ...THEIRS].map((id) => [id, 0]));
    const response = await buildMatchupResponse(sources({ preseason: zeros }), 'l1');

    for (const player of playersOf(response)) {
      expect(player.projectedFinal, `${player.playerId}`).toBeNull();
      expect(player.projectionEstimated ?? false).toBe(false);
    }
  });

  it('keeps the figure when the snapshot answers for some players and not others', async () => {
    const partial = new Map([['wr1', 10 * EXPECTED_GAMES]]);
    const response = await buildMatchupResponse(sources({ preseason: partial }), 'l1');
    const byId = new Map(playersOf(response).map((p) => [p.playerId, p]));

    expect(byId.get('wr1')!.projectedFinal).toBe(10);
    expect(byId.get('te1')!.projectedFinal).toBeNull();
  });
});

describe('the order of the three, and the mark each one carries', () => {
  it('prefers this app’s market to everything else', async () => {
    const all = await buildMatchupResponse(
      sources({
        market: new Map([['wr1', 18]]),
        published: new Map([['wr1', 14]]),
        preseason: new Map([['wr1', 6 * EXPECTED_GAMES]]),
      }),
      'l1',
    );
    const marketOnly = await buildMatchupResponse(sources({ market: new Map([['wr1', 18]]) }), 'l1');

    const wr = playersOf(all).find((p) => p.playerId === 'wr1')!;

    /*
     * Asserted against the market-only build rather than against `18`. The
     * figure a market of eighteen produces is the engine's, not the fixture's,
     * and pinning the literal here would make this a test of the start/sit
     * engine that failed every time somebody tuned it. What it has to show is
     * that the other two numbers changed nothing.
     */
    expect(wr.projectedFinal).toBe(playersOf(marketOnly).find((p) => p.playerId === 'wr1')!.projectedFinal);
    expect(wr.projectedFinal).not.toBe(14);
    expect(wr.projectedFinal).not.toBe(6);
    expect(wr.projectionBorrowed ?? false).toBe(false);
    expect(wr.projectionEstimated ?? false).toBe(false);
  });

  it('prefers Rotowire’s week to an August season total', async () => {
    // Both are somebody else's number; only one of them was made with this
    // Sunday in view. The tie is not close and should never be scored.
    const response = await buildMatchupResponse(
      sources({
        published: new Map([['wr1', 14]]),
        preseason: new Map([['wr1', 6 * EXPECTED_GAMES]]),
      }),
      'l1',
    );
    const wr = playersOf(response).find((p) => p.playerId === 'wr1')!;

    expect(wr.projectedFinal).toBe(14);
    expect(wr.projectionBorrowed).toBe(true);
    expect(wr.projectionEstimated ?? false).toBe(false);
  });

  it('never marks one figure as two kinds of borrowed at once', async () => {
    /*
     * The two flags are mutually exclusive and the screen branches on
     * `projectionEstimated` first, so a player carrying both would be drawn as
     * the weaker tier while the number came from the stronger one. Nothing
     * should be able to set both.
     */
    const mixed = await buildMatchupResponse(
      sources({
        market: new Map([['qb1', 22]]),
        published: new Map([['rb1', 13]]),
        preseason: SEASON_TOTALS,
      }),
      'l1',
    );
    for (const player of playersOf(mixed)) {
      expect(player.projectionBorrowed && player.projectionEstimated, `${player.playerId}`).toBeFalsy();
    }
  });

  it('marks the tier on every player it reached, bench included', async () => {
    // A bench dash beside a starter's estimate would be this app disagreeing
    // with itself about whether it can price a man.
    const twoUp: LeagueRecord = { ...LEAGUE, rosterPositions: ['QB', 'RB', 'BN', 'BN'] };
    const withBench: MatchupSources = {
      ...sources({ preseason: SEASON_TOTALS }),
      leagues: {
        getLeague: async () => twoUp,
        listRosters: async () => [roster(1, true, MINE), roster(2, false, THEIRS)],
      },
      matchups: async () =>
        [
          { roster_id: 1, matchup_id: 7, points: 0, players: MINE, starters: MINE.slice(0, 2), players_points: {} },
          { roster_id: 2, matchup_id: 7, points: 0, players: THEIRS, starters: THEIRS.slice(0, 2), players_points: {} },
        ] as SleeperMatchup[],
    };
    const response = await buildMatchupResponse(withBench, 'l1');
    const benched = playersOf(response).filter((p) => !p.starting);

    expect(benched.length).toBe(4);
    for (const player of benched) expect(player.projectionEstimated).toBe(true);
  });
});

describe('it reaches the win probability, not only the column', () => {
  it('turns a forecast it would have refused into one it can make', async () => {
    const without = await buildMatchupResponse(sources({}), 'l1');
    const withIt = await buildMatchupResponse(sources({ preseason: SEASON_TOTALS }), 'l1');

    // Nobody priced by anybody: the degraded path, and correctly so.
    expect(without.forecast!.degraded).toBe(true);
    expect(without.forecast!.teams.mine.winProbability).toBeNull();

    // The same matchup with the third tier available is a real forecast.
    expect(withIt.forecast!.degraded).toBe(false);
    expect(withIt.forecast!.teams.mine.winProbability).not.toBeNull();
    expect(withIt.forecast!.teams.mine.projectedFinal).toBeGreaterThan(0);
  });

  it('moves the opponent’s total off zero, which is the whole point', async () => {
    /*
     * The failure this replaces, stated as arithmetic. This app buys market
     * lines for the reader's roster and nobody else's, so it is the opponent
     * who goes unpriced — and an unpriced starter is not an uncertain one, he
     * is a certain nothing. One of four starters contributing zero is a
     * twenty-five percent haircut applied to one side of a coin flip.
     */
    const priced = new Map(
      [...SEVEN_MINE, ...SEVEN_THEIRS].filter((id) => id !== 'x7').map((id) => [id, 15] as const),
    );

    const zeroed = await buildMatchupResponse(sevenSources({ market: priced }), 'l1');
    const rescued = await buildMatchupResponse(
      sevenSources({ market: priced, preseason: new Map([['x7', 15 * EXPECTED_GAMES]]) }),
      'l1',
    );

    // Six of seven priced is a 0.143 gap, inside `MAX_COVERAGE_GAP`, so both
    // builds produce a real forecast and the comparison is about the number
    // rather than about which of them refused to make one.
    expect(zeroed.forecast!.degraded).toBe(false);
    expect(rescued.forecast!.degraded).toBe(false);

    expect(zeroed.forecast!.teams.theirs.projectedFinal).toBeLessThan(
      rescued.forecast!.teams.theirs.projectedFinal!,
    );
    // And the reader's own win probability comes down accordingly, because the
    // opponent he was beating was four-sevenths of a team.
    expect(rescued.forecast!.teams.mine.winProbability!).toBeLessThan(
      zeroed.forecast!.teams.mine.winProbability!,
    );
  });

  it('survives a source that fails, with the dash it would have had anyway', async () => {
    const response = await buildMatchupResponse(sources({ preseasonThrows: true }), 'l1');

    expect(response.found).toBe(true);
    for (const player of playersOf(response)) expect(player.projectionEstimated ?? false).toBe(false);
  });

  it('is simply absent for a caller that does not offer it', async () => {
    // Every fixture in the rest of the suite, and Demo Mode: an omitted bag is
    // no fallback rather than an error.
    const { preseasonProjections: _omitted, ...withoutBag } = sources({ preseason: SEASON_TOTALS });
    const response = await buildMatchupResponse(withoutBag as MatchupSources, 'l1');

    expect(response.found).toBe(true);
    for (const player of playersOf(response)) expect(player.projectionEstimated ?? false).toBe(false);
  });
});

describe('what it costs, on a screen that polls every thirty seconds', () => {
  it('does not ask at all when every player already has a number', async () => {
    const asked: string[][] = [];
    await buildMatchupResponse(
      sources({
        market: new Map([...MINE, ...THEIRS].map((id) => [id, 14])),
        preseason: SEASON_TOTALS,
        asked,
      }),
      'l1',
    );
    // The ordinary Sunday. Nothing unpriced, so nothing read: the whole feature
    // costs zero statements on the poll that runs two thousand times a week.
    expect(asked).toEqual([]);
  });

  it('asks only about the players who reached the third tier, never the roster', async () => {
    const asked: string[][] = [];
    await buildMatchupResponse(
      sources({
        market: new Map([...MINE, ...THEIRS].filter((id) => id !== 'qb2').map((id) => [id, 14])),
        published: new Map(),
        preseason: SEASON_TOTALS,
        asked,
      }),
      'l1',
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(['qb2']);
  });

  it('counts Rotowire as priced, so the tiers do not stack their reads', async () => {
    const asked: string[][] = [];
    await buildMatchupResponse(
      sources({
        market: new Map([['qb1', 20]]),
        published: new Map([...MINE, ...THEIRS].filter((id) => id !== 'te2').map((id) => [id, 11])),
        preseason: SEASON_TOTALS,
        asked,
      }),
      'l1',
    );
    expect(asked[0]).toEqual(['te2']);
  });
});

describe('and what those reads plan as, in the database', () => {
  async function seededDb(): Promise<{ db: Database; snapshotId: number }> {
    const db = await createTestDb();
    for (let i = 0; i < 600; i += 1) {
      await db
        .prepare('INSERT INTO players (id, full_name, normalized_name, created_at, updated_at) VALUES (?,?,?,?,?)')
        .bind(`p${i}`, `Player ${i}`, `player ${i}`, 'x', 'x')
        .run();
    }
    // Three captures for one season, so a query that walks them all is visible.
    for (let s = 0; s < 3; s += 1) {
      await db
        .prepare(
          `INSERT INTO preseason_projection_snapshots
             (season, source, captured_at, scoring_key, scoring_json, scoring_label,
              imported_at, capture_label, last_updated, raw_input)
           VALUES ('2026','StartWho',?,?,'{}','Half PPR','x','lab',NULL,'raw')`,
        )
        .bind(`2026-08-0${s + 1}`, `key-${s}`)
        .run();
    }
    const { results } = await db
      .prepare('SELECT id FROM preseason_projection_snapshots ORDER BY id')
      .all<{ id: number }>();
    for (const { id } of results) {
      for (let i = 0; i < 600; i += 1) {
        await db
          .prepare(
            `INSERT INTO preseason_projections (snapshot_id, player_id, source_player_name, points, raw_json)
             VALUES (?,?,?,?,'{}')`,
          )
          .bind(id, `p${i}`, `Player ${i}`, 100 + i)
          .run();
      }
    }
    return { db, snapshotId: Number(results.at(-1)!.id) };
  }

  const planOf = async (db: Database, sql: string, binds: unknown[]): Promise<string> => {
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    return results.map((r) => r.detail).join(' | ');
  };

  it('finds the newest capture without counting the season’s rows', async () => {
    const { db } = await seededDb();
    const plan = await planOf(
      db,
      `SELECT id FROM preseason_projection_snapshots
        WHERE season = ? AND scoring_key = ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
      ['2026', 'key-2'],
    );
    expect(plan).toMatch(/COVERING INDEX idx_preseason_projection_lookup/);
    expect(plan).not.toMatch(/SCAN/);

    const counting = countingDb(db);
    const id = await new PreseasonProjectionsRepo(counting.db).latestId('2026', 'key-2');
    expect(id).not.toBeNull();
    // One row, against `list()`'s eighteen hundred.
    expect(counting.tallies().reduce((n, t) => n + t.rows, 0)).toBe(1);
  });

  it('seeks each wanted player rather than walking the whole capture', async () => {
    /*
     * Migration 0041. Without `(snapshot_id, player_id, points)` this planned
     * as `SEARCH ... USING INDEX idx_preseason_projections_snapshot`, which
     * reads all six hundred rows of the snapshot and filters the thirty wanted
     * ids in memory. D1 bills rows read.
     */
    const { db, snapshotId } = await seededDb();
    const wanted = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const placeholders = wanted.map(() => '?').join(',');

    const plan = await planOf(
      db,
      `SELECT player_id, points FROM preseason_projections
        WHERE snapshot_id = ? AND player_id IN (${placeholders})`,
      [snapshotId, ...wanted],
    );
    expect(plan).toMatch(/COVERING INDEX idx_preseason_projections_snapshot_player/);
    expect(plan).toMatch(/snapshot_id=\? AND player_id=\?/);

    const counting = countingDb(db);
    const points = await new PreseasonProjectionsRepo(counting.db).pointsForSnapshot(snapshotId, wanted);
    expect(points.size).toBe(30);
    expect(counting.tallies().reduce((n, t) => n + t.rows, 0)).toBe(30);
  });

  it('leaves the Admin listing on the query that answers its question', async () => {
    // `list()` is still the join, because the screen it feeds prints the row
    // counts it computes. The point of `latestId` was never to replace it.
    const { db } = await seededDb();
    const all = await new PreseasonProjectionsRepo(db).list('2026');
    expect(all.map((s) => s.rows)).toEqual([600, 600, 600]);
  });
});

describe('the wall the tier is not allowed through', () => {
  const ROOT = path.resolve(import.meta.dirname, '..', 'src');
  const read = (relative: string): string => readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

  it('keeps the preseason snapshot out of every engine that recommends something', () => {
    /*
     * The same wall `sleeperProjectionFallback.test.ts` holds around Rotowire,
     * extended to the tier below it. `build.ts` may choose what number a player
     * carries — that is the assembly's job — and the simulator may run on
     * whatever it is handed. What must not happen is a *ranking* built on an
     * August estimate: a lineup, a draft pick or a trade decided by what
     * somebody thought in the preseason would be this app recommending action
     * on a number it cannot defend for this week.
     */
    for (const relative of [
      'core/matchup/model.ts',
      'core/matchup/simulate.ts',
      'core/matchup/distribution.ts',
      'core/matchup/decision.ts',
      'core/startsit/lineup.ts',
      'core/startsit/engine.ts',
      'core/draft/score.ts',
    ]) {
      const text = read(relative);
      expect(
        /from '[^']*(preseasonProjections|startWho)[^']*'/i.test(text),
        `${relative} reads the preseason snapshot`,
      ).toBe(false);
    }
  });

  it('gives both dividers one definition rather than two sixteens', () => {
    // `core/trades/arbitrage.ts` spreads the same season total over the same
    // games to get the week a player was expected to have. Two copies of the
    // constant would drift the first time either was tuned.
    expect(read('core/trades/arbitrage.ts')).toMatch(/expectedGames:\s*EXPECTED_GAMES/);
    expect(read('core/matchup/build.ts')).toMatch(/EXPECTED_GAMES/);
  });

  it('keeps the shared constant a leaf, so reading it costs no import graph', () => {
    // The `core/trades/category.ts` lesson: a module reachable from the entry
    // lands in the entry chunk whatever else also reaches it, so a constant
    // that lived in the trade engine would drag the trade engine along.
    expect(read('core/nfl/expectedGames.ts')).not.toMatch(/^import /m);
  });
});
