/**
 * Model-integrity invariants: the permanent diagnostics.
 *
 * Every test here pins a pathology the Channel 1 audit actually found in this
 * codebase, or a property whose loss would let one back in. They are written as
 * **mutation tests wherever the property allows it** — the arrangement breaks a
 * guard on purpose and asserts the model notices — because an assertion that
 * only ever sees healthy data cannot tell you the guard is still connected.
 *
 * The findings, and where each is pinned:
 *
 *   P0  Start/Sit compared two players on Vegas totals built from different
 *       market sets, so a provider's coverage gap read as points of inferiority.
 *   P1  The draft's season-market component compared a partial baseline against
 *       a pool of complete ones, turning an unpriced market into a negative.
 *   P1  Duplicate book quotes voted twice in the consensus median and lifted
 *       `bookCount` off 1, silently cancelling the single-book penalty.
 *   P2  `scarcity` spent a real contribution on a component the same breakdown
 *       was labelling unknown.
 *   P3  The Next% cache keyed on how many picks had been made, not which.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEIGHTS,
  rankAvailablePlayers,
  sealComponents,
  type AvailablePlayerInput,
  type ComponentScore,
} from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { marketExpectationScore, seasonBaseline, resolveSeasonMarkets } from '../src/core/vegas/season.ts';
import { buildConsensus, oneQuotePerBook } from '../src/core/vegas/normalize.ts';
import { compareStartSit, type StartSitInput } from '../src/core/startsit/engine.ts';
import { assessMarketComparability } from '../src/core/startsit/comparability.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { draftStateKey } from '../src/core/draft/nextpick/index.ts';
import {
  detectAdpAnomalies,
  detectDuplicateMappings,
  detectGamesPlayedConflicts,
  detectInjuryConflicts,
  detectPeriodMismatch,
  detectPropsForRuledOutPlayers,
  detectSchemaDrift,
  summarizeAnomalies,
} from '../src/core/source/anomalies.ts';
import { PlayerIndex } from '../src/core/identity/index.ts';
import type { PlayerProp, RawPropQuote, SeasonMarketQuote } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

// --------------------------------------------------------------------------
// P2 — unknown contributes nothing
// --------------------------------------------------------------------------

describe('unknown components contribute nothing', () => {
  const board = (): AvailablePlayerInput[] => [
    { player: player({ id: 'a', fullName: 'Priced A', position: 'WR', team: 'CIN' }), adp: 10, adpRank: 10, signal: null },
    { player: player({ id: 'b', fullName: 'Priced B', position: 'WR', team: 'DET' }), adp: 22, adpRank: 22, signal: null },
    { player: player({ id: 'c', fullName: 'Priced C', position: 'WR', team: 'KC' }), adp: 41, adpRank: 41, signal: null },
    { player: player({ id: 'u', fullName: 'Unpriced Man', position: 'WR', team: 'NYJ' }), adp: null, adpRank: null, signal: null },
  ];

  const ctx = {
    currentPick: 15,
    nextPick: 30,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: { QB: 0, RB: 0, WR: 0, TE: 0 },
    totalPicks: 180,
  };

  it('never spends a contribution on a component it calls unknown', () => {
    for (const rec of rankAvailablePlayers(board(), ctx)) {
      for (const component of rec.components) {
        if (!component.unknown) continue;
        expect(
          component.contribution,
          `${rec.name} · ${component.key} is unknown but contributed ${component.contribution}`,
        ).toBe(0);
        // The breakdown shows `score × weight`. A non-zero score beside a zero
        // contribution is the same lie one column to the left.
        expect(component.score, `${rec.name} · ${component.key}`).toBe(0);
      }
    }
  });

  it('scores positional scarcity as unknown for a player with no ADP', () => {
    const unpriced = rankAvailablePlayers(board(), ctx).find((r) => r.playerId === 'u')!;
    const scarcity = unpriced.components.find((c) => c.key === 'scarcity')!;
    expect(scarcity.unknown).toBe(true);
    // The regression itself: this used to be −0.08, from `computeScarcity`'s
    // no-data default being mapped onto the −1..1 scale like a measurement.
    expect(scarcity.contribution).toBe(0);
  });

  it('mutation: a component that breaks the contract is caught by the seal', () => {
    const rogue: ComponentScore = {
      key: 'rogue',
      label: 'Rogue',
      display: 'invented',
      score: -0.4,
      weight: 0.2,
      contribution: -0.08,
      unknown: true,
    };
    sealComponents([rogue]);
    expect(rogue.contribution).toBe(0);
    expect(rogue.score).toBe(0);
  });

  it('leaves known components exactly as they were', () => {
    const honest: ComponentScore = {
      key: 'honest',
      label: 'Honest',
      display: 'measured',
      score: -0.4,
      weight: 0.2,
      contribution: -0.08,
      unknown: false,
    };
    sealComponents([honest]);
    expect(honest.contribution).toBe(-0.08);
    expect(honest.score).toBe(-0.4);
  });
});

// --------------------------------------------------------------------------
// P1 — a missing season market is not a negative opinion
// --------------------------------------------------------------------------

describe('season market coverage is not a verdict', () => {
  const receiver = (yards: number, receptions: number, tds: number) =>
    seasonBaseline(
      'WR',
      [
        { market: 'season_receiving_yards', line: yards },
        { market: 'season_receptions', line: receptions },
        { market: 'season_receiving_tds', line: tds },
      ],
      HALF_PPR,
    );

  /** An ordinary position: five receivers the market has priced completely. */
  const complete = [receiver(800, 55, 4), receiver(950, 65, 6), receiver(1100, 75, 7), receiver(1250, 85, 9), receiver(1400, 95, 11)];

  it('does not penalise an elite player priced on one market only', () => {
    // 1,400 receiving yards is the best figure at the position. He is missing
    // receptions and touchdowns, and that must not make him a below-average WR.
    const partial = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 1400 }], HALF_PPR);
    const score = marketExpectationScore(partial, [...complete, partial]);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it('still reads a genuinely weak partial baseline as weak', () => {
    const partial = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 500 }], HALF_PPR);
    const score = marketExpectationScore(partial, [...complete, partial])!;
    expect(score).toBeLessThan(0);
  });

  it('returns unknown rather than a number when too few peers share his markets', () => {
    const oddball = seasonBaseline('WR', [{ market: 'season_rush_yards', line: 90 }], HALF_PPR);
    // Nobody else at the position is priced on rushing yards.
    expect(marketExpectationScore(oddball, complete)).toBeNull();
  });

  it('mutation: comparing a partial total against complete totals goes negative', () => {
    // The old behaviour, reconstructed. The point of keeping it is that the
    // number below is what the board actually used, and it is the wrong sign.
    const partial = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 1400 }], HALF_PPR);
    const totals = complete.map((c) => c.points!).sort((a, b) => a - b);
    const quantile = (q: number) => {
      const pos = (totals.length - 1) * q;
      const base = Math.floor(pos);
      const next = totals[base + 1];
      return next == null ? totals[base]! : totals[base]! + (pos - base) * (next - totals[base]!);
    };
    const naive = (partial.points! - quantile(0.5)) / Math.max(1, quantile(0.75) - quantile(0.25));
    expect(naive).toBeLessThan(0); // the best receiving-yards figure on the board, read as below median
    expect(marketExpectationScore(partial, [...complete, partial])!).toBeGreaterThan(0);
  });

  it('keeps an unpriced player at zero rather than at a penalty', () => {
    const ctx = {
      currentPick: 15,
      nextPick: 30,
      shape: SHAPE,
      profile: HALF_PPR,
      rosterCounts: { QB: 0, RB: 0, WR: 0, TE: 0 },
      totalPicks: 180,
    };
    const ranked = rankAvailablePlayers(
      [
        { player: player({ id: 'a', fullName: 'A', position: 'WR', team: 'CIN' }), adp: 10, adpRank: 10, signal: null },
        { player: player({ id: 'b', fullName: 'B', position: 'WR', team: 'DET' }), adp: 20, adpRank: 20, signal: null },
        { player: player({ id: 'c', fullName: 'C', position: 'WR', team: 'KC' }), adp: 30, adpRank: 30, signal: null },
      ],
      ctx,
    );
    for (const rec of ranked) {
      const market = rec.components.find((c) => c.key === 'market_expectation')!;
      expect(market.unknown).toBe(true);
      expect(market.contribution).toBe(0);
    }
  });
});

