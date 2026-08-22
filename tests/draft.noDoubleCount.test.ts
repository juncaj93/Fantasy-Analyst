/**
 * One market-derived opinion per player, through the real engine.
 *
 * A raw season baseline and an imported projection answer the same question, so
 * letting both contribute would pay a player twice for the coincidence of being
 * covered twice and make a player only one source covers look worse than he is.
 * The design makes that structurally impossible — one component, one value, raw
 * lines win — and this is where that is checked against the engine rather than
 * against a description of it.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { player } from './helpers/players.ts';
import type { SeasonMarketKey } from '../src/core/vegas/types.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6 }, ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN']);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN']);

const CTX = {
  currentPick: 12,
  nextPick: 25,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 180,
};

/** Four backs, so a standing has the peers it needs at the position. */
function backs(over: Partial<AvailablePlayerInput>[] = []): AvailablePlayerInput[] {
  const names = ['Jahmyr Gibbs', 'Bijan Robinson', 'Christian McCaffrey', 'Derrick Henry'];
  return names.map((name, i) => ({
    player: player({ id: `rb${i}`, fullName: name, team: 'DET', position: 'RB' }),
    adp: i + 1,
    dogAdp: null,
    adpRank: i + 1,
    signal: null,
    myGuyLevel: 0,
    seasonMarkets: [],
    ...(over[i] ?? {}),
  })) as AvailablePlayerInput[];
}

const lines = (rush: number, rec: number): { market: SeasonMarketKey; line: number }[] => [
  { market: 'season_rush_yards', line: rush },
  { market: 'season_receiving_yards', line: rec },
];

function marketComponent(rec: { components: { key: string }[] }) {
  return rec.components.find((c) => c.key === 'market_expectation') as {
    key: string;
    score: number;
    contribution: number;
    unknown: boolean;
    display: string;
  };
}

describe('exactly one market-derived opinion reaches the ranking', () => {
  it('uses the raw season baseline when it exists, and ignores the projection', () => {
    // Both sources present, and they disagree hard: raw lines say he is
    // ordinary, the projection says he is the best back alive.
    const withBoth = backs([
      { seasonMarkets: lines(900, 200), preseasonPoints: 400 },
      { seasonMarkets: lines(1200, 400) },
      { seasonMarkets: lines(1100, 350) },
      { seasonMarkets: lines(1000, 300) },
    ]);
    const ranked = rankAvailablePlayers(withBoth, CTX);
    const gibbs = ranked.find((r) => r.name === 'Jahmyr Gibbs')!;
    const component = marketComponent(gibbs);

    // The raw lines won: he is the worst-priced of the four, so the component
    // is negative despite a projection that would have put him top.
    expect(component.unknown).toBe(false);
    expect(component.score).toBeLessThan(0);
    expect(component.display).toMatch(/pts implied/);
    expect(component.display).not.toMatch(/preseason/i);
  });

  it('falls back to the projection only where the raw lines are silent', () => {
    const projectionOnly = backs([
      { preseasonPoints: 292 },
      { preseasonPoints: 280 },
      { preseasonPoints: 253 },
      { preseasonPoints: 238 },
    ]);
    const ranked = rankAvailablePlayers(projectionOnly, CTX);
    const gibbs = ranked.find((r) => r.name === 'Jahmyr Gibbs')!;
    const component = marketComponent(gibbs);

    expect(component.unknown).toBe(false);
    expect(component.score).toBeGreaterThan(0);
    // And it says which source it read, so the card can explain itself.
    expect(component.display).toMatch(/preseason/i);
  });

  it('contributes through the one component, never two', () => {
    const both = backs([
      { seasonMarkets: lines(1200, 400), preseasonPoints: 292 },
      { seasonMarkets: lines(1100, 350), preseasonPoints: 280 },
      { seasonMarkets: lines(1000, 300), preseasonPoints: 253 },
      { seasonMarkets: lines(900, 250), preseasonPoints: 238 },
    ]);
    const ranked = rankAvailablePlayers(both, CTX);
    for (const rec of ranked) {
      const market = rec.components.filter((c) => c.key === 'market_expectation');
      expect(market).toHaveLength(1);
      // No second component ever appears for the projection.
      expect(rec.components.some((c) => /preseason|projection/i.test(c.key))).toBe(false);
    }
  });

  it('does not pay a player more for being covered twice', () => {
    // The same raw lines either way; the only difference is whether a
    // projection also exists. The market component must be identical.
    const rawOnly = backs([
      { seasonMarkets: lines(1200, 400) },
      { seasonMarkets: lines(1100, 350) },
      { seasonMarkets: lines(1000, 300) },
      { seasonMarkets: lines(900, 250) },
    ]);
    const rawPlusProjection = backs([
      { seasonMarkets: lines(1200, 400), preseasonPoints: 400 },
      { seasonMarkets: lines(1100, 350), preseasonPoints: 380 },
      { seasonMarkets: lines(1000, 300), preseasonPoints: 360 },
      { seasonMarkets: lines(900, 250), preseasonPoints: 340 },
    ]);

    const a = marketComponent(rankAvailablePlayers(rawOnly, CTX).find((r) => r.name === 'Jahmyr Gibbs')!);
    const b = marketComponent(
      rankAvailablePlayers(rawPlusProjection, CTX).find((r) => r.name === 'Jahmyr Gibbs')!,
    );
    expect(b.contribution).toBe(a.contribution);
    expect(b.score).toBe(a.score);
  });
});

