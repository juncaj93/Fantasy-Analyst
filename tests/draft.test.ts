import { describe, expect, it } from 'vitest';
import { toCanonicalPlayers } from '../src/core/sleeper/transform.ts';
import {
  DEFAULT_WEIGHTS,
  marketValueComponent,
  newsComponent,
  rankAvailablePlayers,
  type AvailablePlayerInput,
} from '../src/core/draft/engine.ts';
import { computeNeed, computeScarcity } from '../src/core/draft/need.ts';
import { SURVIVAL_BANDS, adpSpread, estimateSurvival, survivalBand } from '../src/core/draft/survival.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { slotForRoster, slotFromPicks } from '../src/core/sleeper/transform.ts';
import {
  adpFormatForLeague,
  buildRosterShape,
  buildScoringProfile,
  leagueFitMultipliers,
} from '../src/core/sleeper/scoring.ts';
import { TEST_PLAYERS } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const STANDARD_SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

function signal(net: number, items = 2): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

describe('survival estimate', () => {
  it('returns null when ADP is unknown, never a fabricated number', () => {
    const est = estimateSurvival({ adp: null, currentPick: 10, nextPick: 22 });
    expect(est.probability).toBeNull();
    expect(est.note).toContain('unknown');
  });

  /**
   * S(x)/S(x). Kept because it is true, but the board no longer reaches it:
   * the horizon it passes is always a pick later than the one on the clock.
   */
  it('is certain when the horizon is the pick itself', () => {
    expect(estimateSurvival({ adp: 30, currentPick: 10, nextPick: 10 }).probability).toBe(1);
  });

  /**
   * No later pick is not the same fact as "certain to last", and reporting the
   * second is worse than reporting nothing: on your final selection there is
   * nothing for a player to survive to.
   */
  it('is unknown when there is no pick after this one', () => {
    const est = estimateSurvival({ adp: 30, currentPick: 190, nextPick: null });
    expect(est.probability).toBeNull();
    expect(est.note).toContain('nothing for him to last until');
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
    // A shade over half, not exactly half: he was already 93% to reach the
    // current pick, and the estimate is conditioned on his having done it.
    const est = estimateSurvival({ adp: 22, currentPick: 10, nextPick: 22 });
    expect(est.probability!).toBeGreaterThan(0.5);
    expect(est.probability!).toBeLessThan(0.6);
    expect(est.unconditional).toBeCloseTo(0.5, 2);
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

/**
 * The four cases the brief names, plus the property that makes them coherent.
 *
 * The one that matters is C. A player whose ADP was fifteen picks ago and who
 * is somehow still on the board is not 5% to last another eight picks — the
 * board has just shown you that the room does not want him. Answering that
 * question from the unconditional distribution is answering a question about a
 * pick that has already happened.
 */
describe('survival, conditioned on the player still being there', () => {
  it('A: a player at ADP 44 with your next pick at 48 is a real risk, not a lock', () => {
    const est = estimateSurvival({ adp: 44, currentPick: 40, nextPick: 48 });
    expect(est.probability!).toBeGreaterThan(0.35);
    expect(est.probability!).toBeLessThan(0.7);
    expect(survivalBand(est.probability)).toBe('coinflip');
  });

  it('B: the same wait for a player at ADP 78 is comfortable', () => {
    const est = estimateSurvival({ adp: 78, currentPick: 40, nextPick: 48 });
    expect(est.probability!).toBeGreaterThan(0.85);
    expect(survivalBand(est.probability)).toBe('safe');
  });

  it('C: a faller still on the board is judged from now, not from his ADP', () => {
    const est = estimateSurvival({ adp: 45, currentPick: 60, nextPick: 68 });
    // The unconditional model has all but written him off; the board has not.
    expect(est.unconditional!).toBeLessThan(0.1);
    expect(est.probability!).toBeGreaterThan(0.25);
    expect(est.note).toContain('still available at pick 60');
  });

  it('D: a nearer next pick is always likelier than a farther one', () => {
    const near = estimateSurvival({ adp: 45, currentPick: 60, nextPick: 64 }).probability!;
    const far = estimateSurvival({ adp: 45, currentPick: 60, nextPick: 72 }).probability!;
    expect(near).toBeGreaterThan(far);
  });

  it('falls monotonically as the wait grows, for every player', () => {
    for (const adp of [12, 45, 90, 150]) {
      let last = 1;
      for (const nextPick of [61, 64, 68, 74, 84, 100]) {
        const p = estimateSurvival({ adp, currentPick: 60, nextPick }).probability!;
        expect(p).toBeLessThanOrEqual(last);
        last = p;
      }
    }
  });

  it('never returns a probability outside 0..1, however deep the faller', () => {
    const est = estimateSurvival({ adp: 5, currentPick: 200, nextPick: 212 });
    expect(est.probability!).toBeGreaterThanOrEqual(0);
    expect(est.probability!).toBeLessThanOrEqual(1);
    expect(Number.isNaN(est.probability!)).toBe(false);
  });

  it('colours the number from one set of bands, in one place', () => {
    expect(survivalBand(null)).toBe('unknown');
    expect(survivalBand(SURVIVAL_BANDS.gone)).toBe('gone');
    expect(survivalBand(SURVIVAL_BANDS.gone + 0.01)).toBe('coinflip');
    expect(survivalBand(SURVIVAL_BANDS.safe - 0.01)).toBe('coinflip');
    expect(survivalBand(SURVIVAL_BANDS.safe)).toBe('safe');
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

  /**
   * A ceiling on value is right — you only get to spend the one pick. A ceiling
   * on reaching is not: it made every distant player score the same, so the
   * board was decided by roster need and a quarterback with an ADP of 202 came
   * ninth at pick 38.
   */
  it('keeps getting worse the further the reach goes', () => {
    const near = marketValueComponent(60, 38, 10);
    const far = marketValueComponent(202, 38, 10);
    expect(far.score).toBeLessThan(near.score);
    expect(far.score).toBeLessThan(-1);
  });

  it('caps the reward for a player who fell a long way', () => {
    expect(marketValueComponent(1, 200, 10).score).toBe(1);
  });

  it('marks a missing ADP unknown with zero contribution', () => {
    const c = marketValueComponent(null, 20, 12);
    expect(c.unknown).toBe(true);
    expect(c.contribution).toBe(0);
    expect(c.display).toBe('no ADP');
  });

  it('saturates each news window so a huge tally cannot run away', () => {
    expect(newsComponent('news_lifetime', 50, 20).score).toBe(1);
    expect(newsComponent('news_lifetime', -50, 20).score).toBe(-1);
  });

  /** A week holds fewer items than a career, so it maxes out sooner. */
  it('saturates shorter windows sooner', () => {
    expect(newsComponent('news_7d', 3, 2).score).toBe(1);
    expect(newsComponent('news_lifetime', 3, 2).score).toBeLessThan(1);
  });

  it('damps a recent window that contradicts the lifetime record', () => {
    const plain = newsComponent('news_30d', 5, 3);
    const damped = newsComponent('news_30d', 5, 3, DEFAULT_WEIGHTS, 0.5);
    expect(damped.score).toBeCloseTo(plain.score * 0.5, 5);
    expect(damped.display).toContain('damped');
  });

  it('marks an absent news signal unknown rather than negative', () => {
    const c = newsComponent('news_lifetime', 0, 0);
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

  /**
   * The board is a market-value board first. Roster need breaks near ties; it
   * does not promote a player nobody else would take for another fifteen rounds.
   */
  it('will not float a far-off player over a close one on roster need', () => {
    const [qb, rb] = [players.find((p) => p.position === 'QB')!, players.find((p) => p.position === 'RB')!];
    const ranked = rankAvailablePlayers(
      [
        { player: qb, adp: 202, adpRank: 202, signal: null },
        { player: rb, adp: 16, adpRank: 16, signal: null },
      ],
      { ...ctx, rosterCounts: { QB: 0, RB: 2, WR: 3, TE: 1 } },
    );
    expect(ranked[0]!.playerId).toBe(rb.id);
  });

  it('exposes every component with its weight and contribution', () => {
    const [top] = board();
    const keys = top!.components.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'market_value',
        'need',
        'scarcity',
        'league_fit',
        'news_lifetime',
        'news_30d',
        'news_7d',
        'survival',
      ]),
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

  /**
   * Lifetime carries the most weight of the three windows: a player favoured
   * all offseason should still be favoured on draft day.
   */
  it('weights lifetime above the recent windows, and market above all of them', () => {
    expect(DEFAULT_WEIGHTS.newsLifetime).toBeGreaterThan(DEFAULT_WEIGHTS.news30);
    expect(DEFAULT_WEIGHTS.news30).toBeGreaterThan(DEFAULT_WEIGHTS.news7);
    const allNews = DEFAULT_WEIGHTS.newsLifetime + DEFAULT_WEIGHTS.news30 + DEFAULT_WEIGHTS.news7;
    expect(DEFAULT_WEIGHTS.marketValue).toBeGreaterThan(allNews);
  });

  /**
   * The brief's calibration requirement, stated as tests: the user's research
   * has to be able to visibly reorder close decisions, or keeping the tally is
   * pointless — while still losing to a large market gap.
   *
   * `signalOf` builds a PlayerSignal with the three windows set directly.
   */
  describe('how far the tally can move a player', () => {
    const signalOf = (lifetime: number, d30 = 0, d7 = 0) => ({
      playerId: 'x',
      raw: { positive: 0, negative: 0, net: lifetime, items: Math.max(1, Math.abs(lifetime)) },
      last7: { positive: 0, negative: 0, net: d7, items: d7 === 0 ? 0 : Math.abs(d7) },
      last30: { positive: 0, negative: 0, net: d30, items: d30 === 0 ? 0 : Math.abs(d30) },
      seasonToDate: { positive: 0, negative: 0, net: lifetime, items: 1 },
      categoryBreakdown: {},
      pendingCount: 0,
      mixedCount: 0,
      lastEvidenceAt: null,
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    const two = (aAdp: number, aSignal: unknown, bAdp: number, bSignal: unknown, overrides = {}) => {
      const [a, b] = [players[0]!, players[1]!];
      return rankAvailablePlayers(
        [
          { player: a, adp: aAdp, adpRank: aAdp, signal: aSignal as never },
          { player: b, adp: bAdp, adpRank: bAdp, signal: bSignal as never },
        ],
        { ...ctx, currentPick: 40, nextPick: 52, ...overrides },
      ).map((r) => r.playerId);
    };

    it('lets a strong lifetime tally beat a modestly better ADP', () => {
      expect(two(48, signalOf(12, 4), 44, null)[0]).toBe(players[0]!.id);
    });

    it('lets a strong negative tally fall below a modestly worse ADP', () => {
      expect(two(50, signalOf(-10, -4), 54, null)[0]).toBe(players[1]!.id);
    });

    it('adds to the effect when recent momentum agrees', () => {
      const withMomentum = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(8, 5, 3) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      )[0]!.total;
      const without = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(8) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      )[0]!.total;
      expect(withMomentum).toBeGreaterThan(without);
    });

    it('deepens the penalty when recent momentum agrees downward', () => {
      const worse = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(-8, -5, -3) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      )[0]!.total;
      const milder = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(-8) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      )[0]!.total;
      expect(worse).toBeLessThan(milder);
    });

    /** The line the tally must not cross. */
    it('still loses to a large market gap', () => {
      expect(two(90, signalOf(15, 6, 3), 42, null)[0]).toBe(players[1]!.id);
    });

    it('says so when the tally is what moved the player', () => {
      const [top] = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(12, 4) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      );
      expect(top!.reasons.join(' ')).toContain('strong lifetime signal');
      // In picks of ADP — the unit the number is actually in, and the one the
      // ADP column on the same card can be checked against. Never "spots",
      // which reads as places on the board and is a promise this cannot keep.
      expect(top!.reasons.join(' ')).toMatch(/about \d+ picks? of ADP/);
    });

    it('trusts both less when recent news contradicts the lifetime record', () => {
      const [conflicted] = rankAvailablePlayers(
        [{ player: players[0]!, adp: 48, adpRank: 48, signal: signalOf(10, -4) as never }],
        { ...ctx, currentPick: 40, nextPick: 52 },
      );
      expect(conflicted!.newsConflicted).toBe(true);
      expect(conflicted!.counterpoints.join(' ')).toContain('contradicts the lifetime record');
    });
  });

  it('handles an empty pool', () => {
    expect(rankAvailablePlayers([], ctx)).toEqual([]);
  });
});

/**
 * Draft order now comes from Sleeper's own ranking, carried on the player
 * record by the nightly sync, so the board works with no file imported.
 */
describe('Sleeper draft rank', () => {
  const dump = {
    a: { player_id: 'a', full_name: 'Top Back', position: 'RB', team: 'KC', active: true, search_rank: 1 },
    b: { player_id: 'b', full_name: 'Mid Receiver', position: 'WR', team: 'SF', active: true, search_rank: 48 },
    c: { player_id: 'c', full_name: 'Deep Bench', position: 'TE', team: 'NYJ', active: true, search_rank: 9999999 },
    d: { player_id: 'd', full_name: 'No Rank', position: 'WR', team: 'LAR', active: true },
  };

  it('carries the rank through from the player dump', () => {
    const players = toCanonicalPlayers(dump);
    const byName = new Map(players.map((p) => [p.fullName, p]));
    expect(byName.get('Top Back')!.searchRank).toBe(1);
    expect(byName.get('Mid Receiver')!.searchRank).toBe(48);
  });

  it('treats the unranked sentinel as unranked, not as a very late pick', () => {
    const players = toCanonicalPlayers(dump);
    const byName = new Map(players.map((p) => [p.fullName, p]));
    // 9,999,999 is Sleeper's "not ranked", and reading it literally would make
    // the player look merely undrafted-late rather than unknown.
    expect(byName.get('Deep Bench')!.searchRank).toBeNull();
    expect(byName.get('No Rank')!.searchRank).toBeNull();
  });
});

/**
 * Which published ADP applies. Getting this wrong is not a small error: full-PPR
 * ADP in a half-PPR league is wrong everywhere at once, and quietly.
 */
describe('finding your draft slot', () => {
  const picks = [
    { draftSlot: 3, rosterId: 7, pickedBy: 'u7' },
    { draftSlot: 4, rosterId: 2, pickedBy: 'u2' },
  ];

  it('reads the slot from the published map when there is one', () => {
    expect(slotForRoster({ '1': 5, '2': 7 }, 7)).toBe(2);
  });

  /** Best-ball and mock drafts often publish no slot map at all. */
  it('falls back to the slot that made your picks', () => {
    expect(slotForRoster({}, 7)).toBeNull();
    expect(slotFromPicks(picks, 7)).toBe(3);
  });

  it('matches on the Sleeper user when picks carry no roster id', () => {
    const anonymous = [{ draftSlot: 9, rosterId: null, pickedBy: 'u7' }];
    expect(slotFromPicks(anonymous, 7, 'u7')).toBe(9);
  });

  it('stays unknown rather than guessing before you have picked', () => {
    expect(slotFromPicks([], 7, 'u7')).toBeNull();
  });
});

describe('the ADP format a league drafts in', () => {
  const format = (scoring: Record<string, number>, positions: string[], settings = {}) =>
    adpFormatForLeague(buildScoringProfile(scoring, positions), buildRosterShape(positions), settings);

  it('reads half PPR from the scoring settings', () => {
    expect(format({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN']).scoringFormat).toBe('HALF_PPR');
  });

  it('separates full PPR and standard', () => {
    expect(format({ rec: 1 }, ['QB', 'RB', 'BN']).scoringFormat).toBe('PPR');
    expect(format({ rec: 0 }, ['QB', 'RB', 'BN']).scoringFormat).toBe('STANDARD');
  });

  it('is 1QB unless the league starts more than one', () => {
    expect(format({ rec: 0.5 }, ['QB', 'RB', 'WR', 'BN']).qbType).toBe('1QB');
    expect(format({ rec: 0.5 }, ['QB', 'SUPER_FLEX', 'RB', 'BN']).qbType).toBe('SUPERFLEX');
    // Two plain QB slots draft like superflex even without the slot name.
    expect(format({ rec: 0.5 }, ['QB', 'QB', 'RB', 'BN']).qbType).toBe('SUPERFLEX');
  });

  /** Sleeper's league type: 0 redraft, 1 keeper, 2 dynasty. */
  it('treats keeper leagues as redraft and dynasty as dynasty', () => {
    expect(format({ rec: 0.5 }, ['QB', 'BN'], { type: 0 }).draftType).toBe('REDRAFT');
    expect(format({ rec: 0.5 }, ['QB', 'BN'], { type: 1 }).draftType).toBe('REDRAFT');
    expect(format({ rec: 0.5 }, ['QB', 'BN'], { type: 2 }).draftType).toBe('DYNASTY');
  });
});