// --------------------------------------------------------------------------
// P1 — one book, one vote
// --------------------------------------------------------------------------

describe('duplicate book quotes cannot vote twice', () => {
  const quote = (book: string, line: number): RawPropQuote => ({
    playerName: 'Field Stretcher',
    market: 'receiving_yards',
    line,
    overPrice: -110,
    underPrice: -110,
    book,
  });

  it('collapses a book that quoted the same market twice', () => {
    const collapsed = oneQuotePerBook([quote('pinnacle', 70), quote('pinnacle', 74), quote('dk', 60)]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((q) => q.book === 'pinnacle')!.line).toBe(72);
  });

  it('reports book count as distinct books, never as quote count', () => {
    const index = new PlayerIndex([player({ id: 'wr', fullName: 'Field Stretcher', position: 'WR', team: 'CIN' })]);
    const [consensus] = buildConsensus([quote('dk', 60), quote('dk', 60), quote('dk', 60)], index);
    expect(consensus!.bookCount).toBe(1);
    expect(consensus!.books).toEqual(['dk']);
    // The consequence the count exists for: Start/Sit charges half a point of
    // uncertainty when a market rests on one book, and three copies of one book
    // used to clear that check.
    expect(consensus!.consensusMethod).toBe('single');
  });

  it('mutation: a repeated book must not drag the consensus toward itself', () => {
    const index = new PlayerIndex([player({ id: 'wr', fullName: 'Field Stretcher', position: 'WR', team: 'CIN' })]);
    const honest = buildConsensus([quote('a', 60), quote('b', 70), quote('c', 80)], index)[0]!;
    const stuffed = buildConsensus(
      [quote('a', 60), quote('a', 60), quote('a', 60), quote('b', 70), quote('c', 80)],
      index,
    )[0]!;
    expect(stuffed.line).toBe(honest.line);
    expect(stuffed.bookCount).toBe(3);
  });

  it('applies the same rule to season-long markets', () => {
    const index = new PlayerIndex([player({ id: 'wr', fullName: 'Field Stretcher', position: 'WR', team: 'CIN' })]);
    const seasonQuote = (book: string, line: number): SeasonMarketQuote => ({
      playerName: 'Field Stretcher',
      market: 'season_receiving_yards',
      line,
      book,
      overPrice: -110,
      underPrice: -110,
    });
    const [resolved] = resolveSeasonMarkets(
      [seasonQuote('a', 900), seasonQuote('a', 900), seasonQuote('a', 900), seasonQuote('b', 1100), seasonQuote('c', 1300)],
      index,
    );
    expect(resolved!.bookCount).toBe(3);
    expect(resolved!.line).toBe(1100);
  });
});

