/**
 * The behavioural half of Smart Bilateral Trades.
 *
 * Every case here defends one of the two rules that make manager history usable
 * at all rather than merely available:
 *
 *   - **unknown is not inactivity.** A manager with three fully read seasons and
 *     no trades has been measured; a manager whose league nobody has backfilled
 *     has not. They must not produce the same class, the same sentence, or the
 *     same contribution — and the second must produce *no* contribution.
 *   - **behaviour is capped and subordinate.** It settles offers that are
 *     already close and can never carry one past a better offer, however
 *     emphatic the record.
 *
 * The tendencies under test are built by the shipped profiler from real ledger
 * transactions rather than hand-written. A literal would let this file assert
 * against thresholds the derivation does not actually apply, which is how a
 * green test stops describing production.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LABELS,
  MANAGER_FIT_CAP,
  TRADE_SHRINKAGE_K,
  activityClassFor,
  confidenceFor,
  managerFitFor,
  shapeOf,
  shrunkRate,
} from '../src/core/trades/managerFit.ts';
import {
  buildLeagueTradeBaseline,
  buildTradeTendencies,
  type ManagerTradeTendencies,
} from '../src/core/managers/tradeTendencies.ts';
import { TRADEABLE, tradeCapabilityOf } from '../src/core/trades/capability.ts';
import type { LedgerTransaction } from '../src/core/managers/ledger.ts';

/** One completed trade in the ledger, between two named managers. */
function trade(opts: {
  id: string;
  season: string;
  week?: number;
  a: { user: string; gets: string[]; sends: string[] };
  b: { user: string; gets: string[]; sends: string[] };
}): LedgerTransaction {
  return {
    transactionId: opts.id,
    season: opts.season,
    week: opts.week ?? 4,
    type: 'trade',
    status: 'complete',
    createdAtMs: null,
    userIds: [opts.a.user, opts.b.user],
    rosterIds: [1, 2],
    creatorUserId: opts.a.user,
    addsByUser: new Map([
      [opts.a.user, opts.a.gets],
      [opts.b.user, opts.b.gets],
    ]),
    dropsByUser: new Map([
      [opts.a.user, opts.a.sends],
      [opts.b.user, opts.b.sends],
    ]),
    waiverBid: null,
    faabTraded: 0,
    draftPicksMoved: 0,
  };
}

/** Positions for the fixture players. `rbN` is a running back, and so on. */
const positionOf = (id: string): string | null => {
  const match = /^([a-z]+)/.exec(id);
  return match ? match[1]!.toUpperCase() : null;
};

/**
 * Build one manager's tendencies through the shipped derivation.
 *
 * `n` trades spread across the seasons given, always with the same partner
 * unless `partner` says otherwise, so the repeat-partner reading is
 * controllable.
 */
function tendenciesFor(opts: {
  user: string;
  trades: number;
  seasons: string[];
  partner?: string;
  gets?: (i: number) => string[];
  sends?: (i: number) => string[];
}): ManagerTradeTendencies {
  const partner = opts.partner ?? 'other';
  const transactions: LedgerTransaction[] = Array.from({ length: opts.trades }, (_, i) =>
    trade({
      id: `t${i}`,
      season: opts.seasons[i % opts.seasons.length]!,
      a: { user: opts.user, gets: opts.gets?.(i) ?? [`rb${i}`], sends: opts.sends?.(i) ?? [`wr${i}`] },
      b: { user: partner, gets: opts.sends?.(i) ?? [`wr${i}`], sends: opts.gets?.(i) ?? [`rb${i}`] },
    }),
  );

  const built = buildTradeTendencies({
    transactions,
    seasonsByUser: new Map([
      [opts.user, opts.seasons],
      [partner, opts.seasons],
    ]),
    positionOf,
    latestSeason: opts.seasons.at(-1) ?? '2026',
  });
  return built.get(opts.user) ?? ({} as ManagerTradeTendencies);
}

