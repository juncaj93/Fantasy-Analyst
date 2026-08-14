/**
 * Vegas quota discipline.
 *
 * The free plan is 2,500 entities a month, an entity is one event returned, and
 * the app has one API key. So the tests that matter here are the ones about
 * restraint: that a refresh cannot ask for the whole slate, that the guard
 * tightens as the month goes on, that a hard stop is a hard stop, and that
 * every one of those states still serves the lines already stored.
 *
 * The measured facts these encode — one entity per event, an empty answer still
 * costs one, `teamID` is honoured server-side — are recorded in docs/VEGAS.md
 * with the probe that established them.
 */

import { describe, expect, it } from 'vitest';
import {
  BUDGET,
  budgetView,
  canSpend,
  emptyLedger,
  monthOf,
  readProviderUsage,
  type BudgetLedger,
} from '../src/core/vegas/budget.ts';
import { buildFetchPlan, simulateMonth, type PlannedPlayer } from '../src/core/vegas/plan.ts';

const NOW = Date.parse('2026-09-13T14:00:00Z'); // Sunday, two hours to kickoff

function ledger(entities: number, extra: Partial<BudgetLedger> = {}): BudgetLedger {
  return { ...emptyLedger('2026-09'), entities, ...extra };
}

function player(over: Partial<PlannedPlayer> = {}): PlannedPlayer {
  return {
    playerId: 'p1',
    position: 'WR',
    eventId: 'e1',
    kickoff: new Date(NOW + 4 * 3_600_000).toISOString(),
    starter: true,
    status: null,
    contested: false,
    ageMinutes: 1000,
    ...over,
  };
}

describe('the monthly budget', () => {
  it('reads the plan the provider actually reported', () => {
    const usage = readProviderUsage({
      rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 480 } },
    });
    expect(usage).toEqual({ entities: 480, limit: 2500 });
  });

  it('says unknown rather than zero when the payload changes shape', () => {
    // A renamed field must never read as "nothing spent" — that is the one
    // error that would spend the month.
    expect(readProviderUsage({ rateLimits: { 'per-month': { spent: 480 } } })).toEqual({
      entities: null,
      limit: null,
    });
    expect(readProviderUsage(null)).toEqual({ entities: null, limit: null });
  });

  it('moves through healthy, caution, conservation and hard stop', () => {
    expect(budgetView(ledger(100)).state).toBe('healthy');
    expect(budgetView(ledger(BUDGET.monthlyEntities * BUDGET.cautionAt)).state).toBe('caution');
    expect(budgetView(ledger(BUDGET.monthlyEntities * BUDGET.conservationAt)).state).toBe('conservation');
    expect(budgetView(ledger(BUDGET.monthlyEntities * BUDGET.hardStopAt)).state).toBe('hard_stop');
  });

  it('believes whichever count is higher, ours or the provider’s', () => {
    // The provider sees spending this app never made — a probe, another
    // deployment. Ours sees spending made since it was last read. Only the
    // larger of the two cannot under-report.
    expect(budgetView(ledger(100, { providerEntities: 900 })).used).toBe(900);
    expect(budgetView(ledger(100, { providerEntities: 900 })).source).toBe('provider');
    expect(budgetView(ledger(950, { providerEntities: 900 })).used).toBe(950);
    expect(budgetView(ledger(950, { providerEntities: 900 })).source).toBe('ledger');
  });

  it('permits ordinary work while healthy', () => {
    const decision = canSpend(budgetView(ledger(100)), { entities: 8, priority: 'normal' });
    expect(decision).toMatchObject({ allowed: true, entities: 8 });
  });

  it('drops low-priority work first, then normal work', () => {
    const caution = budgetView(ledger(1300));
    expect(canSpend(caution, { entities: 5, priority: 'low' }).allowed).toBe(false);
    expect(canSpend(caution, { entities: 5, priority: 'normal' }).allowed).toBe(true);

    const conservation = budgetView(ledger(1800));
    expect(canSpend(conservation, { entities: 5, priority: 'normal' }).allowed).toBe(false);
    expect(canSpend(conservation, { entities: 5, priority: 'critical' }).allowed).toBe(true);
  });

  it('keeps the last fifth for close game-day decisions only', () => {
    const reserve = budgetView(ledger(2200));
    expect(reserve.state).toBe('hard_stop');
    expect(reserve.spendable).toBe(0);
    for (const priority of ['normal', 'low'] as const) {
      const decision = canSpend(reserve, { entities: 1, priority });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('hard stop');
    }
    // The reserve exists for exactly this: a close call, an hour to kickoff.
    expect(canSpend(reserve, { entities: 4, priority: 'critical' })).toMatchObject({ allowed: true, entities: 4 });
  });

  it('refuses everything once the allowance itself is gone', () => {
    const spent = budgetView(ledger(2500));
    for (const priority of ['critical', 'normal', 'low'] as const) {
      const decision = canSpend(spent, { entities: 1, priority });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('exhausted');
    }
  });

  it('trims a plan rather than refusing it outright', () => {
    const decision = canSpend(budgetView(ledger(2495)), { entities: 8, priority: 'critical' });
    expect(decision.allowed).toBe(true);
    expect(decision.entities).toBe(5);
    expect(decision.reason).toContain('trimmed');
  });

  it('never plans more requests in one pass than the per-minute ceiling', () => {
    const decision = canSpend(budgetView(ledger(0)), { entities: 40, priority: 'critical' });
    expect(decision.entities).toBeLessThanOrEqual(BUDGET.maxEntitiesPerRun);
    expect(BUDGET.maxEntitiesPerRun).toBeLessThan(BUDGET.requestsPerMinute);
  });

  it('uses the calendar month, in UTC', () => {
    expect(monthOf(Date.parse('2026-09-30T23:59:00Z'))).toBe('2026-09');
    expect(monthOf(Date.parse('2026-10-01T00:01:00Z'))).toBe('2026-10');
  });
});

