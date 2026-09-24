/**
 * Every change the lineup card proposes has to be a lineup Sleeper will accept.
 *
 * Reported 24 September 2026, and measured on production the same morning. The
 * reader's Sleeper lineup had its DEF slot empty and Rhamondre Stevenson in
 * FLEX; the optimiser returned one swap:
 *
 *     slot DEF   in Carolina Panthers (DEF)   out Rhamondre Stevenson (RB)   +8.83
 *
 * which the Team screen printed under Stevenson's FLEX row as `Start Carolina
 * Panthers instead`, directly above a DEF row reading "Nobody eligible yet". A
 * defence cannot play FLEX, and filling an empty DEF slot benches nobody. And
 * because the pass had used Stevenson up, the change it actually wanted at FLEX
 * — Tyler Allgeier for him — was never offered.
 *
 * The fixture below is that lineup, with the production figures. The last block
 * does not know what a defence or a flex is: it checks every proposed change in
 * several league shapes against a brute-force search for a legal arrangement,
 * so the rule is shown to be general rather than patched for DEF and FLEX.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup, type LineupRecommendation } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import { DST_SCORING } from '../src/core/demo/fixtures/dst.ts';
import { candidate, defence, pricedCandidate, signalWithNet } from './helpers/startsit.ts';

/* Half PPR, six-point passing touchdowns, and a defence table so DEF can score. */
const HALF_PPR = buildScoringProfile({ ...(DST_SCORING as Record<string, number>), rec: 0.5, pass_td: 6 }, []);
const NOW = '2026-09-24T02:00:00Z';
const KICKOFF = '2026-09-27T17:00:00Z';

const LEAGUE = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN'];

/** The reader's week-3 roster, as production priced it on 24 September. */
function roster(): StartSitInput[] {
  const at = { now: NOW, kickoff: KICKOFF };
  return [
    pricedCandidate('burrow', 'Joe Burrow', 'QB', 19.89, at),
    pricedCandidate('walker', 'Kenneth Walker', 'RB', 16.57, at),
    pricedCandidate('bijan', 'Bijan Robinson', 'RB', 15.61, at),
    pricedCandidate('wilson', 'Garrett Wilson', 'WR', 10.99, at),
    pricedCandidate('egbuka', 'Emeka Egbuka', 'WR', 7.38, at),
    pricedCandidate('mcconkey', 'Ladd McConkey', 'WR', 5.78, at),
    pricedCandidate('laporta', 'Sam LaPorta', 'TE', 8.84, at),
    pricedCandidate('andrews', 'Mark Andrews', 'TE', 7.71, at),
    /* One line of four: the partial market production was holding for him. */
    candidate('stevenson', 'Rhamondre Stevenson', 'RB', 0.75, at),
    pricedCandidate('allgeier', 'Tyler Allgeier', 'RB', 6.93, at),
    defence('carolina', 'Carolina Panthers', { spread: -3, total: 41.5, opponent: 'ATL' }, { team: 'CAR', now: NOW, kickoff: KICKOFF }),
  ];
}

/** Sleeper's lineup: nine starters, DEF empty. */
const SLEEPER = ['burrow', 'bijan', 'walker', 'egbuka', 'wilson', 'mcconkey', 'laporta', 'andrews', 'stevenson'];

function lineup(published?: ReadonlyMap<string, number>): LineupRecommendation {
  return recommendLineup(roster(), buildRosterShape(LEAGUE), HALF_PPR, {
    currentStarterIds: SLEEPER,
    now: NOW,
    ...(published ? { published } : {}),
  });
}

