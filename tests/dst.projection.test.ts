/**
 * The defence model: one anchor, bounded residuals, and unknown when unknown.
 *
 * Three claims are load-bearing and each has a failure behind it that would not
 * look like a failure on a screen:
 *
 *  1. **the curve is monotone in the opponent's implied total.** A defence
 *     facing an offence the market expects to score 17 must never project below
 *     one facing an offence expected to score 27. A model that is not monotone
 *     here is one that has stopped being about football, and it would look
 *     entirely plausible doing it — a handful of defences in the wrong order on
 *     a list nobody can check.
 *  2. **the anchor is the only mean.** Every other term is capped, and the
 *     things the market already knows — the total, the pace, the quality of the
 *     unit — are not paid for a second time. The failure is a projection that
 *     drifts steadily high because one fact was counted twice.
 *  3. **no market, no number.** Not a floor, not a league average, not zero.
 *     The same rule `projection.ts` was written for, on the position most
 *     likely to break it.
 */

import { describe, expect, it } from 'vitest';
import {
  DST_BASELINES,
  DST_CAPS,
  bandProbability,
  expectedYardsAllowed,
  projectDst,
  tierFor,
} from '../src/core/startsit/dstProjection.ts';
import { buildDstScoring } from '../src/core/sleeper/dstScoring.ts';
import { DST_SCORING, DST_SCORING_CUSTOM } from '../src/core/demo/fixtures/dst.ts';

const SCORING = buildDstScoring(DST_SCORING);

/** A defence in a game with a stated total and its own team's spread. */
function project(spread: number, total: number, extra = {}) {
  return projectDst({ game: { spread, total, opponent: 'OPP' }, scoring: SCORING, ...extra });
}

describe('the anchor is the opponent’s implied team total', () => {
  it('reads the spread from this defence’s own team, not from a column', () => {
    // Favoured by 7 in a 44-point game: this team is implied 25.5 and the
    // offence across the field 18.5. Getting the sign backwards would rank the
    // whole slate in reverse and look completely plausible doing it.
    expect(project(-7, 44).opponentImpliedTotal).toBe(18.5);
    expect(project(7, 44).opponentImpliedTotal).toBe(25.5);
    expect(project(0, 44).opponentImpliedTotal).toBe(22);
  });

  it('matches the convention gameScript.ts states for the same field', () => {
    /*
     * `gameScript.ts` computes the *player's own* team total as
     * total/2 − spread/2, so the other side is total/2 + spread/2. One
     * arithmetic, checked here so the two modules cannot drift apart — swept
     * across a slate's worth of lines rather than asserted on one, because a
     * sign error survives a single example far too easily.
     *
     * Compared at one decimal because both modules publish an implied total
     * rounded to one: a team total of 21.75 is a number nobody quotes, and the
     * rounding is what makes the figure on a card and the figure in a test the
     * same figure.
     */
    for (const total of [38, 41.5, 44, 47, 52.5]) {
      for (const spread of [-13.5, -7, -3.5, 0, 3.5, 7, 13.5]) {
        const ownTeam = total / 2 - spread / 2;
        expect(project(spread, total).opponentImpliedTotal).toBeCloseTo(
          Math.round((total - ownTeam) * 10) / 10,
          6,
        );
      }
    }
  });
});

describe('the curve is monotone and saturating', () => {
  it('never rises as the opponent’s implied total rises', () => {
    /*
     * Swept across every implied total a real slate produces, at a fixed
     * spread, so the only thing moving is the anchor. Strictly decreasing
     * rather than merely non-increasing: with a real points-allowed table
     * behind it, every extra point the opponent is expected to score is worth
     * something to a defence, and a flat stretch would mean a band boundary had
     * swallowed a range of games.
     */
    let previous = Infinity;
    for (let total = 32; total <= 60; total += 0.5) {
      const points = project(0, total).points;
      expect(points).not.toBeNull();
      expect(points!).toBeLessThan(previous);
      previous = points!;
    }
  });

  it('is monotone in the spread too, once the anchor moves with it', () => {
    // Holding the total fixed and sweeping the spread moves the anchor and the
    // game-script residual together. The residual is capped well below what the
    // anchor is worth, so the order must still be the anchor's.
    let previous = -Infinity;
    for (let spread = 14; spread >= -14; spread -= 0.5) {
      const points = project(spread, 45).points;
      expect(points!).toBeGreaterThan(previous);
      previous = points!;
    }
  });

  it('saturates rather than running away at the extremes', () => {
    // A 20-point favourite is not twice the defence a 10-point favourite is.
    // The distance between the two must be smaller than the distance between
    // pick'em and a 10-point favourite, which is what "saturating" means.
    const neutral = project(0, 45).points!;
    const ten = project(-10, 45).points!;
    const twenty = project(-20, 45).points!;
    expect(twenty - ten).toBeLessThan(ten - neutral);
  });

  it('prices a good spot above a bad one by an amount worth acting on', () => {
    const good = project(-9.5, 41.5).points!;
    const bad = project(9.5, 41.5).points!;
    expect(good - bad).toBeGreaterThan(2);
  });
});