const ONE_FOR_ONE = { giving: 1, getting: 1, partnerReceives: ['RB'], partnerSends: ['WR'] };

describe('activity classes: unknown is never inactivity', () => {
  it('calls a manager with fully read seasons and no trades effectively inactive', () => {
    expect(
      activityClassFor({ sample: 0, seasonsObserved: 3, historyComplete: true, ratePerSeason: null }),
    ).toBe('effectively_inactive');
  });

  it('calls a manager nobody has read unknown, however many seasons he has played', () => {
    // The same zero trades. The difference is entirely whether anybody looked.
    expect(
      activityClassFor({ sample: 0, seasonsObserved: 0, historyComplete: false, ratePerSeason: null }),
    ).toBe('unknown');
    expect(
      activityClassFor({ sample: 0, seasonsObserved: 4, historyComplete: false, ratePerSeason: null }),
    ).toBe('unknown');
  });

  it('calls a manager in his first observed season unknown rather than inactive', () => {
    expect(
      activityClassFor({ sample: 0, seasonsObserved: 1, historyComplete: true, ratePerSeason: null }),
    ).toBe('unknown');
  });

  it('separates an active trader from a selective one', () => {
    expect(activityClassFor({ sample: 8, seasonsObserved: 3, historyComplete: true, ratePerSeason: 2.4 })).toBe(
      'active',
    );
    expect(activityClassFor({ sample: 4, seasonsObserved: 3, historyComplete: true, ratePerSeason: 1 })).toBe(
      'selective',
    );
  });

  it('calls one trade in three complete seasons low activity, and in one season unknown', () => {
    expect(activityClassFor({ sample: 1, seasonsObserved: 3, historyComplete: true, ratePerSeason: 0.3 })).toBe(
      'low_activity',
    );
    expect(activityClassFor({ sample: 1, seasonsObserved: 1, historyComplete: true, ratePerSeason: 1 })).toBe(
      'unknown',
    );
  });

  it('never prints a label that describes a person the evidence has not measured', () => {
    expect(ACTIVITY_LABELS.unknown).toBe('Limited history');
    expect(ACTIVITY_LABELS.effectively_inactive).not.toMatch(/never|refus|bad|hostile/i);
  });
});

