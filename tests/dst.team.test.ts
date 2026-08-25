/**
 * The phantom DEF slot, and the two things it broke on the Team screen.
 *
 * The reported symptom was a warning: `no scorable player available for: DEF`,
 * on a roster that held a defence, in a league that starts one. Underneath it
 * was a second and worse one — a current-lineup total of `—`, because the total
 * is only shown when every current starter could be scored and the defence
 * never could.
 *
 * Both had the same cause and it was not on the Team screen: `evaluatePlayer`
 * had no model for a defence, so it returned `score: null`, so the optimiser
 * put the defence on the undecidable list and left the slot empty. That is
 * exactly the behaviour a player with no data is supposed to get — the defect
 * was that a defence *always* had no data.
 *
 * So the fix is in the engine and the assertions are through `recommendLineup`,
 * which is what the Team screen actually calls. A Team-only special case would
 * have cleared the warning and left the Matchup screen, the trade engine and
 * the waiver scan each holding their own idea of what a defence is worth.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { recommendWaiverUpgrades } from '../src/core/startsit/waivers.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { marketProjection, weeklyProjection } from '../src/core/startsit/projection.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, defence } from './helpers/startsit.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING, DST_SCORING_CUSTOM } from '../src/core/demo/fixtures/dst.ts';

const SHAPE = buildRosterShape(DST_ROSTER_POSITIONS);
const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);
/** The same league, except its defence rules cannot be read. */
const CUSTOM = buildScoringProfile(DST_SCORING_CUSTOM as Record<string, number>, DST_ROSTER_POSITIONS);

/** A full lineup of skill players, so the only variable is the defence. */
function field() {
  return [
    candidate('qb1', 'Quarterback One', 'QB', 19),
    candidate('rb1', 'Back One', 'RB', 15),
    candidate('rb2', 'Back Two', 'RB', 12),
    candidate('wr1', 'Receiver One', 'WR', 16),
    candidate('wr2', 'Receiver Two', 'WR', 13),
    candidate('wr3', 'Receiver Three', 'WR', 11),
    candidate('te1', 'Tight End One', 'TE', 9),
    candidate('fx1', 'Flex One', 'WR', 10),
  ];
}

const STARTERS = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'fx1'];

describe('a rostered, scorable defence is a lineup slot like any other', () => {
  const inputs = [...field(), defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5, opponent: 'CAR' }, { team: 'JAX' })];

  it('no longer warns that nothing can fill DEF', () => {
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: [...STARTERS, 'def1'] });

    expect(lineup.warnings.join(' ')).not.toContain('no scorable player available');
    expect(lineup.undecidable.map((e) => e.playerId)).not.toContain('def1');
  });

  it('puts it in the DEF slot rather than leaving the slot empty', () => {
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: [...STARTERS, 'def1'] });
    const slot = lineup.slots.find((s) => s.slot === 'DEF');

    expect(slot?.playerId).toBe('def1');
    expect(slot?.score).not.toBeNull();
    expect(lineup.slots.filter((s) => s.playerId == null)).toEqual([]);
  });

  it('does not null the current total merely because a defence is in it', () => {
    // The second half of the defect, and the one nobody reported: the current
    // total is only shown when every current starter could be scored, so an
    // unscorable defence blanked the comparison the whole screen is built on.
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: [...STARTERS, 'def1'] });

    expect(lineup.currentPoints).not.toBeNull();
    expect(lineup.currentPoints!).toBeGreaterThan(0);
  });

  it('publishes a projection for it, from this app’s own model', () => {
    const evaluation = evaluatePlayer(
      defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5 }, { team: 'JAX' }),
      PROFILE,
    );

    // `marketProjection` is the one function allowed to publish a number under
    // the word "projected", and it finds a defence's anchor exactly where it
    // finds a receiver's — so nothing about this position needed a second rule.
    expect(marketProjection(evaluation)).not.toBeNull();
    expect(weeklyProjection(evaluation).source).toBe('market');
  });

  it('carries the defence model’s working on the evaluation, for the card', () => {
    const evaluation = evaluatePlayer(
      defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5 }, { team: 'JAX' }),
      PROFILE,
    );

    expect(evaluation.dst?.opponentImpliedTotal).toBe(17.5);
    expect(evaluation.dst?.components.map((c) => c.key)).toContain('points_allowed');
    expect(evaluation.drivers.join(' ')).toContain('implied against');
  });

  it('ranks a good spot above a bad one', () => {
    const good = evaluatePlayer(defence('good', 'Good', { spread: -9.5, total: 41.5 }), PROFILE);
    const bad = evaluatePlayer(defence('bad', 'Bad', { spread: 9.5, total: 41.5 }), PROFILE);

    expect(good.score!).toBeGreaterThan(bad.score!);
  });
});

