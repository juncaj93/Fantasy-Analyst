/**
 * `MKT PTS` as a draft-strategy input, and the four ways that goes wrong.
 *
 * The brief asks for a market-implied points signal "strong enough to exploit
 * disagreement between scoring markets and ADP, but without double-counting
 * props, inflating QBs, or overwhelming BPA". Each clause is a separate claim
 * and a weight in a table proves none of them, so each is asserted here against
 * the real ranking engine.
 *
 * The measured version of the same questions — effective influence, board
 * displacement, coverage damping — lives in
 * `scripts/probe-mkt-pts-influence.mjs`, and the resulting map is written down
 * in `docs/DRAFT_CONTRIBUTION_MAP.md`. These tests are what stop the findings
 * there from quietly ceasing to be true.
 */

import { describe, expect, it } from 'vitest';
import { rankAvailablePlayers, DEFAULT_WEIGHTS, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { MARKET_BLEND } from '../src/core/draft/marketBaseline.ts';
import { marketStrategyNote } from '../src/core/draft/marketStrategy.ts';
import { marketStandings, seasonBaseline } from '../src/core/vegas/season.ts';
import { sortBoard } from '../src/core/draft/boardSort.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER);
const CTX = {
  currentPick: 53,
  nextPick: 68,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 180,
};

const MARKETS: Record<string, string[]> = {
  QB: ['season_pass_yards', 'season_pass_tds', 'season_rush_yards'],
  RB: ['season_rush_yards', 'season_rush_tds', 'season_receptions', 'season_receiving_yards'],
  WR: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
  TE: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
};

const BASE: Record<string, number> = {
  season_pass_yards: 3950,
  season_pass_tds: 26.5,
  season_rush_yards: 780,
  season_rush_tds: 7.5,
  season_receptions: 68.5,
  season_receiving_yards: 880,
  season_receiving_tds: 6.5,
};

function person(id: string, position: string) {
  return {
    id,
    sleeperPlayerId: id,
    fullName: `Player ${id}`,
    firstName: 'Player',
    lastName: id,
    team: 'DET',
    position,
    status: null,
    active: true,
    normalizedName: `player${id}`,
    aliases: [],
  };
}

/** A player priced at `quality` times the position's base lines. */
function priced(
  id: string,
  position: string,
  adp: number,
  quality: number,
  opts: { markets?: number; dogAdp?: number | null } = {},
): AvailablePlayerInput {
  const keys = MARKETS[position]!;
  const kept = keys.slice(0, opts.markets ?? keys.length);
  return {
    player: person(id, position),
    adp,
    adpRank: Math.round(adp),
    signal: null,
    ...(opts.dogAdp === undefined ? {} : { dogAdp: opts.dogAdp }),
    seasonMarkets: kept.map((market) => ({
      market: market as never,
      line: Math.round(BASE[market]! * quality * 10) / 10,
    })),
  };
}

/** A filler board so every position has comparable peers. */
function filler(): AvailablePlayerInput[] {
  const out: AvailablePlayerInput[] = [];
  const positions = ['QB', 'RB', 'WR', 'TE'];
  for (let i = 0; i < 80; i++) {
    const position = positions[i % positions.length]!;
    out.push(priced(`f${i}`, position, 20 + i * 1.5, 1 + (((i * 7) % 11) - 5) / 25));
  }
  return out;
}

const rank = (board: AvailablePlayerInput[], ctx: Partial<typeof CTX> = {}) =>
  rankAvailablePlayers(board, { ...CTX, ...ctx }, DEFAULT_WEIGHTS);
const find = (recs: ReturnType<typeof rank>, id: string) => recs.find((r) => r.playerId === id)!;
const component = (rec: ReturnType<typeof rank>[number], key: string) =>
  rec.components.find((c) => c.key === key);

describe('1 — it can influence the Score when coverage is sufficient', () => {
  it('separates two identically-priced players whose props disagree', () => {
    const board = [...filler(), priced('rich', 'WR', 60, 1.4), priced('poor', 'WR', 60, 0.7)];
    const recs = rank(board);
    const rich = find(recs, 'rich');
    const poor = find(recs, 'poor');

    expect(component(rich, 'market_expectation')!.unknown).toBe(false);
    expect(rich.total).toBeGreaterThan(poor.total);
    // And the props are what did it: their ADP, need and scarcity are identical.
    expect(component(rich, 'market_value')!.contribution).toBe(component(poor, 'market_value')!.contribution);
  });
});

describe('2 — it has no scoring influence when the picture is too thin', () => {
  it('scores nothing at all for a player no market priced', () => {
    const board = [...filler(), { ...priced('dark', 'WR', 60, 1.4), seasonMarkets: [] }];
    const rec = find(rank(board), 'dark');
    const me = component(rec, 'market_expectation')!;
    expect(me.unknown).toBe(true);
    expect(me.contribution).toBe(0);
  });

  it('scores nothing when too few peers carry his markets to compare against', () => {
    // One receiver priced on a market nobody else has: no honest comparison.
    const lonely: AvailablePlayerInput = {
      player: person('lonely', 'WR'),
      adp: 60,
      adpRank: 60,
      signal: null,
      seasonMarkets: [{ market: 'season_receiving_tds' as never, line: 12 }],
    };
    const peers = [0, 1].map((i) => priced(`p${i}`, 'WR', 50 + i, 1, { markets: 1 }));
    const rec = find(rank([...peers, lonely]), 'lonely');
    expect(component(rec, 'market_expectation')!.unknown).toBe(true);
  });

  it('damps the contribution as coverage falls, without changing its sign', () => {
    const full = find(rank([...filler(), priced('x', 'WR', 60, 1.4)]), 'x');
    // Priced on one market of three: same direction, less of it.
    const thin = find(rank([...filler(), priced('x', 'WR', 60, 1.4, { markets: 1 })]), 'x');
    const a = component(full, 'market_expectation')!.contribution;
    const b = component(thin, 'market_expectation')!.contribution;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(a);
  });
});

describe('3 — raw quarterback points do not dominate cross-position ranking', () => {
  it('gives an identically-placed QB and WR the same contribution from far apart totals', () => {
    const board = [...filler(), priced('qb', 'QB', 40, 1.25), priced('wr', 'WR', 40, 1.25)];
    const recs = rank(board);
    const qb = component(find(recs, 'qb'), 'market_expectation')!;
    const wr = component(find(recs, 'wr'), 'market_expectation')!;

    // The quarterback's implied points are far larger. His contribution is not.
    const qbPoints = seasonBaseline('QB', priced('qb', 'QB', 40, 1.25).seasonMarkets!, PROFILE).points!;
    const wrPoints = seasonBaseline('WR', priced('wr', 'WR', 40, 1.25).seasonMarkets!, PROFILE).points!;
    expect(qbPoints).toBeGreaterThan(wrPoints);
    expect(qb.contribution).toBe(wr.contribution);
  });

  it('does not fill the top of the board with quarterbacks', () => {
    const top = rank(filler()).slice(0, 20);
    const qbs = top.filter((r) => r.position === 'QB').length;
    expect(qbs).toBeLessThan(top.length / 2);
  });
});

describe('4 — the normalization is position-aware and uses league scoring', () => {
  it('rates a tight end against tight ends, not against receivers', () => {
    // Identical lines. As a TE they are strong; as a WR they are ordinary.
    const board = [
      ...filler(),
      priced('te', 'TE', 60, 1.3),
      priced('wr', 'WR', 60, 1.3),
    ];
    const recs = rank(board);
    // Both are 1.3x their own position's base, so both should stand equally
    // *within position* — which is the property that makes them comparable.
    expect(component(find(recs, 'te'), 'market_expectation')!.score).toBe(
      component(find(recs, 'wr'), 'market_expectation')!.score,
    );
  });

  it('reads the league’s own scoring, so PPR and standard rate a receiver differently', () => {
    const board = [...filler(), priced('rec', 'WR', 60, 1.3)];
    const ppr = rank(board).find((r) => r.playerId === 'rec')!;
    const standard = rankAvailablePlayers(
      board,
      { ...CTX, profile: buildScoringProfile({ rec: 0, pass_td: 4 }, ROSTER) },
      DEFAULT_WEIGHTS,
    ).find((r) => r.playerId === 'rec')!;
    expect(ppr.marketBaseline!.points).not.toBe(standard.marketBaseline!.points);
  });
});

describe('5 — the DOG/Sleeper weighting is untouched by any of this', () => {
  it('still blends 60/40 outside best ball and 75/25 inside it', () => {
    expect(MARKET_BLEND.standard).toEqual({ dog: 0.6, sleeper: 0.4 });
    expect(MARKET_BLEND.bestBall).toEqual({ dog: 0.75, sleeper: 0.25 });
  });

  it('prices a player from the blend regardless of what his props say', () => {
    const withProps = priced('a', 'WR', 70, 1.4, { dogAdp: 50 });
    const without: AvailablePlayerInput = { ...withProps, seasonMarkets: [] };
    const a = find(rank([...filler(), withProps], { marketFormat: 'best_ball' } as never), 'a');
    const b = find(rank([...filler(), without], { marketFormat: 'best_ball' } as never), 'a');
    // Same baseline, same ADP-value contribution: the props reach a different
    // component and cannot move the market-cost one.
    expect(component(a, 'market_value')!.contribution).toBe(component(b, 'market_value')!.contribution);
  });
});

describe('6 — there is exactly one prop path into the Score', () => {
  it('has no second component built from season markets', () => {
    const rec = find(rank([...filler(), priced('x', 'WR', 60, 1.2)]), 'x');
    const fromProps = rec.components.filter((c) => c.key === 'market_expectation');
    expect(fromProps).toHaveLength(1);
  });

  it('shows the reader the same number the score consumed', () => {
    const rec = find(rank([...filler(), priced('x', 'WR', 60, 1.2)]), 'x');
    const shown = rec.marketProps!.components.find((c) => c.label === 'pts')!;
    // Not "equal to" — the same object's total. There is no second conversion.
    expect(shown.value).toBe(rec.marketBaseline!.points);
  });
});

describe('7 — disagreement moves a player, modestly and in both directions', () => {
  it('lifts a player the books like more than his draft cost, and lowers the reverse', () => {
    const board = [...filler(), priced('up', 'WR', 60, 1.4), priced('down', 'WR', 60, 0.7)];
    const recs = rank(board);
    expect(component(find(recs, 'up'), 'market_expectation')!.contribution).toBeGreaterThan(0);
    expect(component(find(recs, 'down'), 'market_expectation')!.contribution).toBeLessThan(0);
  });

  it('says which way the two markets disagree, in words', () => {
    const board = [...filler(), priced('cheap', 'WR', 120, 1.4)];
    const recs = rank(board);
    const note = find(recs, 'cheap').marketStrategy!;
    expect(note.kind).toBe('bullish');
    expect(note.disagreement).toContain('scoring market');
  });
});

describe('8 — the influence is bounded', () => {
  it('cannot contribute more than its weight, however extreme the props', () => {
    const board = [...filler(), priced('absurd', 'WR', 60, 40)];
    const me = component(find(rank(board), 'absurd'), 'market_expectation')!;
    expect(Math.abs(me.score)).toBeLessThanOrEqual(1);
    expect(Math.abs(me.contribution)).toBeLessThanOrEqual(DEFAULT_WEIGHTS.marketExpectation);
  });

  it('loses to a real ADP bargain rather than overriding it', () => {
    for (const gap of [20, 30]) {
      const board = [
        ...filler(),
        priced('strongProps', 'WR', 60 + gap, 1.4),
        priced('betterAdp', 'WR', 60, 0.7),
      ];
      const recs = rank(board);
      expect(
        find(recs, 'betterAdp').total,
        `props overrode a ${gap}-pick ADP gap`,
      ).toBeGreaterThan(find(recs, 'strongProps').total);
    }
  });
});

describe('9 — it does not duplicate scarcity or a replacement value', () => {
  it('leaves tier and scarcity components untouched when only the props change', () => {
    const strong = find(rank([...filler(), priced('x', 'WR', 60, 1.4)]), 'x');
    const weak = find(rank([...filler(), priced('x', 'WR', 60, 0.7)]), 'x');
    expect(component(strong, 'scarcity')!.contribution).toBe(component(weak, 'scarcity')!.contribution);
    expect(component(strong, 'tier_cliff')!.contribution).toBe(component(weak, 'tier_cliff')!.contribution);
  });
});

describe('10 — a missing market is never an invented zero', () => {
  it('leaves an unpriced player unknown rather than penalised', () => {
    const board = [...filler(), { ...priced('dark', 'WR', 60, 1), seasonMarkets: [] }];
    const dark = find(rank(board), 'dark');
    expect(component(dark, 'market_expectation')!.unknown).toBe(true);
    expect(component(dark, 'market_expectation')!.contribution).toBe(0);
    // And an unpriced player is not below a demonstrably poor one on this axis.
    const poor = find(rank([...filler(), priced('poor', 'WR', 60, 0.6)]), 'poor');
    expect(component(dark, 'market_expectation')!.contribution).toBeGreaterThan(
      component(poor, 'market_expectation')!.contribution,
    );
  });

  it('omits the sentence rather than hedging about an unknown', () => {
    expect(marketStrategyNote(null, 'WR')).toBeNull();
  });
});

describe('11 — the sort modes are unchanged', () => {
  it('orders by ADP and by DOG exactly as before, whatever the props say', () => {
    const rows = [
      { name: 'a', adp: 30, dogAdp: 55, score: 1, total: 1 },
      { name: 'b', adp: 40, dogAdp: 20, score: 2, total: 2 },
      { name: 'c', adp: 50, dogAdp: 35, score: 3, total: 3 },
    ];
    expect(sortBoard(rows, 'adp').map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(sortBoard(rows, 'dog').map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
});

describe('12 — the decomposition still sums to the score', () => {
  it('adds every component contribution up to the total, props included', () => {
    const recs = rank([...filler(), priced('x', 'WR', 60, 1.3)]);
    for (const rec of recs.slice(0, 12)) {
      const summed = rec.components.reduce((total, c) => total + c.contribution, 0);
      expect(Math.abs(summed - rec.total), `${rec.playerId} does not reconcile`).toBeLessThan(0.02);
    }
  });
});

describe('the standings the explanation is built from', () => {
  it('measures both markets against the same peers', () => {
    const board = [...filler(), priced('x', 'WR', 60, 1.3)];
    const recs = rank(board);
    const rec = find(recs, 'x');
    expect(rec.marketStrategy).not.toBeNull();
    expect(rec.marketStrategy!.standing).toContain('WR');
  });

  it('reports no disagreement when the board never knew his draft cost', () => {
    const baselines = ['a', 'b', 'c', 'd'].map((id) =>
      seasonBaseline('WR', priced(id, 'WR', 50, 1).seasonMarkets!, PROFILE),
    );
    const standings = marketStandings(baselines[0]!, baselines, () => null);
    expect(standings!.cost).toBeNull();
    expect(standings!.disagreement).toBeNull();
  });
});