describe('what a refresh asks for', () => {
  it('charges once for a game two rostered players are in', () => {
    const plan = buildFetchPlan(
      [player({ playerId: 'a', eventId: 'e1' }), player({ playerId: 'b', eventId: 'e1' })],
      { now: NOW },
    );
    expect(plan.events).toHaveLength(1);
    expect(plan.estimatedEntities).toBe(1);
    expect(plan.events[0]!.playerIds).toEqual(['a', 'b']);
  });

  it('never asks for a game nobody on the roster is in', () => {
    // There is no code path that can: the plan is built from players, so a
    // game with no rostered player in it cannot appear in one.
    const plan = buildFetchPlan([player({ eventId: 'e1' })], { now: NOW });
    expect(plan.events.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('stops paying for a game that has kicked off', () => {
    const plan = buildFetchPlan(
      [player({ playerId: 'started', kickoff: new Date(NOW - 60_000).toISOString() })],
      { now: NOW },
    );
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain('has started');
  });

  it('leaves fresh lines alone', () => {
    const plan = buildFetchPlan([player({ ageMinutes: 20 })], { now: NOW });
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain('still fresh');
  });

  it('refreshes fresh lines anyway for a close call near kickoff', () => {
    const plan = buildFetchPlan(
      [player({ ageMinutes: 20, contested: true, kickoff: new Date(NOW + 2 * 3_600_000).toISOString() })],
      { now: NOW },
    );
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]!.priority).toBe('critical');
  });

  it('ranks a questionable player in a close call above a deep bench player', () => {
    const plan = buildFetchPlan(
      [
        player({
          playerId: 'bench',
          eventId: 'bench-game',
          starter: false,
          contested: false,
          ageMinutes: 5000,
        }),
        player({
          playerId: 'doubtful',
          eventId: 'close-game',
          status: 'Questionable',
          contested: true,
          kickoff: new Date(NOW + 3 * 3_600_000).toISOString(),
        }),
      ],
      { now: NOW },
    );
    expect(plan.events[0]!.eventId).toBe('close-game');
    expect(plan.events[0]!.priority).toBe('critical');
    expect(plan.events[1]!.priority).not.toBe('critical');
  });

  it('gives an obvious starter no urgency of his own', () => {
    const plan = buildFetchPlan([player({ starter: true, contested: false, ageMinutes: 5000 })], { now: NOW });
    expect(plan.events[0]!.priority).toBe('normal');
  });

  it('says so rather than guessing when a player has no game mapped', () => {
    const plan = buildFetchPlan([player({ eventId: null })], { now: NOW });
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain('no game mapped');
  });

  it('caps one pass below the per-minute request ceiling', () => {
    const many = Array.from({ length: 20 }, (_, i) => player({ playerId: `p${i}`, eventId: `e${i}` }));
    const plan = buildFetchPlan(many, { now: NOW });
    expect(plan.events.length).toBeLessThanOrEqual(12);
    expect(plan.skipped.some((s) => s.reason.includes('cap'))).toBe(true);
  });
});

describe('the cost of a season', () => {
  /** The strategy this pass shipped, priced before it runs. */
  const STRATEGY = {
    rosterGames: 8,
    checkpointsPerWeek: 2,
    nearKickoffEvents: 3,
    weeksPerMonth: 5,
    seasonEntitiesPerRun: 2,
    seasonRunsPerMonth: 30,
    scheduleEntitiesPerWeek: 9,
  };

  it('fits inside the free plan with room to spare', () => {
    const sim = simulateMonth(STRATEGY, BUDGET.monthlyEntities);
    expect(sim.safe).toBe(true);
    expect(sim.monthly).toBeLessThan(BUDGET.monthlyEntities * BUDGET.hardStopAt);
    expect(sim.headroom).toBeGreaterThan(0);
  });

  /**
   * Measuring changed the story, so the test says the measured thing.
   *
   * A whole Sunday slate is sixteen entities, not the ~3,200 the old notes
   * assumed, so fetching every game twice a week was wasteful rather than
   * fatal. What the two old habits did together was spend about three quarters
   * of the month — most of it on a daily season sweep for markets this provider
   * does not publish — which leaves no reserve for the fetches that matter and
   * nothing at all for a probe or a second deployment sharing the key.
   */
  it('prices the strategy this pass replaced at three quarters of the month', () => {
    const oldWay = simulateMonth(
      {
        ...STRATEGY,
        rosterGames: 16,
        nearKickoffEvents: 16,
        scheduleEntitiesPerWeek: 16,
        seasonEntitiesPerRun: 50,
        seasonRunsPerMonth: 30,
      },
      BUDGET.monthlyEntities,
    );
    expect(oldWay.fraction).toBeGreaterThanOrEqual(BUDGET.conservationAt);
    // The season sweep is where it went: 1,500 of it, for nothing.
    expect(50 * 30).toBeGreaterThan(oldWay.monthly * 0.75);

    // And the new one is a fraction of that.
    const now = simulateMonth(STRATEGY, BUDGET.monthlyEntities);
    expect(now.fraction).toBeLessThan(BUDGET.cautionAt / 2);
    expect(now.monthly).toBeLessThan(oldWay.monthly / 4);
  });

  it('shows its arithmetic', () => {
    const sim = simulateMonth(STRATEGY, BUDGET.monthlyEntities);
    expect(sim.lines.join('\n')).toContain('roster games: 8');
    expect(sim.lines.join('\n')).toContain(`month (5 weeks): ${sim.monthly} of ${BUDGET.monthlyEntities}`);
  });
});
