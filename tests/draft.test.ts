import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  marketValueComponent,
  newsComponent,
  rankAvailablePlayers,
  type AvailablePlayerInput,
} from '../src/core/draft/engine.ts';
import { computeNeed, computeScarcity } from '../src/core/draft/need.ts';
import { adpSpread, estimateSurvival } from '../src/core/draft/survival.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile, leagueFitMultipliers } from '../src/core/sleeper/scoring.ts';
import { TEST_PLAYERS } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const STANDARD_SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

function signal(net: number, items = 2): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last21 = { ...s.raw };
  return s;
}

describe('survival estimate', () => {
  it('returns null when ADP is unknown, never a fabricated number', () => {
    const est = estimateSurvival({ adp: null, currentPick: 10, nextPick: 22 });
    expect(est.probability).toBeNull();
    expect(est.note).toContain('unknown');
  });

  it('is certain when you are on the clock', () => {
    expect(estimateSurvival({ adp: 30, currentPick: 10, nextPick: 10 }).probability).toBe(1);
  });

  it('gives a low probability to a player whose ADP is well before your next pick', () => {
    const est = estimateSurvival({ adp: 12, currentPick: 10, nextPick: 30 });
    expect(est.probability!).toBeLessThan(0.15);
  });

  it('gives a high probability to a player whose ADP is well after your next pick', () => {
    const est = estimateSurvival({ adp: 60, currentPick: 10, nextPick: 22 });
    expect(est.probability!).toBeGreaterThan(0.85);
  });

  it('is near a coin flip when ADP equals your next pick', () => {
    expect(estimateSurvival({ adp: 22, currentPick: 10, nextPick: 22 }).probability).toBeCloseTo(0.5, 2);
  });

  it('widens the spread for later ADPs', () => {
    expect(adpSpread(120)).toBeGreaterThan(adpSpread(10));
  });

  it('is monotonic in ADP', () => {
    const a = estimateSurvival({ adp: 20, currentPick: 10, nextPick: 25 }).probability!;
    const b = estimateSurvival({ adp: 40, currentPick: 10, nextPick: 25 }).probability!;
    expect(b).toBeGreaterThan(a);
  });
});

describe('roster need', () => {
  it('flags an unfilled starting slot as the strongest need', () => {
    const need = computeNeed(STANDARD_SHAPE, { RB: 0, WR: 2, QB: 1, TE: 1 });
    expect(need['RB']!.score).toBeGreaterThan(0.79);
    expect(need['RB']!.startersUnfilled).toBe(2);
  });

  it('drops need once starters are filled', () => {
    const need = computeNeed(STANDARD_SHAPE, { QB: 1, RB: 2, WR: 2, TE: 1 });
    expect(need['QB']!.score).toBeLessThan(0.5);
  });

  it('recognises remaining flex capacity', () => {
    const need = computeNeed(STANDARD_SHAPE, { QB: 1, RB: 2, WR: 2, TE: 1 });
    expect(need['RB']!.flexOpen).toBe(1);
    expect(need['RB']!.score).toBeCloseTo(0.55, 2);
  });

  it('scores a position the league does not use as near zero', () => {
    const need = computeNeed(buildRosterShape(['QB', 'RB', 'WR', 'BN']), { K: 1 });
    expect(need['K']!.score).toBeLessThan(0.15);
  });

  it('reduces need as depth accumulates', () => {
    const shallow = computeNeed(STANDARD_SHAPE, { RB: 3, QB: 1, WR: 2, TE: 1 });
    const deep = computeNeed(STANDARD_SHAPE, { RB: 6, QB: 1, WR: 2, TE: 1 });
    expect(deep['RB']!.score).toBeLessThan(shallow['RB']!.score);
  });
});

