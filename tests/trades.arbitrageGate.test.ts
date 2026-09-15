/**
 * The gate an arbitrage trade may walk past, and the four it may not.
 *
 * Alex, 15 September 2026: *the Trades page suppresses all trade suggestions
 * when my lineup has no starter-upgrade need. Buy-low/sell-high trades are
 * value arbitrage, not need-filling, and should not be suppressed by that gate
 * — a great buy-low target should surface even when my lineup is otherwise
 * fine. Make sure this new category bypasses that specific gate while leaving
 * the gate's original purpose intact for that category.*
 *
 * "That specific gate" is `MIN_USER_GAIN`: a package has to move the starting
 * lineup by a point before it is worth a reader's attention. For an upgrade
 * that is the whole question and it stays exactly where it was. For a buy-low
 * it is the wrong question asked confidently — the bet is on the rest of the
 * season and it is frequently a wash this Sunday.
 *
 * So these tests come in two halves and the second is the important one. A
 * category that bypasses one gate is one careless edit from a category that
 * bypasses all of them, and every failure that would produce is silent: the
 * board keeps working and starts recommending nonsense.
 */

import { describe, expect, it } from 'vitest';
import { candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, type RosterView } from '../src/core/trades/rosterUtility.ts';
import {
  ARBITRAGE_RESERVED_SLOTS,
  MIN_ARBITRAGE_USER_GAIN,
  MIN_USER_GAIN,
  findBilateralTrades,
} from '../src/core/trades/bilateral.ts';
import type { ArbitrageRead } from '../src/core/trades/arbitrage.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];
const profile = buildScoringProfile({}, POSITIONS);
const shape = buildRosterShape(POSITIONS);

type Spec = [id: string, position: string, points: number];

function leagueOf(rosters: Record<string, Spec[]>): Map<string, RosterView> {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(rosters)) {
    for (const [id, position, points] of specs) pool.set(id, candidate(id, id.toUpperCase(), position, points));
  }
  return buildRosterViews({
    rosters: Object.entries(rosters).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape,
    profile,
  });
}

function partnerOf(views: Map<string, RosterView>, key: string) {
  return {
    view: views.get(key)!,
    partner: { key, rosterId: Number(key), displayName: `Manager ${key}`, userId: `u${key}` },
    fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
  };
}

/** A read of a chosen kind and strength. The residual numbers are for display. */
function reading(playerId: string, kind: ArbitrageRead['kind'], strength = 0.8): ArbitrageRead {
  return {
    playerId,
    kind,
    strength,
    residualPerGame: kind === 'buy_low' ? -4 : 4,
    expectedPerGame: 12,
    observedPerGame: kind === 'buy_low' ? 8 : 16,
    games: 5,
    tdDependency: {
      profile: 'insufficient_data',
      share: null,
      touchdowns: 0,
      scoringGames: 0,
      games: 5,
      points: 0,
      display: '',
      driver: null,
    },
    tallyFactor: 1,
    headline: `${playerId} headline`,
    reasons: ['because'],
  };
}

/**
 * A roster with nothing to fix, playing one that cannot fix it.
 *
 * This is the state Alex described: no upgrade clears a point, and the board
 * correctly says there is nothing to do. It is also the state a buy-low most
 * often arrives in — `wr3` on the partner's roster is the underperforming
 * player, and he is *worse* than what Alex starts at his position, which is
 * what makes him cheap and what used to make him invisible.
 */
const SETTLED: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 13],
    ['rbs', 'RB', 10],
    ['wr1', 'WR', 13],
    ['wr2', 'WR', 12],
    ['te1', 'TE', 9],
    ['flex1', 'WR', 11],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb3', 'RB', 8],
    ['rb4', 'RB', 7],
    ['wr3', 'WR', 10],
    ['wr4', 'WR', 12],
    ['wr5', 'WR', 11],
    ['te2', 'TE', 9],
  ],
};

/**
 * The mirror case: a player of Alex's worth moving at his peak.
 *
 * `wr3` is his flex, and shipping him is close to a lineup wash — which is
 * exactly why the ordinary bar refuses it and exactly what a sell-high is. The
 * partner is deep at running back and thin everywhere else, so there is a
 * plausible return at a comparable price.
 */
const SELLABLE: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 9],
    ['wr1', 'WR', 14],
    ['wr2', 'WR', 12],
    ['te1', 'TE', 9],
    ['wr3', 'WR', 11],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb3', 'RB', 16],
    ['rb5', 'RB', 12],
    ['rb6', 'RB', 11],
    ['wr4', 'WR', 13],
    ['te2', 'TE', 9],
  ],
};

