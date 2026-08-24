/**
 * The published fallback, and the wall around it.
 *
 * The product decision is that where this app cannot form a market-derived
 * weekly projection it may show Rotowire's published one instead, by way of
 * Sleeper — and that the borrowed number is **display-only**. It may not reach
 * the start/sit ranking, the matchup simulation, the draft score, the trade
 * engine or any other recommendation.
 *
 * That is a claim about what the code cannot do, so most of this file is written
 * as differences that must be empty: run the engine with a fallback and without
 * one, and prove every conclusion is identical. A test that merely checked the
 * fallback appears would pass just as happily on a build that had wired it into
 * the optimiser.
 *
 * The last describe is structural rather than behavioural — it reads the source
 * tree — because "no engine imports this" is the invariant, and an invariant
 * about imports is best checked against imports.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { marketProjection, weeklyProjection } from '../src/core/startsit/projection.ts';
import {
  parseSleeperWeeklyProjections,
  sleeperProjectionPath,
  sleeperScoringKey,
} from '../src/core/sleeper/weeklyProjections.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { LeagueRecord, RosterRecord, SleeperMatchup } from '../src/core/sleeper/types.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

/** Half PPR with Sleeper's defaults — the live league's shape. */
const HALF_PPR = buildScoringProfile({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'BN']);
const SHAPE = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'BN', 'BN']);

/** An evaluation-shaped fixture: adjustments known, market absent or present. */
function evaluation(over: Partial<{ score: number | null; market: number | null }> = {}) {
  const market = over.market === undefined ? null : over.market;
  return {
    score: over.score === undefined ? 1.35 : over.score,
    expectation: { points: market, coverage: market == null ? 0 : 1 },
    components: [
      { key: 'vegas', value: market ?? 0, unknown: market == null },
      { key: 'news_recent', value: 2.1, unknown: false },
      { key: 'status', value: -1.5, unknown: false },
    ],
  };
}

describe('the hierarchy, in the order it is written down', () => {
  it('takes this app’s market projection whenever there is one', () => {
    // Market present *and* a published figure offered: the market wins, and the
    // published number is not blended into it, added to it or averaged with it.
    const priced = evaluation({ score: 12.4, market: 13.9 });
    expect(weeklyProjection(priced, 21.4)).toEqual({ points: 13.9, source: 'market' });
    expect(marketProjection(priced)).toBe(13.9);
  });

  it('falls back to the published figure only when there is no market', () => {
    expect(weeklyProjection(evaluation(), 20.98)).toEqual({ points: 20.98, source: 'sleeper' });
  });

  it('is unknown when neither exists, and says so as null rather than zero', () => {
    expect(weeklyProjection(evaluation(), null)).toEqual({ points: null, source: null });
    expect(weeklyProjection(evaluation())).toEqual({ points: null, source: null });
    expect(weeklyProjection(evaluation(), undefined)).toEqual({ points: null, source: null });
  });

  it('never separates the number from where it came from', () => {
    // The source is null exactly when the points are, on every path.
    for (const [ev, published] of [
      [evaluation({ score: 12.4, market: 13.9 }), null],
      [evaluation(), 20.98],
      [evaluation(), null],
      [null, 20.98],
      [null, null],
    ] as const) {
      const answer = weeklyProjection(ev, published);
      expect(answer.source == null).toBe(answer.points == null);
    }
  });

  it('refuses a published figure that is not a number', () => {
    expect(weeklyProjection(evaluation(), Number.NaN).source).toBeNull();
    expect(weeklyProjection(evaluation(), Number.POSITIVE_INFINITY).source).toBeNull();
  });
});

describe('nothing is counted twice', () => {
  /**
   * The published figure is quoted exactly as published.
   *
   * This app charges a Questionable player points for being questionable, and
   * takes that charge back out of its *own* projection because availability is
   * expressed again elsewhere. Rotowire's number was never charged, so there is
   * nothing to take out — and taking something out anyway would be this app's
   * arithmetic applied to somebody else's model.
   */
  it('applies no availability adjustment to a borrowed number', () => {
    const questionable = evaluation({ score: 1.35 });
    expect(questionable.components.find((c) => c.key === 'status')?.value).toBe(-1.5);
    expect(weeklyProjection(questionable, 12.7).points).toBe(12.7);
  });

  it('never sums the two tiers', () => {
    const priced = evaluation({ score: 12.4, market: 13.9 });
    const both = weeklyProjection(priced, 21.4).points!;
    expect(both).toBe(13.9);
    expect(both).not.toBeCloseTo(13.9 + 21.4, 5);
  });

  it('rounds to two places and never returns a negative', () => {
    expect(weeklyProjection(evaluation(), 12.3456).points).toBe(12.35);
    expect(weeklyProjection(evaluation(), -4).points).toBe(0);
  });
});