describe('positional scarcity', () => {
  it('detects a tier break after the player', () => {
    const scarcity = computeScarcity({ availableAdps: [10, 45, 50], playerAdp: 10, picksUntilNext: 12 });
    expect(scarcity.tierGap).toBe(35);
    expect(scarcity.reason).toContain('tier break');
  });

  it('reports a thin remaining pool', () => {
    const scarcity = computeScarcity({ availableAdps: [10, 12, 14], playerAdp: 10, picksUntilNext: 12 });
    expect(scarcity.expectedRemaining).toBe(0);
    expect(scarcity.score).toBeGreaterThan(0.4);
  });

  it('degrades gracefully with no ADP', () => {
    const scarcity = computeScarcity({ availableAdps: [], playerAdp: null, picksUntilNext: 5 });
    expect(scarcity.reason).toContain('insufficient');
  });
});

describe('league fit', () => {
  it('lifts pass catchers in full PPR relative to standard', () => {
    const full = leagueFitMultipliers(buildScoringProfile({ rec: 1 }, []), STANDARD_SHAPE);
    const standard = leagueFitMultipliers(buildScoringProfile({ rec: 0 }, []), STANDARD_SHAPE);
    expect(full['WR']!).toBeGreaterThan(standard['WR']!);
  });

  it('raises QB value in superflex', () => {
    const shape = buildRosterShape(['QB', 'RB', 'WR', 'SUPER_FLEX', 'BN']);
    expect(leagueFitMultipliers(buildScoringProfile({ rec: 0.5 }, ['SUPER_FLEX']), shape)['QB']).toBe(1.25);
  });

  it('raises TE value under TE premium', () => {
    const withBonus = leagueFitMultipliers(buildScoringProfile({ rec: 0.5, bonus_rec_te: 0.5 }, []), STANDARD_SHAPE);
    const without = leagueFitMultipliers(HALF_PPR, STANDARD_SHAPE);
    expect(withBonus['TE']!).toBeGreaterThan(without['TE']!);
  });

  it('keeps multipliers bounded', () => {
    const fit = leagueFitMultipliers(buildScoringProfile({ rec: 3, bonus_rec_te: 5, pass_td: 9 }, ['SUPER_FLEX']), STANDARD_SHAPE);
    for (const v of Object.values(fit)) {
      expect(v).toBeGreaterThanOrEqual(0.85);
      expect(v).toBeLessThanOrEqual(1.25);
    }
  });
});

describe('individual components', () => {
  it('rewards a player who fell past their ADP', () => {
    // ADP 8, still on the board at pick 20 => +12 picks of value.
    const c = marketValueComponent(8, 20, 12);
    expect(c.score).toBeGreaterThan(0);
    expect(c.display).toContain('picks of value');
  });

  it('treats picking a later-ADP player as a reach, not as value', () => {
    const c = marketValueComponent(120, 20, 12);
    expect(c.score).toBeLessThan(0);
    expect(c.display).toContain('reach');
  });

  it('penalises a reach only half as hard as it rewards value', () => {
    const fall = marketValueComponent(8, 20, 12); // +12
    const reach = marketValueComponent(32, 20, 12); // -12
    expect(Math.abs(reach.score)).toBeLessThan(fall.score);
  });

  it('marks a missing ADP unknown with zero contribution', () => {
    const c = marketValueComponent(null, 20, 12);
    expect(c.unknown).toBe(true);
    expect(c.contribution).toBe(0);
    expect(c.display).toBe('no ADP');
  });

  it('saturates the news component so a huge tally cannot run away', () => {
    expect(newsComponent('news_recent', 50, 20).score).toBe(1);
    expect(newsComponent('news_recent', -50, 20).score).toBe(-1);
  });

  it('marks an absent news signal unknown rather than negative', () => {
    const c = newsComponent('news_recent', 0, 0);
    expect(c.unknown).toBe(true);
    expect(c.contribution).toBe(0);
  });
});