describe('nothing is counted twice', () => {
  it('does not add the game total as a second full-strength input', () => {
    /*
     * Two games with the same opponent implied total, reached differently: a
     * 40-point game with a 4-point favourite, and a 50-point game with a
     * 14-point favourite. Both imply 18 against. The projections may differ by
     * the game-script residual and by nothing else — if the total were a second
     * input, the second would be materially lower.
     */
    const a = project(-4, 40);
    const b = project(-14, 50);
    expect(a.opponentImpliedTotal).toBe(b.opponentImpliedTotal);
    const scriptGap = Math.abs(
      (a.components.find((c) => c.key === 'game_script')?.points ?? 0) -
        (b.components.find((c) => c.key === 'game_script')?.points ?? 0),
    );
    expect(Math.abs(a.points! - b.points!)).toBeCloseTo(scriptGap, 6);
  });

  it('keeps the game-script residual inside its cap', () => {
    for (const spread of [-24, -14, -7, 0, 7, 14, 24]) {
      const script = project(spread, 45).components.find((c) => c.key === 'game_script');
      expect(Math.abs(script?.points ?? 0)).toBeLessThanOrEqual(DST_CAPS.gameScript + 1e-9);
    }
  });

  it('prices sacks and takeaways on a league baseline, not on this defence', () => {
    /*
     * The categories that make a defence's points are in the number — a league
     * paying 2 a sack must project higher than one paying nothing — but they
     * are the *same* for every defence, so they set the scale rather than the
     * order. Two very different games must carry identical sack lines.
     */
    const great = project(-10, 40);
    const awful = project(10, 52);
    const sacksOf = (p: typeof great) => p.components.find((c) => c.key === 'sacks')!.points;
    expect(sacksOf(great)).toBe(sacksOf(awful));
    expect(sacksOf(great)).toBeCloseTo(DST_BASELINES.sacks * SCORING.sack, 6);
  });

  it('raises the whole scale when the league pays more per sack, and reorders nothing', () => {
    const richer = buildDstScoring({ ...DST_SCORING, sack: 3 });
    const base = project(-7, 44).points!;
    const paid = projectDst({ game: { spread: -7, total: 44 }, scoring: richer }).points!;
    expect(paid).toBeGreaterThan(base);
    expect(paid - base).toBeCloseTo(DST_BASELINES.sacks * 2, 6);
  });

  it('is the exact sum of its components, so the card is the arithmetic', () => {
    const projection = project(-6.5, 43);
    const summed = projection.components.reduce((a, c) => a + c.points, 0);
    expect(projection.points!).toBeCloseTo(summed, 6);
  });
});

