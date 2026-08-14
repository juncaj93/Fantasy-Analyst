/**
 * Which positions the app carries, and which it refuses to.
 *
 * Kickers are gone: nothing in this app models them — no news rule reads them,
 * no Vegas market covers them, no published ADP it uses ranks them — so
 * carrying three hundred of them only ever produced empty screens.
 *
 * Defences are a different case entirely and these tests keep the two apart:
 * defences are still carried, and a league that starts one still sees them. A
 * league that does not start one simply is not offered the filter, which is the
 * behaviour that made them look missing.
 */

import { describe, expect, it } from 'vitest';
import { EXCLUDED_POSITIONS, isExcludedPosition, toCanonicalPlayers } from '../src/core/sleeper/transform.ts';
import { buildRosterShape, startablePositions } from '../src/core/sleeper/scoring.ts';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

function sleeperPlayer(id: string, position: string, first: string, last: string) {
  return {
    player_id: id,
    position,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    team: 'KC',
    active: true,
    search_rank: 100,
  };
}

describe('kickers are not carried', () => {
  it('drops them from the Sleeper dump, keeping everyone else', () => {
    const players = toCanonicalPlayers({
      k1: sleeperPlayer('k1', 'K', 'Harrison', 'Butker'),
      k2: sleeperPlayer('k2', 'PK', 'Justin', 'Tucker'),
      qb1: sleeperPlayer('qb1', 'QB', 'Patrick', 'Mahomes'),
      def1: sleeperPlayer('def1', 'DEF', 'Kansas City', 'Chiefs'),
    });
    expect(players.map((p) => p.position).sort()).toEqual(['DEF', 'QB']);
  });

  it('names the exclusion in one place', () => {
    expect([...EXCLUDED_POSITIONS]).toEqual(['K']);
    expect(isExcludedPosition('K')).toBe(true);
    expect(isExcludedPosition('k')).toBe(true);
    expect(isExcludedPosition('DEF')).toBe(false);
    expect(isExcludedPosition(null)).toBe(false);
  });

  /**
   * A kicker stored by an earlier sync must disappear now, not at the next one.
   */
  it('hides one already in the database', async () => {
    const db: NodeSqliteDatabase = await createTestDb();
    const repo = new PlayerRepo(db);
    await repo.upsertMany([
      player({ id: 'k1', fullName: 'Harrison Butker', position: 'K', team: 'KC' }),
      player({ id: 'wr1', fullName: 'Rashee Rice', position: 'WR', team: 'KC' }),
      player({ id: 'def1', fullName: 'Kansas City Chiefs', position: 'DEF', team: 'KC' }),
    ]);

    const all = await repo.listAll();
    expect(all.map((p) => p.id).sort()).toEqual(['def1', 'wr1']);

    // ...including from search, which is its own query.
    const found = await repo.search('Butker');
    expect(found).toHaveLength(0);
    expect((await repo.search('Rice')).map((p) => p.id)).toEqual(['wr1']);
  });

  /**
   * A league that starts a kicker keeps its kicker slot in Sleeper; the app
   * simply never treats it as a slot it can fill, so no unfillable row and no
   * warning that can never be cleared.
   */
  it('does not turn a league’s kicker slot into a starting slot', () => {
    const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN']);
    expect(shape.starters['K']).toBeUndefined();
    expect(startablePositions(shape).has('K')).toBe(false);

    // The defence slot in the same league is untouched.
    expect(shape.starters['DEF']).toBe(1);
    expect(startablePositions(shape).has('DEF')).toBe(true);
  });
});

describe('defences depend on the league, not on the app', () => {
  /** The real league: best ball, no defence slot. This is why they looked missing. */
  it('is not startable in a league with no defence slot', () => {
    const bestBall = buildRosterShape([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ]);
    const startable = startablePositions(bestBall);
    expect(startable.has('DEF')).toBe(false);
    expect([...startable].sort()).toEqual(['QB', 'RB', 'TE', 'WR']);
  });

  it('is startable the moment a league starts one', () => {
    const withDefence = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN']);
    expect(startablePositions(withDefence).has('DEF')).toBe(true);
  });

  it('is still carried through the player dictionary', () => {
    const players = toCanonicalPlayers({
      def1: sleeperPlayer('def1', 'DEF', 'Kansas City', 'Chiefs'),
      def2: sleeperPlayer('def2', 'D/ST', 'San Francisco', '49ers'),
    });
    expect(players).toHaveLength(2);
    expect(players.every((p) => p.position === 'DEF')).toBe(true);
  });
});