describe('which leagues may read a published total', () => {
  it('matches the three Sleeper publishes, by reception value', () => {
    const std = buildScoringProfile({ rec: 0 }, []);
    const half = buildScoringProfile({ rec: 0.5 }, []);
    const full = buildScoringProfile({ rec: 1 }, []);
    expect(sleeperScoringKey(std, 'WR')).toBe('pts_std');
    expect(sleeperScoringKey(half, 'WR')).toBe('pts_half_ppr');
    expect(sleeperScoringKey(full, 'WR')).toBe('pts_ppr');
  });

  it('refuses a reception value none of the three assumes', () => {
    expect(sleeperScoringKey(buildScoringProfile({ rec: 0.75 }, []), 'WR')).toBeNull();
    expect(sleeperScoringKey(buildScoringProfile({ rec: 2 }, []), 'WR')).toBeNull();
  });

  it('refuses a player whose own stat line is scored differently', () => {
    // Six-point passing touchdowns are worth about two points a game to a
    // quarterback. Quoting a four-point-TD projection to that league is a
    // projection of a different sport, not a projection with a caveat.
    expect(sleeperScoringKey(buildScoringProfile({ rec: 0.5, pass_td: 6 }, []), 'QB')).toBeNull();
    expect(sleeperScoringKey(buildScoringProfile({ rec: 0.5, rec_yd: 0.2 }, []), 'WR')).toBeNull();
    // Fumbles and rushing reach everybody, quarterbacks included.
    expect(sleeperScoringKey(buildScoringProfile({ rec: 1, fum_lost: -1 }, []), 'RB')).toBeNull();
    expect(sleeperScoringKey(buildScoringProfile({ rec: 1, fum_lost: -1 }, []), 'QB')).toBeNull();
    expect(sleeperScoringKey(buildScoringProfile({ rec: 0.5, rush_td: 4 }, []), 'QB')).toBeNull();
  });

  /**
   * The live league, which is what taught this rule to be per-position.
   *
   * `Sunday Morning Best Ball` scores six-point passing touchdowns and
   * minus-two interceptions and is otherwise Sleeper's defaults. The first
   * version of this refused the whole league, so a roster of nine got nine
   * dashes to avoid one wrong quarterback — while Rotowire's published total was
   * exactly right for the other eight, whose projected passing line is zero.
   */
  it('serves the pass-catchers of a six-point-passing-TD league, and not its quarterback', () => {
    const live = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2 }, []);
    expect(sleeperScoringKey(live, 'QB'), 'a QB is priced on passing').toBeNull();
    for (const position of ['RB', 'WR', 'TE']) {
      expect(sleeperScoringKey(live, position), `${position} does not throw`).toBe('pts_half_ppr');
    }
    // …and a caller that cannot say who it is asking about still gets nothing.
    expect(sleeperScoringKey(live, null)).toBeNull();
  });

  it('checks every setting when the position is unknown or unmodelled', () => {
    const passingOnly = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
    expect(sleeperScoringKey(passingOnly, null)).toBeNull();
    expect(sleeperScoringKey(passingOnly, 'K')).toBeNull();
    expect(sleeperScoringKey(passingOnly, 'DEF')).toBeNull();
    // The same league is fine for the positions whose stat lines it does not touch.
    expect(sleeperScoringKey(passingOnly, 'WR')).toBe('pts_half_ppr');
  });

  it('refuses tight ends in a premium league, and only tight ends', () => {
    const premium = buildScoringProfile({ rec: 0.5, bonus_rec_te: 0.5 }, []);
    expect(sleeperScoringKey(premium, 'TE')).toBeNull();
    expect(sleeperScoringKey(premium, 'WR')).toBe('pts_half_ppr');
    // "We were not told" is not "he is not a tight end" — see the matchup path,
    // whose source bag carries no positions.
    expect(sleeperScoringKey(premium, null)).toBeNull();
    expect(sleeperScoringKey(premium, '')).toBeNull();
  });

  it('serves every position when the league is Sleeper’s own scoring throughout', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE', null]) {
      expect(sleeperScoringKey(HALF_PPR, position)).toBe('pts_half_ppr');
    }
  });

  it('has no opinion without a profile', () => {
    expect(sleeperScoringKey(null, 'WR')).toBeNull();
    expect(sleeperScoringKey(undefined, 'WR')).toBeNull();
  });
});

