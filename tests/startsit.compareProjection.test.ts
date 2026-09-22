/**
 * The Compare sheet's projection column, and the two things it must not do.
 *
 * ## What this is about
 *
 * On 22 September 2026 the owner photographed a FLEX comparison: Jahmyr Gibbs
 * at 16.7 with a real market number of 12.3, and Trey McBride at 3.9 with
 * `unknown` Vegas, 0% coverage and "no Vegas data for Trey McBride — compared
 * on news and availability only". A probe of production the same morning found
 * 183.7 preseason points stored for McBride under this league's own scoring key
 * — 11.5 a week — and eight of the owner's ten starters carrying no market
 * expectation at all in week 2.
 *
 * The cause was not McBride and was not tight ends. It was that there were
 * three separate projection ladders in the codebase for one question: three
 * tiers inside `core/matchup/build.ts`, two inside `assembleLineup`, and none
 * at all on the `/api/startsit/compare` path. This file holds the fix in place
 * from both ends:
 *
 *   1. the ladder is **one** function, and the third tier is real arithmetic on
 *      a real number rather than a rounding of a guess;
 *   2. supplying a borrowed figure to a comparison **cannot** change what it
 *      recommends, because the ranking does not read it.
 *
 * (2) is the important one, and it is written as a difference that must be
 * empty: run the comparison with the fallbacks and without them, and prove the
 * verdict, the margin and every score are identical. A test that merely checked
 * the projection appeared would pass just as happily on a build that had wired
 * a borrowed number into `compareStartSit`.
 */

import { describe, expect, it } from 'vitest';
import { assembleComparison } from '../src/core/startsit/assemble.ts';
import { compareStartSit, evaluatePlayer } from '../src/core/startsit/engine.ts';
import { weeklyProjection } from '../src/core/startsit/projection.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN']);

/** The screenshot, as a fixture: one player priced, one not, both with news. */
function theScreenshot() {
  return [
    candidate('9221', 'Jahmyr Gibbs', 'RB', 12.3, { signal: signalWithNet(5, 3), team: 'DET' }),
    candidate('8130', 'Trey McBride', 'TE', null, { signal: signalWithNet(2, 2), team: 'ARI' }),
  ];
}

describe('one ladder, three tiers, in order', () => {
  it('takes the market whenever there is one, whatever else is offered', () => {
    const priced = { score: 12.4, expectation: { points: 13.9 } };
    expect(weeklyProjection(priced, 21.4, 320)).toEqual({ points: 13.9, source: 'market' });
  });

  it('takes the published week ahead of the preseason total', () => {
    const unpriced = { score: 1.35, expectation: { points: null } };
    expect(weeklyProjection(unpriced, 8.58, 183.7)).toEqual({ points: 8.58, source: 'sleeper' });
  });

  it('divides the preseason season total by a full season of games', () => {
    const unpriced = { score: 1.35, expectation: { points: null } };
    // McBride's real stored figure, from the StartWho · Aug 30 capture.
    expect(weeklyProjection(unpriced, null, 183.7)).toEqual({
      points: Math.round((183.7 / EXPECTED_GAMES) * 100) / 100,
      source: 'preseason',
    });
    expect(weeklyProjection(unpriced, null, 183.7).points).toBeCloseTo(11.48, 2);
  });

  /*
   * Not by games played, which is the reading that would have shipped: a season
   * total over one game played is a week-one projection of a hundred and eighty
   * points. Sixteen is a fact about the league, not a tuning knob.
   */
  it('is a weekly figure and not a season one', () => {
    const unpriced = { score: 0, expectation: { points: null } };
    const points = weeklyProjection(unpriced, null, 292.5).points ?? 0;
    expect(points).toBeGreaterThan(5);
    expect(points).toBeLessThan(30);
  });

  it('refuses a stored zero rather than relabelling it as a forecast of nothing', () => {
    const unpriced = { score: 0, expectation: { points: null } };
    expect(weeklyProjection(unpriced, null, 0)).toEqual({ points: null, source: null });
    expect(weeklyProjection(unpriced, null, -40)).toEqual({ points: null, source: null });
  });

  it('never separates the number from where it came from', () => {
    const unpriced = { score: 0, expectation: { points: null } };
    for (const args of [
      [unpriced, null, null],
      [unpriced, 8.58, null],
      [unpriced, null, 183.7],
      [{ score: 1, expectation: { points: 9 } }, 8.58, 183.7],
    ] as const) {
      const result = weeklyProjection(args[0], args[1], args[2]);
      expect(result.source == null).toBe(result.points == null);
    }
  });
});

