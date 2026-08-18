/**
 * The room drafts where it lives — and that is all it does.
 *
 * Two halves to this. The first is that the prior works: a Detroit-area league
 * really does take Lions earlier, so a Lion is genuinely less likely to reach
 * the reader's next pick. The second is the half that matters more, because it
 * is the one that could go wrong invisibly: the prior must reach opponent
 * demand and nothing else. A Lions receiver is priced by the market at exactly
 * what he was priced at before, ranks by the same composite, sits in the same
 * tier, and shows the same `Val`.
 */

import { describe, expect, it } from 'vitest';
import { TEAM_PRIOR, readTeamPrior, teamMultiplier } from '../src/core/draft/nextpick/teamPrior.ts';
import { simulateNextPick } from '../src/core/draft/nextpick/simulate.ts';
import { rankAvailablePlayers } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildBoard, STANDARD_ROSTER } from './helpers/nextpick.ts';
import { player } from './helpers/players.ts';

/** Completed picks in which Lions went exactly where the market said. */
function marketPicks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pickNo: 10 + i * 4,
    slot: 1,
    position: 'WR',
    team: 'DET',
    adp: 10 + i * 4,
  }));
}

/** Completed picks in which Lions consistently went `early` picks ahead. */
function earlyPicks(count: number, early: number) {
  return marketPicks(count).map((p) => ({ ...p, adp: p.pickNo + early }));
}

describe('evidence outranks the assumption', () => {
  it('applies the bounded prior when there is too little draft to measure', () => {
    const result = readTeamPrior({ teams: ['DET'], picks: [], teamsInLeague: 12 });
    expect(result.basis).toBe('prior');
    const multiplier = teamMultiplier(result, 'DET');
    expect(multiplier).toBeGreaterThan(1);
    // The brief's range: a bounded 10-20% lift, never more.
    expect(multiplier).toBeLessThanOrEqual(1 + TEAM_PRIOR.maxPrior);
    expect(result.notes.join(' ')).toContain('bounded local prior');
  });

  it('switches to what the room actually did once there is a sample', () => {
    const result = readTeamPrior({ teams: ['DET'], picks: earlyPicks(12, 10), teamsInLeague: 12 });
    expect(result.basis).toBe('blended');
    expect(result.observed.get('DET')!.picks).toBe(12);
    expect(result.observed.get('DET')!.meanPicksEarly).toBe(10);
    expect(result.notes.join(' ')).toContain('10 picks earlier');
  });

  it('shrinks the observation hard when the sample is small', () => {
    // A mild lean, so neither answer is pinned to the bounds and the shrinkage
    // is the only thing separating them.
    const small = readTeamPrior({ teams: ['DET'], picks: earlyPicks(4, 6), teamsInLeague: 12 });
    const large = readTeamPrior({ teams: ['DET'], picks: earlyPicks(30, 6), teamsInLeague: 12 });
    expect(small.observed.get('DET')!.shrinkage).toBeLessThan(large.observed.get('DET')!.shrinkage);
    // Four picks of a six-pick lean is mostly the prior; thirty picks of it is
    // mostly the measurement, and the measurement here is the stronger claim.
    expect(teamMultiplier(small, 'DET')).not.toBe(teamMultiplier(large, 'DET'));
    expect(large.observed.get('DET')!.shrinkage).toBeGreaterThan(0.75);
    expect(small.observed.get('DET')!.shrinkage).toBeLessThan(0.4);
  });

  it('lets a room that does NOT take them early pull the prior back down', () => {
    // The assumption is overridable by evidence, which is the point of a prior.
    const contrary = readTeamPrior({ teams: ['DET'], picks: earlyPicks(30, -12), teamsInLeague: 12 });
    expect(teamMultiplier(contrary, 'DET')).toBeLessThan(1 + TEAM_PRIOR.defaultPrior);
  });

  it('stays inside its bounds however extreme the evidence', () => {
    for (const early of [-200, -50, 0, 50, 200]) {
      const result = readTeamPrior({ teams: ['DET'], picks: earlyPicks(40, early), teamsInLeague: 12 });
      const m = teamMultiplier(result, 'DET');
      expect(m).toBeGreaterThanOrEqual(TEAM_PRIOR.bounds.min);
      expect(m).toBeLessThanOrEqual(TEAM_PRIOR.bounds.max);
    }
  });

  it('says nothing at all about a league that has named no local team', () => {
    const result = readTeamPrior({ teams: [], picks: earlyPicks(30, 20), teamsInLeague: 12 });
    expect(result.basis).toBe('none');
    expect(teamMultiplier(result, 'DET')).toBe(1);
  });

  it('leaves every other team alone', () => {
    const result = readTeamPrior({ teams: ['DET'], picks: earlyPicks(20, 15), teamsInLeague: 12 });
    expect(teamMultiplier(result, 'GB')).toBe(1);
    expect(teamMultiplier(result, null)).toBe(1);
  });

  it('is deterministic', () => {
    const input = { teams: ['DET'], picks: earlyPicks(15, 8), teamsInLeague: 12 };
    const answers = Array.from({ length: 10 }, () =>
      JSON.stringify([...readTeamPrior(input).multipliers.entries()]),
    );
    expect(new Set(answers).size).toBe(1);
  });
});