describe('reading the feed', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    player_id: '4046',
    company: 'Rotowire',
    stats: { pts_std: 17.4, pts_half_ppr: 20.98, pts_ppr: 24.6 },
    ...over,
  });

  it('keeps the three totals and lower-cases the publisher', () => {
    const [parsed] = parseSleeperWeeklyProjections([row()]);
    expect(parsed).toEqual({
      playerId: '4046',
      publisher: 'rotowire',
      points: { pts_std: 17.4, pts_half_ppr: 20.98, pts_ppr: 24.6 },
    });
  });

  it('keeps a projected zero, which is a forecast and not an absence', () => {
    const [parsed] = parseSleeperWeeklyProjections([row({ stats: { pts_half_ppr: 0 } })]);
    expect(parsed!.points.pts_half_ppr).toBe(0);
    expect(parsed!.points.pts_ppr).toBeNull();
  });

  it('drops rows that can never answer anything', () => {
    expect(parseSleeperWeeklyProjections([row({ player_id: null })])).toEqual([]);
    expect(parseSleeperWeeklyProjections([row({ stats: {} })])).toEqual([]);
    expect(parseSleeperWeeklyProjections([row({ stats: null })])).toEqual([]);
  });

  it('survives a payload that is not the shape it expects', () => {
    expect(parseSleeperWeeklyProjections(null)).toEqual([]);
    expect(parseSleeperWeeklyProjections({})).toEqual([]);
    expect(parseSleeperWeeklyProjections('nope')).toEqual([]);
  });

  it('asks the regular season for the positions this app draws', () => {
    const url = sleeperProjectionPath('2026', 1);
    expect(url).toContain('/projections/nfl/2026/1');
    expect(url).toContain('season_type=regular');
    for (const position of ['QB', 'RB', 'WR', 'TE']) expect(url).toContain(`position[]=${position}`);
  });
});

/**
 * A roster nobody has priced, which is the only state the fallback is for.
 *
 * Every candidate carries news but no market, exactly like production through
 * August 2026 — so `marketProjection` is null for all of them and the optimiser
 * is ranking on adjustments alone.
 */
function unpricedRoster() {
  return [
    candidate('qb1', 'Jalen Hurts', 'QB', null, { signal: signalWithNet(3) }),
    candidate('rb1', 'Christian McCaffrey', 'RB', null, { signal: signalWithNet(4) }),
    candidate('rb2', 'RJ Harvey', 'RB', null, { signal: signalWithNet(1) }),
    candidate('wr1', 'Malik Nabers', 'WR', null, { signal: signalWithNet(2) }),
    candidate('te1', 'Sam LaPorta', 'TE', null, { signal: signalWithNet(2) }),
  ];
}

