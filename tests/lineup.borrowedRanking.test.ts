/**
 * A swap may not contradict the two figures printed beside it.
 *
 * Reported 16 September 2026. The lineup screen carried this, with both
 * projections visible on their own rows:
 *
 *     Rhamondre Stevenson   score 2.53   projection 10.89   sleeper
 *     RJ Harvey             score 7.16   projection  7.16   market
 *     → Start RJ Harvey over Rhamondre Stevenson · +4.63 pts
 *
 * 7.16 − 2.53 = 4.63, and that subtraction is the whole defect: one side is a
 * forecast of a week of football and the other is three bounded nudges, because
 * no book had priced Stevenson and `score` only ever contained this app's own
 * market expectation. The screen, meanwhile, had Rotowire's 10.89 and printed
 * it. So the app benched a ten-point back for a seven-point one and called it a
 * four-point gain.
 *
 * These fix the numbers to the ones production actually produced, because the
 * bug is not that some ordering changed — it is that a reader could read two
 * numbers off one screen and see the sentence between them be false.
 */

import { describe, expect, it } from 'vitest';
import {
  recommendLineup,
  BORROWED_RANKING_DISCOUNT,
} from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);
const NOW = '2026-09-16T12:00:00Z';

/**
 * The two backs from the report, and the rest of a legal roster.
 *
 * `harvey` is priced and carries the positive news tally the card quoted;
 * `stevenson` is the one no book reached. Everybody else is priced and settled
 * so the only question on the board is the one under test.
 */
function roster(opts: { stevensonPriced?: boolean } = {}) {
  return [
    candidate('qb1', 'Joe Burrow', 'QB', 22.07, { now: NOW }),
    candidate('bijan', 'Bijan Robinson', 'RB', 18.98, { now: NOW }),
    candidate('harvey', 'RJ Harvey', 'RB', 7.16, { now: NOW, signal: signalWithNet(1) }),
    candidate('wr1', 'Nico Collins', 'WR', 14.66, { now: NOW }),
    candidate('wr2', 'Garrett Wilson', 'WR', 13.4, { now: NOW }),
    candidate('te1', 'Sam LaPorta', 'TE', 11.22, { now: NOW }),
    candidate('walker', 'Kenneth Walker', 'RB', 16.2, { now: NOW }),
    candidate('stevenson', 'Rhamondre Stevenson', 'RB', opts.stevensonPriced ? 10.89 : null, {
      now: NOW,
      /* A tally, so he scores on nudges alone exactly as production had him. */
      signal: signalWithNet(2),
    }),
  ];
}

/** Rotowire has him at 10.89; this app has no market for him. */
const PUBLISHED = new Map([['stevenson', 10.89]]);

/** Stevenson is in the reader's Sleeper lineup; RJ Harvey is not. */
const STARTING = ['qb1', 'bijan', 'stevenson', 'wr1', 'wr2', 'te1', 'walker'];

function lineup(over: Parameters<typeof recommendLineup>[3] = {}) {
  return recommendLineup(roster(), SHAPE, HALF_PPR, {
    currentStarterIds: STARTING,
    published: PUBLISHED,
    now: NOW,
    ...over,
  });
}

describe('the swap that contradicted its own screen', () => {
  it('does not bench a published ten-point back for a market seven-point one', () => {
    const swap = lineup().swaps.find((s) => s.outPlayerId === 'stevenson');
    expect(swap).toBeUndefined();
  });

  it('keeps the higher-projected player in the lineup', () => {
    const starters = lineup().slots.map((s) => s.playerId);
    expect(starters).toContain('stevenson');
    expect(starters).not.toContain('harvey');
  });

  it('would have made the swap before the figure could rank him', () => {
    /*
     * The defect, pinned. With no published figure Stevenson is unrankable, his
     * score is nudges, and the old arithmetic reappears — which is what makes
     * the assertions above statements about the fix rather than about the
     * fixture.
     */
    const withoutFigure = recommendLineup(roster(), SHAPE, HALF_PPR, {
      currentStarterIds: STARTING,
      now: NOW,
    });
    const swap = withoutFigure.swaps.find((s) => s.outPlayerId === 'stevenson');
    expect(swap?.inPlayerId).toBe('harvey');
  });

  it('never prints a gain the two figures on screen contradict', () => {
    const result = lineup();
    const projectionOf = new Map(result.slots.map((s) => [s.playerId, s.projection]));
    for (const swap of result.swaps) {
      const incoming = projectionOf.get(swap.inPlayerId);
      const outgoing = result.bench.find((e) => e.playerId === swap.outPlayerId);
      if (incoming == null || outgoing == null) continue;
      expect(swap.gain).toBeGreaterThan(0);
    }
  });
});

