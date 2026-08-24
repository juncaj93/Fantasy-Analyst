/**
 * Smart Bilateral Trades: the offers, the gates, and the bounds.
 *
 * Nothing here is mocked below the engine. Every roster is built from real
 * `StartSitInput`s whose Vegas props convert to a chosen number of points, so a
 * test that says "his lineup gains four" is a test of the same optimiser the
 * Team screen draws — which is the only way a test about a trade can also be a
 * test about the valuation it rests on.
 *
 * The cases are the brief's §22 list, and each defends a specific failure that
 * makes a trade tool worthless:
 *
 *   - a deal that helps the user and harms the partner is a fantasy, not a
 *     trade, and must be rejected rather than ranked low;
 *   - a deal that is even on value and does nothing for either roster is
 *     arithmetic nobody acts on;
 *   - a star for a pile of scraps must never survive to a screen;
 *   - and the search must be provably bounded, because the alternative is an
 *     endpoint that gets slower as a league gets deeper.
 */

import { describe, expect, it } from 'vitest';
import { candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, medianByRank, needFor, positionSlots, type RosterView } from '../src/core/trades/rosterUtility.ts';
import {
  FAIRNESS_BANDS,
  MIN_USER_GAIN,
  TRADE_BOUNDS,
  fairnessOf,
  findBilateralTrades,
  generateCandidates,
  packageKey,
  type BilateralInput,
  type OfferEvaluation,
} from '../src/core/trades/bilateral.ts';
import { MANAGER_FIT_CAP } from '../src/core/trades/managerFit.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];
const profile = buildScoringProfile({}, POSITIONS);
const shape = buildRosterShape(POSITIONS);

/** `['rb1', 'RB', 14]` — a player worth about fourteen points a week. */
type Spec = [id: string, position: string, points: number];

interface Fixture {
  views: Map<string, RosterView>;
  pool: Map<string, StartSitInput>;
}

/**
 * A league of rosters, each a list of players at chosen weekly values.
 *
 * The engine subtracts an uncertainty point from a market-only projection, so a
 * player specified at 14 scores about 13. Every assertion below is therefore
 * written about *differences* rather than absolute totals — which is how these
 * ought to read anyway, and means a change to the engine's own components
 * cannot silently invalidate a trade test.
 */
function leagueOf(rosters: Record<string, Spec[]>): Fixture {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(rosters)) {
    for (const [id, position, points] of specs) {
      pool.set(id, candidate(id, id.toUpperCase(), position, points));
    }
  }
  const views = buildRosterViews({
    rosters: Object.entries(rosters).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape,
    profile,
  });
  return { views, pool };
}

/**
 * A partner with no history at all.
 *
 * The default for every bilateral test on purpose: the roster reasoning has to
 * stand on its own, and a fixture that quietly supplied a trade record would let
 * behaviour prop up a case the lineup arithmetic should be making.
 */
function partnerOf(views: Map<string, RosterView>, key: string, name = `Manager ${key}`) {
  return {
    view: views.get(key)!,
    partner: { key, rosterId: Number(key), displayName: name, userId: `u${key}` },
    fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
  };
}

function run(fixture: Fixture, mineKey: string, partnerKeys: string[], bounds?: BilateralInput['bounds']) {
  return findBilateralTrades({
    me: fixture.views.get(mineKey)!,
    partners: partnerKeys.map((k) => partnerOf(fixture.views, k)),
    ...(bounds ? { bounds } : {}),
  });
}

/** Every offer's package, as a readable string, for diagnosis on failure. */
function shapes(offers: OfferEvaluation[]): string[] {
  return offers.map((o) => `${o.give.map((p) => p.playerId).join('+')} > ${o.get.map((p) => p.playerId).join('+')}`);
}

// ------------------------------------------------------------------------- //

