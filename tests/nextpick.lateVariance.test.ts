/**
 * Late in a draft, `Next%` has to stop treating ADP as an appointment time.
 *
 * The board was reporting near-certainty for waits it had no business being
 * certain about: pick 148, a player at ADP 164, and seventeen picks to survive,
 * answered 100%. The audit that found it is
 * `scripts/probe-dog-next-sensitivity.mjs`; the four rows it prints are
 * regression-tested at the bottom of this file.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Not the percentages. The brief is explicit that a number chosen to match a
 * screenshot is worthless, and it is right — a fixture pinned to 92.8% would
 * fail the next time anything about the simulator improved, and would tell
 * nobody anything when it did. What is asserted here is the *shape*: that the
 * same wait is less certain late than early, that a longer wait is less certain
 * than a short one, that early rounds did not move, and that near-certainty has
 * to be earned by a short wait rather than granted by a distant ADP.
 *
 * ## Why the fix is a hazard floor and not a wider spread
 *
 * The obvious repair — widen `adpSpread` as the draft runs on — makes this
 * worse, and `idiosyncraticHazard` carries the measurements showing it. The
 * first test below is the one that pins that down, because it is the mistake
 * anybody re-reading this brief would make first.
 */

import { describe, expect, it } from 'vitest';
import {
  LATE_NOISE,
  adpSpread,
  conditionalMarketSurvival,
  idiosyncraticHazard,
  idiosyncraticSurvival,
} from '../src/core/draft/survival.ts';
import { simulateNextPick, type SimCandidate } from '../src/core/draft/nextpick/simulate.ts';
import { buildPickOwnership } from '../src/core/draft/nextpick/ownership.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** A full board with one subject placed at a known ADP. */
function board(subject: { adp: number; dogAdp?: number | null; position?: string }): SimCandidate[] {
  const out: SimCandidate[] = [];
  for (let i = 0; i < 160; i++) {
    const adp = Math.round((5 + i * 1.6) * 10) / 10;
    out.push({ playerId: `q${i}`, position: POSITIONS[i % POSITIONS.length]!, adp, order: adp });
  }
  out.push({
    playerId: 'subject',
    position: subject.position ?? 'QB',
    adp: subject.adp,
    dogAdp: subject.dogAdp ?? null,
    order: subject.adp,
  });
  return out;
}

/** `Next%` for the subject, on a deterministic board. */
function nextPercent(opts: {
  currentPick: number;
  targetPick: number;
  adp: number;
  dogAdp?: number | null;
}): number {
  const ownership = buildPickOwnership({ teams: 12, rounds: 20, type: 'snake' });
  const rosters = new Map<number, Record<string, number>>();
  for (let slot = 1; slot <= 12; slot++) rosters.set(slot, { QB: 1, RB: 2, WR: 3, TE: 1 });
  const result = simulateNextPick({
    draftId: 'late-variance',
    currentPick: opts.currentPick,
    targetPick: opts.targetPick,
    mySlot: 5,
    ownership,
    shape: SHAPE,
    candidates: board({ adp: opts.adp, dogAdp: opts.dogAdp ?? null }),
    rosters,
    totalPicks: 240,
    simulations: 4000,
  });
  return result.byPlayer.get('subject')!.probability!;
}

describe('the repair that would not have worked', () => {
  it('confirms that widening the spread alone raises late confidence', () => {
    /*
     * The brief asks for a wider distribution late. Measured directly, that
     * moves the number the wrong way for the reported case — a player sitting
     * *before* his ADP faces a per-pick hazard of `1.702·(1−S)/spread`, and
     * widening divides by a larger number than it multiplies by.
     *
     * Kept as a test rather than a comment because it is the reason the fix
     * looks the way it does, and the next person to "simplify" this by widening
     * `adpSpread` should find out here rather than in a draft.
     */
    const survival = (spread: number) => {
      const L = 1.702;
      const z = (p: number) => (L * (164 - p)) / spread;
      const softplus = (x: number) => Math.log(1 + Math.exp(x));
      return Math.exp(softplus(-z(148)) - softplus(-z(153)));
    };
    expect(survival(60)).toBeGreaterThan(survival(adpSpread(164)));
    expect(survival(90)).toBeGreaterThan(survival(60));
    expect(survival(140)).toBeGreaterThan(survival(90));
  });
});

