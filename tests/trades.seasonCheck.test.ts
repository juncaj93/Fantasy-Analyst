/**
 * The Trades ideas, held to Check a trade's answer, and fair to both sides.
 *
 * Finding T3 (October 2026) put every idea through Check a trade. The
 * November 2026 review (T3, T6, T10) and Alex's rule replaced "lean my way"
 * with fair to both sides: an idea is shown only when Check a trade says both
 * lineups gain over the rest of the season and Alex's value edge is at most
 * 10%. An idea the check could not value is left off; a dropped idea is
 * replaced from the reserve behind the board; the drop a deal forces is named.
 */

import { describe, expect, it } from 'vitest';
import { applySeasonChecks, contradicts, ideasToCheck, seasonCheckLabel, seasonCheckOf, type SeasonCheck } from '../src/core/trades/seasonCheck.ts';
import { FAIR_TO_BOTH, fairToBoth, sentValue, valueEdge } from '../src/core/trades/fairToBoth.ts';
import type { OfferEvaluation } from '../src/core/trades/bilateral.ts';

const player = (id: string) => ({ playerId: id, name: id, position: 'WR', value: 10 });
const offer = (id: string, give = [`${id}-g`], get = [`${id}-r`]) =>
  ({ id, headline: `idea ${id}`, give: give.map(player), get: get.map(player) }) as unknown as OfferEvaluation;
const ok = (kind: SeasonCheck['kind'], over: Partial<SeasonCheck> = {}): SeasonCheck => ({
  status: 'ok',
  kind,
  headline: `${kind} headline`,
  confidence: 'medium',
  reason: null,
  you: 12,
  them: 6,
  edge: 0,
  unfair: null,
  drop: null,
  ...over,
});
const unchecked: SeasonCheck = { status: 'insufficient', kind: null, headline: null, confidence: null, reason: 'No number can be put on X' };

describe('fair to both sides, one rule (review T3, T10)', () => {
  it('passes an even deal where both lineups gain', () => {
    expect(fairToBoth({ giveValue: 40, getValue: 42, userGain: 12, partnerGain: 5 })).toEqual({ fair: true, edge: 0.048, reason: null });
  });

  it('refuses a deal more than 10% Alex’s way, in whole percents', () => {
    expect(fairToBoth({ giveValue: 40, getValue: 50, userGain: 20, partnerGain: 5 }).reason).toBe('user_edge');
    // 10.4% reads as 10%: inside the rule.
    expect(fairToBoth({ giveValue: 89.6, getValue: 100, userGain: 20, partnerGain: 5 }).fair).toBe(true);
  });

  it('refuses Alex paying 43 for 3 (the November Build a trade case)', () => {
    expect(fairToBoth({ giveValue: 43.1, getValue: 2.9, userGain: 1.4, partnerGain: 0.8 }).reason).toBe('partner_edge');
  });

  it('refuses a deal the partner gains nothing from', () => {
    expect(fairToBoth({ giveValue: 30, getValue: 30, userGain: 20, partnerGain: 0.2 }).reason).toBe('partner_gain');
  });

  it('refuses a deal under the noise bar for Alex', () => {
    expect(fairToBoth({ giveValue: 30, getValue: 30, userGain: FAIR_TO_BOTH.userMinGain - 1, partnerGain: 5 }).reason).toBe('user_gain');
  });

  it('counts a player the partner would cut at zero for him', () => {
    // Concepcion (9.2) and Love (20) for Lawrence (30.1): "about even", but they cut Love.
    const out = [
      { playerId: 'concepcion', rosValue: 9.2 },
      { playerId: 'love', rosValue: 20 },
    ];
    expect(sentValue(out, new Set())).toBeCloseTo(29.2);
    expect(sentValue(out, new Set(['love']))).toBeCloseTo(9.2);
    expect(valueEdge(9.2, 30.1)).toBeGreaterThan(FAIR_TO_BOTH.userEdgeMax);
  });
});

