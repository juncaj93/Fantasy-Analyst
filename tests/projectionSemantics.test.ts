/**
 * One word, one number: what "projected" is allowed to mean.
 *
 * On 22 August 2026 the Team screen printed `Jalen Hurts 3.15`, `Christian
 * McCaffrey 1.35` and `Malik Nabers -0.9` under the heading "Projected points",
 * against published week-one figures of 20.98, 17.17 and 10.4. Nothing was
 * broken in the arithmetic. The screen was rendering `StartSitEvaluation.score`
 * — the comparable number the lineup optimiser ranks with — and with no market
 * published that score is the sum of the news and availability adjustments with
 * the entire Vegas base dropped as unknown.
 *
 * The Matchup screen, reading the same evaluations through `activeProjection`,
 * correctly showed nothing at all for the same nine players in the same minute.
 * So the app held both answers at once and showed whichever one you navigated
 * to.
 *
 * These tests hold the line in both directions: **this app's own** projection
 * may not exist without a market underneath it, and where one does exist every
 * surface must quote the same number.
 *
 * The rule these tests describe is now `marketProjection`, which is what every
 * engine reads and what the sentence above has always been about. The published
 * Rotowire fallback that `weeklyProjection` may reach for on top of it is a
 * display decision with its own file — `sleeperProjectionFallback.test.ts` —
 * and it is offered nothing here, so every assertion below is unchanged in
 * meaning as well as in value.
 */

import { describe, expect, it } from 'vitest';
import { marketProjection, weeklyProjection } from '../src/core/startsit/projection.ts';
import { activeProjection } from '../src/core/matchup/build.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

/** Half PPR, the shape the live league uses. */
const PROFILE = buildScoringProfile({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'BN']);
const SHAPE = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'BN', 'BN']);

/**
 * A component set shaped like the live one: adjustments known, market absent.
 *
 * The `status` entry is the availability charge the projection takes back out —
 * it is priced again as a mixture on the Matchup screen and printed as a tag on
 * the Team screen, and paying for it three times is what §3 forbids.
 */
interface Fixture {
  score: number | null;
  expectation: { points: number | null; coverage: number };
  components: { key: string; value: number; unknown: boolean }[];
}

function evaluation(over: Partial<Fixture> = {}): Fixture {
  return {
    score: 1.35,
    expectation: { points: null, coverage: 0 },
    components: [
      { key: 'vegas', value: 0, unknown: true },
      { key: 'news_recent', value: 2.1, unknown: false },
      { key: 'news_raw', value: 1.2, unknown: false },
      { key: 'status', value: -1.5, unknown: false },
      { key: 'replacement_risk', value: -0.45, unknown: false },
    ],
    ...over,
  };
}

describe('a projection requires a market', () => {
  it('refuses to project a player nobody has priced', () => {
    // The live shape exactly: every adjustment known, the base missing.
    expect(marketProjection(evaluation())).toBeNull();
  });

  it('refuses even when the adjustments sum to something plausible', () => {
    /*
     * The failure mode that made this hard to see. 3.15 is not obviously wrong
     * the way NaN or -1 would be; it reads as a considered forecast of a bad
     * week, which is why it survived a deploy.
     */
    const hurts = evaluation({
      score: 3.15,
      components: [
        { key: 'vegas', value: 0, unknown: true },
        { key: 'news_recent', value: 2.1, unknown: false },
        { key: 'news_raw', value: 1.05, unknown: false },
        { key: 'status', value: 0, unknown: false },
      ],
    });
    expect(marketProjection(hurts)).toBeNull();
  });

  it('never returns a negative projection', () => {
    // Malik Nabers rendered as -0.9 in production: adjustments that happened to
    // net out below zero, printed as an expectation of negative points.
    const nabers = evaluation({
      score: -0.9,
      expectation: { points: 8, coverage: 1 },
      components: [
        { key: 'vegas', value: 8, unknown: false },
        { key: 'status', value: -1.5, unknown: false },
      ],
    });
    expect(marketProjection(nabers)).toBeGreaterThanOrEqual(0);
  });

  it('treats an absent expectation exactly like a null one', () => {
    // A caller that does not carry the market cannot have its number blessed as
    // a projection just because it forgot to mention it.
    expect(marketProjection({ score: 4, components: [] })).toBeNull();
  });

  it('projects once a market exists, with the availability charge taken back out', () => {
    const priced = evaluation({ score: 12.4, expectation: { points: 13.9, coverage: 1 } });
    // 12.4 minus the -1.5 availability charge.
    expect(marketProjection(priced)).toBeCloseTo(13.9, 5);
  });

  it('leaves an unknown availability charge alone', () => {
    const priced = evaluation({
      score: 12.4,
      expectation: { points: 13.9, coverage: 1 },
      components: [
        { key: 'vegas', value: 13.9, unknown: false },
        { key: 'status', value: -1.5, unknown: true },
      ],
    });
    expect(marketProjection(priced)).toBeCloseTo(12.4, 5);
  });
});