describe('the quarterback residual', () => {
  const line = '2026-09-10T12:00:00.000Z';

  it('is zero when the news is older than the line', () => {
    // The market published *after* the announcement, so it has already priced
    // it. This is the double count the model is most likely to commit.
    const projection = project(-6, 44, {
      lineAsOf: line,
      opponentQuarterback: { starterOut: true, observedAt: '2026-09-09T12:00:00.000Z' },
    });

    expect(projection.components.find((c) => c.key === 'opponent_qb')).toBeUndefined();
    expect(projection.reasons.join(' ')).toContain('already priced');
    expect(projection.points).toBe(project(-6, 44).points);
  });

  it('applies, capped, when the news is newer than the line', () => {
    const projection = project(-6, 44, {
      lineAsOf: line,
      opponentQuarterback: { starterOut: true, observedAt: '2026-09-11T12:00:00.000Z' },
    });

    const qb = projection.components.find((c) => c.key === 'opponent_qb');
    expect(qb?.points).toBe(DST_CAPS.quarterback);
    expect(projection.points!).toBeCloseTo(project(-6, 44).points! + DST_CAPS.quarterback, 6);
  });

  it('is zero when either side cannot be dated', () => {
    const undated = project(-6, 44, {
      lineAsOf: null,
      opponentQuarterback: { starterOut: true, observedAt: '2026-09-11T12:00:00.000Z' },
    });

    expect(undated.components.find((c) => c.key === 'opponent_qb')).toBeUndefined();
    expect(undated.reasons.join(' ')).toContain('cannot be dated');
  });

  it('is zero when the starter is playing', () => {
    const healthy = project(-6, 44, {
      lineAsOf: line,
      opponentQuarterback: { starterOut: false, observedAt: '2026-09-11T12:00:00.000Z' },
    });
    expect(healthy.points).toBe(project(-6, 44).points);
  });
});

describe('home and road', () => {
  it('is bounded and tiny, and absent when the schedule is unknown', () => {
    expect(project(-3, 45).components.find((c) => c.key === 'home_field')).toBeUndefined();

    const home = project(-3, 45, { home: true }).points!;
    const road = project(-3, 45, { home: false }).points!;
    expect(home - road).toBeCloseTo(DST_CAPS.homeField * 2, 6);
    expect(DST_CAPS.homeField).toBeLessThanOrEqual(0.3);
  });
});

describe('unknown stays unknown', () => {
  it('has no number without a total', () => {
    const projection = projectDst({ game: { spread: -6, total: null }, scoring: SCORING });
    expect(projection.points).toBeNull();
    expect(projection.opponentImpliedTotal).toBeNull();
    expect(projection.reasons.join(' ')).toContain('no game total');
  });

  it('has no number without a spread, because half an anchor is a different number', () => {
    const projection = projectDst({ game: { spread: null, total: 45 }, scoring: SCORING });
    expect(projection.points).toBeNull();
    expect(projection.reasons.join(' ')).toContain('which side of the total');
  });

  it('has no number with no game at all', () => {
    expect(projectDst({ game: null, scoring: SCORING }).points).toBeNull();
  });

  it('never falls back to a league-average defence', () => {
    // The only way to fail this is to invent a default, so it is asserted as
    // the absence of any number rather than as a particular one.
    for (const game of [null, { spread: null, total: null }, { spread: -3, total: null }]) {
      expect(projectDst({ game, scoring: SCORING }).points).toBeNull();
    }
  });

  it('has no number in a league whose defence rules could not be read', () => {
    const projection = projectDst({
      game: { spread: -9, total: 41 },
      scoring: buildDstScoring(DST_SCORING_CUSTOM),
    });

    expect(projection.points).toBeNull();
    expect(projection.reasons.join(' ')).toContain('cannot map');
  });

  it('has no number in a league that does not score defences', () => {
    const projection = projectDst({ game: { spread: -9, total: 41 }, scoring: buildDstScoring({ rec: 1 }) });

    expect(projection.points).toBeNull();
    expect(projection.reasons.join(' ')).toContain('does not score defences');
  });
});

describe('confidence says how much is actually known', () => {
  it('is high on a full table with a live line', () => {
    expect(project(-7, 44).confidence).toBe('high');
  });

  it('degrades when the market has nothing to separate defences through', () => {
    const eventsOnly = buildDstScoring({ sack: 1, int: 2, def_td: 6 });
    const projection = projectDst({ game: { spread: -7, total: 44 }, scoring: eventsOnly });

    // Still a number — it is the honest conversion of this league's rules — and
    // one the market can barely move, which is what a confidence field exists
    // to say. "Barely" rather than "not at all": a defence whose opponent has
    // to throw really does get more sacks, and this league pays for those, so
    // the capped game-script residual is the only thing separating two
    // defences here. The anchor itself reaches them through nothing.
    expect(projection.points).not.toBeNull();
    expect(projection.confidence).toBe('low');
    expect(projection.reasons.join(' ')).toContain('capped game-script residual');

    const underdog = projectDst({ game: { spread: 7, total: 44 }, scoring: eventsOnly }).points!;
    expect(Math.abs(projection.points! - underdog)).toBeLessThanOrEqual(2 * DST_CAPS.gameScript + 1e-9);

    // And with the spread held fixed, the anchor moves the total by nothing at
    // all: there is no band table for it to reach.
    const bigGame = projectDst({ game: { spread: -7, total: 58 }, scoring: eventsOnly }).points!;
    expect(bigGame).toBe(projection.points);
  });

  it('degrades when a league scores yards allowed but not points allowed', () => {
    const yardsOnly = buildDstScoring({ sack: 1, yds_allow_0_100: 8, yds_allow_550p: -4 });
    const projection = projectDst({ game: { spread: -7, total: 44 }, scoring: yardsOnly });

    expect(projection.confidence).toBe('medium');
    expect(projection.reasons.join(' ')).toContain('yards allowed');
  });
});