describe('need and surplus are not position counts', () => {
  it('reads a thin second starter as a hole even when the roster is deep at the position', () => {
    /*
     * Four running backs and a hole at running back. The count says depth; the
     * lineup says the second slot is four points light against what the rest of
     * the league starts there, and the lineup is right.
     */
    const need = needFor({ position: 'RB', values: [14, 4, 3, 2], slots: 2.5, benchmark: [14, 12, 6, 3] });
    expect(need.startable).toBe(4);
    expect(need.level).toBe('hole');
    expect(need.shortfall).toBeGreaterThan(3);
  });

  it('does not call a single elite starter a hole in a one-slot league', () => {
    const need = needFor({ position: 'TE', values: [15], slots: 1, benchmark: [9] });
    expect(need.level).not.toBe('hole');
    expect(need.shortfall).toBe(0);
  });

  it('counts genuinely spare startable depth as surplus', () => {
    const need = needFor({ position: 'WR', values: [16, 15, 14, 13, 12], slots: 2.5, benchmark: [15, 13, 8, 4, 2] });
    expect(need.level).toBe('surplus');
    expect(need.surplus).toBeGreaterThanOrEqual(2);
  });

  it('gives a flex-eligible position a share of the flex, not a whole slot', () => {
    const slots = positionSlots(shape);
    expect(slots.get('RB')).toBeGreaterThan(2);
    expect(slots.get('RB')).toBeLessThan(3);
    expect(slots.get('QB')).toBe(1);
  });

  it('treats a roster with nobody at a rank as a zero in the benchmark, not as absent', () => {
    /*
     * Otherwise the benchmark measures "the median of rosters deep enough to
     * have three of these", which rises as the position gets scarcer — the exact
     * inverse of scarcity.
     */
    expect(medianByRank([[10, 8, 6], [10], [10]])).toEqual([10, 0, 0]);
  });
});