function run(rosters: Record<string, Spec[]>, arbitrage?: Map<string, ArbitrageRead>) {
  const views = leagueOf(rosters);
  return findBilateralTrades({
    me: views.get('1')!,
    partners: [partnerOf(views, '2')],
    ...(arbitrage ? { arbitrage } : {}),
  });
}

describe('the gate that suppresses a pointless upgrade', () => {
  it('still suppresses everything when there is no arbitrage read', () => {
    const report = run(SETTLED);

    expect(report.offers).toHaveLength(0);
    expect(report.rejections.some((r) => r.reason === 'user_benefit_negligible')).toBe(true);
    expect(report.notes.join(' ')).toMatch(/no meaningful hole/i);
  });

  it('lets a buy-low target through the same lineup, which is the whole ask', () => {
    // `wr3` sits on the partner's roster and is the one thing that changed.
    const report = run(SETTLED, new Map([['wr3', reading('wr3', 'buy_low')]]));

    expect(report.offers.length).toBeGreaterThan(0);
    const buy = report.offers.find((o) => o.get.some((p) => p.playerId === 'wr3'));
    expect(buy, 'the buy-low target must be reachable when the lineup is otherwise fine').toBeDefined();
    expect(buy!.category).toBe('buy_low');
    expect(buy!.arbitrage[0]!.playerId).toBe('wr3');
  });

  it('lets a sell-high candidate leave a lineup that is otherwise fine', () => {
    // Without the read this pair produces nothing: every package is a wash or
    // close to it, which is the ordinary bar working as designed.
    expect(run(SELLABLE).offers).toHaveLength(0);

    const report = run(SELLABLE, new Map([['wr3', reading('wr3', 'sell_high')]]));
    const sell = report.offers.find((o) => o.give.some((p) => p.playerId === 'wr3'));

    expect(sell, 'a sell-high is something Alex sends, not something he receives').toBeDefined();
    expect(sell!.category).toBe('sell_high');
    // The point of the category: this is a lineup wash and it surfaces anyway.
    expect(sell!.user.starterGain).toBeLessThan(MIN_USER_GAIN);
  });

  it('ignores a read pointing the wrong way through the deal', () => {
    /*
     * A buy-low on a player Alex already owns is not a reason to send him, and
     * a sell-high on somebody else's player is not a reason to acquire him.
     * Both are read off the side of the package the player is on.
     */
    const backwards = new Map([
      ['wr1', reading('wr1', 'buy_low')], // mine: buying what I hold is nothing
      ['wr3', reading('wr3', 'sell_high')], // theirs: selling what I lack is nothing
    ]);
    expect(run(SETTLED, backwards).offers).toHaveLength(0);
  });
});

describe('and the gates it does not get to walk past', () => {
  /** A star on my roster and scraps on theirs — the lopsided case. */
  const LOPSIDED: Record<string, Spec[]> = {
    ...SETTLED,
    '2': [
      ['qb2', 'QB', 20],
      ['rb3', 'RB', 15],
      ['rb4', 'RB', 13],
      ['wr3', 'WR', 2],
      ['wr4', 'WR', 12],
      ['te2', 'TE', 9],
      ['flex2', 'WR', 11],
    ],
  };

  it('cannot buy low on a player whose value is nowhere near what it costs', () => {
    // gate 1, the objective sanity boundary, runs before the user-benefit gate
    // and is not reached by any of this.
    const report = run(LOPSIDED, new Map([['wr3', reading('wr3', 'buy_low', 1)]]));
    const bought = report.offers.filter((o) => o.get.some((p) => p.playerId === 'wr3'));

    for (const offer of bought) expect(offer.fairness.band).not.toBe('outside_range');
    expect(report.rejections.some((r) => r.reason === 'value_gap_outside_range')).toBe(true);
  });

  it('cannot take the lineup materially backwards to do it', () => {
    /*
     * The relaxed bar is a bar, not its absence. A buy-low is allowed to cost
     * about half a point of this week's lineup and no more, which is under the
     * bench-swap threshold the upgrade bar is matched to — "this week is
     * allowed to be a wash", not "this week does not matter".
     */
    expect(MIN_ARBITRAGE_USER_GAIN).toBeLessThan(MIN_USER_GAIN);
    expect(MIN_ARBITRAGE_USER_GAIN).toBeGreaterThan(-1);

    const report = run(SETTLED, new Map([['wr3', reading('wr3', 'buy_low', 1)]]));
    for (const offer of report.offers) {
      expect(offer.user.starterGain).toBeGreaterThanOrEqual(MIN_ARBITRAGE_USER_GAIN);
    }
  });

  it('cannot open a hole in either lineup, or harm the partner into declining', () => {
    const report = run(SETTLED, new Map([['wr3', reading('wr3', 'buy_low', 1)]]));
    for (const offer of report.offers) {
      expect(offer.user.opensSlot).toBe(false);
      expect(offer.counterparty.opensSlot).toBe(false);
      // Gate 3's bar, unchanged: a deal they would look at and decline is not
      // an idea, it is a way of spending the one conversation you get.
      expect(offer.counterparty.starterGain).toBeGreaterThan(-1);
    }
  });
});