describe('the empty DEF slot and the FLEX beside it', () => {
  it('never pairs the defence with a back', () => {
    const result = lineup();
    expect(result.swaps.find((s) => s.inPlayerId === 'carolina')).toBeUndefined();
    expect(result.swaps.find((s) => s.slot === 'DEF')).toBeUndefined();
  });

  it('recommends the defence for the empty DEF slot, benching nobody', () => {
    const fill = lineup().fills.find((f) => f.inPlayerId === 'carolina');
    expect(fill?.slot).toBe('DEF');
    expect(fill?.gain).toBeGreaterThan(0);
  });

  it('offers the FLEX change on its own merits', () => {
    /*
     * With nothing better than his one-line market, Stevenson ranks on it —
     * the behaviour every caller without a published figure has always had —
     * and Allgeier is the better back. The point is that the change is offered
     * at all: it used to be swallowed by the defence.
     */
    const swap = lineup().swaps.find((s) => s.outPlayerId === 'stevenson');
    expect(swap?.inPlayerId).toBe('allgeier');
    expect(swap?.slot).toBe('FLEX');
  });

  it('keeps Stevenson when his published week outranks the one line the market had', () => {
    const result = lineup(new Map([['stevenson', 9.8]]));
    expect(result.swaps.find((s) => s.outPlayerId === 'stevenson')).toBeUndefined();
    expect(result.slots.map((s) => s.playerId)).toContain('stevenson');
    // The DEF decision is independent of the FLEX one.
    expect(result.fills.map((f) => f.inPlayerId)).toEqual(['carolina']);
  });
});

describe('a real reshuffle is still offered', () => {
  it('lets a back into RB replace a receiver when the displaced back slides to FLEX', () => {
    const shape = buildRosterShape(['RB', 'WR', 'FLEX', 'BN', 'BN']);
    const result = recommendLineup(
      [
        pricedCandidate('rbA', 'Back A', 'RB', 10, { now: NOW }),
        pricedCandidate('wrX', 'Receiver X', 'WR', 3, { now: NOW }),
        pricedCandidate('wrY', 'Receiver Y', 'WR', 9, { now: NOW }),
        pricedCandidate('rbC', 'Back C', 'RB', 12, { now: NOW }),
      ],
      shape,
      HALF_PPR,
      { currentStarterIds: ['rbA', 'wrX', 'wrY'], now: NOW },
    );
    const swap = result.swaps.find((s) => s.inPlayerId === 'rbC');
    expect(swap?.outPlayerId).toBe('wrX');
    expect(result.fills).toEqual([]);
  });
});

describe('the other positions a flex will not take', () => {
  it('fills an empty QB slot with a quarterback and never benches a receiver for him', () => {
    const shape = buildRosterShape(['QB', 'RB', 'WR', 'FLEX', 'BN', 'BN']);
    const result = recommendLineup(
      [
        pricedCandidate('rb', 'Back', 'RB', 12, { now: NOW }),
        pricedCandidate('wr', 'Receiver', 'WR', 11, { now: NOW }),
        pricedCandidate('weak', 'Weak Receiver', 'WR', 1, { now: NOW }),
        pricedCandidate('qb', 'Passer', 'QB', 18, { now: NOW }),
      ],
      shape,
      HALF_PPR,
      { currentStarterIds: ['rb', 'wr', 'weak'], now: NOW },
    );
    expect(result.swaps.find((s) => s.inPlayerId === 'qb')).toBeUndefined();
    expect(result.fills.find((f) => f.inPlayerId === 'qb')?.slot).toBe('QB');
  });

  it('never proposes a kicker, whose slot this app does not model at all', () => {
    /*
     * `K` is a non-playing slot in `rosterShape.ts`: no row, no fill, no swap,
     * whatever figure he carries — so there is no K-for-FLEX pairing to make.
     */
    const shape = buildRosterShape(['QB', 'RB', 'FLEX', 'K', 'BN', 'BN']);
    const result = recommendLineup(
      [
        pricedCandidate('qb', 'Passer', 'QB', 18, { now: NOW }),
        pricedCandidate('rb', 'Back', 'RB', 12, { now: NOW }),
        pricedCandidate('weak', 'Weak Back', 'RB', 1, { now: NOW }),
        candidate('kicker', 'Kicker', 'K', null, { now: NOW, signal: signalWithNet(1) }),
      ],
      shape,
      HALF_PPR,
      { currentStarterIds: ['qb', 'rb', 'weak'], now: NOW, published: new Map([['kicker', 30]]) },
    );
    expect(result.slots.map((s) => s.slot)).not.toContain('K');
    expect([...result.swaps, ...result.fills].map((c) => c.inPlayerId)).not.toContain('kicker');
  });
});

/*
 * The general check. For each league shape, a Sleeper lineup with one
 * dedicated slot left empty and a bench holding one player of every position,
 * and then every proposal is tested the slow way: a swap must leave a set of
 * starters that fills exactly the slots the reader already had filled, and a
 * fill must fit a slot the reader had left empty. Brute force over slot
 * permutations, sharing no code with `lineup.ts`.
 */
