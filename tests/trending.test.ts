/**
 * Trending is allowed to price a bid and raise a question. It is not allowed to
 * touch a projection, and the load-bearing test in this file is the one that
 * says so.
 */

import { describe, expect, it } from 'vitest';
import { toSnapshot, trendingHeadline, velocity, type TrendingSnapshot } from '../src/core/market/trending.ts';
import { demandFromDisagreement, detectDisagreement } from '../src/core/market/disagreement.ts';

function snapshot(rows: [string, number][], over: Partial<TrendingSnapshot> = {}): TrendingSnapshot {
  return toSnapshot(
    rows.map(([player_id, count]) => ({ player_id, count })),
    { capturedAt: '2026-09-10T12:00:00.000Z', type: 'add', lookbackHours: 24, ...over },
  );
}

describe('trending snapshots (§5)', () => {
  it('keeps Sleeper’s published order rather than re-sorting by count', () => {
    const snap = snapshot([
      ['a', 100],
      ['b', 500],
    ]);
    expect(snap.rows.map((r) => r.playerId)).toEqual(['a', 'b']);
    expect(snap.rows[0]?.rank).toBe(1);
  });

  it('derives adds per hour from the lookback window', () => {
    const v = velocity(snapshot([['a', 240]]), null).get('a');
    expect(v?.addsPerHour).toBe(10);
  });

  it('reports rank movement and acceleration across two snapshots', () => {
    const previous = snapshot([
      ['b', 480],
      ['a', 240],
    ]);
    const current = snapshot([
      ['a', 1440],
      ['b', 500],
    ]);
    const a = velocity(current, previous).get('a');
    expect(a?.rankMovement).toBe(1);
    expect(a?.acceleration).toBe(6);
    expect(trendingHeadline(a!)).toBe('Add rate accelerated 6×');
  });

  it('withholds acceleration built on a handful of adds', () => {
    const previous = snapshot([['a', 24]]); // 1/hour — below the floor
    const current = snapshot([['a', 480]]);
    expect(velocity(current, previous).get('a')?.acceleration).toBeNull();
  });

  it('refuses to compare rates from different lookback windows', () => {
    const previous = snapshot([['a', 240]], { lookbackHours: 6 });
    const current = snapshot([['a', 2400]]);
    expect(velocity(current, previous).get('a')?.acceleration).toBeNull();
  });

  it('marks a player who has just entered the list', () => {
    const v = velocity(snapshot([['new', 100]]), snapshot([['old', 100]])).get('new');
    expect(v?.entered).toBe(true);
    expect(v?.rankMovement).toBeNull();
  });

  it('says the sentence worth saying, and nothing when there is none', () => {
    const top = velocity(snapshot([['a', 9], ['b', 8]]), null).get('a');
    expect(trendingHeadline(top!, { availableInLeague: true })).toBe('#1 trending add · still available in your league');
    const buried = velocity(snapshot(Array.from({ length: 40 }, (_, i) => [`p${i}`, 40 - i] as [string, number])), null).get('p30');
    expect(trendingHeadline(buried!)).toBeNull();
  });
});

describe('trend vs model (§6)', () => {
  it('flags the market running ahead of the usage', () => {
    const d = detectDisagreement({ marketHeat: 0.9, modelStrength: 0.2, modelObserved: true });
    expect(d.kind).toBe('market_ahead');
    expect(d.confidenceDelta).toBeLessThan(0);
  });

  it('flags the model running ahead of the market — the cheap case', () => {
    const d = detectDisagreement({ marketHeat: 0.05, modelStrength: 0.8, modelObserved: true });
    expect(d.kind).toBe('model_ahead');
    expect(d.line).toContain('quiet');
  });

  it('refuses to disagree on behalf of a model with nothing behind it', () => {
    const d = detectDisagreement({ marketHeat: 0.95, modelStrength: 0.1, modelObserved: false });
    expect(d.kind).toBe('unknown');
    expect(d.confidenceDelta).toBe(0);
  });

  it('never lets a trend become a projection multiplier', () => {
    /*
     * The pin the brief asks for. Every disagreement verdict is confined to
     * confidence and to the bid price; none of them exposes anything a
     * projection could consume.
     */
    for (const heat of [0, 0.3, 0.6, 1]) {
      for (const model of [0, 0.5, 1]) {
        const d = detectDisagreement({ marketHeat: heat, modelStrength: model, modelObserved: true });
        expect(d.affects).toBe('bid_price_and_confidence_only');
        expect(Math.abs(d.confidenceDelta)).toBeLessThanOrEqual(0.1);
        expect(Object.keys(d)).not.toContain('scoreMultiplier');
        expect(Object.keys(d)).not.toContain('projectionDelta');
      }
    }
  });

  it('passes heat through to demand, and only to demand', () => {
    expect(demandFromDisagreement({ marketHeat: 0.8, modelStrength: 0.1, modelObserved: true })).toBe(0.8);
    expect(demandFromDisagreement({ marketHeat: null, modelStrength: 0.1, modelObserved: true })).toBeNull();
  });
});