describe('a degraded defence stays honestly degraded', () => {
  it('is undecidable rather than benched when nobody has priced its game', () => {
    const inputs = [...field(), defence('def1', 'Tennessee', null, { team: 'TEN' })];
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: STARTERS });

    // Unknown stays unknown: the slot is empty and says so, which is the same
    // answer any unscorable player gets and is not the defect above — that one
    // was a defence with a game, a line and a league that scores it.
    expect(lineup.undecidable.map((e) => e.playerId)).toContain('def1');
    expect(lineup.warnings.join(' ')).toContain('no scorable player available for: DEF');
  });

  it('never invents a number for a league whose defence rules cannot be read', () => {
    const evaluation = evaluatePlayer(
      defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5 }, { team: 'JAX' }),
      CUSTOM,
    );

    expect(evaluation.score).toBeNull();
    expect(marketProjection(evaluation)).toBeNull();
    expect(evaluation.confidenceReasons.join(' ')).toContain('cannot map');
  });

  it('does not let an unpriced defence rank as though it were merely bad', () => {
    /*
     * The specific failure `projection.ts` was written about, on the position
     * most likely to commit it. With the anchor gone the only components left
     * are an availability charge and an uncertainty penalty, whose sum is a
     * small number — and a small number sorts above nothing and reads as a
     * judgement. Null is the only honest answer.
     */
    const unpriced = evaluatePlayer(defence('def1', 'Tennessee', null), PROFILE);
    expect(unpriced.score).toBeNull();
    expect(unpriced.confidence).toBe('low');
  });

  it('is left out of the lineup rather than assumed bad when it is out', () => {
    const inputs = [
      ...field(),
      defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5 }, { status: 'Out' }),
    ];
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: STARTERS });

    expect(lineup.slots.find((s) => s.slot === 'DEF')?.playerId).toBeNull();
  });
});

describe('a league with no DEF slot has no defence behaviour', () => {
  it('does not draw a slot the league does not start', () => {
    const noDefence = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);
    const lineup = recommendLineup(
      [...field(), defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5 })],
      noDefence,
      PROFILE,
      { currentStarterIds: STARTERS },
    );

    expect(lineup.slots.some((s) => s.slot === 'DEF')).toBe(false);
    expect(lineup.warnings.join(' ')).not.toContain('DEF');
  });
});

describe('the skill-position path is untouched', () => {
  it('scores a receiver identically whether or not a defence is beside him', () => {
    const alone = evaluatePlayer(candidate('wr1', 'Receiver One', 'WR', 16), PROFILE);
    const beside = evaluatePlayer(candidate('wr1', 'Receiver One', 'WR', 16), PROFILE);

    // The defence branch is the first line of `evaluatePlayer`, so a receiver
    // never runs a line of it — asserted as a whole-object comparison rather
    // than on the score, because a component, a driver or a confidence reason
    // moving would be the same regression wearing a different hat.
    expect(beside).toEqual(alone);
    expect(beside.dst).toBeUndefined();
  });

  it('does not give a receiver a defence’s anchor', () => {
    const receiver = evaluatePlayer(
      { ...candidate('wr1', 'Receiver One', 'WR', 16), game: { spread: -7.5, total: 42.5, opponent: 'CAR' } },
      PROFILE,
    );

    expect(receiver.dst).toBeUndefined();
    // He gets the ordinary game-script component, which is capped against the
    // market's own number exactly as it was before this lane.
    expect(receiver.components.find((c) => c.key === 'game_script')?.unknown).toBe(false);
  });
});