describe('the hazard floor itself', () => {
  it('is nothing at all early', () => {
    expect(idiosyncraticHazard(10)).toBe(0);
    expect(idiosyncraticHazard(LATE_NOISE.onset)).toBe(0);
    expect(idiosyncraticSurvival(idiosyncraticHazard(26), 5)).toBe(1);
  });

  it('rises with draft depth and then stops', () => {
    const depths = [60, 90, 120, 160, 200, 260].map((pick) => idiosyncraticHazard(pick));
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!, `hazard fell between rung ${i - 1} and ${i}`).toBeGreaterThanOrEqual(depths[i - 1]!);
    }
    expect(idiosyncraticHazard(200)).toBeCloseTo(LATE_NOISE.maxHazard, 6);
    // Saturated: a deeper player is no more idiosyncratic than the ceiling.
    expect(idiosyncraticHazard(400)).toBe(idiosyncraticHazard(200));
  });

  it('says nothing about a player the market never priced', () => {
    expect(idiosyncraticHazard(null)).toBe(0);
    expect(idiosyncraticHazard(Number.NaN)).toBe(0);
  });

  it('compounds over the picks actually in the way', () => {
    const h = idiosyncraticHazard(148);
    expect(idiosyncraticSurvival(h, 0)).toBe(1);
    expect(idiosyncraticSurvival(h, 17)).toBeLessThan(idiosyncraticSurvival(h, 5));
    expect(idiosyncraticSurvival(h, 5)).toBeCloseTo(Math.pow(1 - h, 5), 10);
  });
});

describe('DOG is a tail-risk signal and stays one', () => {
  it('lowers confidence when Underdog prices him materially earlier', () => {
    const plain = idiosyncraticHazard(148, { adp: 164 });
    const disagreeing = idiosyncraticHazard(148, { adp: 164, dogAdp: 126 });
    expect(disagreeing).toBeGreaterThan(plain);
  });

  it('caps how far that disagreement can go', () => {
    const wide = idiosyncraticHazard(148, { adp: 164, dogAdp: 4 });
    const atCap = idiosyncraticHazard(148, { adp: 164, dogAdp: 164 - LATE_NOISE.disagreementFull });
    expect(wide).toBeCloseTo(atCap, 10);
  });

  it('ignores Underdog rating him later, which is not early-selection risk', () => {
    expect(idiosyncraticHazard(148, { adp: 164, dogAdp: 200 })).toBe(idiosyncraticHazard(148, { adp: 164 }));
  });

  it('cannot act at all where the market still explains the room', () => {
    /*
     * The structural guarantee, and the reason the term is a gain rather than a
     * hazard of its own: it multiplies a base that is zero for the whole early
     * board, so however far the two markets disagree, DOG opens no tail that
     * draft depth has not already opened.
     *
     * This is what "secondary" is asserted as, rather than a comparison of
     * sensitivities. Deep in a draft the simulator's own Sleeper sensitivity is
     * very low — every remaining candidate is saturated in `marketPickWeight`,
     * which is much of why the late estimate was overconfident to begin with —
     * so "a Sleeper shift moves it further" is not a property that holds in the
     * regime this file is about. Bounding DOG structurally does hold, at every
     * depth, and is the stronger claim.
     */
    for (const pick of [10, 40, LATE_NOISE.onset]) {
      expect(idiosyncraticHazard(pick, { adp: 120, dogAdp: 60 })).toBe(0);
    }
  });

  it('widens the tail by at most half again, however far the two markets differ', () => {
    const plain = idiosyncraticHazard(148, { adp: 164 });
    const absurd = idiosyncraticHazard(148, { adp: 164, dogAdp: 1 });
    // Tolerance is the 4-decimal quantisation the hazard is rounded to, not slack.
    expect(absurd).toBeLessThanOrEqual(plain * (1 + LATE_NOISE.disagreementGain) + 5e-5);
    expect(absurd).toBeGreaterThan(plain);
  });

  it('moves the simulated Next% in the direction that means danger', () => {
    const base = nextPercent({ currentPick: 148, targetPick: 160, adp: 164 });
    const dogEarlier = nextPercent({ currentPick: 148, targetPick: 160, adp: 164, dogAdp: 124 });
    expect(dogEarlier).toBeLessThan(base);
  });

  it('does not break when Underdog has not priced him', () => {
    const withNull = nextPercent({ currentPick: 148, targetPick: 160, adp: 164, dogAdp: null });
    const without = nextPercent({ currentPick: 148, targetPick: 160, adp: 164 });
    expect(withNull).toBe(without);
    expect(Number.isFinite(withNull)).toBe(true);
  });
});

