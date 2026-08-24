/**
 * A defence is worth what *this* league says it is worth, or nothing.
 *
 * The claim under test is a refusal as much as a reading. Every other position
 * in this app is scored from settings that are close to universal, and a wrong
 * guess about one is a rounding error; defences are not like that, and two
 * leagues identical everywhere else can disagree about a shutout by ten points.
 * So there is no "standard DST scoring" to fall back on, and the failure this
 * file exists to prevent is the quiet one: a defence scored correctly on the
 * four categories the model knows and silently missing the fifth the league
 * actually pays for.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDstScoring,
  expectedTierPoints,
  scoresDefences,
  DST_SCORING_UNSUPPORTED,
} from '../src/core/sleeper/dstScoring.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DST_SCORING, DST_SCORING_CUSTOM } from '../src/core/demo/fixtures/dst.ts';

describe('reading a league’s own defence table', () => {
  it('reads every category Sleeper publishes', () => {
    const scoring = buildDstScoring(DST_SCORING);

    expect(scoring.supported).toBe(true);
    expect(scoring.sack).toBe(1);
    expect(scoring.interception).toBe(2);
    expect(scoring.fumbleRecovery).toBe(2);
    expect(scoring.forcedFumble).toBe(1);
    expect(scoring.defensiveTd).toBe(6);
    expect(scoring.specialTeamsTd).toBe(6);
    expect(scoring.safety).toBe(2);
    expect(scoring.blockedKick).toBe(2);
  });

  it('reads the points-allowed bands with Sleeper’s own bounds', () => {
    const { pointsAllowed } = buildDstScoring(DST_SCORING);

    // `pts_allow_1_6` is 1 to 6 inclusive, so a half-open band is [1, 7). Off
    // by one here would move a shutout into the wrong bucket, which is the most
    // valuable band on the table.
    expect(pointsAllowed).toEqual([
      { from: 0, to: 1, points: 10 },
      { from: 1, to: 7, points: 7 },
      { from: 7, to: 14, points: 4 },
      { from: 14, to: 21, points: 1 },
      { from: 21, to: 28, points: 0 },
      { from: 28, to: 35, points: -1 },
      { from: 35, to: Infinity, points: -4 },
    ]);
  });

  it('does not assume a standard table when the league publishes a different one', () => {
    const stingy = buildDstScoring({ ...DST_SCORING, pts_allow_0: 5, sack: 2 });

    expect(stingy.pointsAllowed[0]).toEqual({ from: 0, to: 1, points: 5 });
    expect(stingy.sack).toBe(2);
  });

  it('treats a table nobody scored as no table rather than a table of zeroes', () => {
    const noTiers = { ...DST_SCORING };
    for (const key of Object.keys(noTiers)) if (key.startsWith('pts_allow')) noTiers[key] = 0;

    const scoring = buildDstScoring(noTiers);
    expect(scoring.pointsAllowed).toEqual([]);
    // Yards allowed is still absent in this league, so there is nothing left
    // for the market anchor to reach a defence through — and saying so is the
    // whole job of this flag.
    expect(scoring.anchorSensitive).toBe(false);
  });

  it('is anchor-sensitive when the league scores yards allowed alone', () => {
    const yardsOnly: Record<string, number> = { sack: 1, yds_allow_0_100: 5, yds_allow_550p: -5 };
    const scoring = buildDstScoring(yardsOnly);

    expect(scoring.supported).toBe(true);
    expect(scoring.pointsAllowed).toEqual([]);
    expect(scoring.yardsAllowed.length).toBeGreaterThan(0);
    expect(scoring.anchorSensitive).toBe(true);
  });
});

describe('a league whose defence rules cannot be mapped', () => {
  it('refuses rather than scoring what it recognises and shrugging at the rest', () => {
    const scoring = buildDstScoring(DST_SCORING_CUSTOM);

    expect(scoring.supported).toBe(false);
    expect(scoring.unsupported).toEqual(['def_3_and_out', 'def_forced_punts']);
    // And nothing survives the refusal: a partial table is exactly the "close
    // enough" answer this design exists to prevent.
    expect(scoring.pointsAllowed).toEqual([]);
    expect(scoring.sack).toBe(0);
    expect(scoresDefences(scoring)).toBe(false);
  });

  it('ignores a defence setting the league has switched off', () => {
    // Sleeper writes a league's whole table including the categories it does
    // not use, so refusing on a zero would refuse nearly every league for
    // settings none of them score.
    const scoring = buildDstScoring({ ...DST_SCORING, def_forced_punts: 0, def_3_and_out: 0 });

    expect(scoring.supported).toBe(true);
    expect(scoring.unsupported).toEqual([]);
  });

  it('is not upset by an offensive setting it does not model', () => {
    const scoring = buildDstScoring({ ...DST_SCORING, bonus_rec_te: 0.5, bonus_rush_yd_100: 3 });

    expect(scoring.supported).toBe(true);
  });

  it('is not upset by IDP settings, which score a linebacker rather than the unit', () => {
    // An IDP league's individual-defender scoring changes nothing about what a
    // team defence is worth, and refusing one for it would be a refusal with no
    // reason behind it. IDP itself is out of scope for this lane either way.
    const scoring = buildDstScoring({ ...DST_SCORING, tkl_solo: 1, tkl_ast: 0.5, idp_sack: 2, pass_def: 1 });

    expect(scoring.supported).toBe(true);
    expect(scoring.sack).toBe(1);
  });
});

describe('the profile carries it, so every engine reads one answer', () => {
  it('is built from the same settings blob the rest of the profile is', () => {
    const profile = buildScoringProfile(DST_SCORING as Record<string, number>, ['QB', 'DEF']);

    expect(profile.ppr).toBe(0.5);
    expect(profile.dst.supported).toBe(true);
    expect(profile.dst.sack).toBe(1);
  });

  it('reads a league with no defence settings as one that does not score defences', () => {
    const profile = buildScoringProfile({ rec: 1 }, ['QB', 'WR']);

    // Supported — nothing was unreadable — and empty, which is a real answer
    // about the league rather than a failure to read it.
    expect(profile.dst.supported).toBe(true);
    expect(scoresDefences(profile.dst)).toBe(false);
  });

  it('reads a null settings blob without throwing', () => {
    expect(buildDstScoring(null).supported).toBe(true);
    expect(buildDstScoring(undefined).unsupported).toEqual([]);
  });
});

describe('expectedTierPoints', () => {
  it('is the weighted sum of the bands', () => {
    const tiers = [
      { from: 0, to: 10, points: 8 },
      { from: 10, to: 20, points: 3 },
      { from: 20, to: Infinity, points: -2 },
    ];
    // A distribution that puts everything in the middle band reads that band.
    expect(expectedTierPoints(tiers, (from) => (from === 10 ? 1 : 0))).toBe(3);
    // And an even split across all three is their mean.
    expect(expectedTierPoints(tiers, () => 1 / 3)).toBeCloseTo(3, 6);
  });

  it('is zero over an empty table, which is what a league with no table gets', () => {
    expect(expectedTierPoints([], () => 1)).toBe(0);
    expect(expectedTierPoints(DST_SCORING_UNSUPPORTED.pointsAllowed, () => 1)).toBe(0);
  });
});
