/**
 * Matchup names who takes a real hole, and nothing else (5 November 2026).
 *
 * Its win-chance swap search (its own 2% win-chance bar, its own favorite and
 * underdog reasoning) was never drawn on any screen and is gone: one mode, one
 * toss-up bar, one decision function (Alex's decision; review S3). What is
 * left is the Live insights line for a starter who is Out, Doubtful, on IR or
 * on a bye: who takes his slot, by Team's ranking rule, and what it is worth.
 */

import { describe, expect, it } from 'vitest';
import * as decisionModule from '../src/core/matchup/decision.ts';
import { assessLineupDecision } from '../src/core/matchup/decision.ts';
import { buildDistribution, resolveGameClock } from '../src/core/matchup/distribution.ts';
import { simulateMatchup } from '../src/core/matchup/simulate.ts';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');

function decide(players: MatchupPlayerInput[], now: Date = BEFORE) {
  const distributions = players.map((p) => buildDistribution(p, resolveGameClock(p.kickoff, now, { hasPoints: p.actual > 0 })));
  const result = simulateMatchup({ players, distributions, seed: 'hole-seed', draws: 4000 });
  return assessLineupDecision({ result, players, distributions, slots: slots() });
}

const bench = (over: Partial<MatchupPlayerInput> & { playerId: string }) =>
  player({ side: 'mine', starting: false, slot: null, ...over });

describe('the win-chance swap search is gone', () => {
  it('exports no second bar', () => {
    expect('MIN_WIN_PROBABILITY_GAIN' in decisionModule).toBe(false);
  });

  it('offers nothing when no starter is a hole, even with a better bench player', () => {
    /* A bench receiver 6 points over the FLEX starter: Team's call, not Matchup's. */
    const players = [...lineups(), bench({ playerId: 'b1', position: 'WR', projection: 15 })];
    const decision = decide(players);
    expect(decision.fills).toEqual([]);
    expect(decision.note).toMatch(/has a game/);
  });
});

describe('a real hole is filled by Team\'s ranking rule', () => {
  it('fills a ruled-out starter (Out or Doubtful) with the highest-ranked legal bench player', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-3' ? { ...p, ruledOut: true, designation: 'doubtful' as const } : p));
    players.push(
      bench({ playerId: 'b-wr', position: 'WR', projection: 9 }),
      bench({ playerId: 'b-wr2', position: 'WR', projection: 11 }),
      bench({ playerId: 'b-rb', position: 'RB', projection: 20 }),
    );
    const decision = decide(players);
    expect(decision.fills).toHaveLength(1);
    const fill = decision.fills[0]!;
    expect(fill.outPlayerId).toBe('mine-3');
    /* The WR slot takes only receivers: the 20-point back cannot play it. */
    expect(fill.inPlayerId).toBe('b-wr2');
    expect(fill.winAfter).toBeGreaterThan(fill.winNow);
  });

  it('ranks a Sleeper-only bench player two points lower, as Team does', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-3' ? { ...p, ruledOut: true } : p));
    players.push(
      bench({ playerId: 'priced', position: 'WR', projection: 11 }),
      bench({ playerId: 'borrowed', position: 'WR', projection: 12.5, projectionBorrowed: true }),
    );
    expect(decide(players).fills[0]!.inPlayerId).toBe('priced');
  });

  it('fills a starter on a bye', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-1' ? { ...p, onBye: true, projection: 0 } : p));
    players.push(bench({ playerId: 'b-rb', position: 'RB', projection: 8 }));
    expect(decide(players).fills.map((f) => [f.outPlayerId, f.inPlayerId])).toEqual([['mine-1', 'b-rb']]);
  });

  it('never moves a game that has started', () => {
    const players = lineups().map((p) =>
      p.playerId === 'mine-3' ? { ...p, ruledOut: true, kickoff: '2026-12-20T13:00:00Z' } : p,
    );
    players.push(bench({ playerId: 'b-wr', position: 'WR', projection: 11 }));
    expect(decide(players, new Date('2026-12-20T14:00:00Z')).fills).toEqual([]);
  });

  it('says so when nobody on the bench can take the slot', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-0' ? { ...p, ruledOut: true } : p));
    players.push(bench({ playerId: 'b-wr', position: 'WR', projection: 11 }));
    const decision = decide(players);
    expect(decision.fills).toEqual([]);
    expect(decision.note).toMatch(/Nobody on your bench/);
  });
});
