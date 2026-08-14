/**
 * The lineup once games have started.
 *
 * A recommendation the user physically cannot follow is worse than no
 * recommendation. Once a game kicks off that player's slot is settled, and the
 * only useful advice is about the players who can still be moved — so these
 * tests are about what the optimiser must stop saying, window by window.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { compareStartSit, type StartSitInput } from '../src/core/startsit/engine.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const SUNDAY_1PM = '2026-09-13T17:00:00.000Z';
const SUNDAY_4PM = '2026-09-13T20:00:00.000Z';
const SUNDAY_NIGHT = '2026-09-14T00:20:00.000Z';
const BEFORE_ANY = '2026-09-13T15:00:00.000Z';
const AFTER_1PM = '2026-09-13T18:00:00.000Z';
const AFTER_4PM = '2026-09-13T21:00:00.000Z';

function candidate(
  id: string,
  name: string,
  position: string,
  points: number,
  opts: { kickoff?: string | null; status?: string | null; now?: string } = {},
): StartSitInput {
  const props: PlayerProp[] = [
    {
      playerId: id,
      sourcePlayerName: name,
      market: position === 'QB' ? 'pass_yards' : 'receiving_yards',
      line: position === 'QB' ? points / 0.04 : points * 10,
      overPrice: -110,
      underPrice: -110,
      bookCount: 3,
      consensusMethod: 'median',
      books: ['a', 'b', 'c'],
      impliedProbability: null,
    },
  ];
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props,
    signal: null,
    injuryStatus: opts.status ?? null,
    propsStale: false,
    kickoff: opts.kickoff ?? null,
    now: opts.now ?? BEFORE_ANY,
  };
}

/** A full legal roster, all kicking off at 1pm unless told otherwise. */
function roster(now: string, overrides: Record<string, { kickoff?: string; points?: number; status?: string }> = {}) {
  const base: [string, string, string, number][] = [
    ['qb1', 'Passer One', 'QB', 20],
    ['rb1', 'Runner One', 'RB', 15],
    ['rb2', 'Runner Two', 'RB', 12],
    ['rb3', 'Runner Three', 'RB', 11],
    ['wr1', 'Catcher One', 'WR', 14],
    ['wr2', 'Catcher Two', 'WR', 10],
    ['wr3', 'Catcher Three', 'WR', 9],
    ['te1', 'End One', 'TE', 8],
  ];
  return base.map(([id, name, position, points]) =>
    candidate(id, name, position, overrides[id]?.points ?? points, {
      kickoff: overrides[id]?.kickoff ?? SUNDAY_1PM,
      ...(overrides[id]?.status ? { status: overrides[id]!.status! } : {}),
      now,
    }),
  );
}

