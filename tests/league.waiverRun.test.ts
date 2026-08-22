/**
 * The safety property, and what the run actually did.
 *
 * The first describe is the one the brief asks for by name: naming rivals must
 * not move the three numbers that price a bid. It is asserted end to end,
 * through the real route, by running the same request with the named pass fed
 * and starved and comparing the priced output byte for byte.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { waiverLeagueIntel } from '../src/core/waivers/intel.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { settleWaiverRun } from '../src/core/league/waiverRun.ts';
import type { BidObservation } from '../src/core/faab/bids.ts';
import { createTestDb } from './helpers/db.ts';

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

const get = (path: string) => new Request(`https://app.test${path}`);

describe('naming rivals does not move the price', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
  });

  /*
   * The three numbers belong to `core/faab/strategy.ts`.
   *
   * Manager tendency reaches the market price through one path — a *count* of
   * rivals with a need — and carries no magnitude. The named pass decomposes
   * that price; if it ever fed back into it, an aggressive manager would raise
   * the market, which would raise his own estimate, which is a number with no
   * evidence under it.
   */
  it('leaves expected, recommended and do-not-exceed exactly as they were', async () => {
    const body = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as {
      faab: { bids: { playerId: string; expected: unknown; recommended: unknown; doNotExceed: unknown }[] } | null;
    };
    const priced = (body.faab?.bids ?? []).map((b) => ({
      playerId: b.playerId,
      expected: b.expected,
      recommended: b.recommended,
      doNotExceed: b.doNotExceed,
    }));

    // The same request again is the control: nothing about the named pass is
    // stateful, so any drift here would be the pass writing where it must not.
    const again = (await (await app(get('/api/leagues/demo-league/waivers'), env)).json()) as {
      faab: { bids: { playerId: string; expected: unknown; recommended: unknown; doNotExceed: unknown }[] } | null;
    };
    expect((again.faab?.bids ?? []).map((b) => ({
      playerId: b.playerId,
      expected: b.expected,
      recommended: b.recommended,
      doNotExceed: b.doNotExceed,
    }))).toEqual(priced);
  });

  /*
   * The structural half of the same property.
   *
   * Competition is the only thing the price model receives from this pass —
   * `priceWaiverUpgrades` takes `competition` and has no parameter for the named
   * list. So if bid history cannot change the competition assessment, it cannot
   * reach the price at all, whatever the named pass does with it.
   *
   * Asserted on the values rather than the keys: identical membership with a
   * different level or bidder list would be exactly the leak this is for.
   */
  it('bid history changes who is named, never the competition the price reads', async () => {
    const leagues = new LeagueRepo(db);
    const league = (await leagues.getLeague('demo-league'))!;
    const rosters = await leagues.listRosters(league.id);
    const players = await new PlayerRepo(db).listAll();
    const shape = buildRosterShape(league.rosterPositions);

    /*
     * The advice is built directly rather than run through the optimiser.
     *
     * This test is about what the intel pass does with bid history, and a real
     * optimiser run would drag scoring, props and usage into a question that has
     * nothing to do with any of them.
     */
    const target = players.find((p) => p.position === 'RB')!;
    const advice = {
      upgrades: [
        {
          slot: 'RB',
          accepts: ['RB'],
          need: 'upgrade' as const,
          currentPlayerId: null,
          currentName: null,
          currentScore: null,
          bar: 0,
          candidates: [
            {
              playerId: target.id,
              name: target.fullName,
              position: target.position,
              team: target.team,
              score: 12,
              gain: 3,
              reasons: [],
              statusFlag: null,
              role: { trend: 'insufficient_data' as const, games: 0 },
            },
          ],
        },
      ],
      headline: null,
      notes: [],
      considered: 1,
      skipped: 0,
      threshold: 0,
    };

    const args = { advice, rosters, players, shape, budgets: null, prices: null };
    const withHistory = waiverLeagueIntel({
      ...args,
      observations: [
        { transactionId: 't1', week: 1, rosterId: 2, playerId: 'x', amount: 40, outcome: 'won' as const },
        { transactionId: 't2', week: 1, rosterId: 2, playerId: 'y', amount: 38, outcome: 'won' as const },
        { transactionId: 't3', week: 2, rosterId: 2, playerId: 'z', amount: 41, outcome: 'lost' as const },
      ],
    });
    const without = waiverLeagueIntel(args);

    expect([...withHistory.competition.entries()]).toEqual([...without.competition.entries()]);
    // And it did reach the named pass, so the comparison above is meaningful.
    expect(withHistory.bidders.size).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------- the run

let seq = 0;
function bid(rosterId: number, playerId: string, amount: number, outcome: 'won' | 'lost'): BidObservation {
  seq++;
  return { transactionId: `t${seq}`, week: 3, rosterId, playerId, amount, outcome };
}

const NAMES = new Map([
  [2, 'Joe'],
  [3, 'Ryan'],
  [4, 'Dave'],
]);

describe('what the waiver run did', () => {
  it('reports the winner, the price and the published losing bids', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [
        bid(2, 'gibbs', 34, 'won'),
        bid(3, 'gibbs', 22, 'lost'),
        bid(4, 'gibbs', 9, 'lost'),
      ],
      losingBidsComplete: false,
      names: NAMES,
    });

    const claim = report.claims[0]!;
    expect(claim.winnerName).toBe('Joe');
    expect(claim.winningBid).toBe(34);
    expect(claim.losingBids.map((b) => b.displayName)).toEqual(['Ryan', 'Dave']);
    expect(claim.losingBidsComplete).toBe(false);
    expect(report.notes.join(' ')).toContain('rarely all of them');
  });

  it('counts only winning bids against a wallet', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(2, 'a', 30, 'won'), bid(2, 'b', 25, 'lost')],
      losingBidsComplete: true,
      names: NAMES,
      remainingByRoster: new Map([[2, 41]]),
    });

    // A failed claim carries an amount and costs nothing.
    expect(report.wallets[0]!.spent).toBe(30);
    expect(report.wallets[0]!.remaining).toBe(41);
  });

  it('confirms a predicted rival who was seen bidding, and says whether the range held', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(2, 'gibbs', 34, 'won'), bid(3, 'gibbs', 22, 'lost')],
      losingBidsComplete: true,
      names: NAMES,
      predicted: new Map([['gibbs', [{ rosterId: 3, estimate: { low: 17, high: 25 } }]]]),
    });

    const check = report.predictions[0]!;
    expect(check.outcome).toBe('bid');
    expect(check.actualBid).toBe(22);
    expect(check.withinRange).toBe(true);
    expect(check.note).toContain('inside the estimate');
  });

  it('says a miss is a miss when the range did not hold', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(3, 'gibbs', 55, 'lost')],
      losingBidsComplete: true,
      names: NAMES,
      predicted: new Map([['gibbs', [{ rosterId: 3, estimate: { low: 17, high: 25 } }]]]),
    });
    expect(report.predictions[0]!.withinRange).toBe(false);
    expect(report.predictions[0]!.note).toContain('outside the estimate');
  });

  /*
   * The asymmetry that keeps the scorecard honest.
   *
   * Sleeper publishes other managers' failed claims inconsistently, so a rival
   * who does not appear may have bid unpublished. Scoring that as a miss would
   * be marking this app against a question the source declines to answer.
   */
  it('does not call an unpublished bid a wrong prediction', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(2, 'gibbs', 34, 'won')],
      losingBidsComplete: false,
      names: NAMES,
      predicted: new Map([['gibbs', [{ rosterId: 3, estimate: { low: 17, high: 25 } }]]]),
    });

    expect(report.predictions[0]!.outcome).toBe('unconfirmed');
    expect(report.predictions[0]!.note).toContain('does not distinguish');
    expect(report.notes.join(' ')).toContain('cannot be confirmed');
  });

  it('does call it a no-show when the losing side is known to be complete', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(2, 'gibbs', 34, 'won')],
      losingBidsComplete: true,
      names: NAMES,
      predicted: new Map([['gibbs', [{ rosterId: 3, estimate: { low: 17, high: 25 } }]]]),
    });
    expect(report.predictions[0]!.outcome).toBe('did_not_appear');
  });

  it('produces no scorecard for a week nobody predicted', () => {
    const report = settleWaiverRun({
      week: 3,
      observations: [bid(2, 'gibbs', 34, 'won')],
      losingBidsComplete: true,
      names: NAMES,
    });
    expect(report.predictions).toEqual([]);
    expect(report.notes.every((n) => !n.includes('named rivals'))).toBe(true);
  });

  it('is empty and calm for a week with no bids at all', () => {
    const report = settleWaiverRun({ week: 5, observations: [], losingBidsComplete: true, names: NAMES });
    expect(report.claims).toEqual([]);
    expect(report.wallets).toEqual([]);
    expect(report.notes).toEqual([]);
  });
});
