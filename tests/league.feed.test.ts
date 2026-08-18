/**
 * The decision feed, "why did his rank move", and the planning gates.
 *
 * Three features that are mostly defined by what they refuse to say, so these
 * are mostly tests that nothing is emitted.
 */

import { describe, expect, it } from 'vitest';
import {
  MATERIALITY_THRESHOLD,
  buildFeed,
  dedupe,
  isMaterial,
  reconcile,
  type FeedCandidate,
} from '../src/core/league/feed.ts';
import {
  MIN_PART,
  diffDecomposition,
  hashInputs,
  shouldCapture,
  type Decomposition,
} from '../src/core/league/rankMove.ts';
import { BYE_LOOKAHEAD_WEEKS, byeOutlook, playoffEmphasis, playoffWeeks } from '../src/core/league/planning.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

function candidate(over: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    kind: 'injury',
    dedupeKey: 'injury:4034',
    playerId: '4034',
    headline: 'Ruled out — start confidence down',
    magnitude: 0.8,
    occurredAt: '2026-09-12T14:00:00.000Z',
    changesDecision: true,
    ...over,
  };
}

describe('materiality', () => {
  it('emits nothing when nothing changed a decision', () => {
    expect(isMaterial(candidate({ changesDecision: false, magnitude: 1 }))).toBe(false);
    expect(buildFeed([candidate({ changesDecision: false })])).toEqual([]);
  });

  it('emits nothing for a movement below the threshold', () => {
    const tiny = candidate({ magnitude: MATERIALITY_THRESHOLD - 0.01 });
    expect(isMaterial(tiny)).toBe(false);
    expect(buildFeed([tiny])).toEqual([]);
  });

  it('a refresh that found the same numbers produces no feed at all', () => {
    // The shape a refresh takes: everything observed, nothing decided.
    const refresh = [
      candidate({ kind: 'market', dedupeKey: 'props:1', magnitude: 0.02, changesDecision: false }),
      candidate({ kind: 'market', dedupeKey: 'props:2', magnitude: 0, changesDecision: false }),
      candidate({ kind: 'rank', dedupeKey: 'rank:1', magnitude: 0.05, changesDecision: false }),
    ];
    expect(buildFeed(refresh)).toEqual([]);
  });

  it('lets a real change through', () => {
    expect(buildFeed([candidate()])).toHaveLength(1);
  });
});

