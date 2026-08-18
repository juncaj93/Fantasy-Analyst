/**
 * Which lineup wins **this** matchup.
 *
 * The property under test is the one that separates this from the Team screen:
 * the answer is allowed to differ from "highest median", and in two specific
 * directions. A big underdog should take the wider distribution even at the
 * cost of projected points; a strong favourite should take the narrower one.
 * If those two ever stop holding, the feature has quietly become a second
 * spelling of the projection.
 */

import { describe, expect, it } from 'vitest';
import { assessLineupDecision, suggestedMode, MIN_WIN_PROBABILITY_GAIN } from '../src/core/matchup/decision.ts';
import { buildDistribution, resolveGameClock } from '../src/core/matchup/distribution.ts';
import { simulateMatchup } from '../src/core/matchup/simulate.ts';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');
/** Past the end of the early window, and before the late one kicks off. */
const AFTER_EARLY = new Date('2026-12-20T21:10:00Z');
const EARLY_KICKOFF = '2026-12-20T18:00:00Z';
const LATE_KICKOFF = '2026-12-20T21:25:00Z';

function decide(players: MatchupPlayerInput[], now: Date = BEFORE, minGain?: number) {
  const distributions = players.map((p) =>
    buildDistribution(p, resolveGameClock(p.kickoff, now, { hasPoints: p.actual > 0 })),
  );
  const result = simulateMatchup({ players, distributions, seed: 'decision-seed', draws: 20000 });
  return {
    result,
    decision: assessLineupDecision({
      result,
      players,
      distributions,
      slots: slots(),
      ...(minGain === undefined ? {} : { minGain }),
    }),
  };
}

/**
 * A lineup whose one open decision is a straight variance trade.
 *
 * The FLEX starter and the bench player project within half a point of each
 * other; one is a possession receiver and the other a deep threat. Which of
 * them belongs in the lineup is not a question the projection can answer, and
 * that is the entire point.
 */
function varianceTrade(opts: {
  mine: number[];
  theirs: number[];
  starterRole: string;
  benchRole: string;
}): MatchupPlayerInput[] {
  const base = lineups({ mineProjections: opts.mine, theirsProjections: opts.theirs }).map((p) =>
    p.playerId === 'mine-6'
      ? { ...p, position: 'WR', roleBucket: opts.starterRole, projection: 22 }
      : p,
  );
  return [
    ...base,
    bench({ playerId: 'alternative', projection: 21.5, roleBucket: opts.benchRole, team: 'NYJ' }),
  ];
}

/** The swap into FLEX — the one slot where both players are legal. */
function flexSwap(players: MatchupPlayerInput[]) {
  return decide(players, BEFORE, -1).decision.options.find(
    (o) => o.inPlayerId === 'alternative' && o.slot === 'FLEX',
  );
}

/** One bench player, ready to be given whatever shape a test needs. */
function bench(over: Partial<MatchupPlayerInput> & { playerId: string }): MatchupPlayerInput {
  return player({ side: 'mine', starting: false, slot: null, position: 'WR', team: 'NYJ', ...over });
}

describe('a close A/B choice', () => {
  it('prefers the player who wins the matchup more often', () => {
    const players = [
      ...lineups(),
      bench({ playerId: 'bench-better', projection: 20, team: 'NYJ' }),
    ];
    const { decision } = decide(players);
    expect(decision.best).not.toBeNull();
    expect(decision.best!.inPlayerId).toBe('bench-better');
    expect(decision.best!.gain).toBeGreaterThanOrEqual(MIN_WIN_PROBABILITY_GAIN);
    expect(decision.best!.winAfter).toBeGreaterThan(decision.best!.winNow);
  });

  it('offers nothing when the lineup already maximises the odds', () => {
    const players = [...lineups(), bench({ playerId: 'bench-worse', projection: 3 })];
    const { decision } = decide(players);
    expect(decision.best).toBeNull();
    expect(decision.note).toMatch(/No legal change/);
  });
});