// --------------------------------------------------------------------------
// P0 — Start/Sit must not read a coverage gap as a points gap
// --------------------------------------------------------------------------

describe('Start/Sit compares like with like', () => {
  const wr = (id: string, name: string) => player({ id, fullName: name, position: 'WR', team: 'CIN' });

  const props = (markets: { market: PlayerProp['market']; line: number }[]): PlayerProp[] =>
    markets.map((m) => ({
      playerId: null,
      sourcePlayerName: 'x',
      market: m.market,
      line: m.line,
      overPrice: -110,
      underPrice: -110,
      bookCount: 3,
      consensusMethod: 'median',
      books: ['a', 'b', 'c'],
      impliedProbability: null,
    }));

  const candidate = (id: string, name: string, markets: { market: PlayerProp['market']; line: number }[]): StartSitInput => ({
    player: wr(id, name),
    props: props(markets),
    signal: null,
  });

  it('flags a lead that is smaller than the alternative’s unpriced markets', () => {
    const covered = candidate('covered', 'Fully Covered', [
      { market: 'receiving_yards', line: 70 },
      { market: 'receptions', line: 6 },
    ]);
    // A better receiving line than the man who beats him; his receptions
    // market simply was not quoted, and that alone is the whole margin.
    const thin = candidate('thin', 'Thinly Covered', [{ market: 'receiving_yards', line: 92 }]);

    const comparison = compareStartSit([covered, thin], HALF_PPR);
    expect(comparison.recommendedPlayerId).toBe('covered');
    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.confidence).toBe('low');
    expect(comparison.warnings.join(' ')).toContain('Market coverage differs');
  });

  it('leaves a comparison alone when both are priced on the same markets', () => {
    const a = candidate('a', 'A', [
      { market: 'receiving_yards', line: 90 },
      { market: 'receptions', line: 7 },
    ]);
    const b = candidate('b', 'B', [
      { market: 'receiving_yards', line: 50 },
      { market: 'receptions', line: 4 },
    ]);
    const comparison = compareStartSit([a, b], HALF_PPR);
    expect(comparison.comparability.comparable).toBe(true);
    expect(comparison.comparability.coverageEdge).toBe(0);
    expect(comparison.warnings.join(' ')).not.toContain('Market coverage differs');
  });

  it('does not object when the lead is far wider than the blind spot', () => {
    const covered = candidate('covered', 'Fully Covered', [
      { market: 'receiving_yards', line: 140 },
      { market: 'receptions', line: 11 },
    ]);
    const thin = candidate('thin', 'Thinly Covered', [{ market: 'receiving_yards', line: 20 }]);
    const comparison = compareStartSit([covered, thin], HALF_PPR);
    expect(comparison.comparability.comparable).toBe(true);
    expect(comparison.comparability.unpriced).not.toHaveLength(0);
  });

  it('does not treat a market a position never has as missing', () => {
    // A receiver has no rushing-yards line and is missing nothing by not
    // having one; a running back without one is missing his largest market.
    const back = {
      name: 'Lead Back',
      position: 'RB',
      expectation: buildExpectation(
        'RB',
        props([
          { market: 'rush_yards', line: 80 },
          { market: 'receiving_yards', line: 20 },
          { market: 'receptions', line: 2 },
        ]),
        HALF_PPR,
      ),
    };
    const receiver = {
      name: 'Field Stretcher',
      position: 'WR',
      expectation: buildExpectation(
        'WR',
        props([
          { market: 'receiving_yards', line: 70 },
          { market: 'receptions', line: 6 },
        ]),
        HALF_PPR,
      ),
    };
    const assessment = assessMarketComparability(back, receiver, 1);
    expect(assessment.unpriced.map((u) => u.name)).not.toContain('Field Stretcher');
  });
});

