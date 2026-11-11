/**
 * The trade finder (Round 19) on Alex's real league, rebuilt from the Round 16
 * backtest file with no database: Tony's Pizza Fantasy as it stood at weeks 6
 * to 10. The Round 16 backtest replayed six weeks and found no idea ever
 * passed; the old search took six players a side and threw most packages out
 * on weekly guesses before the season rule was asked. These pin what the
 * finder must do instead.
 */

import { describe, expect, it } from 'vitest';
import { round16League, type Round16League } from './helpers/round16League.ts';
import { FINDER, fastLineups, findTrades, lineupSolver, type FinderInput, type FinderRoster } from '../src/core/trades/finder.ts';
import { evaluateTrade, type TradeSide } from '../src/core/tradeValue/evaluate.ts';
import { verdictOfEvaluation, tradeVerdict, VERDICT_WORDS } from '../src/core/trades/verdict.ts';
import { bestLineup, slotsOf, type LineupCandidate } from '../src/core/tradeValue/lineup.ts';
import { tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import type { ActivityClass } from '../src/core/trades/activity.ts';

function inputOf(L: Round16League, activity: (rosterId: number) => ActivityClass = () => 'unknown'): FinderInput {
  return {
    horizon: L.horizon,
    shape: L.shape,
    replacement: L.replacement,
    rates: L.rates,
    rosterLimit: L.rosterLimit,
    rosters: L.rosters.map(
      (r): FinderRoster => ({
        ...r,
        activity: { class: activity(r.rosterId), thisSeason: L.tradesBefore.get(r.rosterId) ?? 0, withYou: L.tradesWithMe.get(r.rosterId) ?? 0, line: '' },
      }),
    ),
  };
}

function checkDirectly(L: Round16League, partnerId: number, give: string[], get: string[]) {
  const side = (rosterId: number): TradeSide => {
    const r = L.rosters.find((x) => x.rosterId === rosterId)!;
    return { label: r.label, rosterId, isMine: r.isMine, roster: r.playerIds.map((id) => L.rates.get(id)!).filter(Boolean), starterIds: r.starterIds };
  };
  const mine = L.rosters.find((r) => r.isMine)!;
  return evaluateTrade({ horizon: L.horizon, shape: L.shape, replacement: L.replacement, a: side(mine.rosterId), b: side(partnerId), rosterLimit: L.rosterLimit, aSends: give, bSends: get });
}

describe('the trade finder on Alex’s real week 10', () => {
  const L = round16League(10);
  const result = findTrades(inputOf(L));

  it('finds fair offers where the old search found none', () => {
    expect(result.status).toBe('fair');
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.length).toBeLessThanOrEqual(FINDER.shown);
  });

  it('shows only deals fair to both sides, with the numbers Check a trade prints for them', () => {
    for (const offer of result.offers) {
      const evaluation = checkDirectly(L, offer.partner.rosterId, offer.give.map((p) => p.playerId), offer.get.map((p) => p.playerId));
      const reading = verdictOfEvaluation(evaluation)!;
      expect(reading.fairToBoth, offer.id).toBe(true);
      expect(reading.verdict).not.toBe('bad');
      expect(offer.kind).toBe('fair');
      expect(offer.you.restOfSeason).toBe(Math.round(evaluation.a!.net * 10) / 10);
      expect(offer.them.restOfSeason).toBe(Math.round(evaluation.b!.net * 10) / 10);
      expect(offer.edgePercent).toBe(reading.edgePercent);
      expect(offer.edgePercent).toBeLessThanOrEqual(10);
      expect(offer.edgePercent).toBeGreaterThanOrEqual(-25);
      expect([VERDICT_WORDS.fair, VERDICT_WORDS.good]).toContain(offer.label);
    }
  });

  it('never uses a player twice and sends at most two offers to one manager', () => {
    const ids = result.offers.flatMap((o) => [...o.give, ...o.get].map((p) => p.playerId));
    expect(new Set(ids).size).toBe(ids.length);
    const perPartner = new Map<number, number>();
    for (const o of result.offers) perPartner.set(o.partner.rosterId, (perPartner.get(o.partner.rosterId) ?? 0) + 1);
    for (const n of perPartner.values()) expect(n).toBeLessThanOrEqual(FINDER.perPartner);
  });

  it('says what each step removed, and every count adds up', () => {
    const f = result.funnel;
    expect(f.generated).toBeGreaterThan(10_000);
    expect(f.checked).toBeLessThanOrEqual(FINDER.checked);
    expect(f.fair).toBeGreaterThan(0);
    expect(f.removed.worthless_piece).toBeGreaterThan(0);
    expect(f.removed.value_far_apart).toBeGreaterThan(0);
  });

  it('gives every offer one short reason and a this-week, rest-of-season and playoff number', () => {
    for (const o of result.offers) {
      expect(o.reason.length).toBeGreaterThan(5);
      expect(o.reason).not.toMatch(/—/);
      expect(Number.isFinite(o.you.thisWeek)).toBe(true);
      expect(Number.isFinite(o.you.playoffs)).toBe(true);
    }
  });

  it('runs in a bounded time', () => {
    const input = inputOf(L);
    findTrades(input);
    const started = performance.now();
    findTrades(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('when nothing is fully fair', () => {
  const L = round16League(6);
  const result = findTrades(inputOf(L));

  it('shows the closest few, each labelled close with its exact edge, never as fair', () => {
    expect(result.status).toBe('close');
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.length).toBeLessThanOrEqual(FINDER.shown);
    expect(result.note).toMatch(/closest/i);
    for (const offer of result.offers) {
      expect(offer.kind).toBe('close');
      expect(offer.label).toMatch(/^Close: /);
      expect(Number.isInteger(offer.edgePercent)).toBe(true);
      const reading = verdictOfEvaluation(checkDirectly(L, offer.partner.rosterId, offer.give.map((p) => p.playerId), offer.get.map((p) => p.playerId)))!;
      expect(reading.fairToBoth).toBe(false);
      expect(reading.verdict).not.toBe('bad');
      expect(offer.you.restOfSeason).toBeGreaterThan(0);
      expect(offer.them.restOfSeason).toBeGreaterThan(0);
    }
  });
});

describe('partners', () => {
  const L = round16League(10);

  it('sends nothing to a manager the record shows almost never trades', () => {
    const found = findTrades(inputOf(L, () => 'effectively_inactive'));
    expect(found.offers).toEqual([]);
    expect(found.funnel.skippedPartners).toBe(9);
    expect(found.note).toMatch(/trades often/);
  });

  it('ranks a manager who trades often ahead of the same deal with one whose record is thin', () => {
    const plain = findTrades(inputOf(L));
    const active = findTrades(inputOf(L, () => 'active'));
    const shared = plain.offers.filter((o) => active.offers.some((a) => a.id === o.id));
    expect(shared.length).toBeGreaterThan(0);
    for (const o of shared) {
      const boosted = active.offers.find((a) => a.id === o.id)!;
      expect(boosted.score - o.score).toBeCloseTo(FINDER.rank.partnerActive, 6);
    }
  });
});

describe('the deadline', () => {
  it('suggests nothing once trades have closed', () => {
    const L = round16League(10);
    const horizon = tradeHorizon({ leagueSettings: { ...L.settings, trade_deadline: 9 }, currentWeek: 10 });
    const result = findTrades({ ...inputOf(L), horizon });
    expect(result.status).toBe('closed');
    expect(result.offers).toEqual([]);
  });
});

describe('the fast lineup', () => {
  const L = round16League(10);
  const slots = slotsOf(L.shape);

  it('gives the exact best lineup total, week by week, before and after any swap', () => {
    const fills: LineupCandidate[] = [];
    for (const [position, level] of L.replacement) {
      const n = slots.filter((s) => s.eligible.has(position)).length;
      for (let i = 0; i < n; i++) fills.push({ id: `r:${position}:${i}`, position, value: level.rate });
    }
    const fast = fastLineups({ slots, fills, rates: L.rates, weeks: L.horizon.weeks.length })!;
    expect(fast).not.toBeNull();
    const exact = (ids: readonly string[], w: number) =>
      bestLineup(slots, [
        ...ids.map((id) => L.rates.get(id)!).filter((r) => r.rate != null).map((r) => ({ id: r.playerId, position: r.position, value: r.rate! * (r.weekly[w] ?? 1) })),
        ...fills,
      ]).total;
    const [a, b] = [L.rosters[0]!, L.rosters[3]!];
    const base = fast.base(a.playerIds);
    for (let i = 0; i < 6; i++) {
      const out = [a.playerIds[i]!, a.playerIds[(i + 5) % a.playerIds.length]!];
      const inn = [b.playerIds[i]!];
      const after = fast.totals(base, out, inn);
      const ids = [...a.playerIds.filter((id) => !out.includes(id)), ...inn];
      after.forEach((total, w) => expect(total).toBeCloseTo(exact(ids, w), 6));
    }
    fast.totals(base).forEach((total, w) => expect(total).toBeCloseTo(exact(a.playerIds, w), 6));
  });

  it('agrees with the exact solver on a single flex shape', () => {
    const solve = lineupSolver(slots);
    const roster = L.rosters[1]!.playerIds.map((id) => L.rates.get(id)!).map((r) => ({ id: r.playerId, position: r.position, value: r.rate ?? 0 }));
    expect(solve(roster)).toBeCloseTo(bestLineup(slots, roster).total, 6);
  });
});

describe('one verdict for both screens', () => {
  const base = { giveValue: 100, getValue: 100, weightedWeeks: 9.5, band: 4 };

  it('calls a deal fair to both sides Fair', () => {
    expect(tradeVerdict({ ...base, you: 12, them: 10 }).verdict).toBe('fair');
  });
  it('calls a deal that does not help Alex Bad for you', () => {
    expect(tradeVerdict({ ...base, you: -1, them: 10 }).verdict).toBe('bad');
    expect(tradeVerdict({ ...base, you: 0, them: 0 }).verdict).toBe('bad');
  });
  it('calls a deal where they gain clearly more Bad for you, even when the values are even', () => {
    expect(tradeVerdict({ ...base, you: 9, them: 20 }).verdict).toBe('bad');
  });
  it('calls a deal that helps Alex and tilts his way Good for you', () => {
    const r = tradeVerdict({ ...base, getValue: 130, you: 15, them: 12 });
    expect(r.verdict).toBe('good');
    expect(r.unfair).toBe('user_edge');
    expect(r.edgePercent).toBe(23);
  });
  it('calls an even deal with a small gain Fair, but not fair to both sides by the rule', () => {
    const r = tradeVerdict({ ...base, you: 4, them: 4 });
    expect(r.verdict).toBe('fair');
    expect(r.fairToBoth).toBe(false);
    expect(r.unfair).toBe('user_gain');
  });
});