describe('the objective is winning, not the median', () => {
  /*
   * Both tests below are *comparative*, and deliberately.
   *
   * The absolute size of a variance-driven swap is small — a point of win
   * probability in an ordinary lineup — and asserting a fixed number would be
   * pinning an artefact of one fixture. What has to hold is the direction and
   * that it reverses: the identical pair of players, the identical trade of half
   * a projected point, is right when you are behind and wrong when you are not.
   * A model that had collapsed into "highest median wins" would fail this and
   * pass any absolute threshold you cared to set.
   */
  const MINE = [18, 12, 10, 14, 11, 8, 22];

  it('a big underdog prefers the wider range; an even matchup does not', () => {
    const underdog = flexSwap(
      varianceTrade({
        mine: MINE,
        theirs: [26, 20, 18, 24, 20, 16, 24],
        starterRole: 'underneath_receiver',
        benchRole: 'deep_receiver',
      }),
    );
    const even = flexSwap(
      varianceTrade({
        mine: MINE,
        theirs: [20, 13, 12, 15, 12, 9, 14],
        starterRole: 'underneath_receiver',
        benchRole: 'deep_receiver',
      }),
    );

    expect(underdog).toBeDefined();
    expect(even).toBeDefined();
    // The same half-point of projection given up, both times.
    expect(underdog!.pointsDelta).toBeLessThan(0);
    expect(underdog!.pointsDelta).toBe(even!.pointsDelta);
    // Behind, the wider player is worth more than he costs. Level, he is not.
    expect(underdog!.gain).toBeGreaterThan(0);
    expect(even!.gain).toBeLessThan(0);
    expect(underdog!.reason).toMatch(/behind/);
  });

  it('a favourite prefers the narrower range, and more so the closer it gets', () => {
    const bigLead = flexSwap(
      varianceTrade({
        mine: [26, 20, 18, 24, 20, 16, 22],
        theirs: [18, 12, 10, 14, 11, 8, 10],
        starterRole: 'deep_receiver',
        benchRole: 'underneath_receiver',
      }),
    );
    const narrowLead = flexSwap(
      varianceTrade({
        mine: [26, 20, 18, 24, 20, 16, 22],
        theirs: [22, 16, 15, 19, 16, 12, 16],
        starterRole: 'deep_receiver',
        benchRole: 'underneath_receiver',
      }),
    );

    expect(bigLead).toBeDefined();
    expect(narrowLead).toBeDefined();
    expect(narrowLead!.pointsDelta).toBeLessThan(0);
    // Ahead, the safer player is worth the half point in both — and worth more
    // where the lead is small enough for a bad afternoon to matter.
    expect(bigLead!.gain).toBeGreaterThan(0);
    expect(narrowLead!.gain).toBeGreaterThan(bigLead!.gain);
    expect(narrowLead!.reason).toMatch(/ahead/);
  });
});

describe('legality', () => {
  it('never proposes moving a player whose game has started', () => {
    const players = [
      ...lineups().map((p) => ({ ...p, kickoff: EARLY_KICKOFF })),
      bench({ playerId: 'huge', projection: 40, kickoff: LATE_KICKOFF }),
    ];
    const { decision } = decide(players, AFTER_EARLY);
    expect(decision.best).toBeNull();
    expect(decision.note).toMatch(/locked/);
  });

  it('never proposes a player whose own game has started', () => {
    const players = [
      ...lineups().map((p) => ({ ...p, kickoff: LATE_KICKOFF })),
      bench({ playerId: 'started', projection: 40, kickoff: EARLY_KICKOFF }),
    ];
    const { decision } = decide(players, AFTER_EARLY);
    expect(decision.options.some((o) => o.inPlayerId === 'started')).toBe(false);
  });

  it('never proposes a player who is ruled out', () => {
    const players = [
      ...lineups(),
      bench({ playerId: 'injured', projection: 40, ruledOut: true, availability: 'inactive' }),
    ];
    const { decision } = decide(players);
    expect(decision.options.some((o) => o.inPlayerId === 'injured')).toBe(false);
  });

  it('rejects an illegal flex combination', () => {
    // A quarterback cannot fill a FLEX slot in this league's shape, whatever
    // the arithmetic says about him.
    const players = [
      ...lineups(),
      bench({ playerId: 'backup-qb', position: 'QB', projection: 40 }),
    ];
    const { decision } = decide(players);
    const intoFlex = decision.options.filter((o) => o.inPlayerId === 'backup-qb' && o.slot === 'FLEX');
    expect(intoFlex).toHaveLength(0);
    // He is not eligible anywhere except QB, and the QB slot is what he can
    // legally contest.
    for (const option of decision.options.filter((o) => o.inPlayerId === 'backup-qb')) {
      expect(option.slot).toBe('QB');
    }
  });

  it('lets an unresolved injury change the decision', () => {
    const healthy = [
      ...lineups(),
      bench({ playerId: 'alt', projection: 15 }),
    ];
    const risky = healthy.map((p) => (p.playerId === 'alt' ? { ...p, availability: 'uncertain' as const } : p));
    const withHealthy = decide(healthy).decision.options.find((o) => o.inPlayerId === 'alt');
    const withRisk = decide(risky).decision.options.find((o) => o.inPlayerId === 'alt');
    expect(withHealthy).toBeDefined();
    // A one-in-three chance he does not play makes the same swap worth less,
    // and frequently not worth offering at all.
    if (withRisk) expect(withRisk.gain).toBeLessThan(withHealthy!.gain);
  });
});

describe('the suggested mode follows the matchup', () => {
  it('asks a clear favourite for his floor', () => {
    expect(suggestedMode(0.78).mode).toBe('floor');
  });

  it('asks a meaningful underdog for a ceiling', () => {
    expect(suggestedMode(0.22).mode).toBe('ceiling');
  });

  it('asks a close matchup for neither', () => {
    expect(suggestedMode(0.51).mode).toBe('balanced');
  });
});