describe('the effect lands on Next%, and it is relative demand rather than a subtraction', () => {
  /**
   * Matched pairs: two players at every ADP, identical in every respect except
   * the badge on the helmet.
   *
   * The paired design is not a stylistic choice, it is the only design that
   * measures the right thing. The simulator takes a fixed number of players off
   * the board — fourteen picks are fourteen picks — so demand is a share of a
   * fixed total, and the question "is a Lion likelier to be taken" is only
   * answerable as "likelier *than whom*". Comparing a Lion against himself on
   * a board where every player was also boosted asks nothing at all: see the
   * normalisation test below, which is that fact stated deliberately.
   */
  function pairedPool() {
    const out = [];
    for (let i = 0; i < 60; i++) {
      const adp = 52 + i * 2;
      out.push(
        { playerId: `DET-${adp}`, position: 'WR', adp, order: adp, team: 'DET' },
        { playerId: `GB-${adp}`, position: 'WR', adp, order: adp, team: 'GB' },
      );
    }
    return out;
  }

  const prior = readTeamPrior({ teams: ['DET'], picks: [], teamsInLeague: 12 });

  /** Mean survival of each side of the pair, over one simulated board. */
  function pairedSurvival(targetPick: number, teamPrior?: ReturnType<typeof readTeamPrior>) {
    const board = buildBoard({ candidates: pairedPool(), targetPick, simulations: 6000 });
    const result = simulateNextPick({ ...board, teamPrior });
    const mean = (prefix: string) => {
      const probs = [...result.byPlayer.values()]
        .filter((p) => p.playerId.startsWith(prefix))
        .map((p) => p.probability)
        .filter((p): p is number => p != null);
      return probs.reduce((a, b) => a + b, 0) / probs.length;
    };
    return { det: mean('DET-'), gb: mean('GB-'), result };
  }

  it('makes a Lion less likely than an identical non-Lion to reach your next pick', () => {
    const { det, gb } = pairedSurvival(75, prior);
    expect(det).toBeLessThan(gb);
  });

  it('treats them identically when the room has no local team', () => {
    const { det, gb } = pairedSurvival(75, undefined);
    // Same ADP, same position, same everything: any gap here is sampling noise.
    expect(Math.abs(det - gb)).toBeLessThan(0.01);
  });

  /**
   * A hazard compounds over the picks a player has to survive; a flat
   * subtraction from a percentage does not. Measured as the gap between the
   * matched pair widening as the horizon lengthens.
   */
  it('compounds with the number of intervening picks rather than being flat', () => {
    const near = pairedSurvival(58, prior);
    const far = pairedSurvival(80, prior);
    expect(far.gb - far.det).toBeGreaterThan(near.gb - near.det);
  });

  it('stays a bounded nudge rather than reordering the board', () => {
    const { det, gb } = pairedSurvival(75, prior);
    // Real, and small: single-digit percentage points, not a collapse.
    expect(gb - det).toBeGreaterThan(0.005);
    expect(gb - det).toBeLessThan(0.15);
  });

  /**
   * The normalisation property, stated on purpose rather than discovered later.
   *
   * Demand is a share of a fixed number of picks, so lifting *everybody* lifts
   * nobody: a league in which every available player is a Lion sees no effect
   * at all, which is correct — the room still makes fourteen picks and the
   * prior has nothing to express a preference between.
   */
  it('is a no-op when every player on the board is a local player', () => {
    const all = pairedPool().map((c) => ({ ...c, team: 'DET' }));
    const board = buildBoard({ candidates: all, targetPick: 75, simulations: 4000 });
    const withPrior = simulateNextPick({ ...board, teamPrior: prior });
    const without = simulateNextPick({ ...board, teamPrior: undefined });
    for (const [id, after] of withPrior.byPlayer) {
      expect(after.probability).toBe(without.byPlayer.get(id)!.probability);
    }
  });

  it('leaves the market baseline — what ADP alone says — completely untouched', () => {
    const { result } = pairedSurvival(75, prior);
    const neutral = pairedSurvival(75, undefined).result;
    for (const [id, after] of result.byPlayer) {
      expect(after.marketBaseline).toBe(neutral.byPlayer.get(id)!.marketBaseline);
    }
  });

  it('reports what it applied, so the effect can be inspected', () => {
    const { result } = pairedSurvival(75, prior);
    expect(result.teamPrior).not.toBeNull();
    expect(result.teamPrior!.multipliers.get('DET')).toBeGreaterThan(1);
    expect(pairedSurvival(75, undefined).result.teamPrior).toBeNull();
  });
});