describe('the projection is bounded, not inert', () => {
  /*
   * Two claims that are easy to confuse, and only one of them is true.
   *
   * False: "the projection can never reorder the board." A second opinion that
   * cannot move anybody is not a signal, and the whole reason to import one is
   * that it should separate players the rest of the board cannot tell apart.
   *
   * True: it is bounded. It may break ties and reshuffle a tight cluster; it
   * may not overturn a recommendation that is materially stronger on
   * everything else. ±0.2 is the ceiling, and it is the market component's own
   * existing weight rather than a new one.
   */

  /** Same ADP for all four, so only the projection can separate them. */
  const clustered = (points: number[]) =>
    backs(points.map((p) => ({ adp: 20, adpRank: 20, preseasonPoints: p })));

  it('reorders a tightly clustered group', () => {
    // Input order is best-to-worst by name; the projection is worst-to-best.
    // If the projection did nothing, the output would come back in input order.
    const ranked = rankAvailablePlayers(clustered([212.4, 238.7, 253.1, 292.0]), CTX);
    expect(ranked.map((r) => r.name)).toEqual([
      'Derrick Henry',
      'Christian McCaffrey',
      'Bijan Robinson',
      'Jahmyr Gibbs',
    ]);
  });

  it('spends at most its own weight, best projection to worst', () => {
    /*
     * The ceiling, measured where it is actually enforced.
     *
     * Deliberately *not* asserted on `total`. Separation and opportunity are
     * second-pass components: they read the composite the first pass produced,
     * so every first-pass component — market value and the news scores just as
     * much as this one — echoes a little into them, and the spread between the
     * best and worst projection here comes out around 0.47 rather than 0.40.
     * That is the engine's existing shape, not the projection escaping. What is
     * bounded is what this component is allowed to spend, and it is bounded
     * here.
     */
    const ranked = rankAvailablePlayers(clustered([212.4, 238.7, 253.1, 292.0]), CTX);
    const spent = ranked.map((r) => marketComponent(r).contribution);
    expect(Math.max(...spent) - Math.min(...spent)).toBeCloseTo(
      2 * DEFAULT_WEIGHTS.marketExpectation,
      9,
    );
    for (const c of spent) {
      expect(Math.abs(c)).toBeLessThanOrEqual(DEFAULT_WEIGHTS.marketExpectation + 1e-9);
    }
  });

  it('cannot overturn a materially stronger recommendation', () => {
    // Gibbs has fallen fifteen picks past his ADP and carries the worst
    // projection on the board; the other three are priced where they are being
    // taken and projected well. The bargain still comes out first, because the
    // strongest possible projection is worth about four picks of ADP.
    const ranked = rankAvailablePlayers(
      backs([
        { adp: 5, adpRank: 5, preseasonPoints: 212.4 },
        { adp: 20, adpRank: 20, preseasonPoints: 253.1 },
        { adp: 21, adpRank: 21, preseasonPoints: 280.1 },
        { adp: 22, adpRank: 22, preseasonPoints: 292.0 },
      ]),
      { ...CTX, currentPick: 20, nextPick: 33 },
    );
    expect(ranked[0]!.name).toBe('Jahmyr Gibbs');
    // And he is last on the projection, so it is genuinely pulling against him.
    expect(marketComponent(ranked[0]!).contribution).toBeLessThan(0);
  });

  it('rides the weight the market component already had', () => {
    // No new weight, and nothing else retuned to make room for one.
    expect(DEFAULT_WEIGHTS).toEqual({
      marketValue: 1,
      need: 0.1,
      scarcity: 0.2,
      leagueFit: 0.25,
      newsLifetime: 0.35,
      news30: 0.2,
      news7: 0.12,
      survivalUrgency: 0.22,
      marketExpectation: 0.2,
      myGuy: 0.5,
      avoid: 0.3,
      tierCliff: 0.15,
    });
  });

  it('contributes no more than the weight, on the real imported numbers', () => {
    const ranked = rankAvailablePlayers(clustered([212.4, 238.7, 253.1, 292.0]), CTX);
    for (const rec of ranked) {
      const market = marketComponent(rec);
      expect(Math.abs(market.contribution)).toBeLessThanOrEqual(
        DEFAULT_WEIGHTS.marketExpectation + 1e-9,
      );
    }
  });
});

describe('missing data stays neutral', () => {
  it('is unknown when neither source has him', () => {
    const none = backs();
    const ranked = rankAvailablePlayers(none, CTX);
    const component = marketComponent(ranked[0]!);
    expect(component.unknown).toBe(true);
    expect(component.score).toBe(0);
    expect(component.contribution).toBe(0);
  });

  it('neither rewards nor punishes an unprojected player among projected ones', () => {
    const mixed = backs([
      { preseasonPoints: 292 },
      { preseasonPoints: 280 },
      { preseasonPoints: 253 },
      {}, // Derrick Henry, unprojected
    ]);
    const ranked = rankAvailablePlayers(mixed, CTX);
    const henry = marketComponent(ranked.find((r) => r.name === 'Derrick Henry')!);
    // Zero is the median of a median-centred scale: exactly what an ordinary
    // player contributes, which is the definition of neutral.
    expect(henry.unknown).toBe(true);
    expect(henry.contribution).toBe(0);
  });

  it('exposes the projection on the recommendation without it being a score', () => {
    const ranked = rankAvailablePlayers(backs([{ preseasonPoints: 292 }]), CTX);
    const gibbs = ranked.find((r) => r.name === 'Jahmyr Gibbs')!;
    expect(gibbs.preseasonPoints).toBe(292);
    // The other three carry none, and carry null rather than zero.
    expect(ranked.find((r) => r.name === 'Derrick Henry')?.preseasonPoints).toBeNull();
  });
});