// --------------------------------------------------------------------------
// P3 — the Next% cache must key on what the answer depends on
// --------------------------------------------------------------------------

describe('Next% cache key covers the picks themselves', () => {
  const base = {
    draftId: 'draft-1',
    currentPick: 20,
    targetPick: 32,
    mySlot: 4,
    totalPicks: 180,
    candidates: [
      { playerId: 'a', position: 'WR', adp: 21, order: 21 },
      { playerId: 'b', position: 'RB', adp: 25, order: 25 },
    ],
    rosters: new Map<number, Record<string, number>>([[1, { WR: 1 }]]),
    shape: SHAPE,
    ownership: { ownerAt: () => 1 },
    universe: [{ position: 'WR', adp: 21 }],
  };

  it('changes when a completed pick is corrected without changing the count', () => {
    const before = draftStateKey({
      ...base,
      completed: [{ pickNo: 19, slot: 1, position: 'WR', adp: 18 }],
    } as never);
    const after = draftStateKey({
      ...base,
      // Same pick number, same slot, different player: a Sleeper re-sync
      // correcting who was actually taken. The room reads this.
      completed: [{ pickNo: 19, slot: 1, position: 'RB', adp: 40 }],
    } as never);
    expect(after).not.toBe(before);
  });

  it('is stable for a board that has not moved', () => {
    const request = { ...base, completed: [{ pickNo: 19, slot: 1, position: 'WR', adp: 18 }] } as never;
    expect(draftStateKey(request)).toBe(draftStateKey(request));
  });
});