describe('the lineup is ranked without it', () => {
  /**
   * The published numbers are deliberately upside down.
   *
   * They rank the roster in the reverse of the order the engine chose, so a
   * build that let them anywhere near the optimiser would not merely differ —
   * it would differ visibly, in the assignment itself.
   */
  const upsideDown = new Map([
    ['qb1', 4.1],
    ['rb1', 5.2],
    ['rb2', 30.3],
    ['wr1', 28.4],
    ['te1', 26.5],
  ]);

  const withFallback = () =>
    recommendLineup(unpricedRoster(), SHAPE, HALF_PPR, { published: upsideDown, now: '2026-09-13T15:00:00Z' });
  const without = () => recommendLineup(unpricedRoster(), SHAPE, HALF_PPR, { now: '2026-09-13T15:00:00Z' });

  it('assigns exactly the same players to exactly the same slots', () => {
    const a = withFallback();
    const b = without();
    expect(a.slots.map((s) => [s.slot, s.playerId])).toEqual(b.slots.map((s) => [s.slot, s.playerId]));
  });

  it('leaves every ranking number identical', () => {
    const a = withFallback();
    const b = without();
    expect(a.slots.map((s) => s.score)).toEqual(b.slots.map((s) => s.score));
    expect(a.recommendedPoints).toBe(b.recommendedPoints);
    expect(a.currentPoints).toBe(b.currentPoints);
    expect(a.confidence).toBe(b.confidence);
    expect(a.swaps).toEqual(b.swaps);
    expect(a.bench.map((e) => [e.playerId, e.score])).toEqual(b.bench.map((e) => [e.playerId, e.score]));
  });

  it('differs in the displayed projection and in nothing else', () => {
    const a = withFallback();
    const b = without();
    const strip = (r: ReturnType<typeof withFallback>) =>
      r.slots.map(({ projection, projectionSource, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));

    // …and the display really did change, so the comparison above is not vacuous.
    const filled = a.slots.filter((s) => s.playerId);
    expect(filled.length).toBeGreaterThan(0);
    expect(filled.every((s) => s.projectionSource === 'sleeper')).toBe(true);
    expect(b.slots.filter((s) => s.playerId).every((s) => s.projection == null)).toBe(true);
  });

  it('still refuses to project a player the fallback does not cover', () => {
    const partial = new Map([['qb1', 21.4]]);
    const lineup = recommendLineup(unpricedRoster(), SHAPE, HALF_PPR, {
      published: partial,
      now: '2026-09-13T15:00:00Z',
    });
    const qb = lineup.slots.find((s) => s.playerId === 'qb1')!;
    const rb = lineup.slots.find((s) => s.playerId === 'rb1')!;
    expect(qb.projection).toBe(21.4);
    expect(qb.projectionSource).toBe('sleeper');
    expect(rb.projection).toBeNull();
    expect(rb.projectionSource).toBeNull();
  });
});

describe('the weekly card quotes it and names it', () => {
  const base = {
    playerId: 'qb1',
    name: 'Jalen Hurts',
    position: 'QB',
    team: 'PHI',
    confidence: 'low',
    statusFlag: null,
    ruledOut: false,
  };

  it('shows the published figure and marks it as published', () => {
    const card = buildWeeklyCard({ ...base, ...evaluation({ score: 3.15 }) }, { starting: true, published: 20.98 });
    expect(card.score).toBe(20.98);
    expect(card.projectionSource).toBe('sleeper');
  });

  it('prefers the market and marks it as ours', () => {
    const card = buildWeeklyCard(
      { ...base, ...evaluation({ score: 12.4, market: 13.9 }) },
      { starting: true, published: 20.98 },
    );
    expect(card.score).toBe(13.9);
    expect(card.projectionSource).toBe('market');
  });

  it('says nothing at all when neither exists', () => {
    const card = buildWeeklyCard({ ...base, ...evaluation({ score: 3.15 }) }, { starting: true });
    expect(card.score).toBeNull();
    expect(card.projectionSource).toBeNull();
  });
});

/**
 * The matchup assembly, run twice over one fixture.
 *
 * The forecast is the whole model — distributions, correlation, the simulation,
 * the projected final, the win probability, the swap advice — so comparing two
 * whole forecasts is the strongest available statement that the fallback
 * reaches none of it.
 */
describe('the matchup forecast is simulated without it', () => {
  const LEAGUE: LeagueRecord = {
    id: 'l1',
    sleeperLeagueId: 's1',
    name: 'Test',
    season: '2026',
    totalRosters: 2,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'],
    leagueSettings: {},
    draftId: null,
    lastSyncedAt: '2026-09-17T14:00:00Z',
  };

  const roster = (rosterId: number, isMine: boolean, ids: string[]): RosterRecord => ({
    leagueId: 'l1',
    rosterId,
    ownerId: `o${rosterId}`,
    ownerName: `Owner ${rosterId}`,
    playerIds: ids,
    starterIds: ids.slice(0, 4),
    reserveIds: [],
    isMine,
  });

  const MINE = ['qb1', 'rb1', 'wr1', 'te1'];
  const THEIRS = ['qb2', 'rb2', 'wr2', 'te2'];

  const matchupRows = (): SleeperMatchup[] => [
    { roster_id: 1, matchup_id: 7, points: 0, players: MINE, starters: MINE, players_points: {} } as SleeperMatchup,
    { roster_id: 2, matchup_id: 7, points: 0, players: THEIRS, starters: THEIRS, players_points: {} } as SleeperMatchup,
  ];

  const inputsFor = (ids: string[]) =>
    ids.map((id) => candidate(id, `Player ${id}`, id.slice(0, 2).toUpperCase(), null, { signal: signalWithNet(2) }));

  function sources(published: Map<string, number> | null): MatchupSources {
    return {
      leagues: {
        getLeague: async () => LEAGUE,
        listRosters: async () => [roster(1, true, MINE), roster(2, false, THEIRS)],
      },
      matchups: async () => matchupRows(),
      nflState: async () => ({ season: '2026', seasonType: 'regular', week: 2 }),
      startSitInputs: async (ids) => inputsFor(ids),
      previousForecast: async () => null,
      cached: () => null,
      remember: () => {},
      now: () => new Date('2026-09-17T15:00:00Z'),
      ...(published ? { publishedProjections: async () => published } : {}),
    };
  }

  /** Large enough that a forecast built on them could not be mistaken for one that was not. */
  const PUBLISHED = new Map([...MINE, ...THEIRS].map((id, i) => [id, 15 + i]));

  it('produces an identical forecast with and without the published feed', async () => {
    const withIt = await buildMatchupResponse(sources(PUBLISHED), 'l1');
    const without = await buildMatchupResponse(sources(null), 'l1');
    expect(withIt.found).toBe(true);
    expect(withIt.forecast).toEqual(without.forecast);
  });

  it('leaves the projected final and the win probability unknown, as a market-less week is', () => {
    // The degraded path §33 describes: a scoreboard, and no forecast on top of
    // it. The published numbers must not turn it into a confident afternoon.
    return buildMatchupResponse(sources(PUBLISHED), 'l1').then((response) => {
      expect(response.forecast!.teams.mine.projectedFinal).toBeNull();
      expect(response.forecast!.teams.mine.winProbability).toBeNull();
    });
  });

  /**
   * …and the forecast is sensitive to projections, so that equality means something.
   *
   * Without this, "the two forecasts match" could be satisfied by a model that
   * ignored projections altogether. Giving the same fixture real markets moves
   * the forecast from the degraded path to a live one — which is exactly the
   * change the published numbers were large enough to have caused, and did not.
   */
  it('and the same fixture with real markets forecasts differently', async () => {
    const priced: MatchupSources = {
      ...sources(PUBLISHED),
      startSitInputs: async (ids) =>
        ids.map((id, i) =>
          candidate(id, `Player ${id}`, id.slice(0, 2).toUpperCase(), 15 + i, { signal: signalWithNet(2) }),
        ),
    };
    const response = await buildMatchupResponse(priced, 'l1');
    expect(response.forecast!.teams.mine.projectedFinal).not.toBeNull();
    expect(response.forecast!.teams.mine.winProbability).not.toBeNull();
  });

  it('does change the cards, so the comparison above is not vacuous', async () => {
    const withIt = await buildMatchupResponse(sources(PUBLISHED), 'l1');
    const without = await buildMatchupResponse(sources(null), 'l1');
    expect(withIt.cards['qb1']!.score).toBe(PUBLISHED.get('qb1'));
    expect(withIt.cards['qb1']!.projectionSource).toBe('sleeper');
    expect(without.cards['qb1']!.score).toBeNull();
    expect(without.cards['qb1']!.projectionSource).toBeNull();
  });
});

/**
 * The wall, read off the source tree.
 *
 * Every test above is about behaviour on today's code. This one is about what a
 * future change is allowed to do: the fallback enters through exactly two
 * functions, and if a new caller of either appears inside an engine, this fails
 * and names the file. It is the cheapest available substitute for a compiler
 * that understood the word "display-only".
 */
describe('no recommendation engine can reach the fallback', () => {
  const ROOT = path.resolve(import.meta.dirname, '..', 'src');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  /** The three places a display value is legitimately assembled. */
  const DISPLAY_OWNERS = new Set(
    [
      'core/startsit/lineup.ts',
      'core/startsit/weekCard.ts',
      'core/startsit/projection.ts',
      'server/app.ts',
      'web/screens/TeamScreen.tsx',
    ].map((p) => path.join(ROOT, ...p.split('/'))),
  );

  it('only the display owners import weeklyProjection', () => {
    const offenders = sourceFiles(ROOT).filter((file) => {
      if (DISPLAY_OWNERS.has(file)) return false;
      const text = readFileSync(file, 'utf8');
      return /\bimport\b[^;]*\bweeklyProjection\b[^;]*from/.test(text);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the matchup model, the draft score and the trade engine read the market number or nothing', () => {
    for (const relative of [
      'core/matchup/model.ts',
      'core/matchup/simulate.ts',
      'core/matchup/distribution.ts',
      'core/matchup/decision.ts',
      'core/draft/score.ts',
      'core/draft/engine.ts',
      'core/trades/engine.ts',
      'core/startsit/engine.ts',
    ]) {
      const file = path.join(ROOT, ...relative.split('/'));
      const text = readFileSync(file, 'utf8');
      expect(/\bimport\b[^;]*\bweeklyProjection\b/.test(text), `${relative} imports weeklyProjection`).toBe(false);
      expect(
        /\bimport\b[^;]*\bsleeperProjectionService\b/i.test(text),
        `${relative} imports the published feed`,
      ).toBe(false);
    }
  });

  /**
   * The weekly hierarchy and StartWho's Preseason PTS never meet.
   *
   * They are two numbers a screen could plausibly print under similar words and
   * they answer different questions — one is this week, the other is the whole
   * season, captured once before it started. Keeping them in separate files is
   * not enough on its own; keeping them from importing each other is what makes
   * "never confused" checkable.
   */
  it('the weekly path and the preseason snapshot do not read each other', () => {
    const weeklyPath = [
      'core/sleeper/weeklyProjections.ts',
      'core/startsit/projection.ts',
      'server/repos/sleeperProjections.ts',
      'server/services/sleeperProjectionService.ts',
    ];
    for (const relative of weeklyPath) {
      const text = readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
      expect(/from '[^']*(preseason|seasonImport|startWho)[^']*'/i.test(text), `${relative} reads preseason`).toBe(
        false,
      );
    }

    /*
     * And the Team screen, which is where the two could actually be confused.
     *
     * Preseason PTS has a legitimate home on the draft board and in the expanded
     * player view, both of which label it. What it must never be is the number on
     * the trailing edge of a Team row — that field is this week's projection, and
     * a season-long baseline sitting in it would read as a forecast of Sunday.
     * The row takes its value from `LineupSlot.projection` and the screen knows
     * no other word for it, which is what this asserts.
     */
    const team = readFileSync(path.join(ROOT, 'web', 'screens', 'TeamScreen.tsx'), 'utf8');
    expect(/preseason/i.test(team), 'the Team screen mentions preseason').toBe(false);

    const preseason = sourceFiles(ROOT).filter((file) => /preseason|seasonImport|startWho/i.test(file));
    expect(preseason.length, 'the preseason modules should exist to be checked').toBeGreaterThan(0);
    for (const file of preseason) {
      const text = readFileSync(file, 'utf8');
      expect(
        /from '[^']*(weeklyProjections|sleeperProjection)[^']*'/.test(text),
        `${path.relative(ROOT, file)} reads the weekly feed`,
      ).toBe(false);
    }
  });

  it('nothing outside the sanctioned paths reads the published feed at all', () => {
    const allowed = new Set(
      [
        'core/sleeper/client.ts',
        'core/sleeper/weeklyProjections.ts',
        'server/repos/sleeperProjections.ts',
        'server/services/sleeperProjectionService.ts',
        'server/services/matchupService.ts',
        'server/services/startSitRefresh.ts',
        /*
         * The Projection v2 side-by-side, and it is sanctioned for exactly the
         * reason this list exists.
         *
         * The rule being guarded is that Rotowire's number never enters a
         * recommendation. This service enters nothing: it is the phase-1
         * evaluation report, it reads the published figure to print it in a
         * comparison column beside this app's own projection and Projection v2,
         * and its output is returned to a diagnostics route rather than stored
         * or consumed. `tests/projectionV2.boundary.test.ts` asserts separately
         * that no recommendation engine imports anything it produces, which is
         * the other half of the same promise.
         */
        'server/services/projectionV2Service.ts',
        'server/app.ts',
        'worker/index.ts',
      ].map((p) => path.join(ROOT, ...p.split('/'))),
    );
    const offenders = sourceFiles(ROOT).filter((file) => {
      if (allowed.has(file)) return false;
      const text = readFileSync(file, 'utf8');
      return /from '[^']*(weeklyProjections|sleeperProjection[sS]?ervice|repos\/sleeperProjections)[^']*'/.test(text);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