describe('every surface means the same thing by it', () => {
  it('the matchup export is the same function', () => {
    expect(activeProjection).toBe(marketProjection);
  });

  /**
   * …and the hierarchy on top of it is exactly that: on top of it.
   *
   * With nothing published, `weeklyProjection` is `marketProjection` wearing a
   * label. This is the claim that keeps every other test in this file true after
   * the fallback landed — none of them offers a published figure, so none of
   * them can have quietly started measuring a different function.
   */
  it('offering no published figure leaves the market rule untouched', () => {
    const priced = evaluation({ score: 12.4, expectation: { points: 13.9, coverage: 1 } });
    expect(weeklyProjection(priced)).toEqual({ points: marketProjection(priced), source: 'market' });
    expect(weeklyProjection(evaluation())).toEqual({ points: null, source: null });
  });

  it('the weekly card quotes the projection, not the ranking score', () => {
    const card = buildWeeklyCard(
      {
        playerId: 'p1',
        name: 'Jalen Hurts',
        position: 'QB',
        team: 'PHI',
        confidence: 'low',
        statusFlag: null,
        ruledOut: false,
        ...evaluation({ score: 3.15 }),
      },
      { starting: true },
    );
    // The card prints this under "Proj". It may not be 3.15.
    expect(card.score).toBeNull();
  });

  it('the weekly card still ranks him, because ranking is a different question', () => {
    /*
     * "Not enough data to rank him" reads `evaluation.score` and must keep
     * doing so. A player with no published market is perfectly rankable against
     * his own bench — what he is not is projectable.
     */
    const card = buildWeeklyCard(
      {
        playerId: 'p1',
        name: 'Jalen Hurts',
        position: 'QB',
        team: 'PHI',
        confidence: 'low',
        statusFlag: null,
        ruledOut: false,
        ...evaluation({ score: 3.15 }),
      },
      { starting: false },
    );
    expect(card.headline.verdict).toBe('bench');
    expect(card.headline.label).not.toMatch(/not enough data/i);
  });
});

describe('the lineup carries both numbers, and they are not the same number', () => {
  /**
   * The live shape: no market anywhere, but enough news to make every player
   * rankable — which is exactly why the screen had something to print.
   */
  const unpriced = () => [
    candidate('qb', 'A Quarterback', 'QB', null, { signal: signalWithNet(3) }),
    candidate('rb', 'A Runner', 'RB', null, { signal: signalWithNet(2) }),
    candidate('wr', 'A Receiver', 'WR', null, { signal: signalWithNet(2) }),
    candidate('te', 'A Tight End', 'TE', null, { signal: signalWithNet(1) }),
  ];

  it('with no market it still ranks, and still refuses to project', () => {
    const recommendation = recommendLineup(unpriced(), SHAPE, PROFILE, { currentStarterIds: [] });
    const filled = recommendation.slots.filter((s) => s.playerId);

    expect(filled.length, 'the optimiser still filled the lineup').toBeGreaterThan(0);
    for (const slot of filled) {
      /*
       * The whole point, in two assertions on one row: he was good enough to be
       * picked for a slot — so the ranking worked — and there is still nothing
       * honest to print beside his name.
       */
      expect(slot.score, `${slot.name} in ${slot.slot} was rankable`).not.toBeNull();
      expect(slot.projection, `${slot.name} in ${slot.slot} must not be projected`).toBeNull();
    }
  });

  it('projects a filled slot once the market is there', () => {
    const priced = [candidate('wr1', 'First Receiver', 'WR', 11.5, { signal: signalWithNet(2) })];
    const recommendation = recommendLineup(priced, SHAPE, PROFILE, { currentStarterIds: [] });

    const wr = recommendation.slots.find((s) => s.playerId === 'wr1');
    expect(wr, 'the receiver took a slot').toBeTruthy();
    expect(wr!.projection).not.toBeNull();
    /*
     * The order of magnitude is the finding. A weekly projection lives in the
     * teens; the broken screen was printing one and a third.
     */
    expect(wr!.projection!).toBeGreaterThan(8);
  });

  it('projects some players and not others in the same lineup, rather than all or nothing', () => {
    const mixed = [
      candidate('wr1', 'Priced Receiver', 'WR', 12, { signal: signalWithNet(2) }),
      candidate('wr2', 'Unpriced Receiver', 'WR', null, { signal: signalWithNet(2) }),
    ];
    const recommendation = recommendLineup(mixed, SHAPE, PROFILE, { currentStarterIds: [] });

    /*
     * Whether each of them started is the optimiser's business and not this
     * test's, so both are looked for in the slots and on the bench. What is
     * asserted is only that the priced one is projectable and the unpriced one
     * is not — the same lineup, two different answers, which is what makes this
     * a per-player fact rather than a screen-wide switch.
     */
    const projectionOf = (playerId: string): number | null => {
      const slot = recommendation.slots.find((s) => s.playerId === playerId);
      if (slot) return slot.projection;
      return marketProjection(recommendation.bench.find((b) => b.playerId === playerId) ?? null);
    };

    expect(projectionOf('wr1'), 'the priced receiver').not.toBeNull();
    expect(projectionOf('wr2'), 'the unpriced receiver').toBeNull();
  });
});