describe('the three gates', () => {
  it('surfaces a deal that helps both teams', () => {
    /*
     * I am deep at receiver and thin at running back; he is the mirror. The
     * textbook trade, and if this does not appear nothing else matters.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['wr5', 'WR', 4], ['wr6', 'WR', 3], ['te2', 'TE', 9]],
      '3': [['qb3', 'QB', 16], ['rb6', 'RB', 12], ['rb7', 'RB', 11], ['wr7', 'WR', 12], ['wr8', 'WR', 11], ['te3', 'TE', 8]],
    });

    const report = run(fixture, '1', ['2', '3']);

    expect(report.offers.length).toBeGreaterThan(0);
    const best = report.offers[0]!;
    expect(best.user.starterGain).toBeGreaterThanOrEqual(MIN_USER_GAIN);
    expect(best.counterparty.starterGain).toBeGreaterThan(0);
    expect(best.reasons.join(' ')).toMatch(/both teams improve|upgrades your|fills your/i);
  });

  it('rejects a deal that helps the user and materially harms the partner', () => {
    /*
     * He has one good receiver and nothing behind him. Taking it improves my
     * lineup and guts his, which is a deal he would decline — so it must never
     * reach a screen, and the rejection must be nameable.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 13], ['wr1', 'WR', 4], ['wr2', 'WR', 4], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 14], ['rb4', 'RB', 13], ['wr5', 'WR', 16], ['wr6', 'WR', 4], ['te2', 'TE', 9]],
    });

    const report = run(fixture, '1', ['2']);
    const tookHisStar = report.offers.some((o) => o.get.some((p) => p.playerId === 'wr5'));

    expect(tookHisStar).toBe(false);
    expect(report.rejections.map((r) => r.reason)).toContain('harms_counterparty');
  });

  it('rejects an even deal with no roster logic for either side', () => {
    /*
     * Two identical rosters swapping like for like. Every value is even, nothing
     * changes for anybody, and a calculator would happily print a dozen of these.
     */
    const symmetric: Spec[] = [['qb', 'QB', 18], ['rba', 'RB', 14], ['rbb', 'RB', 13], ['wra', 'WR', 15], ['wrb', 'WR', 14], ['te', 'TE', 9]];
    const fixture = leagueOf({
      '1': symmetric,
      '2': symmetric.map(([id, pos, pts]) => [`${id}x`, pos, pts] as Spec),
    });

    const report = run(fixture, '1', ['2']);
    expect(report.offers).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/no bilateral trade|no meaningful hole/i);
  });

  it('rejects a star for a pile of scraps on the objective value gate alone', () => {
    const give = [{ playerId: 'a', name: 'A', position: 'WR', value: 3 }, { playerId: 'b', name: 'B', position: 'WR', value: 3 }];
    const get = [{ playerId: 'c', name: 'C', position: 'RB', value: 18 }];

    const fairness = fairnessOf(give, get);
    expect(fairness.band).toBe('outside_range');
    expect(Math.abs(fairness.gap)).toBeGreaterThan(FAIRNESS_BANDS.edge);
  });

  it('refuses a package that would leave one of my slots empty', () => {
    /*
     * My only quarterback, in a league that starts one. Whatever comes back, the
     * lineup afterwards cannot fill QB — which is illegal in the only sense that
     * matters and is caught by the optimiser rather than by a rule about counts.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 20], ['rb1', 'RB', 14], ['rb2', 'RB', 4], ['wr1', 'WR', 15], ['wr2', 'WR', 14], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 18], ['qb3', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['wr5', 'WR', 5], ['te2', 'TE', 8]],
    });

    const report = run(fixture, '1', ['2']);
    const sentMyOnlyQb = report.offers.some((o) => o.give.some((p) => p.playerId === 'qb1'));
    expect(sentMyOnlyQb).toBe(false);
  });
});

describe('roster logic the offers must be able to name', () => {
  it('names the acquisition entering the lineup and who it displaces', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 8]],
    });

    const report = run(fixture, '1', ['2']);
    const best = report.offers[0];
    expect(best).toBeDefined();
    expect(best!.user.entersLineup.length).toBeGreaterThan(0);
    expect(best!.reasons.join(' ')).toMatch(/fills your|upgrades your/i);
  });

  it('recognises surplus-for-need on both sides', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 15], ['wr4', 'WR', 14], ['wr5', 'WR', 14], ['wr6', 'WR', 13], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 15], ['rb5', 'RB', 14], ['rb6', 'RB', 13], ['rb7', 'RB', 13], ['wr7', 'WR', 4], ['wr8', 'WR', 3], ['te2', 'TE', 9]],
    });

    const report = run(fixture, '1', ['2']);
    expect(report.offers.length).toBeGreaterThan(0);
    const rationales = report.offers.flatMap((o) => o.counterparty.rationales);
    expect(rationales).toContain('surplus_for_need');
  });

  it('offers a consolidation only to a roster deep enough to afford it', () => {
    /*
     * Two startable receivers for one better running back. It is a real idea for
     * a roster with bench cover and a bad one for a roster without, and the
     * rationale exists only in the first case.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 15], ['wr2', 'WR', 14], ['wr3', 'WR', 13], ['wr4', 'WR', 12], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 18], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 9]],
    });

    const report = run(fixture, '1', ['2']);
    const packages = report.offers.filter((o) => o.give.length === 2);
    for (const offer of packages) {
      // A 2-for-1 that reaches a screen has to say what it does for them.
      expect(offer.counterparty.rationales.length).toBeGreaterThan(0);
    }
  });

  it('charges a caveat when a deal costs the user startable depth', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 15], ['wr2', 'WR', 14], ['wr3', 'WR', 13], ['wr4', 'WR', 13], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 18], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['wr6', 'WR', 4], ['te2', 'TE', 9]],
    });

    const report = run(fixture, '1', ['2']);
    const costly = report.offers.find((o) => o.user.depthChange < 0);
    if (costly) expect(costly.caveats.join(' ')).toMatch(/bench player/i);
  });
});

describe('the search is bounded and deterministic', () => {
  /** A twelve-team league of sixteen-man rosters: the realistic worst case. */
  function bigLeague() {
    const rosters: Record<string, Spec[]> = {};
    for (let team = 1; team <= 12; team++) {
      const specs: Spec[] = [];
      for (let i = 0; i < 16; i++) {
        const position = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'RB'][i % 8]!;
        // Deterministic spread, different per team, no randomness anywhere.
        specs.push([`p${team}_${i}`, position, 4 + ((team * 7 + i * 3) % 14)]);
      }
      rosters[String(team)] = specs;
    }
    return leagueOf(rosters);
  }

  it('never scores more candidates than the documented bound allows', () => {
    const fixture = bigLeague();
    const report = run(fixture, '1', ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);

    expect(report.partners).toBe(11);
    expect(report.scored).toBeLessThanOrEqual(TRADE_BOUNDS.scoredPerPartner * report.partners);
    expect(report.offers.length).toBeLessThanOrEqual(TRADE_BOUNDS.offersTotal);
  });

  it('caps candidates per partner before the optimiser is ever asked', () => {
    const fixture = bigLeague();
    const rejections: never[] = [];
    const candidates = generateCandidates({
      me: fixture.views.get('1')!,
      them: fixture.views.get('2')!,
      partnerKey: '2',
      bounds: TRADE_BOUNDS,
      rejections,
    });

    /*
     * The generator itself is capped by construction: at most one 1-for-1, one
     * 2-for-1 and one 1-for-2 per (target, give) pairing, and both lists are
     * sliced before the loop.
     */
    const pairings = TRADE_BOUNDS.targetsPerPartner * TRADE_BOUNDS.givePerPartner;
    expect(candidates.length).toBeLessThanOrEqual(pairings * 3);
  });

  it('produces the same board twice from the same inputs', () => {
    const a = run(bigLeague(), '1', ['2', '3', '4', '5']);
    const b = run(bigLeague(), '1', ['2', '3', '4', '5']);
    expect(shapes(a.offers)).toEqual(shapes(b.offers));
    expect(a.offers.map((o) => o.score)).toEqual(b.offers.map((o) => o.score));
  });

  it('emits no duplicate packages, in either spelling', () => {
    const report = run(bigLeague(), '1', ['2', '3', '4', '5', '6']);
    const keys = report.offers.map((o) => packageKey(o.give.map((p) => p.playerId), o.get.map((p) => p.playerId)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never offers the same player of mine to two different managers', () => {
    /*
     * The near-duplicate failure §24 names, in the form a real league actually
     * produces it: the same spare receiver is the right thing to send to four
     * different people, so four of five "ideas" are one decision wearing
     * different names. A reader has one of him.
     */
    const report = run(bigLeague(), '1', ['2', '3', '4', '5', '6', '7', '8']);
    const involved = report.offers.flatMap((o) => [...o.give, ...o.get].map((p) => p.playerId));
    expect(new Set(involved).size).toBe(involved.length);
  });

  it('never lists the same target twice for one partner', () => {
    const report = run(bigLeague(), '1', ['2'], { offersPerPartner: 5, offersTotal: 20 });
    const targets = report.offers.flatMap((o) => o.get.map((p) => p.playerId));
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('reports how many candidates it dropped rather than dropping them silently', () => {
    const report = run(bigLeague(), '1', ['2', '3', '4']);
    const pruned = report.rejections.filter((r) => r.reason === 'pruned_by_bound');
    if (report.generated > TRADE_BOUNDS.scoredPerPartner) {
      expect(pruned.length).toBeGreaterThan(0);
      expect(pruned[0]!.detail).toMatch(/dropped before scoring/);
    }
  });
});

describe('degradation', () => {
  it('works with no manager history at all', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 8]],
    });

    const report = run(fixture, '1', ['2']);
    expect(report.offers.length).toBeGreaterThan(0);
    for (const offer of report.offers) {
      expect(offer.managerFit.contribution).toBe(0);
      expect(offer.managerFit.activity).toBe('unknown');
    }
  });

  it('says there is nothing rather than inventing filler', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 13], ['wr1', 'WR', 15], ['wr2', 'WR', 14], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 5], ['rb3', 'RB', 4], ['rb4', 'RB', 3], ['wr5', 'WR', 4], ['te2', 'TE', 3]],
    });

    const report = run(fixture, '1', ['2']);
    expect(report.offers).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('survives a roster whose players cannot be scored', () => {
    const pool = new Map<string, StartSitInput>();
    // No props at all: the engine returns a null score and the player is unscorable.
    for (const id of ['x1', 'x2', 'x3']) pool.set(id, candidate(id, id, 'WR', null));
    for (const [id, pts] of [['y1', 15], ['y2', 14], ['y3', 13]] as const) {
      pool.set(id, candidate(id, id, 'RB', pts));
    }

    const views = buildRosterViews({
      rosters: [
        { key: '1', playerIds: ['x1', 'x2', 'x3'] },
        { key: '2', playerIds: ['y1', 'y2', 'y3'] },
      ],
      pool,
      shape,
      profile,
    });

    const report = findBilateralTrades({
      me: views.get('1')!,
      partners: [
        {
          view: views.get('2')!,
          partner: { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' },
          fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
        },
      ],
    });

    // No throw, no offers built from players nobody could price.
    expect(report.offers.every((o) => [...o.give, ...o.get].every((p) => Number.isFinite(p.value)))).toBe(true);
  });

  it('handles an empty league and a roster with no partners', () => {
    const fixture = leagueOf({ '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14]] });
    const report = findBilateralTrades({ me: fixture.views.get('1')!, partners: [] });

    expect(report.offers).toEqual([]);
    expect(report.partners).toBe(0);
    expect(report.notes.join(' ')).toMatch(/no other rosters/i);
  });
});

describe('behaviour cannot overrule the objective gates', () => {
  /** A manager whose record is as strong as the module can represent. */
  const enthusiast = {
    tendencies: {
      userId: 'u2',
      displayName: 'Two',
      seasons: ['2023', '2024', '2025', '2026'],
      sample: 20,
      tradesPerSeason: 5,
      usable: true,
      plausibility: 'plausible' as const,
      medianWeek: 5,
      preseasonShare: 0,
      meanReceived: 1,
      meanSent: 1,
      typicalShape: 'one_for_one' as const,
      consolidationRate: 0,
      acquires: ['WR', 'RB', 'QB', 'TE'],
      sends: ['WR', 'RB', 'QB', 'TE'],
      repeatPartners: [{ userId: 'u1', displayName: 'One', trades: 6 }],
      includesPicks: true,
      includesFaab: true,
      confidence: 0.95,
      notes: [],
    },
    seasonsObserved: 4,
    historyComplete: true,
    askingUserId: 'u1',
    leagueRate: 0.5,
  };

  it('does not rescue a trade that would gut the partner', () => {
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 13], ['wr1', 'WR', 4], ['wr2', 'WR', 4], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 14], ['rb4', 'RB', 13], ['wr5', 'WR', 16], ['wr6', 'WR', 4], ['te2', 'TE', 9]],
    });

    const report = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [{ view: fixture.views.get('2')!, partner: { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' }, fit: enthusiast }],
    });

    expect(report.offers.some((o) => o.get.some((p) => p.playerId === 'wr5'))).toBe(false);
  });

  it('does not rescue a value gap outside the recommendation range', () => {
    /*
     * The gate that proves the ordering of the pipeline: fairness is decided
     * before a profile is read, so the strongest record in the league cannot
     * bring a star-for-scraps package back.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 13], ['wr1', 'WR', 3], ['wr2', 'WR', 3], ['wr3', 'WR', 3], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 14], ['rb4', 'RB', 13], ['wr5', 'WR', 20], ['wr6', 'WR', 19], ['te2', 'TE', 9]],
    });

    const report = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [{ view: fixture.views.get('2')!, partner: { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' }, fit: enthusiast }],
    });

    expect(report.offers).toEqual([]);
    expect(report.rejections.map((r) => r.reason)).toContain('value_gap_outside_range');
  });

  it('costs an unmeasured manager nothing at all', () => {
    /*
     * §10 and §18 both require unknown to be neutral, and "neutral" has to mean
     * the composite is *identical* — not merely that the fit contribution is
     * zero. Evidence confidence used to be a second, uncapped channel here: an
     * unmeasured manager scored zero on it and every offer in a league nobody
     * had backfilled ranked below an identical one in a league that had been.
     *
     * The same offer, the same rosters, one manager unmeasured and the other
     * measured with a fit that happens to net zero. The scores must match.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 8]],
    });
    const view = fixture.views.get('2')!;
    const partner = { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' };

    const unmeasured = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [{ view, partner, fit: { tendencies: null, seasonsObserved: 0, historyComplete: false } }],
    });
    const measured = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [
        {
          view,
          partner,
          // A measured manager whose terms happen to cancel to nothing.
          fit: { tendencies: null, seasonsObserved: 1, historyComplete: true, leagueRate: 1 },
        },
      ],
    });

    expect(unmeasured.offers.length).toBeGreaterThan(0);
    expect(unmeasured.offers[0]!.managerFit.contribution).toBe(0);
    expect(unmeasured.offers[0]!.score).toBe(measured.offers[0]!.score);
  });

  it('bounds the whole behavioural influence at the documented cap', () => {
    /*
     * The property the cap is supposed to have, asserted on the composite rather
     * than on the contribution: no manager reading may move an offer's score by
     * more than `MANAGER_FIT_CAP`, in either direction, against the same offer
     * read with no history at all.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 8]],
    });
    const view = fixture.views.get('2')!;
    const partner = { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' };
    const me = fixture.views.get('1')!;

    const baseline = findBilateralTrades({
      me,
      partners: [{ view, partner, fit: { tendencies: null, seasonsObserved: 0, historyComplete: false } }],
    }).offers[0]!;

    for (const fit of [
      enthusiast,
      { tendencies: null, seasonsObserved: 4, historyComplete: true, leagueRate: 1 },
    ]) {
      const offer = findBilateralTrades({ me, partners: [{ view, partner, fit }] }).offers[0];
      expect(offer).toBeDefined();
      expect(Math.abs(offer!.score - baseline.score)).toBeLessThanOrEqual(MANAGER_FIT_CAP + 1e-9);
    }
  });

  it('lowers rank for a measured non-trader without hiding the best roster fit', () => {
    /*
     * §10, stated as an outcome rather than as a constant: the same offer, the
     * same rosters, one manager measured and quiet and the other measured and
     * active. Both survive; only the order changes.
     */
    const fixture = leagueOf({
      '1': [['qb1', 'QB', 18], ['rb1', 'RB', 14], ['rb2', 'RB', 3], ['wr1', 'WR', 16], ['wr2', 'WR', 15], ['wr3', 'WR', 14], ['wr4', 'WR', 13], ['wr5', 'WR', 12], ['te1', 'TE', 9]],
      '2': [['qb2', 'QB', 17], ['rb3', 'RB', 15], ['rb4', 'RB', 14], ['rb5', 'RB', 13], ['rb6', 'RB', 12], ['wr6', 'WR', 4], ['wr7', 'WR', 3], ['te2', 'TE', 8]],
    });
    const view = fixture.views.get('2')!;
    const partner = { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' };

    const quiet = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [{ view, partner, fit: { tendencies: null, seasonsObserved: 3, historyComplete: true, leagueRate: 1 } }],
    });
    const active = findBilateralTrades({
      me: fixture.views.get('1')!,
      partners: [{ view, partner, fit: enthusiast }],
    });

    expect(quiet.offers.length).toBeGreaterThan(0);
    expect(quiet.offers[0]!.managerFit.activity).toBe('effectively_inactive');
    expect(quiet.offers[0]!.caveats.join(' ')).toMatch(/rarely trades/i);
    // Same idea, ranked lower — not removed.
    expect(quiet.offers[0]!.score).toBeLessThan(active.offers[0]!.score);
    expect(shapes(quiet.offers)[0]).toEqual(shapes(active.offers)[0]);
  });
});