/**
 * A roster with real upgrades available, playing a partner who is deep at
 * running back.
 *
 * `rb4` is a good upgrade target on his own; `rb6` is not, and is the one an
 * arbitrage read has to reach. Having both in one fixture is the point — the
 * two questions the category has to get right are "does the label claim
 * reasoning the board used" and "can the two kinds share a board", and they are
 * only really testable against a league where both are possible.
 */
const MIXED: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 12],
    ['wr1', 'WR', 14],
    ['wr2', 'WR', 12],
    ['te1', 'TE', 9],
    ['wr3', 'WR', 11],
    ['wr6', 'WR', 10],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb3', 'RB', 16],
    ['rb4', 'RB', 14],
    ['rb5', 'RB', 12],
    ['rb6', 'RB', 11],
    ['wr4', 'WR', 13],
    ['te2', 'TE', 9],
    ['wr7', 'WR', 6],
  ],
};

describe('the label only claims reasoning the board actually used', () => {
  it('calls an offer an upgrade when the lineup gain carried it', () => {
    /*
     * The same rule `applyLineupPreferences` keeps about naming correlation
     * only when correlation moved something: an offer that clears MIN_USER_GAIN
     * on its own is an upgrade that happens to involve a buy-low target, and
     * labelling it a buy-low would be claiming reasoning the board did not need.
     *
     * This also pins something the first implementation got wrong. A read on a
     * player who was *already* a good target produced two packages for the same
     * man — one worth 2.9 points of lineup, one a wash — and the board surfaced
     * the wash. The board a reader sees must be no worse for the read existing.
     */
    const plain = run(MIXED);
    const read = run(MIXED, new Map([['rb4', reading('rb4', 'buy_low')]]));

    expect(plain.offers.map((o) => o.id)).toEqual(read.offers.map((o) => o.id));
    const offer = read.offers.find((o) => o.get.some((p) => p.playerId === 'rb4'))!;
    expect(offer.user.starterGain).toBeGreaterThanOrEqual(MIN_USER_GAIN);
    expect(offer.category).toBe('upgrade');
    expect(offer.arbitrage).toEqual([]);
  });

  it('leaves a league with no reads byte-identical to the board that shipped before', () => {
    const withMap = run(MIXED, new Map());
    const without = run(MIXED);

    expect(withMap.offers.map((o) => o.id)).toEqual(without.offers.map((o) => o.id));
    for (const offer of without.offers) {
      expect(offer.category).toBe('upgrade');
      expect(offer.arbitrage).toEqual([]);
    }
  });
});

describe('arbitrage is given room on the board rather than promoted onto it', () => {
  it('reserves a bounded share, and no more', () => {
    expect(ARBITRAGE_RESERVED_SLOTS).toBeLessThan(5);
    expect(ARBITRAGE_RESERVED_SLOTS).toBeGreaterThan(0);
  });

  it('surfaces a buy-low on a week that also has upgrades to make', () => {
    /*
     * The failure this catches is the suppression arriving by a different door.
     * An arbitrage offer's composite is built from a read's strength rather
     * than from weekly lineup points, so on a roster that does have holes the
     * upgrades out-score it — and a board of five would be five upgrades on
     * exactly the weeks a buy-low is most interesting.
     *
     * `rb6` is chosen because he is *not* an upgrade for this roster. That is
     * what makes him a buy-low and what made him unreachable before.
     */
    const report = run(MIXED, new Map([['rb6', reading('rb6', 'buy_low', 0.9)]]));

    expect(report.offers.some((o) => o.category === 'upgrade')).toBe(true);
    const buy = report.offers.find((o) => o.category === 'buy_low');
    expect(buy, 'a buy-low must not need an empty board to be seen').toBeDefined();
    expect(buy!.get.map((p) => p.playerId)).toContain('rb6');
    expect(buy!.user.starterGain).toBeLessThan(MIN_USER_GAIN);
  });
});