describe('nothing about player quality moves because a player is a Lion', () => {
  const shape = buildRosterShape(STANDARD_ROSTER);
  const profile = buildScoringProfile({}, STANDARD_ROSTER);
  const LION = player({ id: 'lion', fullName: 'Lion Receiver', position: 'WR', team: 'DET' });
  const OTHER = player({ id: 'other', fullName: 'Other Receiver', position: 'WR', team: 'GB' });

  const ctx = {
    currentPick: 53,
    nextPick: 68,
    shape,
    profile,
    rosterCounts: {},
    totalPicks: 180,
  };

  it('gives identical Scores, Vals and tiers to two identical players on different teams', () => {
    const ranked = rankAvailablePlayers(
      [
        { player: LION, adp: 55, adpRank: 1, signal: null },
        { player: OTHER, adp: 55, adpRank: 2, signal: null },
      ],
      ctx,
    );
    const lion = ranked.find((r) => r.playerId === 'lion')!;
    const other = ranked.find((r) => r.playerId === 'other')!;
    expect(lion.score).toBe(other.score);
    expect(lion.adpValue).toBe(other.adpValue);
    expect(lion.tierCliff.severity).toBe(other.tierCliff.severity);
    expect(lion.marketBlend.adp).toBe(other.marketBlend.adp);
  });

  it('never lets the ranking engine see an NFL team as a market input', () => {
    // The engine has no team-prior input at all: the only route from "he is a
    // Lion" to a number is the simulator's survival probability, handed in.
    const ranked = rankAvailablePlayers([{ player: LION, adp: 55, adpRank: 1, signal: null }], ctx);
    const marketComponent = ranked[0]!.components.find((c) => c.key === 'market_value')!;
    expect(marketComponent.display).not.toContain('DET');
    expect(marketComponent.display).not.toContain('Lion');
  });

  it('moves the ranking only through the pre-existing survival channel', () => {
    // Same player, two survival probabilities — the only thing a room prior can
    // change. Everything else on the card is identical.
    const at = (probability: number) =>
      rankAvailablePlayers(
        [
          {
            player: LION,
            adp: 55,
            adpRank: 1,
            signal: null,
            nextPickSurvival: { probability, note: '' },
          },
        ],
        ctx,
      )[0]!;
    const likely = at(0.8);
    const unlikely = at(0.2);
    expect(likely.adpValue).toBe(unlikely.adpValue);
    expect(likely.tierCliff.severity).toBe(unlikely.tierCliff.severity);
    expect(likely.marketBlend.adp).toBe(unlikely.marketBlend.adp);
    // Only the survival component differs, and it is the bounded one.
    const differing = likely.components.filter(
      (c, i) => c.contribution !== unlikely.components[i]!.contribution,
    );
    expect(differing.map((c) => c.key)).toEqual(['survival']);
  });
});