describe('the wire can fill an empty DEF slot, and cannot yet stream one', () => {
  const wire = [
    defence('free1', 'Kansas City', { spread: -9.5, total: 41.5 }, { team: 'KC' }),
    defence('free2', 'Baltimore', { spread: -6.5, total: 43 }, { team: 'BAL' }),
  ];

  function scan(roster: ReturnType<typeof field>) {
    return recommendWaiverUpgrades({
      roster,
      candidates: wire,
      shape: SHAPE,
      profile: PROFILE,
      rosteredPlayerIds: roster.map((r) => r.player.id),
    });
  }

  it('offers a defence for a slot that has nobody in it', () => {
    // The ordinary answer to an ordinary hole: a reader who owns no defence in
    // a league that starts one should be told, in the same words a reader
    // missing a tight end is told.
    const advice = scan(field());
    const forDefence = advice.upgrades.filter((s) => s.slot === 'DEF');

    expect(forDefence).toHaveLength(1);
    expect(forDefence[0]?.need).toBe('unfilled');
    expect(forDefence[0]?.candidates[0]?.playerId).toBe('free1');
  });

  it('does not offer to swap a rostered defence for a better one', () => {
    /*
     * The scope line, and it is deliberate rather than a limitation of the
     * model. Swapping one rostered defence for a better one every week is
     * streaming, it arrives free the moment defences are scorable — the gap
     * across a slate is comfortably over the upgrade bar — and it is the next
     * lane's product, not this one's. `assessStreaming` exists and is
     * deliberately not wired in.
     */
    const held = [...field(), defence('mine', 'Cleveland', { spread: 6.5, total: 43 }, { team: 'CLE' })];
    const advice = recommendWaiverUpgrades({
      roster: held,
      candidates: wire,
      shape: SHAPE,
      profile: PROFILE,
      rosteredPlayerIds: held.map((r) => r.player.id),
    });

    // The upgrade is real and is large — this is not passing because the
    // numbers happen to be close.
    const mine = evaluatePlayer(held.at(-1)!, PROFILE).score!;
    const best = evaluatePlayer(wire[0]!, PROFILE).score!;
    expect(best - mine).toBeGreaterThan(2.5);

    expect(advice.upgrades.some((s) => s.slot === 'DEF')).toBe(false);
  });

  it('still offers upgrades at every other position', () => {
    const thin = [
      candidate('qb1', 'Quarterback One', 'QB', 19),
      candidate('rb1', 'Back One', 'RB', 15),
      candidate('rb2', 'Back Two', 'RB', 3),
      candidate('wr1', 'Receiver One', 'WR', 16),
      candidate('wr2', 'Receiver Two', 'WR', 13),
      candidate('wr3', 'Receiver Three', 'WR', 11),
      candidate('te1', 'Tight End One', 'TE', 9),
      candidate('fx1', 'Flex One', 'WR', 10),
    ];
    const advice = recommendWaiverUpgrades({
      roster: thin,
      candidates: [candidate('freeRb', 'Free Back', 'RB', 14)],
      shape: SHAPE,
      profile: PROFILE,
      rosteredPlayerIds: thin.map((r) => r.player.id),
    });

    expect(advice.upgrades.some((s) => s.candidates.some((c) => c.playerId === 'freeRb'))).toBe(true);
  });
});

/**
 * The regressions this lane could plausibly have caused, asserted rather than
 * assumed.
 *
 * `home` was added to `StartSitInput` for one term in one model, and it is set
 * for every player on the request because the assembly does not know which of
 * them is a defence. So the claim that has to hold is that it reaches nobody
 * else: a receiver evaluated with a home flag must be the same object as one
 * evaluated without it, field for field.
 */
describe('the home flag reaches the defence model and nothing else', () => {
  it('leaves a skill player byte-identical', () => {
    const receiver = candidate('wr9', 'Receiver Nine', 'WR', 14);

    const without = evaluatePlayer(receiver, PROFILE);
    const withHome = evaluatePlayer({ ...receiver, home: true }, PROFILE);

    expect(withHome).toEqual(without);
  });

  it('does move a defence, by the small amount it is capped at', () => {
    const unit = defence('def9', 'Seattle', { spread: -3, total: 44, opponent: 'ARI' }, { team: 'SEA' });

    const road = evaluatePlayer({ ...unit, home: false }, PROFILE).score!;
    const home = evaluatePlayer({ ...unit, home: true }, PROFILE).score!;

    expect(home).toBeGreaterThan(road);
    expect(home - road).toBeLessThan(1);
  });

  it('still refuses a defence with no game line, home flag or not', () => {
    const unpriced = defence('def10', 'Chicago', null, { team: 'CHI' });

    expect(evaluatePlayer({ ...unpriced, home: true }, PROFILE).score).toBeNull();
  });
});
