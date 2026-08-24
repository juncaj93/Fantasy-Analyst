/**
 * A DST is never a Smart Trades target or trade asset, and an unfilled DEF slot
 * is never a roster need for trade purposes.
 *
 * ## Why this test could not have been written before
 *
 * The app has never offered a trade involving a defence, and until this lane
 * that was an **accident rather than a rule**. `tradeableFrom` drops anything
 * the engine could not score, defences were unscorable everywhere, and so the
 * exclusion held for a reason that had nothing to do with defences. Making a
 * DST scorable removes that accident. Without the two gates added alongside it,
 * the first defence with a game line would have walked into a package.
 *
 * So every fixture here uses a **genuinely scorable** defence — one with a real
 * game line, in a league with a real defence table, whose `score` is a number.
 * A test built on an unscorable DST would pass against no exclusion at all,
 * which is precisely the failure mode this file exists to close.
 *
 * ## The shape, and why it is this shape
 *
 * The invariant only has teeth in a league where trading for a defence would
 * otherwise look like a good idea. So: **I have no defence**, my partner has a
 * good one, and every other position on both rosters is adequate. A need model
 * with no exclusion reads my empty DEF slot as the biggest hole on my roster —
 * it is measured against a league where everybody else starts one — and a
 * candidate generator would find the obvious deal immediately.
 */

import { describe, expect, it } from 'vitest';
import { candidate, defence } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import {
  buildRosterViews,
  needFor,
  tradeExcluded,
  TRADE_EXCLUDED_POSITIONS,
  type RosterView,
} from '../src/core/trades/rosterUtility.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { findBilateralTrades, generateCandidates, TRADE_BOUNDS } from '../src/core/trades/bilateral.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';

const SHAPE = buildRosterShape(DST_ROSTER_POSITIONS);
const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);

/** `['rb1', 'RB', 14]`, or `['def1', 'DEF', spread, total]` for a defence. */
type Spec = [id: string, position: string, points: number] | [id: string, position: 'DEF', spread: number, total: number];

function inputFor(spec: Spec): StartSitInput {
  const [id, position] = spec;
  if (position === 'DEF') {
    const [, , spread, total] = spec as [string, 'DEF', number, number];
    return defence(id, id.toUpperCase(), { spread, total, opponent: 'OPP' });
  }
  return candidate(id, id.toUpperCase(), position, spec[2] as number);
}

function leagueOf(rosters: Record<string, Spec[]>): Map<string, RosterView> {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(rosters)) for (const spec of specs) pool.set(spec[0], inputFor(spec));
  return buildRosterViews({
    rosters: Object.entries(rosters).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape: SHAPE,
    profile: PROFILE,
  });
}

/**
 * A roster of skill players adequate everywhere, at a chosen strength.
 *
 * `offset` shifts the whole roster so two of them are not identical — a league
 * in which every roster is the same is a league with no benchmark and therefore
 * no needs at all, which would make this file pass for the wrong reason.
 */
function field(prefix: string, offset = 0): Spec[] {
  return [
    [`${prefix}qb`, 'QB', 19 + offset],
    [`${prefix}rb1`, 'RB', 15 + offset],
    [`${prefix}rb2`, 'RB', 12 + offset],
    [`${prefix}wr1`, 'WR', 16 + offset],
    [`${prefix}wr2`, 'WR', 13 + offset],
    [`${prefix}wr3`, 'WR', 11 + offset],
    [`${prefix}te1`, 'TE', 9 + offset],
    [`${prefix}fx1`, 'WR', 10 + offset],
  ];
}

/** Me: no defence. Them: a good one. Everybody else: comparable, with one. */
function theLeague() {
  return leagueOf({
    mine: field('m'),
    theirs: [...field('t', 0.5), ['tdef', 'DEF', -9.5, 41.5]],
    third: [...field('x', -0.5), ['xdef', 'DEF', -6.5, 43]],
    fourth: [...field('y', 0.25), ['ydef', 'DEF', -1, 45]],
  });
}


/**
 * A partner with no trade history at all.
 *
 * The default here for the same reason it is the default in
 * `trades.bilateral.test.ts`: the roster reasoning has to stand on its own, and
 * a fixture that quietly supplied a behaviour profile would let history prop up
 * a case the exclusion should be making.
 */
function partnerOf(views: Map<string, RosterView>, key: string, name: string) {
  return {
    view: views.get(key)!,
    partner: { key, rosterId: key.length, displayName: name, userId: `u-${key}` },
    fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
  };
}

