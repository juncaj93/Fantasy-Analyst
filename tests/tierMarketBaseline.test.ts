/**
 * Tiers read the market the Score is anchored to.
 *
 * They used to read Sleeper ADP while the ranking beside them was anchored to
 * the DOG/Sleeper blend, so a best-ball board could rank one tight end above
 * another on one market and then put them in the same tier on another. Nobody
 * would see a bug; they would see a board that quietly did not add up.
 *
 * The pairing that matters most here is the last one: the ladder and the lookup
 * must use the *same* number. A ladder built from blended values and queried
 * with raw Sleeper ADP puts players on rungs they are not on and says nothing
 * while it does it, which is why it is asserted directly rather than inferred
 * from a tier label looking plausible.
 */

import { describe, expect, it } from 'vitest';
import { rankAvailablePlayers, DEFAULT_WEIGHTS, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildPositionTierMap } from '../src/core/draft/tiers.ts';
import { blendMarketBaseline, MARKET_BLEND } from '../src/core/draft/marketBaseline.ts';
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

function entry(id: string, position: string, adp: number, dogAdp?: number | null): AvailablePlayerInput {
  return {
    player: {
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
    },
    adp,
    ...(dogAdp === undefined ? {} : { dogAdp }),
    adpRank: Math.round(adp),
    signal: null,
  };
}

const rank = (board: AvailablePlayerInput[], format?: 'standard' | 'best_ball') =>
  rankAvailablePlayers(board, { ...CTX, ...(format ? { marketFormat: format } : {}) }, DEFAULT_WEIGHTS);
const find = (recs: ReturnType<typeof rank>, id: string) => recs.find((r) => r.playerId === id)!;

/**
 * Tight ends the two markets disagree about, deliberately.
 *
 * Sleeper has all five within sixteen picks — one undifferentiated clump. DOG
 * splits them: two it likes and three it does not, forty picks apart. A ladder
 * built from Sleeper sees no cliff here at all; a ladder built from the blend
 * sees an obvious one. That disagreement is the whole point of the board, and
 * it is what makes the lookup test below capable of failing.
 */
function tightEnds(): AvailablePlayerInput[] {
  return [
    entry('te-a', 'TE', 100, 100),
    entry('te-b', 'TE', 104, 104),
    entry('te-c', 'TE', 108, 160),
    entry('te-d', 'TE', 112, 164),
    entry('te-e', 'TE', 116, 168),
    // Filler so the ladder has something to be a ladder of.
    ...Array.from({ length: 20 }, (_, i) => entry(`wr${i}`, 'WR', 30 + i * 5, 30 + i * 5)),
  ];
}

/** The blended baselines for one position on a board, in ladder order. */
function baselinesFor(board: AvailablePlayerInput[], position: string, format: 'standard' | 'best_ball') {
  return board
    .filter((e) => e.player.position === position)
    .map((e) => blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format }).adp)
    .filter((a): a is number => a != null);
}

describe('the ladder is built from the blend', () => {
  it('moves a tier boundary when only DOG moves', () => {
    const flat = [
      entry('a', 'TE', 100, 100),
      entry('b', 'TE', 104, 104),
      entry('c', 'TE', 108, 108),
      entry('d', 'TE', 112, 112),
      ...Array.from({ length: 20 }, (_, i) => entry(`wr${i}`, 'WR', 30 + i * 5, 30 + i * 5)),
    ];
    // The same Sleeper board, with DOG opening a chasm between b and c.
    const gapped = flat.map((e) =>
      e.player.id === 'c' ? entry('c', 'TE', 108, 190) : e.player.id === 'd' ? entry('d', 'TE', 112, 194) : e,
    );

    const before = find(rank(flat), 'b').tierCliff;
    const after = find(rank(gapped), 'b').tierCliff;
    expect(
      JSON.stringify(before) === JSON.stringify(after),
      'a DOG-only change left the tier structure identical, so the ladder is not reading DOG',
    ).toBe(false);
  });

  it('responds to DOG more in best ball than outside it', () => {
    // A blend weight of 0.75 moves a rung further from Sleeper than one of 0.6
    // does, which is the whole of "best ball is more DOG-anchored".
    const sleeper = 100;
    const dog = 160;
    const standard = blendMarketBaseline({ dogAdp: dog, sleeperAdp: sleeper, format: 'standard' }).adp!;
    const bestBall = blendMarketBaseline({ dogAdp: dog, sleeperAdp: sleeper, format: 'best_ball' }).adp!;
    expect(Math.abs(bestBall - sleeper)).toBeGreaterThan(Math.abs(standard - sleeper));

    // And the ladders the tier engine is handed differ accordingly: every rung
    // the two markets disagree about sits further out in best ball.
    const board = tightEnds();
    const std = baselinesFor(board, 'TE', 'standard').sort((a, b) => a - b);
    const bb = baselinesFor(board, 'TE', 'best_ball').sort((a, b) => a - b);
    expect(std).not.toEqual(bb);
    const disagreed = board.filter((e) => e.player.position === 'TE' && e.dogAdp !== e.adp);
    expect(disagreed.length).toBeGreaterThan(0);
    for (const e of disagreed) {
      const s0 = blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format: 'standard' }).adp!;
      const b0 = blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format: 'best_ball' }).adp!;
      expect(Math.abs(b0 - e.adp!)).toBeGreaterThan(Math.abs(s0 - e.adp!));
    }
  });

  it('uses the standard blend when the league is not best ball', () => {
    expect(MARKET_BLEND.standard).toEqual({ dog: 0.6, sleeper: 0.4 });
    expect(MARKET_BLEND.bestBall).toEqual({ dog: 0.75, sleeper: 0.25 });
  });
});

