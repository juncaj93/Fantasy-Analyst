/**
 * Weekly decision quality.
 *
 * The valuable behaviour here is almost all refusal: not locking a player whose
 * kickoff is unknown, not calling a one-game spike a role change, not alerting
 * on a yard of passing yardage, not claiming to know whether waiting is worth it
 * when there is no projection. Each of those has a test, because each of them is
 * a way the feature could quietly start lying.
 */

import { describe, expect, it } from 'vitest';
import {
  WEEKLY_THRESHOLDS,
  assessLateSwap,
  assessRole,
  compareMarkets,
  isSignificantMove,
  lockState,
  rolePoints,
} from '../src/core/startsit/decisions.ts';

const SUNDAY_1PM = '2026-09-13T17:00:00.000Z';
const SUNDAY_4PM = '2026-09-13T20:00:00.000Z';
const SUNDAY_NIGHT = '2026-09-14T00:20:00.000Z';
const BEFORE_KICKOFF = '2026-09-13T15:00:00.000Z';
const AFTER_1PM = '2026-09-13T17:30:00.000Z';

describe('locked games', () => {
  it('locks a player once his game has started', () => {
    const state = lockState(SUNDAY_1PM, AFTER_1PM);
    expect(state.locked).toBe(true);
    expect(state.reason).toBe('game has started');
  });

  it('leaves a player unlocked before kickoff', () => {
    expect(lockState(SUNDAY_1PM, BEFORE_KICKOFF).locked).toBe(false);
  });

  it('locks exactly at kickoff, not a minute later', () => {
    expect(lockState(SUNDAY_1PM, SUNDAY_1PM).locked).toBe(true);
  });

  /** Staggered windows: the 1pm player is gone while the night player is not. */
  it('handles staggered kickoffs independently', () => {
    expect(lockState(SUNDAY_1PM, AFTER_1PM).locked).toBe(true);
    expect(lockState(SUNDAY_4PM, AFTER_1PM).locked).toBe(false);
    expect(lockState(SUNDAY_NIGHT, AFTER_1PM).locked).toBe(false);
  });

  it('never invents a lock from a missing or unreadable kickoff', () => {
    expect(lockState(null, AFTER_1PM).locked).toBe(false);
    expect(lockState('not a date', AFTER_1PM).locked).toBe(false);
    expect(lockState(undefined, AFTER_1PM).reason).toContain('unknown');
  });
});

describe('late-swap safety', () => {
  const healthyEarly = { name: 'Early WR', kickoff: SUNDAY_1PM, status: null, score: 11.1 };

  it('says nothing about a player with no injury designation', () => {
    const result = assessLateSwap(
      { preferred: { name: 'Night WR', kickoff: SUNDAY_NIGHT, status: null, score: 11.8 }, alternative: healthyEarly },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('no_risk');
  });

  /** The brief's own example: a small gap is not worth the availability risk. */
  it('suggests the healthy early option when the gap is small', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Night WR', kickoff: SUNDAY_NIGHT, status: 'Questionable', score: 11.8 },
        alternative: healthyEarly,
      },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('consider_early_option');
    expect(result.detail).toContain('Consider starting Early WR');
    expect(result.detail).toContain('unless the status improves');
    expect(result.advantage).toBe(0.7);
  });

  it('says a clearly better late player is worth waiting for', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Star WR', kickoff: SUNDAY_NIGHT, status: 'Questionable', score: 18 },
        alternative: healthyEarly,
      },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('worth_waiting');
    expect(result.detail).toContain('justify the availability risk');
  });

  it('treats Doubtful far harder than Questionable', () => {
    const preferred = { name: 'Star WR', kickoff: SUNDAY_NIGHT, score: 15 };
    const questionable = assessLateSwap(
      { preferred: { ...preferred, status: 'Questionable' }, alternative: healthyEarly },
      BEFORE_KICKOFF,
    );
    const doubtful = assessLateSwap(
      { preferred: { ...preferred, status: 'Doubtful' }, alternative: healthyEarly },
      BEFORE_KICKOFF,
    );
    // The same 3.9-point edge clears the bar when Questionable and not when Doubtful.
    expect(questionable.verdict).toBe('worth_waiting');
    expect(doubtful.verdict).toBe('consider_early_option');
  });

  it('is not a risk when the alternative does not lock meaningfully earlier', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Late WR', kickoff: SUNDAY_4PM, status: 'Questionable', score: 12 },
        alternative: { name: 'Other WR', kickoff: SUNDAY_4PM, status: null, score: 11 },
      },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('no_risk');
  });

  it('says the option is gone once the alternative has kicked off', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Night WR', kickoff: SUNDAY_NIGHT, status: 'Questionable', score: 11.8 },
        alternative: healthyEarly,
      },
      AFTER_1PM,
    );
    expect(result.verdict).toBe('unknown');
    expect(result.detail).toContain('already kicked off');
  });

  it('admits it cannot judge without projections', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Night WR', kickoff: SUNDAY_NIGHT, status: 'Questionable', score: null },
        alternative: { ...healthyEarly, score: null },
      },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('unknown');
    expect(result.detail).toContain('not enough projection data');
  });

  it('says so when there is no alternative at all', () => {
    const result = assessLateSwap(
      {
        preferred: { name: 'Night WR', kickoff: SUNDAY_NIGHT, status: 'Questionable', score: 11.8 },
        alternative: null,
      },
      BEFORE_KICKOFF,
    );
    expect(result.verdict).toBe('unknown');
    expect(result.detail).toContain('no eligible alternative');
  });
});

