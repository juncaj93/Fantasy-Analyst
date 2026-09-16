/**
 * One slot, two tabs, two different men — because one tab docked a figure.
 *
 * Reported 16 September 2026, the Matchup tab and the Team tab of the same app,
 * about the same FLEX slot:
 *
 *     Matchup   Best move: Start K. Concepcion over J. Reed   +2.5 projected pts
 *     Team      Start RJ Harvey over Jayden Reed              +1.37 pts
 *
 * Probed on production, the two screens held identical data and priced one man
 * differently:
 *
 *     K. Concepcion   matchup 8.28 (published)   lineup ranks him 8.28 − 2 = 6.28
 *     RJ Harvey       matchup 7.16 (market)      lineup ranks him 7.16
 *     Jayden Reed     matchup 5.79 (market)      lineup ranks him 5.79
 *
 * 8.28 − 5.79 = 2.49, which is the `+2.5` printed on the card.
 *
 * The disagreement was not about whether to change the FLEX — both screens
 * wanted to — but about **who to change it to**. Both men beat Reed on either
 * screen's arithmetic. The screens picked different winners because they ranked
 * the two candidates against *each other* on different numbers:
 *
 *     lineup    Harvey 7.16  >  Concepcion 6.28 (docked)     -> Harvey
 *     matchup   Concepcion 8.28  >  Harvey 7.16 (undocked)   -> Concepcion
 *
 * So the rule these hold is about candidates competing for one slot, and the
 * first attempt at it — a gate asking whether each swap was worth making on its
 * own — could not express it: Concepcion's docked 6.28 does clear Reed's 5.79,
 * so asked one swap at a time he is a fine answer. He is only the wrong answer
 * standing next to Harvey.
 *
 * Just as important: the forecast is untouched. The simulator still draws
 * Concepcion from 8.28, because a mean wants the best estimate available and
 * the alternative is a confident zero.
 */

import { describe, expect, it } from 'vitest';
import { assessLineupDecision, MIN_WIN_PROBABILITY_GAIN } from '../src/core/matchup/decision.ts';
import { BORROWED_RANKING_DISCOUNT } from '../src/core/startsit/lineup.ts';
import { buildDistribution, resolveGameClock } from '../src/core/matchup/distribution.ts';
import { simulateMatchup } from '../src/core/matchup/simulate.ts';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');

function decide(players: MatchupPlayerInput[], minGain = -1) {
  const distributions = players.map((p) =>
    buildDistribution(p, resolveGameClock(p.kickoff, BEFORE, { hasPoints: p.actual > 0 })),
  );
  const result = simulateMatchup({ players, distributions, seed: 'borrowed-seed', draws: 20000 });
  return {
    result,
    decision: assessLineupDecision({ result, players, distributions, slots: slots(), minGain }),
  };
}

/**
 * The reported shape: a thin FLEX starter, and two men on the bench who could
 * take his place — one priced by a book, one borrowed from Rotowire.
 */
function roster(opts: { concepcion: number } = { concepcion: 8.28 }): MatchupPlayerInput[] {
  const base = lineups({
    mineProjections: [22.07, 18.98, 16.4, 14.66, 13.4, 11.27, 5.79],
    theirsProjections: [23.2, 18, 13.8, 8.5, 9.7, 7.6, 12.2],
  });
  return [
    ...base,
    player({
      playerId: 'concepcion',
      side: 'mine',
      name: 'KC Concepcion',
      position: 'WR',
      team: 'CAR',
      starting: false,
      projection: opts.concepcion,
      projectionBorrowed: true,
    }),
    player({
      playerId: 'harvey',
      side: 'mine',
      name: 'RJ Harvey',
      position: 'RB',
      team: 'DEN',
      starting: false,
      projection: 7.16,
    }),
  ];
}

/** Whoever the FLEX row is told to start, if anybody. */
const flexOffers = (players: MatchupPlayerInput[]) =>
  decide(players).decision.options.filter((o) => o.slot === 'FLEX').map((o) => o.inPlayerId);

/** The one the card would name, which is the whole of what the reader sees. */
const bestIn = (players: MatchupPlayerInput[]) =>
  decide(players, 0.0001).decision.best?.inPlayerId ?? null;

describe('a borrowed figure does not outrank a priced one for the same slot', () => {
  it('names RJ Harvey, the same man the Team screen names', () => {
    expect(bestIn(roster())).toBe('harvey');
  });

  it('does not offer Concepcion at all while Harvey outranks him', () => {
    /* 6.28 against 7.16 — he clears Reed and loses to the man beside him. */
    expect(8.28 - BORROWED_RANKING_DISCOUNT).toBeLessThan(7.16);
    expect(flexOffers(roster())).not.toContain('concepcion');
  });

  it('named Concepcion before the discount reached this screen', () => {
    /*
     * The defect, pinned. Without the borrowed mark he is an ordinary 8.28, he
     * outranks Harvey, and the card says what production said — which is what
     * makes the assertions above statements about the rule rather than about
     * this fixture's numbers.
     */
    const unmarked = roster().map((p) =>
      p.playerId === 'concepcion' ? { ...p, projectionBorrowed: false } : p,
    );
    expect(bestIn(unmarked)).toBe('concepcion');
  });

  it('offers him once his own figure wins even after the docking', () => {
    const clear = roster({ concepcion: 7.16 + BORROWED_RANKING_DISCOUNT + 3 });
    expect(flexOffers(clear)).toContain('concepcion');
  });

  it('leaves him alone when no priced rival is competing for the slot', () => {
    /* Harvey removed: Concepcion's docked 6.28 still clears Reed's 5.79. */
    const alone = roster().filter((p) => p.playerId !== 'harvey');
    expect(flexOffers(alone)).toContain('concepcion');
  });
});