describe('deduplication', () => {
  it('collapses three sources describing one injury into one event', () => {
    const events = buildFeed([
      candidate({ magnitude: 0.5, source: 'newsletter', headline: 'Questionable' }),
      candidate({ magnitude: 0.9, source: 'injury report', headline: 'Ruled out — start confidence down' }),
      candidate({ magnitude: 0.6, source: 'Sleeper', headline: 'Doubtful' }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.headline).toBe('Ruled out — start confidence down');
    expect(events[0]!.corroboration.sort()).toEqual(['Sleeper', 'newsletter']);
  });

  it('keeps genuinely different situations apart', () => {
    const events = buildFeed([candidate(), candidate({ dedupeKey: 'role:911', playerId: '911', kind: 'role' })]);
    expect(events).toHaveLength(2);
  });

  it('filters before it merges, so repetition cannot defeat the threshold', () => {
    const immaterial = Array.from({ length: 5 }, () => candidate({ magnitude: 0.05, changesDecision: false }));
    expect(buildFeed(immaterial)).toEqual([]);
    // Without the ordering, dedupe would have produced one event from five.
    expect(dedupe(immaterial)).toHaveLength(1);
  });
});

describe('reconciling against what is already on screen', () => {
  const open = [{ id: 7, dedupeKey: 'injury:4034', headline: 'Questionable', magnitude: 0.5 }];

  it('supersedes a developing story rather than duplicating it', () => {
    const result = reconcile(open, buildFeed([candidate()]));
    expect(result.insert).toEqual([]);
    expect(result.supersede).toHaveLength(1);
    expect(result.supersede[0]!.id).toBe(7);
  });

  it('changes nothing when the same thing is reported again', () => {
    const same = buildFeed([candidate({ headline: 'Questionable', magnitude: 0.5 })]);
    const result = reconcile(open, same);
    expect(result.unchanged).toHaveLength(1);
    expect(result.insert).toEqual([]);
    expect(result.supersede).toEqual([]);
  });

  it('inserts a situation nothing on screen covers', () => {
    const result = reconcile(open, buildFeed([candidate({ dedupeKey: 'role:99', kind: 'role' })]));
    expect(result.insert).toHaveLength(1);
  });
});

// ------------------------------------------------------- why did rank move

function decomposition(over: Partial<Decomposition> = {}): Decomposition {
  return {
    context: 'draft',
    scope: 'draft-1',
    playerId: 'p1',
    capturedAt: '2026-09-10T00:00:00.000Z',
    rank: 8,
    total: 10,
    components: [
      { key: 'role', label: 'Role', value: 4 },
      { key: 'vegas', label: 'Vegas', value: 3 },
      { key: 'matchup', label: 'Matchup', value: 3 },
    ],
    inputHash: 'aaaa',
    ...over,
  };
}

describe('why did his rank move', () => {
  it('decomposes the movement into parts that reconcile', () => {
    const movement = diffDecomposition(
      decomposition(),
      decomposition({
        rank: 4,
        total: 14,
        capturedAt: '2026-09-12T00:00:00.000Z',
        components: [
          { key: 'role', label: 'Role', value: 7 },
          { key: 'vegas', label: 'Vegas', value: 5 },
          { key: 'matchup', label: 'Matchup', value: 2 },
        ],
        inputHash: 'bbbb',
      }),
    );

    expect(movement.rankDisplay).toBe('#8 -> #4');
    expect(movement.reconciles).toBe(true);
    expect(movement.parts.map((p) => p.display)).toEqual(['+3 role', '+2 vegas', '-1 matchup']);
    expect(movement.parts.reduce((a, p) => a + p.delta, 0)).toBeCloseTo(movement.totalDelta, 5);
  });

  it('says so rather than inventing a reason when the parts do not add up', () => {
    const movement = diffDecomposition(
      decomposition(),
      decomposition({ total: 20, inputHash: 'bbbb' }),
    );
    expect(movement.reconciles).toBe(false);
    const residual = movement.parts.find((p) => p.key === 'unexplained')!;
    expect(residual.display).toBe('+10 unexplained');
  });

  it('does not print a component that barely moved', () => {
    const movement = diffDecomposition(
      decomposition(),
      decomposition({
        total: 10 + MIN_PART / 2,
        components: [
          { key: 'role', label: 'Role', value: 4 + MIN_PART / 2 },
          { key: 'vegas', label: 'Vegas', value: 3 },
          { key: 'matchup', label: 'Matchup', value: 3 },
        ],
        inputHash: 'bbbb',
      }),
    );
    expect(movement.parts.filter((p) => p.key === 'role')).toEqual([]);
  });

  it('treats a component that did not exist before as having been zero', () => {
    const movement = diffDecomposition(
      decomposition({ components: [{ key: 'role', label: 'Role', value: 4 }], total: 4 }),
      decomposition({
        components: [
          { key: 'role', label: 'Role', value: 4 },
          { key: 'weather', label: 'Weather', value: -2 },
        ],
        total: 2,
        inputHash: 'bbbb',
      }),
    );
    expect(movement.reconciles).toBe(true);
    expect(movement.parts[0]!.display).toBe('-2 weather');
  });
});

describe('no fake movement', () => {
  it('hashes the same inputs to the same value regardless of key order', () => {
    expect(hashInputs({ a: 1, b: [2, 3] })).toBe(hashInputs({ b: [2, 3], a: 1 }));
    expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
  });

  it('refuses to capture a snapshot whose inputs are unchanged', () => {
    const latest = decomposition({ inputHash: 'same' });
    expect(shouldCapture(latest, { inputHash: 'same' })).toBe(false);
    expect(shouldCapture(latest, { inputHash: 'different' })).toBe(true);
    expect(shouldCapture(null, { inputHash: 'anything' })).toBe(true);
  });

  it('reports no movement when a board is recomputed identically', () => {
    const movement = diffDecomposition(decomposition(), decomposition({ capturedAt: '2026-09-11T00:00:00.000Z' }));
    expect(movement.moved).toBe(false);
    expect(movement.parts).toEqual([]);
  });
});

// ------------------------------------------------------------- bye/playoff

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

describe('bye planning is quiet unless it matters', () => {
  const roster = (byes: (number | null)[]) =>
    byes.map((byeWeek, i) => ({
      playerId: `rb${i}`,
      name: `RB ${i}`,
      position: 'RB',
      byeWeek,
      starter: i < 2,
    }));

  it('says nothing when the roster covers every bye', () => {
    const outlook = byeOutlook({ roster: roster([6, 7, 8, 9]), shape: SHAPE, currentWeek: 5 });
    expect(outlook.gaps).toEqual([]);
    expect(outlook.alerts).toEqual([]);
  });

  it('reports a week that leaves a slot unfillable', () => {
    const outlook = byeOutlook({ roster: roster([6, 6]), shape: SHAPE, currentWeek: 5 });
    expect(outlook.gaps).toHaveLength(1);
    expect(outlook.gaps[0]!.severity).toBe('unfillable');
    expect(outlook.alerts[0]).toContain('Week 6');
  });

  it('does not warn in week 1 about a week 12 cluster', () => {
    const outlook = byeOutlook({ roster: roster([12, 12]), shape: SHAPE, currentWeek: 1 });
    expect(outlook.gaps).toEqual([]);
    expect(outlook.window).toEqual({ from: 1, to: 1 + BYE_LOOKAHEAD_WEEKS });
  });

  it('says nothing at all when no bye weeks are known', () => {
    const outlook = byeOutlook({ roster: roster([null, null, null]), shape: SHAPE, currentWeek: 5 });
    expect(outlook.gaps).toEqual([]);
  });
});

describe('playoff weeks arrive on a ramp', () => {
  it('carries no weight in August', () => {
    const { weight, reason } = playoffEmphasis({
      currentWeek: 1,
      playoffStartWeek: 15,
      wins: 0,
      losses: 0,
      playoffTeams: 6,
      totalTeams: 12,
    });
    expect(weight).toBe(0);
    expect(reason).toContain('too early');
  });

  it('carries no weight for a team that is not heading there', () => {
    const { weight } = playoffEmphasis({
      currentWeek: 9,
      playoffStartWeek: 15,
      wins: 1,
      losses: 8,
      playoffTeams: 6,
      totalTeams: 12,
    });
    expect(weight).toBe(0);
  });

  it('ramps up for a contender late in the season', () => {
    const early = playoffEmphasis({
      currentWeek: 6,
      playoffStartWeek: 15,
      wins: 5,
      losses: 1,
      playoffTeams: 6,
      totalTeams: 12,
    });
    const late = playoffEmphasis({
      currentWeek: 12,
      playoffStartWeek: 15,
      wins: 10,
      losses: 2,
      playoffTeams: 6,
      totalTeams: 12,
    });
    expect(early.weight).toBeGreaterThan(0);
    expect(late.weight).toBeGreaterThan(early.weight);
    expect(late.weight).toBeLessThanOrEqual(1);
  });

  it('asks more of a team in a league where fewer make it', () => {
    const wide = playoffEmphasis({ currentWeek: 10, playoffStartWeek: 15, wins: 5, losses: 5, playoffTeams: 8, totalTeams: 12 });
    const narrow = playoffEmphasis({ currentWeek: 10, playoffStartWeek: 15, wins: 5, losses: 5, playoffTeams: 4, totalTeams: 12 });
    expect(wide.weight).toBeGreaterThan(narrow.weight);
  });

  it('reads the playoff weeks from the league rather than assuming them', () => {
    expect(playoffWeeks(15)).toEqual([15, 16, 17]);
    expect(playoffWeeks(14, 4)).toEqual([14, 15, 16, 17]);
    expect(playoffWeeks(0)).toEqual([]);
  });
});