describe('market movement', () => {
  it('ignores trivial movement, per market', () => {
    // The brief's own calibration: a yard of passing is nothing, a reception is a lot.
    expect(isSignificantMove('pass_yards', 1)).toBe(false);
    expect(isSignificantMove('receptions', 1)).toBe(true);
    expect(isSignificantMove('receiving_yards', 7)).toBe(true);
    expect(isSignificantMove('receiving_yards', 2)).toBe(false);
    expect(isSignificantMove('game_total', 5)).toBe(true);
    expect(isSignificantMove('game_total', 1.5)).toBe(false);
  });

  it('reports a single meaningful move with both numbers', () => {
    const summary = compareMarkets(
      [{ market: 'receiving_yards', line: 52.5 }],
      [{ market: 'receiving_yards', line: 59.5 }],
    );
    expect(summary.headline).toBe('Market rising');
    expect(summary.significant).toHaveLength(1);
    expect(summary.significant[0]!.display).toBe('Receiving yards: 52.5 → 59.5');
  });

  it('calls several markets moving together what it is', () => {
    const summary = compareMarkets(
      [
        { market: 'receptions', line: 4.5 },
        { market: 'receiving_yards', line: 52.5 },
        { market: 'anytime_td', line: 0.32 },
      ],
      [
        { market: 'receptions', line: 5.5 },
        { market: 'receiving_yards', line: 61.5 },
        { market: 'anytime_td', line: 0.45 },
      ],
    );
    expect(summary.headline).toBe('Multiple markets rising');
    expect(summary.direction).toBe('up');
    expect(summary.significant).toHaveLength(3);
  });

  it('names a falling game environment separately', () => {
    const summary = compareMarkets([{ market: 'game_total', line: 49.5 }], [{ market: 'game_total', line: 44 }]);
    expect(summary.headline).toBe('Game environment falling');
  });

  it('says nothing at all when nothing moved enough', () => {
    const summary = compareMarkets(
      [
        { market: 'pass_yards', line: 245.5 },
        { market: 'rush_yards', line: 62.5 },
      ],
      [
        { market: 'pass_yards', line: 247.5 },
        { market: 'rush_yards', line: 64.5 },
      ],
    );
    expect(summary.headline).toBeNull();
    expect(summary.significant).toHaveLength(0);
    // The raw moves are still there for anyone who expands them.
    expect(summary.movements).toHaveLength(2);
  });

  it('does not treat an appearing or disappearing line as movement', () => {
    const summary = compareMarkets(
      [{ market: 'receptions', line: null }],
      [{ market: 'receptions', line: 6.5 }, { market: 'receiving_yards', line: 70 }],
    );
    expect(summary.movements).toHaveLength(0);
  });
});

