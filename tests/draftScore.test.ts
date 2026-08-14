/**
 * The number on the card, and the one live input behind it.
 *
 * Two separate things are being defended here.
 *
 * The first is that `Score` is a *transform* and not an opinion. The board is
 * ordered by a composite that runs from about −18 to +0.6 with the entire
 * contested top of the board packed into the last 9% of it; the Score has to
 * make that readable without becoming a second ranking, and it has to be stable
 * — the same composite must produce the same number tomorrow, at a different
 * pick, on a board of a different size.
 *
 * The second is the separation component: the board knew that a falling player
 * gains value, and did not know that the players who would replace him were
 * disappearing. These are the scenarios that say it now does, and the bounds
 * that stop it running away.
 */

import { describe, expect, it } from 'vitest';
import { SCORE_CALIBRATION, SEPARATION, draftScore, separationScore } from '../src/core/draft/score.ts';
import { rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { player } from './helpers/players.ts';

describe('the 0-100 transform', () => {
  it('is bounded whatever it is handed', () => {
    for (const total of [-1e9, -40, -18, -2.5, 0, 5, 1e9]) {
      const s = draftScore(total);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('never returns NaN for a total that is not a number', () => {
    expect(draftScore(Number.NaN)).toBe(0);
    expect(draftScore(Number.POSITIVE_INFINITY)).toBe(100);
    expect(draftScore(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('is monotonic: a higher composite is never a lower Score', () => {
    let previous = -1;
    for (let total = -20; total <= 4; total += 0.05) {
      const s = draftScore(total);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
  });

  it('puts the centre of the curve at 50', () => {
    expect(draftScore(SCORE_CALIBRATION.centre)).toBe(50);
  });

  /**
   * The property that rules out min-max scaling against the current pool.
   *
   * A player's Score may not change because somebody unrelated at the bottom of
   * the board was drafted, so the transform is given no knowledge of the pool at
   * all: it is a function of one number.
   */
  it('gives the same composite the same Score, always', () => {
    expect(draftScore(-1.234)).toBe(draftScore(-1.234));
    expect(draftScore(0.555)).toBe(draftScore(0.555));
  });

  /**
   * The measured production distribution: median −5.15, p95 −0.54, best +0.56.
   * A linear map over that range put the whole top of the board inside three
   * points; this is the check that the calibration still spends its resolution
   * where the decision is.
   */
  it('separates the players actually being chosen between', () => {
    const best = draftScore(0.555);
    const fifteenth = draftScore(-0.883);
    const median = draftScore(-5.151);
    expect(best - fifteenth).toBeGreaterThanOrEqual(8);
    expect(fifteenth - median).toBeGreaterThanOrEqual(30);
    expect(best).toBeLessThan(100);
    expect(median).toBeGreaterThan(0);
  });
});

describe('separation from the alternatives', () => {
  it('is nothing when there is nobody behind him', () => {
    const r = separationScore({ base: 0.4, positionBases: [] });
    expect(r.score).toBe(0);
    expect(r.gap).toBeNull();
    expect(r.comparedWith).toBe(0);
  });

  it('is nothing when the next few are just as good', () => {
    const r = separationScore({ base: 0.4, positionBases: [0.4, 0.4, 0.4] });
    expect(r.score).toBe(0);
    expect(r.gap).toBe(0);
    expect(Object.is(r.gap, -0)).toBe(false);
  });

  /**
   * The calibration, checked against the board it was measured on.
   *
   * A live 195-player board put the median gap at 0.33 and the ninetieth
   * percentile at 0.89. The component has to be somewhere in the middle of its
   * range for a typical player — a component that is already maxed out cannot
   * notice the alternatives disappearing, which is the entire reason it exists.
   */
  it('leaves the typical player room to move', () => {
    const typical = separationScore({ base: 0.33, positionBases: [0, 0, 0] }).score;
    expect(typical).toBeGreaterThan(0.2);
    expect(typical).toBeLessThan(0.8);
  });

  it('grows as the alternatives get worse', () => {
    const near = separationScore({ base: 0.4, positionBases: [0.3, 0.3, 0.3] }).score;
    const far = separationScore({ base: 0.4, positionBases: [-0.1, -0.1, -0.1] }).score;
    expect(far).toBeGreaterThan(near);
  });

  it('saturates, so a hopeless position does not become a lock', () => {
    const r = separationScore({ base: 0.4, positionBases: [-40, -50, -60] });
    expect(r.score).toBe(1);
  });

  /** Only the few players you would actually take instead count. */
  it('ignores the far end of the position', () => {
    const withTail = separationScore({ base: 0.4, positionBases: [0.3, 0.25, 0.2, -12, -13, -14] });
    const withoutTail = separationScore({ base: 0.4, positionBases: [0.3, 0.25, 0.2] });
    expect(withTail.score).toBe(withoutTail.score);
    expect(withTail.comparedWith).toBe(SEPARATION.alternatives);
  });

  /** Better players are not alternatives to him, so they cannot penalise him. */
  it('never goes negative for a player who is not the best at his position', () => {
    const r = separationScore({ base: 0.1, positionBases: [0.9, 0.8, 0.05] });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.comparedWith).toBe(1);
  });
});

// --------------------------------------------------------------- on a board

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);
const EMPTY_ROSTER = { QB: 0, RB: 0, WR: 0, TE: 0 };

function ctx(overrides: Partial<Parameters<typeof rankAvailablePlayers>[1]> = {}) {
  return {
    currentPick: 40,
    nextPick: 62,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: EMPTY_ROSTER,
    totalPicks: 180,
    ...overrides,
  };
}

function wr(id: string, adp: number, extra: Partial<AvailablePlayerInput> = {}): AvailablePlayerInput {
  return {
    player: player({ id, fullName: `Receiver ${id}`, position: 'WR', team: 'CIN' }),
    adp,
    adpRank: Math.round(adp),
    signal: null,
    ...extra,
  };
}

function signal(net: number, items = 4): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

const find = (ranked: { playerId: string }[], id: string) => ranked.find((r) => r.playerId === id)!;

describe('the Score on a real board', () => {
  it('is attached to every player and agrees with board order', () => {
    const ranked = rankAvailablePlayers([wr('a', 30), wr('b', 45), wr('c', 60)], ctx());
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.score).toBeLessThanOrEqual(ranked[i - 1]!.score);
    }
    expect(ranked.every((r) => r.score >= 0 && r.score <= 100)).toBe(true);
  });

  it('is the transform of the total the board is sorted by, and nothing else', () => {
    const ranked = rankAvailablePlayers([wr('a', 30), wr('b', 45)], ctx());
    for (const rec of ranked) expect(rec.score).toBe(draftScore(rec.total));
  });

  /* §18 — a positive tally raises the Score, all else equal. */
  it('rises with a positive tally', () => {
    const ranked = rankAvailablePlayers([wr('a', 44, { signal: signal(6) }), wr('b', 44)], ctx());
    const a = find(ranked, 'a');
    const b = find(ranked, 'b');
    expect(a.total).toBeGreaterThan(b.total);
    expect(a.score).toBeGreaterThan(b.score);
    expect(ranked[0]!.playerId).toBe('a');
  });

  it('falls with a negative tally', () => {
    const ranked = rankAvailablePlayers([wr('a', 44, { signal: signal(-4) }), wr('b', 44)], ctx());
    const a = find(ranked, 'a');
    const b = find(ranked, 'b');
    expect(a.total).toBeLessThan(b.total);
    expect(a.score).toBeLessThan(b.score);
    expect(ranked[0]!.playerId).toBe('b');
  });

  /*
   * §19 — the core product goal: the board is allowed to disagree with ADP,
   * and the Score is what makes the disagreement legible rather than mystifying.
   */
  it('lets accumulated research outrank a better ADP, visibly', () => {
    const ranked = rankAvailablePlayers([wr('researched', 48, { signal: signal(10) }), wr('market', 42)], ctx());
    expect(ranked[0]!.playerId).toBe('researched');
    expect(find(ranked, 'researched').score).toBeGreaterThan(find(ranked, 'market').score);
    // ADP itself is untouched: the market number still says what the market says.
    expect(find(ranked, 'researched').adp).toBe(48);
    expect(find(ranked, 'market').adp).toBe(42);
  });

  /*
   * §20 — one unrelated player leaving the board rescales nobody.
   *
   * The transform is what is on trial here, so the player removed is at another
   * position entirely: nothing about him is an input to any receiver's ranking,
   * and under min-max scaling against the pool every score on the board would
   * have moved anyway.
   */
  it('does not move when an unrelated player is drafted', () => {
    const contenders = [wr('a', 38), wr('b', 41), wr('c', 44)];
    const elsewhere: AvailablePlayerInput = {
      player: player({ id: 'k', fullName: 'Kicker', position: 'K', team: 'BAL' }),
      adp: 190,
      adpRank: 190,
      signal: null,
    };
    const before = rankAvailablePlayers([...contenders, elsewhere], ctx());
    const after = rankAvailablePlayers(contenders, ctx());
    for (const id of ['a', 'b', 'c']) {
      expect(find(after, id).score).toBe(find(before, id).score);
    }
  });

  it('scores a player with no ADP and no evidence rather than failing', () => {
    const ranked = rankAvailablePlayers(
      [{ ...wr('bare', 0), adp: null, adpRank: null }, wr('b', 41)],
      ctx(),
    );
    expect(Number.isInteger(find(ranked, 'bare').score)).toBe(true);
  });
});

/**
 * §36 — the scenarios the user described, one test each.
 *
 * "If the current #1 player keeps falling while players below him are drafted,
 * his Score should continue to increase." Both halves of that are checked
 * separately, because they come from different components and only one of them
 * is new.
 */
describe('the Score as the draft moves', () => {
  /**
   * A receiver room rather than four names.
   *
   * Density is the point. On a five-player fixture the next man at the position
   * is a hundred picks away, every gap is enormous and the separation component
   * saturates for everybody — which is true of that board and true of no real
   * one. A live board put the median gap between a player and his next three at
   * 0.33 of composite, which is roughly what a two-pick ADP ladder produces.
   */
  const alternatives = (count = 10) =>
    Array.from({ length: count }, (_, i) => wr(`alt${i + 1}`, 44 + i * 2));
  const board = () => [wr('star', 40), ...alternatives(), wr('deep', 150)];

  /** A — nothing changed, so nothing changes. */
  it('is stable on an unchanged board', () => {
    const first = rankAvailablePlayers(board(), ctx({ currentPick: 40, nextPick: 62 }));
    const second = rankAvailablePlayers(board(), ctx({ currentPick: 40, nextPick: 62 }));
    expect(second.map((r) => r.score)).toEqual(first.map((r) => r.score));
  });

  /** B — he keeps falling, and the board notices. */
  it('rises as a player falls past his ADP', () => {
    const at40 = find(rankAvailablePlayers(board(), ctx({ currentPick: 40, nextPick: 62 })), 'star');
    const at50 = find(rankAvailablePlayers(board(), ctx({ currentPick: 50, nextPick: 72 })), 'star');
    const at60 = find(rankAvailablePlayers(board(), ctx({ currentPick: 60, nextPick: 82 })), 'star');
    expect(at50.score).toBeGreaterThan(at40.score);
    expect(at60.score).toBeGreaterThan(at50.score);
  });

  /**
   * C — the players who would have replaced him are gone.
   *
   * The current pick does not move, so market value is identical in both
   * boards: everything that changes here is the disappearance of the three
   * receivers closest to him. This is the behaviour the board did not have.
   */
  it('rises when comparable alternatives are drafted', () => {
    const before = find(rankAvailablePlayers(board(), ctx()), 'star');
    const runOnReceivers = [wr('star', 40), ...alternatives().slice(3), wr('deep', 150)];
    const after = find(rankAvailablePlayers(runOnReceivers, ctx()), 'star');
    expect(separationOf(after)).toBeGreaterThan(separationOf(before));
    expect(after.score).toBeGreaterThan(before.score);
    // Market value did not move, because the pick on the clock did not.
    expect(after.adpValue).toBe(before.adpValue);
  });

  /** D — the ones who left were never alternatives. */
  it('barely moves when only distant players are drafted', () => {
    const full = rankAvailablePlayers([...board(), wr('deep2', 170), wr('deep3', 185)], ctx());
    const thinned = rankAvailablePlayers(board(), ctx());
    expect(Math.abs(find(thinned, 'star').score - find(full, 'star').score)).toBeLessThanOrEqual(1);
  });

  /** E — a falling player with news against him does not float regardless. */
  it('does not let the fall outvote real negative evidence', () => {
    const clean = find(rankAvailablePlayers(board(), ctx({ currentPick: 60, nextPick: 82 })), 'star');
    const withNews = find(
      rankAvailablePlayers(
        [wr('star', 40, { signal: signal(-8) }), ...alternatives(), wr('deep', 150)],
        ctx({ currentPick: 60, nextPick: 82 }),
      ),
      'star',
    );
    expect(withNews.score).toBeLessThan(clean.score);
  });

  /*
   * §33 and §34 — the two ways this could have gone wrong.
   *
   * Runaway: the component is capped, so however isolated a player becomes the
   * most it can ever add is its weight. Circular: it reads base composites
   * rather than ordinal rank, so being ranked first is not itself a reason to
   * be ranked first — which is checked by the arithmetic below, where the
   * board's #1 gains exactly his separation contribution and no more.
   */
  it('is capped however isolated a player becomes', () => {
    const alone = find(rankAvailablePlayers([wr('star', 40), wr('deep', 250)], ctx()), 'star');
    expect(separationOf(alone)).toBeLessThanOrEqual(SEPARATION.weight);
    const component = alone.components.find((c) => c.key === 'separation')!;
    expect(component.score).toBeLessThanOrEqual(1);
    expect(component.weight).toBe(SEPARATION.weight);
  });

  it('adds separation to the total exactly once', () => {
    const ranked = rankAvailablePlayers(board(), ctx());
    for (const rec of ranked) {
      expect(rec.components.filter((c) => c.key === 'separation')).toHaveLength(1);
      const sum = rec.components.reduce((a, c) => a + c.contribution, 0);
      expect(Math.abs(sum - rec.total)).toBeLessThan(0.002);
    }
  });
});

function separationOf(rec: { components: { key: string; contribution: number }[] }): number {
  return rec.components.find((c) => c.key === 'separation')?.contribution ?? 0;
}