describe('the fixture is genuinely at risk, which is what makes the test worth having', () => {
  it('scores the partner’s defence — an unscorable one would pass against no rule at all', () => {
    const views = theLeague();
    const theirs = views.get('theirs')!;

    expect(theirs.unscored.has('tdef')).toBe(false);
    expect(theirs.valueOf.get('tdef')).toBeGreaterThan(0);
    expect(evaluatePlayer(defence('tdef', 'TDEF', { spread: -9.5, total: 41.5 }), PROFILE).score).not.toBeNull();
  });

  it('and my roster really is missing the one thing they have spare', () => {
    const views = theLeague();
    expect(views.get('mine')!.positionOf.get('mdef')).toBeUndefined();
    expect([...views.get('mine')!.positionOf.values()]).not.toContain('DEF');
  });
});

describe('an empty DEF slot is not a roster need', () => {
  it('reads as adequate however empty it is', () => {
    const need = theLeague().get('mine')!.needs.get('DEF');

    expect(need).toBeDefined();
    expect(need!.level).toBe('adequate');
    expect(need!.shortfall).toBe(0);
    expect(need!.surplus).toBe(0);
  });

  it('is present in the map rather than missing from it', () => {
    // Six places in `bilateral.ts` do `needs.get(position)` and fall through to
    // their own default when it is absent. One neutral answer is a guarantee;
    // six defaults are six chances to get it wrong.
    expect(theLeague().get('mine')!.needs.has('DEF')).toBe(true);
  });

  it('stays adequate even against a league that all start one and score well', () => {
    const need = needFor({ position: 'DEF', values: [], slots: 1, benchmark: [12] });
    // A twelve-point shortfall at a required slot is a hole four times over by
    // every threshold in the module, and it is still adequate here.
    expect(need.level).toBe('adequate');
    expect(need.shortfall).toBe(0);
  });

  it('does not make the roster look like one with something to fix', () => {
    /*
     * `hasNeed()` is not exported, and is asserted through the sentence it
     * decides — which is the thing a reader actually sees, and the difference
     * between two empty states the app is careful to keep apart: "nothing in
     * this league helps both sides" and "you have nothing to fix". A roster
     * whose only gap is a defence is the second, and saying the first would be
     * inviting the reader to go looking.
     */
    const views = theLeague();
    const result = findBilateralTrades({
      me: views.get('mine')!,
      partners: [partnerOf(views, 'theirs', 'Rival')],
    });

    expect(result.offers).toEqual([]);
    expect(result.notes.join(' ')).toContain('no meaningful hole');
  });

  it('a surplus defence is not a reason to trade one away either', () => {
    // `adequate` rather than `surplus`, and deliberately: surplus is an
    // argument *for* moving somebody, and it would put a spare defence into the
    // `surplus_for_need` rationale and the "you can afford to move DEF depth"
    // sentence.
    const twoDefences = leagueOf({
      mine: [...field('m'), ['mdef1', 'DEF', -9.5, 41.5], ['mdef2', 'DEF', -6.5, 43]],
      theirs: [...field('t', 0.5), ['tdef', 'DEF', -1, 45]],
      third: field('x', -0.5),
    });

    expect(twoDefences.get('mine')!.needs.get('DEF')!.level).toBe('adequate');
    expect(twoDefences.get('mine')!.needs.get('DEF')!.surplus).toBe(0);
  });
});

describe('no offer ever contains a defence', () => {
  it('generates no candidate package with one in it', () => {
    const views = theLeague();
    const rejections: Parameters<typeof generateCandidates>[0]['rejections'] = [];
    const candidates = generateCandidates({
      me: views.get('mine')!,
      them: views.get('theirs')!,
      partnerKey: 'theirs',
      bounds: TRADE_BOUNDS,
      rejections,
    });

    for (const pkg of candidates) {
      expect(pkg.give).not.toContain('tdef');
      expect(pkg.get).not.toContain('tdef');
    }
  });

  it('surfaces no offer with one, against every partner in the league', () => {
    const views = theLeague();
    const result = findBilateralTrades({
      me: views.get('mine')!,
      partners: [
        partnerOf(views, 'theirs', 'Rival'),
        partnerOf(views, 'third', 'Third'),
        partnerOf(views, 'fourth', 'Fourth'),
      ],
    });

    const defences = new Set(['tdef', 'xdef', 'ydef']);
    for (const offer of result.offers) {
      for (const player of [...offer.give, ...offer.get]) {
        expect(defences.has(player.playerId)).toBe(false);
        expect(player.position).not.toBe('DEF');
      }
    }
  });

  it('does not offer one from my side either, when I am the one holding it', () => {
    const iHaveTwo = leagueOf({
      mine: [...field('m'), ['mdef1', 'DEF', -9.5, 41.5], ['mdef2', 'DEF', -6.5, 43]],
      theirs: field('t', 1.5),
      third: [...field('x', -1), ['xdef', 'DEF', -1, 45]],
    });
    const result = findBilateralTrades({
      me: iHaveTwo.get('mine')!,
      partners: [partnerOf(iHaveTwo, 'theirs', 'Rival'), partnerOf(iHaveTwo, 'third', 'Third')],
    });

    for (const offer of result.offers) {
      for (const player of [...offer.give, ...offer.get]) expect(player.position).not.toBe('DEF');
    }
  });

  it('never explains an offer by a hole a defence fills', () => {
    const views = theLeague();
    const result = findBilateralTrades({
      me: views.get('mine')!,
      partners: [partnerOf(views, 'theirs', 'Rival'), partnerOf(views, 'third', 'Third')],
    });

    for (const offer of result.offers) {
      // The rationale atoms and the prose alike: `fills_hole` and
      // `surplus_for_need` are both decided by a need level, so a defence that
      // could reach either would name itself in the sentence beside it.
      const sentences = [...offer.reasons, ...offer.user.rationales, ...offer.counterparty.rationales].join(' ');
      expect(sentences).not.toContain('DEF');
      expect(sentences).not.toContain('defence');

      const holeFillers = [...offer.user.rationales, ...offer.counterparty.rationales].filter(
        (r) => r === 'fills_hole' || r === 'surplus_for_need',
      );
      if (holeFillers.length > 0) {
        for (const player of [...offer.give, ...offer.get]) expect(player.position).not.toBe('DEF');
      }
    }
  });
});