describe('role change', () => {
  const targets = (perGame: number[]) => [{ key: 'targets', label: 'Targets', perGame }];

  it('says so plainly when no usage is connected', () => {
    const result = assessRole([]);
    expect(result.trend).toBe('insufficient_data');
    expect(result.detail).toContain('No per-game usage is connected');
  });

  it('refuses to judge a short sample', () => {
    const result = assessRole(targets([5, 6, 7, 8]));
    expect(result.trend).toBe('insufficient_data');
    expect(result.games).toBe(4);
  });

  it('calls a steady role stable', () => {
    expect(assessRole(targets([6, 5, 7, 6, 6, 7])).trend).toBe('stable');
  });

  /** The brief's explicit anti-example: 6.0 season, 7.0 recent, one 14-target game. */
  it('does not call a one-game spike a role change', () => {
    const result = assessRole(targets([6, 6, 6, 6, 2, 3, 14]));
    expect(result.trend).toBe('spike');
    expect(result.label).toContain('One-game spike');
  });

  it('calls a sustained rise a rise', () => {
    const result = assessRole(targets([6, 6, 6, 6, 8, 8, 8]));
    expect(result.trend).toBe('rising_moderate');
    expect(result.detail).toContain('Targets up');
  });

  /** Agreement across metrics is what lifts a moderate call to a confident one. */
  it('is more confident when two metrics agree', () => {
    const alone = assessRole([{ key: 'targets', label: 'Targets', perGame: [6, 6, 6, 6, 8, 8, 8] }]);
    const together = assessRole([
      { key: 'targets', label: 'Targets', perGame: [6, 6, 6, 6, 8, 8, 8] },
      { key: 'routes', label: 'Route share', perGame: [70, 70, 70, 70, 90, 90, 90] },
    ]);
    expect(alone.trend).toBe('rising_moderate');
    expect(together.trend).toBe('rising_high');
    expect(together.detail).toContain('agreeing');
  });

  /**
   * The brief says high confidence "ideally" wants agreement, not that it
   * requires it: one metric moving emphatically with nothing contradicting it
   * is a confident call on its own.
   */
  it('is confident about one emphatic metric with nothing against it', () => {
    expect(assessRole(targets([5, 6, 5, 6, 9, 10, 10])).trend).toBe('rising_high');
  });

  it('trusts neither metric when they disagree', () => {
    const result = assessRole([
      { key: 'targets', label: 'Targets', perGame: [5, 5, 5, 5, 10, 10, 10] },
      { key: 'carries', label: 'Carries', perGame: [10, 10, 10, 10, 4, 4, 4] },
    ]);
    expect(result.trend).toBe('stable');
    expect(result.detail).toContain('disagree');
  });

  it('detects a falling role too', () => {
    const result = assessRole(targets([10, 11, 10, 11, 5, 6, 5]));
    expect(result.trend).toMatch(/^falling_/);
  });

  it('is worth a modest nudge in a close call, and nothing when unknown', () => {
    expect(rolePoints('rising_high')).toBeGreaterThan(rolePoints('rising_moderate'));
    expect(rolePoints('falling_high')).toBeLessThan(rolePoints('falling_moderate'));
    expect(rolePoints('stable')).toBe(0);
    expect(rolePoints('insufficient_data')).toBe(0);
    expect(rolePoints('spike')).toBe(0);
    // Bounded: a role trend nudges a close decision, it does not decide one.
    expect(Math.abs(rolePoints('rising_high'))).toBeLessThanOrEqual(1);
  });

  it('keeps the per-metric numbers for the expandable view', () => {
    const result = assessRole(targets([5, 6, 5, 6, 9, 10, 10]));
    expect(result.metrics[0]).toMatchObject({ key: 'targets', direction: 'up' });
    expect(result.metrics[0]!.baseline).toBeGreaterThan(0);
    expect(result.metrics[0]!.recent).toBeGreaterThan(result.metrics[0]!.baseline);
  });

  it('uses the configured recent window', () => {
    expect(WEEKLY_THRESHOLDS.role.recentGames).toBe(3);
  });
});