describe('the calibration property', () => {
  it('is less certain about the same wait late than early', () => {
    // Sixteen picks of ADP cushion and a five-pick wait, at both ends of the
    // draft. Late must be the less confident of the two.
    const early = nextPercent({ currentPick: 10, targetPick: 15, adp: 26 });
    const late = nextPercent({ currentPick: 148, targetPick: 153, adp: 164 });
    expect(late).toBeLessThan(early);
  });

  it('leaves the early rounds where they were', () => {
    // The floor is zero below its onset, so nothing about round one moves.
    const early = nextPercent({ currentPick: 10, targetPick: 15, adp: 26 });
    expect(early).toBeGreaterThan(0.9);
  });

  it('is less certain about a longer wait than a short one', () => {
    const short = nextPercent({ currentPick: 148, targetPick: 153, adp: 164 });
    const long = nextPercent({ currentPick: 148, targetPick: 165, adp: 164 });
    expect(long).toBeLessThan(short);
  });

  it('still allows near-certainty when only a couple of picks intervene', () => {
    // The ceiling has to emerge from the evidence rather than be imposed: two
    // picks away from a player nobody is near taking is genuinely safe.
    const adjacent = nextPercent({ currentPick: 148, targetPick: 151, adp: 210 });
    expect(adjacent).toBeGreaterThan(0.85);
  });

  it('does not hand out near-certainty for a long late wait', () => {
    const long = nextPercent({ currentPick: 148, targetPick: 165, adp: 164 });
    expect(long).toBeLessThan(0.9);
  });

  it('responds to the number of intervening picks, not only to ADP distance', () => {
    const three = nextPercent({ currentPick: 148, targetPick: 151, adp: 164 });
    const nine = nextPercent({ currentPick: 148, targetPick: 157, adp: 164 });
    const seventeen = nextPercent({ currentPick: 148, targetPick: 165, adp: 164 });
    expect(nine).toBeLessThan(three);
    expect(seventeen).toBeLessThan(nine);
  });
});

describe('the four audited cases', () => {
  /*
   * The rows the probe printed before the fix, all four of which are quoted in
   * the brief. Asserted as properties rather than as percentages: what matters
   * is that the three late rows stopped being certainties and the early row did
   * not move.
   */
  it('no longer reports a five-pick late wait as a certainty', () => {
    const p = nextPercent({ currentPick: 148, targetPick: 153, adp: 164 });
    expect(p).toBeLessThan(1);
    expect(p).toBeGreaterThan(0.5);
  });

  it('no longer reports a seventeen-pick late wait as a certainty', () => {
    const p = nextPercent({ currentPick: 148, targetPick: 165, adp: 164 });
    expect(p).toBeLessThan(0.9);
  });

  it('keeps a three-pick wait on a very deep player confident', () => {
    const p = nextPercent({ currentPick: 148, targetPick: 151, adp: 210 });
    expect(p).toBeGreaterThan(0.85);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('leaves the early-round case alone', () => {
    const p = nextPercent({ currentPick: 10, targetPick: 15, adp: 26 });
    expect(p).toBeGreaterThan(0.9);
    expect(p).toBeLessThan(1);
  });
});

describe('what the floor must not touch', () => {
  it('is deterministic, so the same board answers the same twice', () => {
    const a = nextPercent({ currentPick: 148, targetPick: 160, adp: 164 });
    const b = nextPercent({ currentPick: 148, targetPick: 160, adp: 164 });
    expect(a).toBe(b);
  });

  it('keeps the market diagnostic in step with the same hazard', () => {
    // `conditionalMarketSurvival` is the pure-market answer the board shows for
    // inspection. It has to carry the same floor, or the two numbers beside
    // each other would disagree about the same draft.
    const withFloor = conditionalMarketSurvival(164, 148, 165);
    const ordered = (() => {
      const L = 1.702;
      const spread = adpSpread(164);
      const z = (p: number) => (L * (164 - p)) / spread;
      const softplus = (x: number) => Math.log(1 + Math.exp(x));
      return Math.exp(softplus(-z(148)) - softplus(-z(165)));
    })();
    expect(withFloor).toBeLessThan(ordered);
    expect(withFloor).toBeCloseTo(
      ordered * idiosyncraticSurvival(idiosyncraticHazard(148, { adp: 164 }), 17),
      6,
    );
  });

  it('leaves a probability in [0, 1]', () => {
    for (const adp of [5, 60, 164, 210, 400]) {
      for (const wait of [1, 5, 40]) {
        const p = conditionalMarketSurvival(adp, 100, 100 + wait);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});
