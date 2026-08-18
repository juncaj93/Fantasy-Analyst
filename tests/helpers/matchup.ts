/**
 * Fixtures for the matchup model.
 *
 * Deliberately hand-built rather than derived from a start/sit evaluation: the
 * model's whole contract is that it is arithmetic over a list of players, and a
 * fixture that needed the evidence ledger, the Vegas cache and the injury layer
 * to exist would be testing the pipeline instead of the model.
 */

import { slotKey } from '../../src/core/matchup/model.ts';
import type { SlotSpec } from '../../src/core/matchup/decision.ts';
import type { MatchupPlayerInput, MatchupSide } from '../../src/core/matchup/types.ts';

/** The ordinary half-PPR shape, as slot specs the model can read. */
export function slots(labels: string[] = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']): SlotSpec[] {
  const accepts: Record<string, string[]> = {
    QB: ['QB'],
    RB: ['RB'],
    WR: ['WR'],
    TE: ['TE'],
    FLEX: ['RB', 'WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  };
  return labels.map((slot, index) => ({
    key: slotKey(slot, index),
    slot,
    accepts: accepts[slot] ?? [slot],
  }));
}

export function player(
  over: Partial<MatchupPlayerInput> & { playerId: string; side: MatchupSide },
): MatchupPlayerInput {
  return {
    name: `Player ${over.playerId}`,
    position: 'WR',
    team: 'KC',
    opponent: 'DEN',
    slot: null,
    starting: true,
    projection: 12,
    actual: 0,
    kickoff: '2026-12-20T18:00:00Z',
    roleBucket: 'unclassified',
    availability: 'high_confidence_active',
    ruledOut: false,
    ...over,
  };
}

/**
 * Two full lineups, symmetrical apart from what a test changes.
 *
 * Symmetry matters: a fixture whose two sides differ in a way the test did not
 * intend produces a win probability that looks like a finding and is a typo.
 */
export function lineups(opts: {
  mineProjections?: number[];
  theirsProjections?: number[];
  positions?: string[];
  mineTeams?: string[];
  theirsTeams?: string[];
} = {}): MatchupPlayerInput[] {
  const positions = opts.positions ?? ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR'];
  const spec = slots();
  const mineProjections = opts.mineProjections ?? [18, 12, 10, 14, 11, 8, 9];
  const theirsProjections = opts.theirsProjections ?? [18, 12, 10, 14, 11, 8, 9];
  const mineTeams = opts.mineTeams ?? ['KC', 'BUF', 'SF', 'PHI', 'MIA', 'DET', 'LAR'];
  const theirsTeams = opts.theirsTeams ?? ['CIN', 'BAL', 'GB', 'MIN', 'SEA', 'DAL', 'HOU'];

  const build = (side: MatchupSide, projections: number[], teams: string[]) =>
    positions.map((position, i) =>
      player({
        playerId: `${side}-${i}`,
        side,
        name: `${side === 'mine' ? 'Mine' : 'Theirs'} ${position}${i}`,
        position,
        team: teams[i] ?? 'KC',
        opponent: 'OPP',
        slot: spec[i]!.key,
        starting: true,
        projection: projections[i] ?? 10,
      }),
    );

  return [...build('mine', mineProjections, mineTeams), ...build('theirs', theirsProjections, theirsTeams)];
}