describe('the comparison shows the tier and is not decided by it', () => {
  const profile = HALF_PPR;

  it('prices the unpriced player from the preseason snapshot', () => {
    const comparison = compareStartSit(theScreenshot(), profile);
    const assembled = assembleComparison({
      evaluations: comparison.evaluations,
      preseason: new Map([['8130', 183.7]]),
    });

    const mcbride = assembled.evaluations.find((e) => e.playerId === '8130');
    expect(mcbride?.projectionSource).toBe('preseason');
    expect(mcbride?.projection).toBeCloseTo(11.48, 2);

    const gibbs = assembled.evaluations.find((e) => e.playerId === '9221');
    expect(gibbs?.projectionSource).toBe('market');
    expect(gibbs?.projection).toBeCloseTo(12.3, 1);
  });

  /**
   * The whole point, as a difference that must be empty.
   *
   * McBride's preseason figure (11.48) is above Gibbs' market figure (12.3) on
   * neither reading, but his *score* is far below it — so if the borrowed number
   * were reaching the ranking at all, the margin would move. It does not move,
   * because `compareStartSit` has finished before `assembleComparison` is
   * called and reads nothing it is given.
   */
  it('recommends the same player, by the same margin, with and without the fallbacks', () => {
    const bare = compareStartSit(theScreenshot(), profile);
    const fed = compareStartSit(theScreenshot(), profile);
    const assembled = assembleComparison({
      evaluations: fed.evaluations,
      published: new Map([['8130', 8.58]]),
      preseason: new Map([['8130', 183.7], ['9221', 292.5]]),
    });

    expect(assembled.evaluations.map((e) => e.playerId)).toEqual(bare.evaluations.map((e) => e.playerId));
    expect(fed.recommendedPlayerId).toBe(bare.recommendedPlayerId);
    expect(fed.margin).toBe(bare.margin);
    expect(fed.confidence).toBe(bare.confidence);
    for (const [i, evaluation] of assembled.evaluations.entries()) {
      expect(evaluation.score).toBe(bare.evaluations[i]!.score);
      expect(evaluation.expectation.points).toBe(bare.evaluations[i]!.expectation.points);
    }
  });

  it('is unchanged when there is nothing to fall back to', () => {
    const comparison = compareStartSit(theScreenshot(), profile);
    const assembled = assembleComparison({ evaluations: comparison.evaluations });
    const mcbride = assembled.evaluations.find((e) => e.playerId === '8130');
    expect(mcbride?.projection).toBeNull();
    expect(mcbride?.projectionSource).toBeNull();
  });

  it('names the borrowed tiers under the column rather than per cell', () => {
    const comparison = compareStartSit(theScreenshot(), profile);
    const estimated = assembleComparison({
      evaluations: comparison.evaluations,
      preseason: new Map([['8130', 183.7]]),
    });
    expect(estimated.projectionNotes.join(' ')).toMatch(/preseason/i);
    expect(estimated.projectionNotes.join(' ')).toMatch(/divided by a full season of games/i);

    const borrowed = assembleComparison({
      evaluations: comparison.evaluations,
      published: new Map([['8130', 8.58]]),
    });
    expect(borrowed.projectionNotes.join(' ')).toMatch(/Rotowire/);
  });

  it('says so out loud when nobody has a projection from any source', () => {
    const neither = compareStartSit(
      [
        candidate('a', 'One', 'WR', null, { signal: signalWithNet(1, 1) }),
        candidate('b', 'Two', 'WR', null, { signal: signalWithNet(2, 1) }),
      ],
      profile,
    );
    const assembled = assembleComparison({ evaluations: neither.evaluations });
    expect(assembled.projectionNotes.join(' ')).toMatch(/nobody here has a projection/i);
  });

  /*
   * Only when the fallback is otherwise working, for the reason `notesFor`
   * gives: with nothing borrowed anywhere, "and especially not for your
   * quarterback" answers a question nobody looking at that screen has.
   */
  it('withholds the refusal sentence when nothing was borrowed', () => {
    const comparison = compareStartSit(theScreenshot(), profile);
    const refusal = 'Published projections — the feed assumes 4 points per passing touchdown.';
    expect(assembleComparison({ evaluations: comparison.evaluations, publishedRefusal: refusal }).projectionNotes)
      .not.toContain(refusal);
    expect(
      assembleComparison({
        evaluations: comparison.evaluations,
        published: new Map([['8130', 8.58]]),
        publishedRefusal: refusal,
      }).projectionNotes,
    ).toContain(refusal);
  });
});