describe('every proposal is a legal lineup, whatever the league', () => {
  const ACCEPTS: Record<string, string[]> = {
    FLEX: ['RB', 'WR', 'TE'],
    WRRB_FLEX: ['RB', 'WR'],
    REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  };
  const accepts = (slot: string): string[] => ACCEPTS[slot] ?? [slot];

  /** Can these positions fill exactly these slots, one each? */
  function fits(positions: string[], slots: string[]): boolean {
    if (positions.length !== slots.length) return false;
    const go = (i: number, used: boolean[]): boolean => {
      if (i === positions.length) return true;
      for (let s = 0; s < slots.length; s++) {
        if (used[s] || !accepts(slots[s]!).includes(positions[i]!)) continue;
        used[s] = true;
        if (go(i + 1, used)) return true;
        used[s] = false;
      }
      return false;
    };
    return go(0, slots.map(() => false));
  }

  const SHAPES: { name: string; slots: string[]; empty: string }[] = [
    { name: 'this league, DEF empty', slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF'], empty: 'DEF' },
    { name: 'two flexes, RB empty', slots: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRB_FLEX', 'DEF'], empty: 'RB' },
    { name: 'superflex, TE empty', slots: ['QB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'DEF'], empty: 'TE' },
    { name: 'rec flex, QB empty', slots: ['QB', 'RB', 'WR', 'TE', 'REC_FLEX', 'WRRB_FLEX'], empty: 'QB' },
  ];

  for (const shape of SHAPES) {
    it(shape.name, () => {
      /* Sleeper's starters: one player per slot, a weak one, except the empty slot. */
      const starters: StartSitInput[] = [];
      const slotOf = new Map<string, string>();
      let n = 0;
      for (const slot of shape.slots) {
        if (slot === shape.empty) continue;
        const position = accepts(slot)[accepts(slot).length - 1]!;
        const id = `s${n++}`;
        slotOf.set(id, slot);
        starters.push(
          position === 'DEF'
            ? defence(id, `Starter ${id}`, { spread: 3, total: 38 }, { now: NOW })
            : pricedCandidate(id, `Starter ${id}`, position, 2 + n / 10, { now: NOW }),
        );
      }
      /* A bench holding one strong player of every position. */
      const bench: StartSitInput[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((position, i) =>
        position === 'DEF'
          ? defence(`b${i}`, `Bench ${position}`, { spread: -7, total: 47 }, { now: NOW })
          : position === 'K'
            ? candidate(`b${i}`, `Bench ${position}`, 'K', null, { now: NOW, signal: signalWithNet(1) })
            : pricedCandidate(`b${i}`, `Bench ${position}`, position, 14, { now: NOW }),
      );
      const result = recommendLineup([...starters, ...bench], buildRosterShape([...shape.slots, 'BN']), HALF_PPR, {
        currentStarterIds: starters.map((s) => s.player.id),
        now: NOW,
        published: new Map([['b4', 9]]),
      });

      const positionOf = new Map([...starters, ...bench].map((i) => [i.player.id, i.player.position]));
      const occupied = shape.slots.filter((s) => s !== shape.empty);
      const lineupNow = new Set(starters.map((s) => s.player.id));

      expect(result.swaps.length + result.fills.length, 'the fixture has to propose something').toBeGreaterThan(0);

      /*
       * A fill seats one more starter than Sleeper has, in every slot: it may
       * arrive by a reshuffle (a quarterback into SUPER_FLEX with the tight end
       * who was there sliding into the empty TE slot), and that is legal.
       */
      for (const fill of result.fills) {
        const after = [...lineupNow, fill.inPlayerId];
        expect(fits(after.map((id) => positionOf.get(id)!), shape.slots), `${fill.inName} fills a slot`).toBe(true);
        lineupNow.add(fill.inPlayerId);
      }
      const filledSlots = result.fills.length > 0 ? shape.slots : occupied;
      for (const swap of result.swaps) {
        const after = [...lineupNow].filter((id) => id !== swap.outPlayerId);
        after.push(swap.inPlayerId);
        expect(
          fits(after.map((id) => positionOf.get(id)!), filledSlots),
          `${swap.inName} (${positionOf.get(swap.inPlayerId)}) over ${swap.outName} (${positionOf.get(swap.outPlayerId)})`,
        ).toBe(true);
      }
    });
  }
});
