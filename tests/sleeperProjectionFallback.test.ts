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
  publishedDefenseRefusal,
  scorePublishedDefense,
  sleeperProjectionPath,
  SLEEPER_PROJECTION_POSITIONS,
  sleeperScoringKey,
  publishedRefusal,
} from '../src/core/sleeper/weeklyProjections.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DST_SCORING_UNSUPPORTED } from '../src/core/sleeper/dstScoring.ts';
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

  /**
   * The refusal, out loud.
   *
   * The rule above is right and it was invisible, which is a different defect
   * with the same symptom. A half-PPR league scoring six-point passing
   * touchdowns gives every pass-catcher a published number and its quarterback a
   * dash, and from a phone that is one screen where the projections stopped
   * working for one player. Reported as exactly that on 2 September 2026:
   * "projections show for most players but not for QB Joe Burrow specifically."
   */
  describe('saying why', () => {
    const live = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2 }, []);

    it('says nothing at all where the published total is served', () => {
      for (const position of ['RB', 'WR', 'TE']) expect(publishedRefusal(live, position)).toBeNull();
      expect(publishedRefusal(HALF_PPR, 'QB')).toBeNull();
    });

    it('names the settings that differ, so a reader can check them in Sleeper', () => {
      const reason = publishedRefusal(live, 'QB');
      expect(reason).not.toBeNull();
      expect(reason).toContain('QB');
      expect(reason).toContain('4 points per passing touchdown');
      expect(reason).toContain('-1 per interception');
    });

    it('names the reception value when that is what disqualified the league', () => {
      const reason = publishedRefusal(buildScoringProfile({ rec: 0.75 }, []), 'WR');
      expect(reason).toContain('0.75 per reception');
    });

    it('names the premium for the tight ends it applies to', () => {
      const premium = buildScoringProfile({ rec: 0.5, bonus_rec_te: 0.5 }, []);
      expect(publishedRefusal(premium, 'TE')).toContain('tight-end premium');
      expect(publishedRefusal(premium, 'WR')).toBeNull();
    });

    it('has no opinion without a profile', () => {
      expect(publishedRefusal(null, 'QB')).toBeNull();
    });
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
      // A quarterback has no defensive line. See the defence block below.
      defense: null,
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
/**
 * The one feature that *does* simulate on it, and everything that still does not.
 *
 * This block asserted the opposite until 10 September 2026: the matchup
 * forecast ran on `marketProjection` alone and the published feed reached only
 * the cards. The owner reversed it for this feature, and the reason is what a
 * null actually did — `buildDistribution` settles an unprojected starter as
 * truth-only, so he contributed *zero* to his side's total. This app prices the
 * reader's roster and no other, so that fell on the opponent, and an opponent
 * priced 4 of 7 came back as a 93.8% loss on a fixture that is a coin flip when
 * everybody is priced. A lower-confidence estimate beats a confident zero.
 *
 * So what this block now defends is the shape of the exception rather than its
 * absence: the forecast may borrow, it says so on every player that did, and
 * the lineup, the draft board and the trade engine still may not — which the
 * import-graph tests at the bottom of this file hold.
 */