describe('the pieces the curve is built from', () => {
  it('bandProbability tiles without gaps or overlap', () => {
    const bands = [
      [0, 1],
      [1, 7],
      [7, 14],
      [14, 21],
      [21, 28],
      [28, 35],
      [35, Infinity],
    ] as const;
    const total = bands.reduce((a, [from, to]) => a + bandProbability(from, to, 22, 9.6), 0);
    // The tail below zero is the only mass unaccounted for, and a team cannot
    // score negative points — so this is just under one by that amount.
    expect(total).toBeGreaterThan(0.97);
    expect(total).toBeLessThanOrEqual(1);
  });

  it('bandProbability is monotone in the mean, which is what makes the curve monotone', () => {
    let previous = Infinity;
    for (let mean = 10; mean <= 40; mean += 1) {
      const shutoutish = bandProbability(0, 7, mean, 9.6);
      expect(shutoutish).toBeLessThan(previous);
      previous = shutoutish;
    }
  });

  it('expectedYardsAllowed rises with the implied total and stays inside football', () => {
    expect(expectedYardsAllowed(10)).toBeLessThan(expectedYardsAllowed(30));
    expect(expectedYardsAllowed(-50)).toBeGreaterThanOrEqual(120);
    expect(expectedYardsAllowed(200)).toBeLessThanOrEqual(600);
  });

  it('tierFor finds the band a number falls in, on the half-open bounds', () => {
    const tiers = SCORING.pointsAllowed;
    expect(tierFor(tiers, 0)?.points).toBe(10);
    expect(tierFor(tiers, 1)?.points).toBe(7);
    expect(tierFor(tiers, 6)?.points).toBe(7);
    expect(tierFor(tiers, 7)?.points).toBe(4);
    expect(tierFor(tiers, 99)?.points).toBe(-4);
  });
});

/**
 * Home and road, which was written and dormant until the fixture list arrived.
 *
 * The foundation lane built the term and left it at zero, because the only
 * schedule this app held was the one that fell out of the betting data, and
 * `vegas_events.home_team` means "a team we asked about" rather than "the home
 * side" — reading it as home field would have been the same vocabulary trap
 * that had every stored spread pointing the wrong way. `nfl_schedule` carries
 * the real flag, so the term is now supplied from there.
 *
 * What matters is that it stayed tiny. It is allowed to break a tie between two
 * defences and must never decide one.
 */
describe('the home-field residual, now that there is a schedule to read it from', () => {
  it('is worth more at home than on the road, and by less than a point either way', () => {
    const at = project(-3, 44, { home: true }).points!;
    const away = project(-3, 44, { home: false }).points!;

    expect(at).toBeGreaterThan(away);
    expect(at - away).toBeCloseTo(2 * DST_CAPS.homeField, 5);
    expect(DST_CAPS.homeField).toBeLessThan(0.5);
  });

  it('is absent rather than zero when the fixture list has not been read', () => {
    const unknown = project(-3, 44);

    expect(unknown.components.some((c) => c.key === 'home_field')).toBe(false);
  });

  it('never reorders two defences the anchor separates', () => {
    /*
     * The claim the cap exists for. A defence facing an offence implied three
     * points lower is ahead on the anchor by far more than the whole home-field
     * term, so the worse matchup cannot overtake it by playing at home.
     */
    const softRoad = project(0, 34, { home: false }).points!;
    const hardHome = project(0, 40, { home: true }).points!;

    expect(softRoad).toBeGreaterThan(hardHome);
  });
});