describe('the ladder and the lookup agree', () => {
  it('classifies a player at the rung his blended baseline actually sits on', () => {
    const board = tightEnds();
    const format = 'best_ball' as const;
    const recs = rank(board, format);

    // Rebuild the ladder the engine should have built, independently.
    const baselines = board
      .filter((e) => e.player.position === 'TE')
      .map((e) => blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format }).adp)
      .filter((a): a is number => a != null);
    const ladder = buildPositionTierMap('TE', baselines, { picksUntilNext: 15 });

    for (const e of board.filter((x) => x.player.position === 'TE')) {
      const own = blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format }).adp;
      const expected = ladder.at(own);
      const actual = find(recs, e.player.id).tierCliff;
      expect(actual.tierIndex, `${e.player.id} landed on a different rung than his own baseline`).toBe(
        expected.tierIndex,
      );
    }
  });

  it('does not classify a player by his raw Sleeper ADP', () => {
    const board = tightEnds();
    const format = 'best_ball' as const;
    const recs = rank(board, format);

    const baselines = board
      .filter((e) => e.player.position === 'TE')
      .map((e) => blendMarketBaseline({ dogAdp: e.dogAdp ?? null, sleeperAdp: e.adp, format }).adp)
      .filter((a): a is number => a != null);
    const ladder = buildPositionTierMap('TE', baselines, { picksUntilNext: 15 });

    // Querying the correct ladder with the wrong key is the bug this guards
    // against. On this board it produces a different answer for at least one
    // player, which is what makes the guard meaningful rather than vacuous.
    const mismatches = board
      .filter((e) => e.player.position === 'TE')
      .filter((e) => ladder.at(e.adp).tierIndex !== find(recs, e.player.id).tierCliff.tierIndex);
    expect(mismatches.length, 'the Sleeper-keyed lookup agrees everywhere, so this test proves nothing').toBeGreaterThan(0);
  });
});

describe('what the tier engine still does', () => {
  it('falls back to Sleeper alone when DOG has not priced him', () => {
    const board = [
      entry('lonely', 'TE', 100, null),
      ...Array.from({ length: 6 }, (_, i) => entry(`te${i}`, 'TE', 104 + i * 4, null)),
    ];
    // No DOG anywhere: the blend collapses to Sleeper and the ladder is the one
    // it always was.
    const recs = rank(board);
    expect(find(recs, 'lonely').tierCliff).toBeTruthy();
    const ladder = buildPositionTierMap('TE', board.map((e) => e.adp!), { picksUntilNext: 15 });
    expect(find(recs, 'lonely').tierCliff.tierIndex).toBe(ladder.at(100).tierIndex);
  });

  it('keeps the best available player in the top tier of his position', () => {
    const board = tightEnds();
    const recs = rank(board, 'best_ball');
    const tes = board.filter((e) => e.player.position === 'TE');
    const best = tes.reduce((a, b) =>
      blendMarketBaseline({ dogAdp: a.dogAdp ?? null, sleeperAdp: a.adp, format: 'best_ball' }).adp! <
      blendMarketBaseline({ dogAdp: b.dogAdp ?? null, sleeperAdp: b.adp, format: 'best_ball' }).adp!
        ? a
        : b,
    );
    expect(find(recs, best.player.id).tierCliff.tierIndex).toBe(0);
  });

  it('gives every player at a position a tier', () => {
    const recs = rank(tightEnds(), 'best_ball');
    for (const rec of recs.filter((r) => r.position === 'TE')) {
      expect(rec.tierCliff.tierIndex, `${rec.playerId} has no tier`).not.toBeNull();
    }
  });

  it('leaves an unpriced player out of the ladder rather than inventing a rung', () => {
    const board = [
      { ...entry('unpriced', 'TE', 0), adp: null } as AvailablePlayerInput,
      ...Array.from({ length: 6 }, (_, i) => entry(`te${i}`, 'TE', 100 + i * 4)),
    ];
    const recs = rank(board);
    const ladder = buildPositionTierMap('TE', board.map((e) => e.adp), { picksUntilNext: 15 });
    // Six rungs, not seven: the unpriced player contributed nothing.
    expect(ladder.ladder).toHaveLength(6);
    expect(find(recs, 'unpriced').tierCliff.tierIndex).toBeNull();
  });
});

describe('scarcity is deliberately still Sleeper’s', () => {
  /*
   * The *measurement* is Sleeper's and does not move. The *weight* can, and
   * that is not a leak: `POSITIONAL_STRUCTURE` caps scarcity, the tier cliff,
   * separation and opportunity jointly, because all four rise together when a
   * position is thin. Tiers now read the blend, so a DOG-only change can shift
   * how much of the shared ceiling scarcity is allowed — which is the cap doing
   * its job, not scarcity learning about DOG.
   */
  it('does not move when only DOG moves', () => {
    const flat = [
      entry('x', 'TE', 100, 100),
      ...Array.from({ length: 8 }, (_, i) => entry(`te${i}`, 'TE', 104 + i * 4, 104 + i * 4)),
    ];
    const dogShifted = flat.map((e) =>
      e.player.position === 'TE' && e.player.id !== 'x' ? entry(e.player.id, 'TE', e.adp!, e.adp! + 60) : e,
    );
    const a = find(rank(flat), 'x').components.find((c) => c.key === 'scarcity')!;
    const b = find(rank(dogShifted), 'x').components.find((c) => c.key === 'scarcity')!;
    // How thin the position is getting *in this room* is a fact about Sleeper's
    // board. A receiver Underdog rates highly is not one more receiver here.
    expect(a.score).toBe(b.score);
    expect(a.display).toBe(b.display);
  });
});