describe('the discount on somebody else’s model', () => {
  it('lets a borrowed figure win a gap a reader can see', () => {
    /* 10.89 − 2 = 8.89, comfortably past RJ Harvey's 7.16. */
    expect(10.89 - BORROWED_RANKING_DISCOUNT).toBeGreaterThan(7.16);
    expect(lineup().slots.map((s) => s.playerId)).toContain('stevenson');
  });

  it('does not let one win a close call against this app’s own number', () => {
    /*
     * 8.28 against 6.77 was the other pair on the same board: a point and a
     * half between two different models, which is not evidence.
     *
     * Written against the incumbent's own finished score rather than against a
     * figure chosen here, because the score carries the bounded nudges and a
     * fixture that hardcoded the market line would be testing the arithmetic of
     * this file instead of the rule.
     */
    const contest = (publishedFigure: number) =>
      recommendLineup(
        [
          candidate('qb1', 'Joe Burrow', 'QB', 22.07, { now: NOW }),
          candidate('bijan', 'Bijan Robinson', 'RB', 18.98, { now: NOW }),
          candidate('walker', 'Kenneth Walker', 'RB', 16.2, { now: NOW }),
          candidate('wr1', 'Nico Collins', 'WR', 14.66, { now: NOW }),
          candidate('wr2', 'Garrett Wilson', 'WR', 13.4, { now: NOW }),
          candidate('te1', 'Sam LaPorta', 'TE', 11.22, { now: NOW }),
          candidate('andrews', 'Mark Andrews', 'TE', 6.77, { now: NOW }),
          candidate('concepcion', 'KC Concepcion', 'WR', null, { now: NOW, signal: signalWithNet(2) }),
        ],
        SHAPE,
        HALF_PPR,
        {
          currentStarterIds: ['qb1', 'bijan', 'walker', 'wr1', 'wr2', 'te1', 'andrews'],
          published: new Map([['concepcion', publishedFigure]]),
          now: NOW,
        },
      );

    /* What this app makes of the incumbent, nudges and all. */
    const andrewsScore = contest(0).bench.find((e) => e.playerId === 'andrews')?.score
      ?? contest(0).slots.find((s) => s.playerId === 'andrews')!.score!;

    const inside = contest(andrewsScore + BORROWED_RANKING_DISCOUNT - 0.5);
    expect(inside.slots.map((s) => s.playerId)).toContain('andrews');
    expect(inside.slots.map((s) => s.playerId)).not.toContain('concepcion');

    const beyond = contest(andrewsScore + BORROWED_RANKING_DISCOUNT + 0.5);
    expect(beyond.slots.map((s) => s.playerId)).toContain('concepcion');
  });
});

describe('what the note says it did', () => {
  it('stops claiming a ranked player kept his slot unranked', () => {
    const notes = lineup().notes.join(' ');
    expect(notes).not.toMatch(/they keep the slots you already had them in/);
    expect(notes).toContain('Rotowire');
  });

  it('still makes the older promise to a player nobody has any figure for', () => {
    const noFigure = recommendLineup(roster(), SHAPE, HALF_PPR, {
      currentStarterIds: STARTING,
      now: NOW,
    });
    expect(noFigure.notes.join(' ')).toMatch(/no figure from any source this week/);
  });
});

describe('what did not change', () => {
  it('leaves a fully-priced roster byte for byte where it was', () => {
    const priced = () =>
      recommendLineup(roster({ stevensonPriced: true }), SHAPE, HALF_PPR, {
        currentStarterIds: STARTING,
        now: NOW,
      });
    const withMap = recommendLineup(roster({ stevensonPriced: true }), SHAPE, HALF_PPR, {
      currentStarterIds: STARTING,
      published: PUBLISHED,
      now: NOW,
    });

    /*
     * A market number is never displaced by a published one for the same
     * player — `rankingPoints` reads the market first — so handing the map over
     * changes nothing at all on a roster the books have fully reached.
     */
    expect(withMap.slots.map((s) => [s.slot, s.playerId, s.score])).toEqual(
      priced().slots.map((s) => [s.slot, s.playerId, s.score]),
    );
    expect(withMap.swaps).toEqual(priced().swaps);
  });

  it('still replaces a player who has no figure anywhere, which is the bye week', () => {
    const onBye = recommendLineup(roster(), SHAPE, HALF_PPR, {
      currentStarterIds: STARTING,
      /* No entry for Stevenson: nobody has a number for him at all. */
      published: new Map(),
      now: NOW,
    });
    expect(onBye.swaps.find((s) => s.outPlayerId === 'stevenson')?.inPlayerId).toBe('harvey');
  });
});