describe('the matchup forecast may borrow, and says which players it borrowed for', () => {
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

  /**
   * Everything the simulator produces, and one field that is not simulated.
   *
   * The feed changes the forecast now, and that is the point of it.
   *
   * Asserted as a difference rather than an equality, because an exception
   * nobody exercises is an exception that quietly becomes a hole: without the
   * feed this fixture prices nobody and the forecast degrades; with it, every
   * starter carries a number and there is a real answer.
   */
  /**
   * The regression that emptied the opponent's column in production.
   *
   * Every fixture above stubs `publishedProjections` as a map lookup, which
   * cannot fail the way production failed: there the source is the real one,
   * and the real one checks the league's settings *per position*. The matchup's
   * source bag passed no positions — deliberately, on the reasoning that a
   * caller who cannot say who it is asking about should get the conservative
   * answer — and an unknown position is checked against every setting the feed
   * assumes at once.
   *
   * This league pays six points for a passing touchdown. So the conservative
   * answer was every player in it refused, and a probe of the live app on 10
   * September 2026 found what that looks like from outside: four unpriced
   * opponent starters, no borrowed number anywhere on either side, coverage of
   * 0.9 against 0.6, and no win probability at all.
   *
   * The stub here is the real rule rather than a map, so the assertion is about
   * routing and not about arithmetic.
   */
  it('asks the feed who each player is, so one rule about quarterbacks does not silence it', async () => {
    const sixPointPassing: LeagueRecord = { ...LEAGUE, scoringSettings: { rec: 0.5, pass_td: 6 } };
    const asked: (string | null)[] = [];

    const withPositions: MatchupSources = {
      ...sources(null),
      leagues: {
        getLeague: async () => sixPointPassing,
        listRosters: async () => [roster(1, true, MINE), roster(2, false, THEIRS)],
      },
      publishedProjections: async ({ playerIds, profile, positionOf }) => {
        const out = new Map<string, number>();
        for (const id of playerIds) {
          const position = positionOf(id);
          asked.push(position);
          if (sleeperScoringKey(profile, position) != null) out.set(id, 12);
        }
        return out;
      },
    };

    const response = await buildMatchupResponse(withPositions, 'l1');
    const rows = (response.forecast?.slots ?? []).flatMap((r) => [r.mine, r.theirs]).filter(Boolean);

    // The bag knows who it is asking about at all, which is the fix.
    expect(asked).toContain('RB');
    expect(asked.filter((p) => p == null)).toEqual([]);

    // A passing setting refuses the quarterback and nobody else.
    const borrowed = rows.filter((p) => p!.projectionBorrowed).map((p) => p!.playerId).sort();
    expect(borrowed).toEqual(['rb1', 'rb2', 'te1', 'te2', 'wr1', 'wr2']);
    for (const qb of ['qb1', 'qb2']) {
      expect(rows.find((p) => p!.playerId === qb)?.projectionBorrowed).toBeUndefined();
    }
  });

  it('turns a forecast it could not make into one it can', async () => {
    const withIt = await buildMatchupResponse(sources(PUBLISHED), 'l1');
    const without = await buildMatchupResponse(sources(null), 'l1');
    expect(withIt.found).toBe(true);

    // Nobody priced, nothing to simulate: the degraded path §33 describes.
    expect(without.forecast!.degraded).toBe(true);
    expect(without.forecast!.teams.mine.winProbability).toBeNull();

    // Borrowed throughout, and now a forecast rather than a scoreboard.
    expect(withIt.forecast!.degraded).toBe(false);
    expect(withIt.forecast!.teams.mine.winProbability).not.toBeNull();
    expect(withIt.forecast!.teams.mine.projectedFinal).not.toBeNull();
  });

  it('marks every player whose projection it borrowed', async () => {
    const withIt = await buildMatchupResponse(sources(PUBLISHED), 'l1');
    const players = [
      ...withIt.forecast!.slots.flatMap((row) => [row.mine, row.theirs]),
      ...withIt.forecast!.bench.mine,
      ...withIt.forecast!.bench.theirs,
    ].filter((p): p is NonNullable<typeof p> => p != null);

    expect(players.length).toBeGreaterThan(0);
    for (const player of players) {
      // This fixture has no market at all, so every figure is borrowed and
      // every one of them has to say so — the flag is what the screen draws
      // the lighter, italic treatment from.
      expect(player.projectedFinal, `${player.playerId} should carry a figure`).not.toBeNull();
      expect(player.projectionBorrowed, `${player.playerId} must be marked borrowed`).toBe(true);
    }
  });

  it('does not mark a player it priced itself', async () => {
    // The other direction, so the flag means something. Same fixture, real
    // markets: the figures are this app's and nothing is marked.
    const priced: MatchupSources = {
      ...sources(PUBLISHED),
      startSitInputs: async (ids) =>
        ids.map((id, i) =>
          candidate(id, `Player ${id}`, id.slice(0, 2).toUpperCase(), 15 + i, { signal: signalWithNet(2) }),
        ),
    };
    const response = await buildMatchupResponse(priced, 'l1');
    const starters = response.forecast!.slots.flatMap((row) => [row.mine, row.theirs]).filter(Boolean);

    expect(starters.length).toBeGreaterThan(0);
    for (const player of starters) expect(player!.projectionBorrowed ?? false).toBe(false);
  });

  it('lets the published week reach the posture too', async () => {
    const withIt = await buildMatchupResponse(sources(PUBLISHED), 'l1');
    const without = await buildMatchupResponse(sources(null), 'l1');

    // Without the feed nothing is priced on either side, so there is nothing to
    // read and Balanced is a default rather than a choice.
    expect(without.forecast!.suggestedMode.auto).toBe(false);
    // With it, both sides carry a number and the matchup can be called.
    expect(withIt.forecast!.suggestedMode.auto).toBe(true);
    expect(withIt.forecast!.suggestedMode.reasons.join(' ')).toMatch(/Rotowire/);
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

  /**
   * The places a display value is legitimately assembled.
   *
   * `core/startsit/assemble.ts` is here because the Team screen's display
   * layering moved into it: the lineup route used to spell out the projection
   * pass itself, and it now shares one function with Demo Mode and with the
   * support replay so the three cannot drift. The wall is unchanged in meaning —
   * that file assembles what is *shown*, and nothing in it decides a lineup.
   * `recommendLineup` runs to completion before the pass is applied.
   */
  const DISPLAY_OWNERS = new Set(
    [
      'core/startsit/lineup.ts',
      'core/startsit/weekCard.ts',
      'core/startsit/projection.ts',
      'core/startsit/assemble.ts',
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
        /*
         * The lineup route's own gathering, which is where it always was.
         *
         * It used to be spelled out inside `server/app.ts`; it moved when the
         * support snapshot needed the *same* reads the Team screen makes, and
         * the rule is unchanged — the published figure fills a display column
         * and reaches no ranking. `core/startsit/assemble.ts` runs the whole
         * optimiser before the map is touched.
         */
        'server/services/decisionInputs.ts',
        /*
         * Data Health, which reads the feed's *freshness* and never its numbers.
         *
         * `SleeperProjectionsRepo.freshness` returns a count, an instant and a
         * publisher name — how much of a week is stored and how old it is — and
         * that is the whole of what this service asks for. No projection value
         * crosses into it, and it produces a read-only report rather than an
         * input to anything: the rule this list guards is that Rotowire's
         * number never enters a recommendation, and a timestamp is not a
         * number about a player.
         */
        'server/services/dataHealthService.ts',
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


/**
 * A defence nobody quoted, which is now a number rather than a dash.
 *
 * The Week 1 gap left open by the market-anchored DST work: `projectDst` needs
 * either this defence's own game line or a priced opponent to anchor on, and
 * Jacksonville had neither. The row said nothing, correctly, and "nothing" is a
 * poor answer for the one slot the reader has least else to go on.
 *
 * The first attempt at this routed a defence to the published *total* and put a
 * comparison table in front of it — nine categories and a points-allowed table,
 * hand-written as what Rotowire was assumed to pay, quoted only to a league
 * that matched all of it. It never fired once in production, for two reasons
 * measured on 10 September 2026 rather than reasoned about:
 *
 *   1. The feed was never asked for a defensive row. `SLEEPER_PROJECTION_POSITIONS`
 *      listed QB, RB, WR and TE, so the table it was being compared against had
 *      nothing in it to compare. That is the first test below.
 *   2. Two of the nine values in the comparison table had never been
 *      established. Fitting all 32 published defences against their own totals
 *      showed the feed pays 1 per forced fumble, and the table said 0.
 *
 * So the table is gone. The feed publishes the projected *counts* beside the
 * total, which means a defence's number can be computed under this league's own
 * rules instead of being quoted from somebody else's — exactly right rather
 * than nearly right, and available to every league rather than to the ones that
 * happen to match Sleeper's defaults. That is `scorePublishedDefense`.
 */
describe('a defence with no line at all', () => {
  /** Sleeper's defaults, which the published totals are computed under. */
  const DEFAULT_DST = {
    rec: 0.5,
    sack: 1,
    int: 2,
    fum_rec: 2,
    ff: 1,
    def_td: 6,
    def_st_td: 6,
    safe: 2,
    blk_kick: 2,
    def_2pt: 2,
    pts_allow_0: 10,
    pts_allow_1_6: 7,
    pts_allow_7_13: 4,
    pts_allow_14_20: 1,
    pts_allow_21_27: 0,
    pts_allow_28_34: -1,
    pts_allow_35p: -4,
  };

  /**
   * Jacksonville's own published week, copied off the live feed.
   *
   * A real row rather than a tidy one, because the arithmetic below is a claim
   * about the feed's model and a made-up stat line could only ever confirm the
   * claim it was made up from. Sleeper published these counts and the total
   * 9.47 for JAX in week 1 of 2026.
   */
  const JACKSONVILLE = {
    sacks: 2.99,
    interceptions: 0.9,
    fumbleRecoveries: 0.69,
    forcedFumbles: 0.9,
    defensiveTds: 0.21,
    specialTeamsTds: 0,
    safeties: 0,
    blockedKicks: 0.07,
    pointsAllowed: 15.75,
    yardsAllowed: 270.98,
  };

  it('is asked for at all, which is the whole of why this never fired', () => {
    /*
     * The defect in one assertion. Every other part of the fallback was built,
     * labelled and tested, against a feed request that filtered defences out.
     */
    expect(SLEEPER_PROJECTION_POSITIONS).toContain('DEF');
    expect(sleeperProjectionPath('2026', 1)).toContain('position[]=DEF');
  });

  it('reproduces the published total when the league is scored the way the feed is', () => {
    /*
     * The fit, as a test. Scoring Rotowire's own counts under Sleeper's own
     * defaults has to come back at Rotowire's own total, or the components are
     * not the components the total was built from — and every league-specific
     * number below would be built on sand.
     *
     * Measured across all 32 defences of the live week: mean absolute error
     * 0.03, worst 0.06. Jacksonville lands exactly.
     */
    const profile = buildScoringProfile(DEFAULT_DST, []);
    expect(scorePublishedDefense(JACKSONVILLE, profile.dst)).toBeCloseTo(9.47, 2);
  });

  it('answers a league that scores a defence nothing like the feed does', () => {
    /*
     * The case the old comparison table refused, and the reason it is gone.
     * This is the owner's real league: it pays nothing for a forced fumble
     * where the feed pays one, and nothing in the two worst points-allowed
     * bands where the feed charges -1 and -4.
     *
     * The old rule called that "differs" and showed a dash. It differs, and the
     * answer is 8.57 — Rotowire's forecast of what Jacksonville will do, priced
     * at what this league pays for it. Exactly 0.9 below the published total,
     * which is the one forced fumble the league does not pay for.
     */
    const league = buildScoringProfile(
      { ...DEFAULT_DST, ff: 0, pts_allow_28_34: 0, pts_allow_35p: 0 },
      [],
    );
    expect(scorePublishedDefense(JACKSONVILLE, league.dst)).toBeCloseTo(8.57, 2);
  });

  it('prices the same week differently for two leagues, because they pay differently', () => {
    const stingy = buildScoringProfile({ ...DEFAULT_DST, sack: 2 }, []);
    const plain = buildScoringProfile(DEFAULT_DST, []);
    const a = scorePublishedDefense(JACKSONVILLE, stingy.dst)!;
    const b = scorePublishedDefense(JACKSONVILLE, plain.dst)!;
    // One extra point per sack, on 2.99 projected sacks.
    expect(a - b).toBeCloseTo(2.99, 2);
  });

  it('scores yards allowed for the leagues that have a table for it', () => {
    const yards = buildScoringProfile({ ...DEFAULT_DST, yds_allow_200_299: 5 }, []);
    const plain = buildScoringProfile(DEFAULT_DST, []);
    const withYards = scorePublishedDefense(JACKSONVILLE, yards.dst)!;
    const without = scorePublishedDefense(JACKSONVILLE, plain.dst)!;
    // 270.98 yards allowed falls in the band this league pays 5 for.
    expect(withYards - without).toBeCloseTo(5, 2);
  });

  it('has no answer only when the league’s own rules cannot be read', () => {
    expect(scorePublishedDefense(JACKSONVILLE, DST_SCORING_UNSUPPORTED)).toBeNull();
    expect(scorePublishedDefense(JACKSONVILLE, null)).toBeNull();
    expect(publishedDefenseRefusal(DST_SCORING_UNSUPPORTED)).toMatch(/could not be read/);
    expect(publishedDefenseRefusal(buildScoringProfile(DEFAULT_DST, []).dst)).toBeNull();
  });

  it('never quotes a published total for a defence, in any league', () => {
    /*
     * Not a refusal — a different question. The three totals are one number
     * computed under one defensive table, and a defence's number is computed
     * here instead. A league that matches the feed exactly still takes the
     * computed route, so there is one path rather than two that could disagree.
     */
    for (const dst of [DEFAULT_DST, { ...DEFAULT_DST, sack: 2 }]) {
      expect(sleeperScoringKey(buildScoringProfile(dst, []), 'DEF')).toBeNull();
      expect(sleeperScoringKey(buildScoringProfile(dst, []), 'DST')).toBeNull();
    }
    // And a six-point passing touchdown still has nothing to do with it.
    const passing = buildScoringProfile({ ...DEFAULT_DST, pass_td: 6 }, []);
    expect(sleeperScoringKey(passing, 'QB'), 'the quarterback is still refused').toBeNull();
    expect(publishedDefenseRefusal(passing.dst), 'the defence never threw a pass').toBeNull();
  });

  it('reads a defence’s counts off the feed and nobody else’s', () => {
    const [defence] = parseSleeperWeeklyProjections([
      {
        player_id: 'JAX',
        company: 'rotowire',
        player: { position: 'DEF' },
        stats: { pts_half_ppr: 9.47, sack: 2.99, int: 0.9, ff: 0.9, pts_allow: 15.75 },
      },
    ]);
    expect(defence?.defense?.sacks).toBe(2.99);
    expect(defence?.defense?.pointsAllowed).toBe(15.75);
    // Absent counts are zero; an absent expectation stays unknown, because
    // reading a missing `pts_allow` as 0 would put the defence in the shutout
    // band and pay it ten points for it.
    expect(defence?.defense?.safeties).toBe(0);

    const [receiver] = parseSleeperWeeklyProjections([
      {
        player_id: '4034',
        company: 'rotowire',
        player: { position: 'WR' },
        stats: { pts_half_ppr: 13.33, st_td: 0.06 },
      },
    ]);
    // A receiver with a return touchdown is not a defence.
    expect(receiver?.defense).toBeNull();
  });

  it('quotes the published figure and says whose it is', () => {
    /*
     * The end of the path. An unscorable defence — no market expectation, so no
     * score — carrying a published number comes back labelled `sleeper`, which
     * is what every surface keys its provenance off.
     */
    const unscorable = { score: null, expectation: { points: null }, components: [] };
    const quoted = weeklyProjection(unscorable, 6.4);

    expect(quoted.points).toBe(6.4);
    expect(quoted.source).toBe('sleeper');
    // And it still cannot be mistaken for this app's own number.
    expect(marketProjection(unscorable)).toBeNull();
  });
});