describe('the lineup pass stops at tier 2', () => {
  /**
   * The behavioural half of the structural assertion in
   * `sleeperProjectionFallback.test.ts`.
   *
   * A lineup is a recommendation this app makes. A borrowed weekly figure is
   * already ranked there at a discount; an August season total flattened over
   * sixteen games is not a claim about Sunday that a *starting* decision should
   * turn on, so `assembleLineup` calls the ladder with a published figure and
   * nothing else. If that ever changes it should change deliberately, and this
   * is what makes it impossible to change by accident.
   */
  it('produces no projection for a player only the preseason snapshot knows', async () => {
    const { assembleLineup } = await import('../src/core/startsit/assemble.ts');
    const { buildRosterShape } = await import('../src/core/sleeper/scoring.ts');
    const decision = assembleLineup({
      inputs: [candidate('8130', 'Trey McBride', 'TE', null, { signal: signalWithNet(2, 2) })],
      shape: buildRosterShape(['TE', 'BN']),
      profile: HALF_PPR,
      currentStarterIds: [],
      mode: 'balanced',
      // No published figure and no way to pass a preseason one: the argument
      // does not exist on this request, which is the guard.
    });
    const rows = [...decision.starters, ...decision.bench, ...decision.undecidable];
    const mcbride = rows.find((r) => r.playerId === '8130');
    expect(mcbride).toBeDefined();
    expect(mcbride?.projection).toBeNull();
    expect(mcbride?.projectionSource).toBeNull();
  });
});

describe('a component the engine could not read is not a zero', () => {
  /**
   * The arithmetic behind the dash, asserted rather than assumed.
   *
   * The screen used to print a bold `0.00` for every unread factor, and the
   * reason that is safe to replace with `—` is that the engine never summed
   * those numbers: `evaluatePlayer` filters on `unknown` before adding. A probe
   * of production on 22 September 2026 found `sum(known) === sum(all)` for all
   * ten players on the owner's roster, every unknown component sitting at
   * exactly 0. This is that measurement as a test.
   */
  it('excludes unknown components from the score', () => {
    const evaluation = evaluatePlayer(
      candidate('8130', 'Trey McBride', 'TE', null, { signal: signalWithNet(2, 2) }),
      HALF_PPR,
    );

    const known = evaluation.components.filter((c) => !c.unknown);
    const sumKnown = Math.round(known.reduce((a, c) => a + c.value, 0) * 100) / 100;
    expect(evaluation.score).toBe(sumKnown);

    // And there is genuinely something unread to print a dash for.
    const unknown = evaluation.components.filter((c) => c.unknown);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.some((c) => c.key === 'vegas')).toBe(true);

    /*
     * Every unknown component is also numerically zero, which is what made the
     * old display so convincing and is why the fix had to be the *mark* rather
     * than the number. If one ever carries a non-zero value, the grid would be
     * hiding a reading rather than declining to invent one — so this fails
     * loudly rather than quietly changing meaning.
     */
    for (const component of unknown) {
      expect(component.value, `${component.key} is unknown but carries a value`).toBe(0);
    }
  });

  /**
   * The other half, and the reason the grid could not simply hide every zero.
   *
   * `uncertainty` reads 0 for a player with no market at all — there is nothing
   * to be uncertain about, the engine says so in the word `none`, and that is a
   * finding rather than a gap. It is `unknown: false`, it is summed, and it
   * keeps printing `0.00`.
   *
   * `status` is the instructive one, because it is *both*, depending on what
   * was read. Given a resolved injury state it is a computed zero — the
   * production screenshot's `Availability 0.00 · no designation`, which means
   * "checked, and he costs nothing". Given nothing at all, as here, the same
   * component is `unknown` and the grid draws a dash. Same row, two meanings,
   * decided per player and per component rather than per label — which is why
   * the fix had to read the flag the engine already sets instead of pattern-
   * matching on the word "unknown" in a label.
   */
  it('still reports a real computed zero as a zero', () => {
    const unread = evaluatePlayer(
      candidate('8130', 'Trey McBride', 'TE', null, { signal: signalWithNet(2, 2) }),
      HALF_PPR,
    );
    const uncertainty = unread.components.find((c) => c.key === 'uncertainty');
    expect(uncertainty?.unknown).toBe(false);
    expect(uncertainty?.value).toBe(0);
    expect(uncertainty?.display).toBe('none');

    // Nothing was read about his availability, so that one is a dash.
    expect(unread.components.find((c) => c.key === 'status')?.unknown).toBe(true);

    // Read it, and the identical zero becomes a reading again.
    const read = evaluatePlayer(
      candidate('8130', 'Trey McBride', 'TE', null, { signal: signalWithNet(2, 2), status: 'Active' }),
      HALF_PPR,
    );
    const status = read.components.find((c) => c.key === 'status');
    expect(status?.unknown).toBe(false);
    expect(status?.value).toBe(0);
  });
});