describe('the contribution', () => {
  it('gives an unknown manager exactly zero, and says why', () => {
    const fit = managerFitFor({ tendencies: null, seasonsObserved: 0, historyComplete: false, offer: ONE_FOR_ONE });

    expect(fit.activity).toBe('unknown');
    expect(fit.contribution).toBe(0);
    expect(fit.uncertain).toBe(true);
    expect(fit.notes.join(' ')).toMatch(/limited trade history/i);
  });

  it('gives an active trader a modest lift and a measured non-trader a penalty', () => {
    const active = managerFitFor({
      tendencies: tendenciesFor({ user: 'a', trades: 9, seasons: ['2024', '2025', '2026'] }),
      seasonsObserved: 3,
      historyComplete: true,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });
    const inactive = managerFitFor({
      tendencies: null,
      seasonsObserved: 3,
      historyComplete: true,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });

    expect(active.activity).toBe('active');
    expect(active.contribution).toBeGreaterThan(0);
    expect(inactive.activity).toBe('effectively_inactive');
    expect(inactive.contribution).toBeLessThan(0);

    // Symmetric: the feature can demote as well as promote.
    expect(Math.abs(inactive.contribution)).toBeGreaterThan(0);
  });

  it('caps the contribution however many signals agree', () => {
    /*
     * Every term this module can award, all at once: a heavy trader, dealing in
     * the shape offered, in the positions he moves, with the asking manager
     * himself. If any combination could exceed the cap it would be this one.
     */
    const heavy = tendenciesFor({
      user: 'a',
      trades: 12,
      seasons: ['2023', '2024', '2025', '2026'],
      partner: 'me',
      gets: () => ['rb1'],
      sends: () => ['wr1'],
    });
    const fit = managerFitFor({
      tendencies: heavy,
      seasonsObserved: 4,
      historyComplete: true,
      askingUserId: 'me',
      leagueRate: 0.5,
      offer: { giving: 1, getting: 1, partnerReceives: ['RB'], partnerSends: ['WR'] },
    });

    expect(fit.contribution).toBeLessThanOrEqual(MANAGER_FIT_CAP);
    expect(fit.contribution).toBeGreaterThan(0);
    expect(Math.abs(fit.contribution)).toBeLessThanOrEqual(MANAGER_FIT_CAP);
  });

  it('cannot move much on one trade', () => {
    const one = managerFitFor({
      tendencies: tendenciesFor({ user: 'a', trades: 1, seasons: ['2024', '2025', '2026'] }),
      seasonsObserved: 3,
      historyComplete: true,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });
    const many = managerFitFor({
      tendencies: tendenciesFor({ user: 'a', trades: 12, seasons: ['2024', '2025', '2026'] }),
      seasonsObserved: 3,
      historyComplete: true,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });

    // A single observation is worth a fraction of a measured record.
    expect(Math.abs(one.contribution)).toBeLessThan(Math.abs(many.contribution));
    expect(Math.abs(one.contribution)).toBeLessThan(MANAGER_FIT_CAP / 2);
  });

  it('halves its confidence while the league history is still being read', () => {
    const shared = { trades: 8, seasons: ['2024', '2025', '2026'], user: 'a' };
    const complete = managerFitFor({
      tendencies: tendenciesFor(shared),
      seasonsObserved: 3,
      historyComplete: true,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });
    const partial = managerFitFor({
      tendencies: tendenciesFor(shared),
      seasonsObserved: 3,
      historyComplete: false,
      leagueRate: 1,
      offer: ONE_FOR_ONE,
    });

    /*
     * Within one unit of the stored precision. Confidence is rounded to two
     * places, so an exact halving of an odd value is not representable and
     * asserting one would be asserting against the rounding rather than the
     * rule.
     */
    expect(Math.abs(partial.evidence.confidence - complete.evidence.confidence / 2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(partial.contribution)).toBeLessThan(Math.abs(complete.contribution));
    expect(partial.uncertain).toBe(true);
    expect(partial.notes.join(' ')).toMatch(/still being read/i);
  });
});

describe('shrinkage and recency', () => {
  it('pulls a thin sample toward the league and leaves a thick one alone', () => {
    const thin = shrunkRate({ observed: 4, sample: 1, leagueRate: 1 });
    const thick = shrunkRate({ observed: 4, sample: 40, leagueRate: 1 });

    expect(thin).toBeLessThan(2);
    expect(thick).toBeGreaterThan(3.5);
  });

  it('shrinks exactly half way at the documented sample', () => {
    expect(shrunkRate({ observed: 3, sample: TRADE_SHRINKAGE_K, leagueRate: 1 })).toBeCloseTo(2, 5);
  });

  it('lets one recent trade move a rate without erasing three seasons of it', () => {
    /*
     * The same manager, measured before and after a single new deal. §11: one
     * recent trade must not erase a substantial history — so the rate moves, and
     * it moves by less than the difference between the two raw counts implies.
     */
    const before = tendenciesFor({ user: 'a', trades: 6, seasons: ['2024', '2025', '2026'] });
    const after = tendenciesFor({ user: 'a', trades: 7, seasons: ['2024', '2025', '2026'] });

    expect(after.tradesPerSeason).toBeGreaterThan(before.tradesPerSeason ?? 0);
    expect((after.tradesPerSeason ?? 0) - (before.tradesPerSeason ?? 0)).toBeLessThan(1);
  });

  it('reads a well-observed non-trader as well evidenced, not badly', () => {
    /*
     * The one place a naive confidence would be exactly backwards: "three
     * complete seasons and no trades" is the strongest finding available, and
     * scaling it by a sample of zero would erase it.
     */
    const measured = confidenceFor({ sample: 0, seasonsObserved: 3, historyComplete: true });
    const unmeasured = confidenceFor({ sample: 0, seasonsObserved: 0, historyComplete: false });

    expect(measured).toBeGreaterThan(0.9);
    expect(unmeasured).toBe(0);
  });
});

describe('offer shape, read from the partner’s chair', () => {
  it('calls two-from-them-for-one-of-mine a consolidation for them', () => {
    expect(shapeOf({ giving: 1, getting: 2, partnerReceives: ['RB'], partnerSends: ['WR', 'TE'] })).toBe(
      'depth_for_starter',
    );
  });

  it('calls a straight swap one-for-one and anything larger a package', () => {
    expect(shapeOf({ giving: 1, getting: 1, partnerReceives: ['RB'], partnerSends: ['WR'] })).toBe('one_for_one');
    expect(shapeOf({ giving: 2, getting: 1, partnerReceives: ['RB', 'RB'], partnerSends: ['WR'] })).toBe('package');
  });
});

describe('the league baseline the shrinkage leans on', () => {
  it('measures the room’s own rate rather than assuming one', () => {
    const transactions = [
      trade({ id: 't1', season: '2025', a: { user: 'a', gets: ['rb1'], sends: ['wr1'] }, b: { user: 'b', gets: ['wr1'], sends: ['rb1'] } }),
      trade({ id: 't2', season: '2025', a: { user: 'a', gets: ['rb2'], sends: ['wr2'] }, b: { user: 'c', gets: ['wr2'], sends: ['rb2'] } }),
    ];
    const baseline = buildLeagueTradeBaseline({
      transactions,
      seasonsByUser: new Map([['a', ['2025']], ['b', ['2025']], ['c', ['2025']]]),
      positionOf,
      latestSeason: '2025',
    });

    expect(baseline.trades).toBe(2);
    expect(baseline.traders).toBe(3);
    expect(baseline.tradesPerManagerSeason).toBeGreaterThan(0);
  });
});

describe('league trade capability', () => {
  it('blocks a league Sleeper states is best ball', () => {
    const cap = tradeCapabilityOf({ leagueSettings: { best_ball: 1 } });
    expect(cap.tradeable).toBe(false);
    expect(cap.basis).toBe('best_ball');
    expect(cap.reason).toMatch(/best-ball/i);
  });

  it('reads the flag off league metadata too, and as a string', () => {
    expect(tradeCapabilityOf({ leagueMetadata: { best_ball: '1' } }).tradeable).toBe(false);
  });

  it('blocks a league whose commissioner switched trading off', () => {
    const cap = tradeCapabilityOf({ leagueSettings: { disable_trades: 1 } });
    expect(cap.tradeable).toBe(false);
    expect(cap.basis).toBe('trades_disabled');
  });

  it('permits an ordinary league, and one Sleeper says nothing about', () => {
    expect(tradeCapabilityOf({ leagueSettings: { playoff_week_start: 15 } })).toEqual(TRADEABLE);
    expect(tradeCapabilityOf({})).toEqual(TRADEABLE);
    expect(tradeCapabilityOf({ leagueSettings: null })).toEqual(TRADEABLE);
  });

  it('does not turn a missing flag into a disabled feature', () => {
    /*
     * `detectBestBall` answers `bestBall: false, confident: false` for a league
     * Sleeper has not described, which is "not stated" rather than "not best
     * ball". Treating that as a block would silence the feature for the
     * overwhelmingly common league, which carries no flag and does trade.
     */
    expect(tradeCapabilityOf({ leagueSettings: { best_ball: 'maybe' } }).tradeable).toBe(true);
    expect(tradeCapabilityOf({ leagueSettings: { disable_trades: 0 } }).tradeable).toBe(true);
    expect(tradeCapabilityOf({ leagueSettings: { disable_trades: 'nope' } }).tradeable).toBe(true);
  });
});