describe('rankAvailablePlayers', () => {
  const players = TEST_PLAYERS.filter((p) => p.active);
  const ctx = {
    currentPick: 15,
    nextPick: 30,
    shape: STANDARD_SHAPE,
    profile: HALF_PPR,
    rosterCounts: { QB: 1, RB: 0, WR: 1, TE: 0 },
    totalPicks: 180,
  };

  function board(overrides: Partial<Record<string, Partial<AvailablePlayerInput>>> = {}) {
    return rankAvailablePlayers(
      players.map((player, i) => ({
        player,
        adp: 10 + i * 8,
        adpRank: i + 1,
        signal: null,
        ...(overrides[player.id] ?? {}),
      })),
      ctx,
    );
  }

  it('exposes every component with its weight and contribution', () => {
    const [top] = board();
    const keys = top!.components.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining(['market_value', 'need', 'scarcity', 'league_fit', 'news_recent', 'news_raw', 'survival']),
    );
    for (const c of top!.components) {
      // Contributions are rounded to 3dp for display stability.
      expect(c.contribution).toBeCloseTo(c.score * c.weight, 2);
    }
  });

  it('never returns a recommendation without reasons', () => {
    for (const rec of board()) expect(rec.reasons.length).toBeGreaterThan(0);
  });

  it('sums the components into the total', () => {
    const [top] = board();
    const sum = top!.components.reduce((a, c) => a + c.contribution, 0);
    expect(top!.total).toBeCloseTo(sum, 2);
  });

  it('is deterministic for the same board state', () => {
    expect(JSON.stringify(board())).toBe(JSON.stringify(board()));
  });

  it('ranks a faller above an otherwise identical player going at ADP', () => {
    const wrs = players.filter((p) => p.position === 'WR').slice(0, 2);
    const ranked = rankAvailablePlayers(
      [
        { player: wrs[0]!, adp: 15, adpRank: 1, signal: null }, // exactly at cost
        { player: wrs[1]!, adp: 4, adpRank: 2, signal: null }, // fell 11 picks
      ],
      ctx,
    );
    expect(ranked[0]?.playerId).toBe(wrs[1]!.id);
    expect(ranked[0]?.adpValue).toBe(11);
  });

  it('lets news break a tie but not overturn a large ADP gap', () => {
    const players2 = [players[0]!, players[1]!];
    const rank = (adpA: number, adpB: number, netB: number) =>
      rankAvailablePlayers(
        [
          { player: players2[0]!, adp: adpA, adpRank: 1, signal: null },
          { player: players2[1]!, adp: adpB, adpRank: 2, signal: signal(netB) },
        ],
        ctx,
      );

    // Near-identical market value: a strong positive signal flips the order.
    const close = rank(14, 15, 6);
    expect(close[0]?.playerId).toBe(players2[1]!.id);

    // Huge market-value gap: the same signal must not overturn it.
    const wide = rank(4, 120, 6);
    expect(wide[0]?.playerId).toBe(players2[0]!.id);
  });

  it('marks players with no ADP as degraded but still ranks them', () => {
    const ranked = rankAvailablePlayers(
      [{ player: players[0]!, adp: null, adpRank: null, signal: null }],
      ctx,
    );
    expect(ranked[0]?.degraded).toBe(true);
    expect(ranked[0]?.counterpoints.join(' ')).toContain('no ADP');
  });

  it('surfaces unreviewed evidence as a counterpoint', () => {
    const withPending = emptySignal(players[0]!.id);
    withPending.pendingCount = 3;
    const ranked = rankAvailablePlayers(
      [{ player: players[0]!, adp: 20, adpRank: 1, signal: withPending }],
      ctx,
    );
    expect(ranked[0]?.counterpoints.join(' ')).toContain('awaiting your review');
  });

  it('uses the documented default weights', () => {
    expect(DEFAULT_WEIGHTS.marketValue).toBeGreaterThan(DEFAULT_WEIGHTS.newsRecent * 5);
  });

  it('handles an empty pool', () => {
    expect(rankAvailablePlayers([], ctx)).toEqual([]);
  });
});