describe('the forecast is not touched by any of this', () => {
  it('still draws him from Rotowire’s number, not from the docked one', () => {
    /*
     * The mean is the best estimate available and the alternative is a
     * confident zero — the failure `build.ts` records, where an opponent priced
     * 4 of 7 came back as a 93.8% loss on what is really a coin flip.
     */
    const withHim = decide(roster()).result;
    const asDocked = decide(
      roster({ concepcion: 8.28 - BORROWED_RANKING_DISCOUNT }),
    ).result;
    expect(withHim.winProbability).not.toBe(asDocked.winProbability);
  });

  it('reports the same win probability as it did before the gate existed', () => {
    /*
     * The gate decides what may be *offered* and touches no distribution, so
     * the number on the bar is independent of it. Asserted by marking and
     * unmarking the same player: only the offers may move.
     */
    const marked = decide(roster()).result.winProbability;
    const unmarked = decide(
      roster().map((p) => (p.playerId === 'concepcion' ? { ...p, projectionBorrowed: false } : p)),
    ).result.winProbability;
    expect(marked).toBe(unmarked);
  });
});

describe('what the variance trade keeps', () => {
  it('never filters a contest between two market-priced players', () => {
    /*
     * The divergence this module exists for, and the one the rule must not
     * reach: `outrankedByAPricedRival` returns false for an unborrowed
     * candidate before it looks at anything else, so marking and unmarking the
     * borrowed man cannot change which priced swaps are on offer.
     */
    const priced = (players: MatchupPlayerInput[]) =>
      decide(players).decision.options.filter((o) => o.inPlayerId === 'harvey').map((o) => o.slot);
    const withBorrowed = priced(roster());
    const withoutHim = priced(roster().filter((p) => p.playerId !== 'concepcion'));
    expect(withBorrowed).toEqual(withoutHim);
    expect(withBorrowed.length).toBeGreaterThan(0);
  });
});

/**
 * And when this screen has nothing of its own to say.
 *
 * Removing Concepcion left the reported matchup with no move above the
 * two-point win-probability bar, so the Matchup tab read `Hold your lineup`
 * while the Team tab read `1 change to make`. Both were correct and the pair
 * still reads as one app contradicting itself, because nothing on either screen
 * says they are answers to different questions.
 *
 * `onProjection` is the projection's answer carried here to be labelled as the
 * projection's answer. It is not a lowering of the bar: it appears only when
 * `options` is empty, and a change this model believes in always wins.
 */
describe('the answer the Team screen would give', () => {
  /* The real bar, not the -1 the tests above use to see every option. */
  const atTheBar = (players: MatchupPlayerInput[]) =>
    decide(players, MIN_WIN_PROBABILITY_GAIN).decision;

  /**
   * The reported shape, which `roster()` above is half a point away from.
   *
   * There, Harvey over Reed is worth 2.25 points of win probability and clears
   * the bar on its own, so there is nothing to echo. The state this is about
   * needs a change that is genuinely better on paper and genuinely too small to
   * matter here — which is what production had, and what a FLEX incumbent
   * within half a point of his challenger produces.
   */
  const level = () =>
    roster().map((p) => (p.playerId === 'mine-6' ? { ...p, projection: 6.9 } : p));

  it('names the same man the lineup names, when nothing clears the bar', () => {
    const decision = atTheBar(level());
    expect(decision.best).toBeNull();
    expect(decision.onProjection?.inPlayerId).toBe('harvey');
  });

  it('is the man the app ranks highest, not the highest published figure', () => {
    /* Concepcion's 8.28 is larger and his ranked 6.28 is not. */
    const decision = atTheBar(level());
    expect(decision.onProjection).not.toBeNull();
    expect(decision.onProjection?.inPlayerId).not.toBe('concepcion');
  });

  it('never displaces a change this model does believe in', () => {
    /*
     * Give Harvey a figure big enough to clear the win-probability bar and the
     * echo must stand down: `best` is the stronger claim and owns the row.
     */
    const strong = level().map((p) =>
      p.playerId === 'harvey' ? { ...p, projection: 28 } : p,
    );
    const decision = decide(strong, 0.02).decision;
    expect(decision.best).not.toBeNull();
    expect(decision.onProjection).toBeNull();
  });

  it('says nothing at all when the lineup is already the best one', () => {
    /* No bench player outranks a starter, so there is nothing to echo. */
    const settled = level().filter((p) => p.playerId !== 'harvey' && p.playerId !== 'concepcion');
    const decision = atTheBar(settled);
    expect(decision.best).toBeNull();
    expect(decision.onProjection).toBeNull();
  });

  it('carries a reason that does not overstate what it is worth', () => {
    const decision = atTheBar(level());
    expect(decision.onProjection?.reason).toMatch(/not enough to swing this matchup/i);
  });
});
