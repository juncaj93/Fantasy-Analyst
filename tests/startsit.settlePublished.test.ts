/**
 * For a player ranked on a published week, the rows add up to the number.
 *
 * Before this, the Compare sheet's news and opportunity rows were the engine's
 * own values while the number beside them was built from Rotowire's week plus
 * adjustments held to 10% of it, so the rows contradicted the total.
 */

import { describe, expect, it } from 'vitest';
import { compareStartSit, evaluatePlayer, type StartSitEvaluation } from '../src/core/startsit/engine.ts';
import { decisionPoints, settleOnPublishedWeek } from '../src/core/startsit/decisionPoints.ts';
import { totalBudget, BUDGETED_KEYS } from '../src/core/startsit/adjustmentBudget.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const PUBLISHED = new Map([['a', 10]]);

type Row = { key: string; value: number; shownValue?: number; unknown: boolean };
const shown = (c: Row) => c.shownValue ?? c.value;

/** The rows a published-week number is made of: everything but the market's own pieces. */
const rowsOf = (e: StartSitEvaluation) =>
  e.components.filter((c) => !c.unknown && c.key !== 'vegas' && c.key !== 'uncertainty' && c.key !== 'replacement_risk');

/** An evaluation with the display-only field stripped, for "nothing else moved". */
const withoutShown = (e: StartSitEvaluation) =>
  JSON.stringify({ ...e, components: e.components.map(({ shownValue: _drop, ...rest }) => rest) });

describe('settleOnPublishedWeek', () => {
  const unpriced = () => evaluatePlayer(candidate('a', 'A', 'WR', null, { signal: signalWithNet(9) }), HALF_PPR);

  it('prints the rows at what the published week allows', () => {
    const e = unpriced();
    settleOnPublishedWeek(e, PUBLISHED);
    const nudges = e.components.filter((c) => !c.unknown && BUDGETED_KEYS.includes(c.key) && c.key !== 'uncertainty');
    expect(Math.abs(nudges.reduce((a, c) => a + shown(c), 0))).toBeLessThanOrEqual(totalBudget(10) + 1e-9);
    expect(e.components.find((c) => c.key === 'news_recent')!.shownValue).toBeLessThan(2.1);
  });

  it('changes nothing but the display field: value, score and ranking stay', () => {
    const before = unpriced();
    const e = unpriced();
    settleOnPublishedWeek(e, PUBLISHED);
    expect(withoutShown(e)).toBe(JSON.stringify(before));
    expect(e.score).toBe(before.score);
  });

  it('does not change the number decisions are made on', () => {
    const before = decisionPoints(unpriced(), PUBLISHED)!;
    const e = unpriced();
    settleOnPublishedWeek(e, PUBLISHED);
    expect(decisionPoints(e, PUBLISHED)).toEqual(before);
  });

  it('makes the rows add up to the published week plus the adjustments', () => {
    const e = unpriced();
    settleOnPublishedWeek(e, PUBLISHED);
    const d = decisionPoints(e, PUBLISHED)!;
    expect(d.basis).toBe('published');
    expect(d.base + rowsOf(e).reduce((a, c) => a + shown(c), 0)).toBeCloseTo(d.points, 1);
  });

  it('is safe to call twice', () => {
    const once = unpriced();
    settleOnPublishedWeek(once, PUBLISHED);
    const twice = unpriced();
    settleOnPublishedWeek(twice, PUBLISHED);
    settleOnPublishedWeek(twice, PUBLISHED);
    expect(twice.components).toEqual(once.components);
  });

  it('leaves a complete market alone', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', 14, { signal: signalWithNet(9), fullBoard: true }), HALF_PPR);
    const before = JSON.stringify(e);
    settleOnPublishedWeek(e, PUBLISHED);
    expect(JSON.stringify(e)).toBe(before);
  });

  it('leaves a player nobody published alone', () => {
    const e = unpriced();
    const before = JSON.stringify(e);
    settleOnPublishedWeek(e, new Map());
    settleOnPublishedWeek(e, undefined);
    expect(JSON.stringify(e)).toBe(before);
  });

  it('leaves availability as it was', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', null, { signal: signalWithNet(9), status: 'Doubtful' }), HALF_PPR);
    settleOnPublishedWeek(e, PUBLISHED);
    expect(e.components.find((c) => c.key === 'status')!.shownValue).toBeUndefined();
  });
});

describe('where the Compare sheet and the lineup read it', () => {
  it('a comparison returns settled rows and the same decision numbers as before', () => {
    const inputs = [
      candidate('a', 'A', 'WR', null, { signal: signalWithNet(9) }),
      candidate('b', 'B', 'WR', 14),
    ];
    const result = compareStartSit(inputs, HALF_PPR, { published: PUBLISHED });
    const a = result.evaluations.find((e) => e.playerId === 'a')!;
    expect(a.decision?.basis).toBe('published');
    expect(a.decision!.base + rowsOf(a).reduce((s, c) => s + shown(c), 0)).toBeCloseTo(a.decision!.points, 1);
    expect(a.components.find((c) => c.key === 'news_recent')!.shownValue).toBeLessThan(2.1);

    const raw = decisionPoints(evaluatePlayer(inputs[0]!, HALF_PPR), PUBLISHED)!;
    expect(a.decision).toEqual(raw);
  });

  it('a lineup returns settled rows and ranks the same', () => {
    const inputs = [
      candidate('a', 'A', 'WR', null, { signal: signalWithNet(9) }),
      candidate('b', 'B', 'WR', 14),
      candidate('c', 'C', 'WR', 9),
    ];
    const shape = buildRosterShape(['WR', 'WR', 'BN']);
    const withPublished = recommendLineup(inputs, shape, HALF_PPR, { published: PUBLISHED });
    const a = [...withPublished.starters, ...withPublished.bench].find((e) => e.playerId === 'a')!;
    expect(a.decision!.base + rowsOf(a).reduce((s, c) => s + shown(c), 0)).toBeCloseTo(a.decision!.points, 1);
    expect(a.decision).toEqual(decisionPoints(evaluatePlayer(inputs[0]!, HALF_PPR), PUBLISHED));
  });
});