// --------------------------------------------------------------------------
// §17 — the anomaly detector
// --------------------------------------------------------------------------

describe('cross-source anomaly detection', () => {
  it('catches a healthy designation against a ruled-out one', () => {
    const found = detectInjuryConflicts('p1', [
      { source: 'sleeper', designation: 'healthy' },
      { source: 'nflverse', designation: 'ir' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('contradiction');
    expect(found[0]!.sources).toEqual(['nflverse', 'sleeper']);
  });

  it('does not call an absence a conflict', () => {
    // `unknown` is not a claim, and this is the distinction the injury model
    // keeps `healthy` and `unknown` separate for.
    expect(detectInjuryConflicts('p1', [
      { source: 'sleeper', designation: 'unknown' },
      { source: 'nflverse', designation: 'out' },
    ])).toEqual([]);
    // Two words for the same fog are not a contradiction either.
    expect(detectInjuryConflicts('p1', [
      { source: 'sleeper', designation: 'questionable' },
      { source: 'nflverse', designation: 'doubtful' },
    ])).toEqual([]);
  });

  it('catches a market still priced for a player who is out', () => {
    const found = detectPropsForRuledOutPlayers(
      [
        { playerId: 'p1', market: 'receiving_yards', line: 62, source: 'cache' },
        { playerId: 'p1', market: 'receptions', line: 5, source: 'cache' },
        { playerId: 'p2', market: 'rush_yards', line: 70, source: 'cache' },
      ],
      (id) => (id === 'p1' ? 'out' : 'healthy'),
    );
    expect(found).toHaveLength(1); // one finding per player, not per market
    expect(found[0]!.playerId).toBe('p1');
    expect(found[0]!.detail).toContain('2 market(s)');
  });

  it('catches arithmetic no season can produce', () => {
    expect(
      detectGamesPlayedConflicts({ playerId: 'p1', gamesPlayed: 19, weeksInactive: 0, weeksElapsed: 19, sources: ['nflverse'] }),
    ).toHaveLength(1);
    expect(
      detectGamesPlayedConflicts({ playerId: 'p1', gamesPlayed: 8, weeksInactive: 6, weeksElapsed: 10, sources: ['nflverse', 'sleeper'] })[0]!
        .kind,
    ).toBe('games_played_conflict');
    expect(
      detectGamesPlayedConflicts({ playerId: 'p1', gamesPlayed: 8, weeksInactive: 2, weeksElapsed: 10, sources: ['nflverse'] }),
    ).toEqual([]);
  });

  it('catches an impossible ADP move and a collapsed snapshot', () => {
    const previous = Array.from({ length: 100 }, (_, i) => ({ playerId: `p${i}`, adp: i + 1 }));
    const next = previous.slice(0, 50).map((e) => (e.playerId === 'p3' ? { ...e, adp: 190 } : e));
    const found = detectAdpAnomalies(previous, next);
    expect(found.some((a) => a.kind === 'adp_jump' && a.playerId === 'p3')).toBe(true);
    expect(found.some((a) => a.kind === 'coverage_collapse')).toBe(true);
    // A board that merely moved is not an anomaly.
    expect(detectAdpAnomalies(previous, previous)).toEqual([]);
  });

  it('catches a source answering about the wrong season or week', () => {
    const found = detectPeriodMismatch({ season: 2025, week: 6 }, [
      { source: 'nflverse-usage', season: 2024, week: 6 },
      { source: 'nflverse-injury', season: 2025, week: 5 },
      { source: 'sleeper', season: 2025, week: 6 },
    ]);
    expect(found.map((a) => a.kind).sort()).toEqual(['wrong_season', 'wrong_week']);
  });

  it('catches a provider that renamed a column', () => {
    expect(detectSchemaDrift('nflverse-usage', ['player_id', 'targets'], ['player_id', 'targets', 'routes'])).toHaveLength(1);
    expect(detectSchemaDrift('nflverse-usage', ['player_id', 'targets', 'routes'], ['player_id', 'targets'])).toEqual([]);
  });

  it('catches one external name mapped to two canonical players', () => {
    const found = detectDuplicateMappings([
      { externalKey: 'Michael Pittman', playerId: 'p1', source: 'vegas' },
      { externalKey: 'michael pittman', playerId: 'p2', source: 'newsletter' },
      { externalKey: 'Someone Else', playerId: 'p3', source: 'vegas' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.sources).toEqual(['newsletter', 'vegas']);
  });

  it('keeps a coverage note out of the material bucket on its own', () => {
    const previous = Array.from({ length: 100 }, (_, i) => ({ playerId: `p${i}`, adp: i + 1 }));
    const quiet = summarizeAnomalies(detectAdpAnomalies(previous, previous.slice(0, 40)));
    expect(quiet.bySeverity.coverage).toBe(1);
    expect(quiet.material).toBe(false);

    const loud = summarizeAnomalies(detectInjuryConflicts('p1', [
      { source: 'sleeper', designation: 'healthy' },
      { source: 'nflverse', designation: 'ir' },
    ]));
    expect(loud.material).toBe(true);
  });

  it('orders findings the same way every time', () => {
    const mappings = [
      { externalKey: 'zeta', playerId: 'p9', source: 'a' },
      { externalKey: 'zeta', playerId: 'p8', source: 'b' },
      { externalKey: 'alpha', playerId: 'p2', source: 'a' },
      { externalKey: 'alpha', playerId: 'p1', source: 'b' },
    ];
    const once = summarizeAnomalies(detectDuplicateMappings(mappings)).anomalies.map((a) => a.detail);
    const twice = summarizeAnomalies(detectDuplicateMappings([...mappings].reverse())).anomalies.map((a) => a.detail);
    expect(once).toEqual(twice);
  });
});

// --------------------------------------------------------------------------
// Standing properties the audit checked and found sound. Kept so they stay so.
// --------------------------------------------------------------------------

describe('standing model invariants', () => {
  it('keeps every default draft weight bounded and positive', () => {
    for (const [key, weight] of Object.entries(DEFAULT_WEIGHTS)) {
      expect(weight, key).toBeGreaterThan(0);
      expect(weight, key).toBeLessThanOrEqual(1);
    }
  });

  it('cannot let the non-market components outvote a large reach', () => {
    // Market value is the one component allowed below −1, without limit, so a
    // player taken 160 picks early cannot be rescued by everything else at once.
    const everythingElse = Object.entries(DEFAULT_WEIGHTS)
      .filter(([key]) => key !== 'marketValue')
      .reduce((total, [, weight]) => total + weight, 0);
    const reach = rankAvailablePlayers(
      [
        {
          player: player({ id: 'reach', fullName: 'Deep Sleeper', position: 'QB', team: 'GB' }),
          adp: 202,
          adpRank: 202,
          signal: null,
          myGuyLevel: 3,
        },
        { player: player({ id: 'good', fullName: 'Obvious Pick', position: 'WR', team: 'CIN' }), adp: 36, adpRank: 36, signal: null },
      ],
      {
        currentPick: 38,
        nextPick: 50,
        shape: SHAPE,
        profile: HALF_PPR,
        rosterCounts: { QB: 0, RB: 2, WR: 2, TE: 1 },
        totalPicks: 180,
      },
    );
    expect(reach[0]!.playerId).toBe('good');
    const marketValue = reach.find((r) => r.playerId === 'reach')!.components.find((c) => c.key === 'market_value')!;
    expect(marketValue.contribution).toBeLessThan(-everythingElse);
  });
});