describe('and nothing that is not a defence is distorted by the exclusion', () => {
  it('leaves every other position’s need exactly as it was', () => {
    /*
     * The paranoid half. The exclusion is a change to the need model, and the
     * need model is what prices every trade in the app — so the claim that it
     * touches nothing but DEF is asserted as a comparison against the identical
     * league with the defences removed entirely, position by position.
     */
    const withDefences = theLeague();
    const without = leagueOf({
      mine: field('m'),
      theirs: field('t', 0.5),
      third: field('x', -0.5),
      fourth: field('y', 0.25),
    });

    for (const key of ['mine', 'theirs', 'third', 'fourth']) {
      for (const position of ['QB', 'RB', 'WR', 'TE']) {
        expect(withDefences.get(key)!.needs.get(position)).toEqual(without.get(key)!.needs.get(position));
      }
    }
  });

  it('does not count a spare defence as bench depth', () => {
    // `depthChange` is a headline number on an offer card — "costs you one
    // startable bench player" — and a spare DST in it would let a package look
    // like it thins a roster on the strength of a unit nobody would trade for.
    const twoDefences = leagueOf({
      mine: [...field('m'), ['mdef1', 'DEF', -9.5, 41.5], ['mdef2', 'DEF', -6.5, 43]],
      theirs: field('t', 0.5),
      third: field('x', -0.5),
    });

    expect(twoDefences.get('mine')!.benchDepth.has('DEF')).toBe(false);
  });

  it('still finds the trade that is actually there', () => {
    /*
     * The exclusion must not be a way of quietly switching the engine off. A
     * league with a real, ordinary imbalance at a real position still produces
     * an offer — otherwise every assertion above would be passing because
     * nothing is ever offered at all.
     */
    const lopsided = leagueOf({
      mine: [
        ['mqb', 'QB', 19],
        ['mrb1', 'RB', 16],
        ['mrb2', 'RB', 15],
        ['mrb3', 'RB', 14],
        ['mwr1', 'WR', 16],
        ['mwr2', 'WR', 6],
        ['mwr3', 'WR', 5],
        ['mte1', 'TE', 9],
        ['mfx1', 'WR', 5],
        ['mdef', 'DEF', -9.5, 41.5],
      ],
      theirs: [
        ['tqb', 'QB', 19],
        ['trb1', 'RB', 8],
        ['trb2', 'RB', 6],
        ['twr1', 'WR', 17],
        ['twr2', 'WR', 15],
        ['twr3', 'WR', 14],
        ['twr4', 'WR', 13],
        ['tte1', 'TE', 9],
        ['tfx1', 'WR', 12],
        ['tdef', 'DEF', -6.5, 43],
      ],
      third: [...field('x', -0.5), ['xdef', 'DEF', -1, 45]],
    });

    const result = findBilateralTrades({
      me: lopsided.get('mine')!,
      partners: [partnerOf(lopsided, 'theirs', 'Rival'), partnerOf(lopsided, 'third', 'Third')],
    });

    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      for (const player of [...offer.give, ...offer.get]) expect(player.position).not.toBe('DEF');
    }
  });
});

describe('the exclusion is stated once and is not a spelling', () => {
  it('names DEF and nothing else', () => {
    expect([...TRADE_EXCLUDED_POSITIONS]).toEqual(['DEF']);
    expect(tradeExcluded('DEF')).toBe(true);
    expect(tradeExcluded('def')).toBe(true);
    expect(tradeExcluded('WR')).toBe(false);
    expect(tradeExcluded(null)).toBe(false);
    expect(tradeExcluded(undefined)).toBe(false);
  });
});
