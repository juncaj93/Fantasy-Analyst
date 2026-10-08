/**
 * The Trades ideas, held to Check a trade's answer (finding T3, October 2026).
 *
 * An idea the rest-of-season check says favours the other team is left off;
 * every idea shown carries the verdict; an idea that could not be checked is
 * kept and says so; no checks at all leaves the board exactly as it was.
 */

import { describe, expect, it } from 'vitest';
import { applySeasonChecks, contradicts, seasonCheckLabel, seasonCheckOf, type SeasonCheck } from '../src/core/trades/seasonCheck.ts';
import type { OfferEvaluation } from '../src/core/trades/bilateral.ts';

const offer = (id: string) => ({ id, headline: `idea ${id}` }) as unknown as OfferEvaluation;
const ok = (kind: SeasonCheck['kind']): SeasonCheck => ({ status: 'ok', kind, headline: `${kind} headline`, confidence: 'medium', reason: null });
const unchecked: SeasonCheck = { status: 'insufficient', kind: null, headline: null, confidence: null, reason: 'No number can be put on X' };

describe('one rule for the board and the check', () => {
  const board = { offers: ['a', 'b', 'c', 'd', 'e'].map(offer), notes: [] as string[] };
  const checks = new Map<string, SeasonCheck>([
    ['a', ok('favors_a')],
    ['b', ok('leans_b')],
    ['c', ok('close')],
    ['d', ok('favors_b')],
    ['e', unchecked],
  ]);

  it('leaves off every idea the season check says favours the other team', () => {
    const { board: out, dropped } = applySeasonChecks(board, checks);
    expect(out.offers.map((o) => o.id)).toEqual(['a', 'c', 'e']);
    expect(dropped.map((o) => o.id)).toEqual(['b', 'd']);
  });

  it('says how many were left off, and why', () => {
    const { board: out } = applySeasonChecks(board, checks);
    expect(out.notes.at(-1)).toBe('2 ideas were left off: over the rest of the season, Check a trade says they favor the other team.');
  });

  it('puts the verdict on every idea it keeps, so a card cannot disagree with the check', () => {
    const { board: out } = applySeasonChecks(board, checks);
    expect(out.offers.map((o) => o.seasonCheck?.kind ?? 'unchecked')).toEqual(['favors_a', 'close', 'unchecked']);
    expect(out.offers.every((o) => !contradicts(o.seasonCheck))).toBe(true);
  });

  it('keeps an idea it could not check, and says so', () => {
    const { board: out } = applySeasonChecks(board, checks);
    const e = out.offers.find((o) => o.id === 'e')!;
    expect(e.seasonCheck?.status).toBe('insufficient');
    expect(seasonCheckLabel(e.seasonCheck)).toBe('Season: not checked');
  });

  it('leaves the board exactly as it was when no check ran', () => {
    const { board: out, dropped } = applySeasonChecks(board, new Map());
    expect(out).toBe(board);
    expect(dropped).toEqual([]);
  });

  it('labels each kept verdict in four words or fewer', () => {
    expect(seasonCheckLabel(ok('favors_a'))).toBe('Season: favors you');
    expect(seasonCheckLabel(ok('leans_a'))).toBe('Season: leans you');
    expect(seasonCheckLabel(ok('close'))).toBe('Season: close call');
    expect(seasonCheckLabel(undefined)).toBeNull();
  });

  it('reads a Check a trade evaluation the way the check itself does', () => {
    expect(
      seasonCheckOf({ status: 'ok', insufficientReason: null, verdict: { kind: 'leans_b', headline: 'Leans toward them' }, confidence: 'low' }),
    ).toEqual({ status: 'ok', kind: 'leans_b', headline: 'Leans toward them', confidence: 'low', reason: null });
    expect(seasonCheckOf({ status: 'insufficient', insufficientReason: 'why', verdict: null, confidence: 'low' }).status).toBe(
      'insufficient',
    );
  });
});