describe('locked games', () => {
  it('changes nothing before any game has started', () => {
    const result = recommendLineup(roster(BEFORE_ANY), SHAPE, HALF_PPR, {
      currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'],
    });
    expect(result.slots.every((s) => !s.locked)).toBe(true);
    expect(result.notes.join(' ')).not.toContain('kicked off');
  });

  it('keeps a locked starter in their slot even when a better bench option exists', () => {
    // Catcher Two is locked and starting; Catcher Three is better but is not.
    const result = recommendLineup(
      roster(AFTER_1PM, {
        wr2: { kickoff: SUNDAY_1PM, points: 10 },
        wr3: { kickoff: SUNDAY_NIGHT, points: 13 },
        qb1: { kickoff: SUNDAY_NIGHT },
        rb1: { kickoff: SUNDAY_NIGHT },
        rb2: { kickoff: SUNDAY_NIGHT },
        rb3: { kickoff: SUNDAY_NIGHT },
        wr1: { kickoff: SUNDAY_NIGHT },
        te1: { kickoff: SUNDAY_NIGHT },
      }),
      SHAPE,
      HALF_PPR,
      { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'] },
    );

    const wr2Slot = result.slots.find((s) => s.playerId === 'wr2');
    expect(wr2Slot, 'a locked starter keeps their slot').toBeDefined();
    expect(wr2Slot!.locked).toBe(true);
    // ...and no swap is proposed against them.
    expect(result.swaps.some((s) => s.outPlayerId === 'wr2')).toBe(false);
  });

  it('excludes a bench player whose game has already started', () => {
    const result = recommendLineup(
      roster(AFTER_1PM, {
        // The best available receiver has already played — he is not an option.
        wr3: { kickoff: SUNDAY_1PM, points: 30 },
        qb1: { kickoff: SUNDAY_NIGHT },
        rb1: { kickoff: SUNDAY_NIGHT },
        rb2: { kickoff: SUNDAY_NIGHT },
        rb3: { kickoff: SUNDAY_NIGHT },
        wr1: { kickoff: SUNDAY_NIGHT },
        wr2: { kickoff: SUNDAY_NIGHT },
        te1: { kickoff: SUNDAY_NIGHT },
      }),
      SHAPE,
      HALF_PPR,
      { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1'] },
    );

    expect(result.slots.some((s) => s.playerId === 'wr3')).toBe(false);
    expect(result.bench.some((b) => b.playerId === 'wr3')).toBe(false);
    expect(result.swaps.some((s) => s.inPlayerId === 'wr3')).toBe(false);
  });

  it('recalculates as each window starts', () => {
    const overrides = {
      qb1: { kickoff: SUNDAY_1PM },
      rb1: { kickoff: SUNDAY_1PM },
      rb2: { kickoff: SUNDAY_4PM },
      rb3: { kickoff: SUNDAY_4PM },
      wr1: { kickoff: SUNDAY_4PM },
      wr2: { kickoff: SUNDAY_NIGHT },
      wr3: { kickoff: SUNDAY_NIGHT },
      te1: { kickoff: SUNDAY_NIGHT },
    };
    const starters = { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'] };

    const early = recommendLineup(roster(BEFORE_ANY, overrides), SHAPE, HALF_PPR, starters);
    const afterOne = recommendLineup(roster(AFTER_1PM, overrides), SHAPE, HALF_PPR, starters);
    const afterFour = recommendLineup(roster(AFTER_4PM, overrides), SHAPE, HALF_PPR, starters);

    expect(early.slots.filter((s) => s.locked)).toHaveLength(0);
    // The 1pm pair locks first, then the 4pm group joins them.
    expect(afterOne.slots.filter((s) => s.locked).map((s) => s.playerId).sort()).toEqual(['qb1', 'rb1']);
    expect(afterFour.slots.filter((s) => s.locked).map((s) => s.playerId).sort()).toEqual([
      'qb1',
      'rb1',
      'rb2',
      'rb3',
      'wr1',
    ]);
    expect(afterFour.notes.join(' ')).toContain('kicked off');
  });

  it('never locks a player whose kickoff is unknown', () => {
    const result = recommendLineup(
      roster(AFTER_4PM, {}).map((c) => ({ ...c, kickoff: null })),
      SHAPE,
      HALF_PPR,
      { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'] },
    );
    expect(result.slots.every((s) => !s.locked)).toBe(true);
  });
});

describe('late swap in a head-to-head comparison', () => {
  it('warns when the preferred player is questionable and locks much later', () => {
    // The brief's own numbers: after the Questionable penalty the night player
    // still projects ~0.7 points ahead of the healthy 1pm alternative.
    const comparison = compareStartSit(
      [
        candidate('night', 'Night WR', 'WR', 13.3, { kickoff: SUNDAY_NIGHT, status: 'Questionable' }),
        candidate('early', 'Early WR', 'WR', 11.1, { kickoff: SUNDAY_1PM }),
      ],
      HALF_PPR,
    );
    // The projection still prefers the better player — the risk is named, not
    // silently applied.
    expect(comparison.recommendedPlayerId).toBe('night');
    expect(comparison.margin).toBeCloseTo(0.7, 1);
    expect(comparison.lateSwap.verdict).toBe('consider_early_option');
    expect(comparison.warnings.join(' ')).toContain('Consider starting Early WR');
  });

  it('says a much better late player is worth waiting for', () => {
    const comparison = compareStartSit(
      [
        candidate('night', 'Star WR', 'WR', 19, { kickoff: SUNDAY_NIGHT, status: 'Questionable' }),
        candidate('early', 'Early WR', 'WR', 11, { kickoff: SUNDAY_1PM }),
      ],
      HALF_PPR,
    );
    expect(comparison.lateSwap.verdict).toBe('worth_waiting');
    expect(comparison.reasons.join(' ')).toContain('justify the availability risk');
  });

  it('says nothing about timing when nobody is carrying a designation', () => {
    const comparison = compareStartSit(
      [
        candidate('night', 'Night WR', 'WR', 11.8, { kickoff: SUNDAY_NIGHT }),
        candidate('early', 'Early WR', 'WR', 11.1, { kickoff: SUNDAY_1PM }),
      ],
      HALF_PPR,
    );
    expect(comparison.lateSwap.verdict).toBe('no_risk');
    expect(comparison.warnings.join(' ')).not.toContain('Consider starting');
  });

  it('says plainly when a candidate has already kicked off', () => {
    const comparison = compareStartSit(
      [
        candidate('night', 'Night WR', 'WR', 11.8, { kickoff: SUNDAY_NIGHT, now: AFTER_1PM }),
        candidate('early', 'Early WR', 'WR', 11.1, { kickoff: SUNDAY_1PM, now: AFTER_1PM }),
      ],
      HALF_PPR,
    );
    expect(comparison.warnings.join(' ')).toContain('Early WR has already kicked off');
  });
});
