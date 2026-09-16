/**
 * The waiver scan cannot recommend a defence it never looked at.
 *
 * Measured on production on 16 September 2026, the defences the streaming lane
 * had to choose between were:
 *
 *     ARI ATL BUF CAR CHI CIN CLE DAL GB IND LV LAC
 *
 * Arizona through Los Angeles, alphabetically, and then it stops. Twelve of
 * thirty-two. Sleeper publishes neither an ADP nor a useful `search_rank` for a
 * team defence, so every one of them ties at the bottom of both sort keys and
 * the comparator falls through to its last tie-break — the name. Tampa Bay and
 * San Francisco sit 26th and 23rd in the alphabet, so the app had never once
 * been able to suggest either of them.
 *
 * It was not ranking them badly. It had never been shown them.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFreeAgentIds,
  FREE_AGENTS_PER_POSITION,
  WHOLE_POSITION_CAP,
} from '../src/core/roster/freeAgents.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';

/** Every NFL team, in the order Sleeper's own dictionary happens to hold them. */
const TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LV', 'LAC', 'LAR', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS',
];

/** Full names, so the alphabetical tie-break behaves as it does in production. */
const DEFENCE_NAMES: Record<string, string> = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs',
  LV: 'Las Vegas Raiders', LAC: 'Los Angeles Chargers', LAR: 'Los Angeles Rams', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SF: 'San Francisco 49ers',
  SEA: 'Seattle Seahawks', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

function player(over: Partial<CanonicalPlayer> & { id: string }): CanonicalPlayer {
  return {
    sleeperPlayerId: over.id,
    fullName: over.id,
    firstName: over.id,
    lastName: '',
    team: 'FA',
    position: 'WR',
    status: 'Active',
    active: true,
    normalizedName: over.id.toLowerCase(),
    aliases: [],
    ...over,
  } as CanonicalPlayer;
}

/**
 * The defences exactly as Sleeper serves them: no ADP, no `search_rank`,
 * identified by team abbreviation, named in full.
 */
function defences(): CanonicalPlayer[] {
  return TEAMS.map((team) =>
    player({ id: team, team, position: 'DEF', fullName: DEFENCE_NAMES[team]!, searchRank: null }),
  );
}

function receivers(count: number): CanonicalPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    player({ id: `wr${i}`, position: 'WR', fullName: `Receiver ${String(i).padStart(3, '0')}`, searchRank: i + 1 }),
  );
}

const NO_RANKS = new Map<string, { adp: number | null }>();

describe('a defence pool the alphabet cannot truncate', () => {
  it('scans every defence rather than the first twelve by name', () => {
    const ids = boundedFreeAgentIds(defences(), {
      rosteredIds: new Set(),
      startable: new Set(['DEF']),
      ranks: NO_RANKS,
    });

    expect(ids).toHaveLength(TEAMS.length);
  });

  it('reaches the two the reader could see and the app could not', () => {
    const ids = boundedFreeAgentIds(defences(), {
      rosteredIds: new Set(),
      startable: new Set(['DEF']),
      ranks: NO_RANKS,
    });

    expect(ids).toContain('TB');
    expect(ids).toContain('SF');
  });

  it('would have missed them under the old bound, which is why this test exists', () => {
    /*
     * The same comparator, the same data, truncated at twelve. Not a test of
     * today's code — a demonstration that the pool this app used to build could
     * not contain the answer, whatever the projection model said afterwards.
     */
    const alphabetical = defences()
      .map((d) => d.fullName)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, FREE_AGENTS_PER_POSITION);

    expect(alphabetical).not.toContain('Tampa Bay Buccaneers');
    expect(alphabetical).not.toContain('San Francisco 49ers');
  });

  it('still excludes a defence somebody already owns', () => {
    const ids = boundedFreeAgentIds(defences(), {
      rosteredIds: new Set(['JAX', 'TB']),
      startable: new Set(['DEF']),
      ranks: NO_RANKS,
    });

    expect(ids).not.toContain('JAX');
    expect(ids).not.toContain('TB');
    expect(ids).toContain('SF');
    expect(ids).toHaveLength(TEAMS.length - 2);
  });

  it('leaves every other position bounded exactly as it was', () => {
    const ids = boundedFreeAgentIds(receivers(60), {
      rosteredIds: new Set(),
      startable: new Set(['WR']),
      ranks: NO_RANKS,
    });

    expect(ids).toHaveLength(FREE_AGENTS_PER_POSITION);
  });

  it('keeps the ordinary bound if a league somehow produces more than one defence per team', () => {
    const tooMany = Array.from({ length: WHOLE_POSITION_CAP + 1 }, (_, i) =>
      player({ id: `def${i}`, position: 'DEF', fullName: `Defence ${i}`, searchRank: null }),
    );

    const ids = boundedFreeAgentIds(tooMany, {
      rosteredIds: new Set(),
      startable: new Set(['DEF']),
      ranks: NO_RANKS,
    });

    expect(ids).toHaveLength(FREE_AGENTS_PER_POSITION);
  });

  it('does not grow the scan for a league that does not start a defence', () => {
    const ids = boundedFreeAgentIds([...defences(), ...receivers(30)], {
      rosteredIds: new Set(),
      startable: new Set(['WR']),
      ranks: NO_RANKS,
    });

    expect(ids.every((id) => id.startsWith('wr'))).toBe(true);
    expect(ids).toHaveLength(FREE_AGENTS_PER_POSITION);
  });
});