describe('reading Check a trade', () => {
  const side = (net: number, inn: number, out: number, drop: { playerId: string; name: string } | null = null) => ({
    net,
    incoming: [{ playerId: 'in', rosValue: inn }],
    outgoing: [{ playerId: 'out', rosValue: out }],
    mustDrop: drop,
  });

  it('carries both gains, the edge, and the player Alex would drop', () => {
    const check = seasonCheckOf({
      status: 'ok',
      insufficientReason: null,
      verdict: { kind: 'close', headline: 'Close call.' },
      confidence: 'medium',
      a: side(14, 40, 40, { playerId: 'bench', name: 'Antonio Williams' }),
      b: side(6, 40, 40),
    });
    expect(check).toMatchObject({ status: 'ok', kind: 'close', you: 14, them: 6, edge: 0, unfair: null, drop: 'Antonio Williams' });
    expect(contradicts(check)).toBe(false);
  });

  it('marks an idea where the partner’s season gain is 0 or less', () => {
    const check = seasonCheckOf({
      status: 'ok',
      insufficientReason: null,
      verdict: { kind: 'leans_a', headline: 'Leans toward you.' },
      confidence: 'medium',
      a: side(20, 40, 40),
      b: side(0, 40, 40),
    });
    expect(check.unfair).toBe('partner_gain');
    expect(contradicts(check)).toBe(true);
  });

  it('values a player the partner would cut at zero', () => {
    const check = seasonCheckOf({
      status: 'ok',
      insufficientReason: null,
      verdict: { kind: 'close', headline: 'Close call.' },
      confidence: 'medium',
      a: side(20, 30, 29),
      b: { ...side(7, 29, 30), mustDrop: { playerId: 'out', name: 'Jordan Love' } },
    });
    expect(check.unfair).toBe('user_edge');
  });

  it('reads an insufficient evaluation as not checked', () => {
    expect(seasonCheckOf({ status: 'insufficient', insufficientReason: 'why', verdict: null, confidence: 'low' }).status).toBe('insufficient');
  });
});

describe('the board keeps only fair ideas', () => {
  const board = { offers: ['a', 'b', 'c', 'd', 'e'].map((id) => offer(id)), notes: [] as string[], reserve: ['f', 'g'].map((id) => offer(id)) };
  const checks = new Map<string, SeasonCheck>([
    ['a', ok('favors_a')],
    ['b', ok('leans_b')],
    ['c', ok('close')],
    ['d', ok('close', { unfair: 'partner_gain' })],
    ['e', unchecked],
    ['f', ok('leans_a')],
    ['g', ok('close')],
  ]);

  it('leaves off what leans their way, what is not fair, and what was not checked', () => {
    const { board: out, dropped } = applySeasonChecks(board, checks);
    expect(dropped.map((o) => o.id)).toEqual(['b', 'd', 'e']);
    expect(out.offers.map((o) => o.id)).toEqual(['a', 'c', 'f', 'g']);
  });

  it('keeps an even deal that helps the user more than them: they still gain, at a fair price', () => {
    expect(contradicts(ok('favors_a', { you: 80, them: 46, edge: 0 }))).toBe(false);
  });

  it('fills the board from the reserve, and never shows the reserve itself', () => {
    const { board: out } = applySeasonChecks(board, checks);
    expect(out.offers.length).toBe(4);
    expect('reserve' in out).toBe(false);
    expect(ideasToCheck(board).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('never shows two ideas that share a player', () => {
    const shared = { offers: [offer('x', ['p1']), offer('y', ['p1'], ['other'])], notes: [] as string[] };
    const { board: out } = applySeasonChecks(shared, new Map([['x', ok('close')], ['y', ok('close')]]));
    expect(out.offers.map((o) => o.id)).toEqual(['x']);
  });

  it('puts the verdict on every idea it keeps', () => {
    const { board: out } = applySeasonChecks(board, checks);
    expect(out.offers.every((o) => o.seasonCheck != null && !contradicts(o.seasonCheck))).toBe(true);
  });

  it('says so in one line when nothing fair is left', () => {
    const { board: out } = applySeasonChecks({ offers: [offer('b')], notes: [] }, new Map([['b', ok('leans_b')]]));
    expect(out.offers).toEqual([]);
    expect(out.notes).toEqual(['No trade in this league is fair to both sides right now.']);
  });

  it('leaves the ideas as the search produced them when no check ran', () => {
    const { board: out, dropped } = applySeasonChecks(board, new Map());
    expect(out.offers.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect('reserve' in out).toBe(false);
    expect(dropped).toEqual([]);
  });

  it('labels each kept verdict in four words or fewer', () => {
    expect(seasonCheckLabel(ok('favors_a'))).toBe('Season: favors you');
    expect(seasonCheckLabel(ok('leans_a'))).toBe('Season: leans you');
    expect(seasonCheckLabel(ok('close'))).toBe('Season: close call');
    expect(seasonCheckLabel(undefined)).toBeNull();
  });
});
