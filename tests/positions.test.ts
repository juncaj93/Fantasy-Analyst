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
import { offersFlexFilter, orderFilterChips } from '../src/core/sleeper/eligibility.ts';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
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

  /**
   * ...and when it is startable, its chip is the last one in the row.
   *
   * Asserted over what a board actually publishes rather than over a roster
   * shape, because the draft screen builds its chips from `startablePositions`
   * and `offersFlex` and from nothing else. A defence used to land between TE
   * and FLX, in the middle of a row a reader scans for receivers.
   */
  it('is the last chip in the filter row, after FLX', () => {
    const withDefence = startablePositions(buildRosterShape(['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN']));
    expect(orderFilterChips(withDefence, offersFlexFilter(withDefence))).toEqual([
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'DEF',
    ]);

    // Best ball, the far more common shape here: no defence slot, no defence
    // chip, and a row that is exactly what it was before any of this.
    const bestBall = startablePositions(
      buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'BN', 'BN']),
    );
    expect(orderFilterChips(bestBall, offersFlexFilter(bestBall))).toEqual(['QB', 'RB', 'WR', 'TE', 'FLX']);
  });

  /**
   * The case from Tony's league, end to end: a league that starts a defence,
   * and an ADP file that ranks none of them.
   */
  it('still lists a startable position the ranking does not cover', async () => {
    const db = await createTestDb();
    const playerRepo = new PlayerRepo(db);
    await playerRepo.upsertMany([
      player({ id: 'qb1', fullName: 'Patrick Mahomes', position: 'QB', team: 'KC' }),
      // On an NFL roster, which is what "every other active quarterback in the
      // league" means and what the assertion below is protecting. He was
      // written as a free agent, which since the draftability rule landed makes
      // him indistinguishable from a player who retired in 2021 — see
      // `draftable.ts`, and the teamless case asserted at the end of this test.
      player({ id: 'qb2', fullName: 'Unranked Passer', position: 'QB', team: 'DEN' }),
      player({ id: 'qb3', fullName: 'Retired Passer', position: 'QB', team: 'FA' }),
      player({ id: 'def1', fullName: 'Kansas City Chiefs', position: 'DEF', team: 'KC' }),
      player({ id: 'def2', fullName: 'San Francisco 49ers', position: 'DEF', team: 'SF' }),
    ]);

    const leagues = new LeagueRepo(db);
    await leagues.upsertLeague({
      id: 'tonys',
      sleeperLeagueId: 'tonys',
      name: "Tony's",
      season: '2026',
      totalRosters: 10,
      scoringSettings: { rec: 0.5 },
      rosterPositions: ['QB', 'DEF', 'BN', 'BN'],
      leagueSettings: {},
      draftId: 'tonys-draft',
      lastSyncedAt: new Date().toISOString(),
    });
    await leagues.selectLeague('tonys');
    await leagues.upsertDraft({
      id: 'tonys-draft',
      sleeperDraftId: 'tonys-draft',
      leagueId: 'tonys',
      status: 'pre_draft',
      type: 'snake',
      season: '2026',
      rounds: 4,
      teams: 10,
      slotToRosterId: {},
      settings: {},
      lastSyncedAt: new Date().toISOString(),
    });

    // A ranking that covers quarterbacks and no defences — the shape of every
    // ADP file this project has.
    const index = await playerRepo.buildIndex();
    const adpResult = importAdpSnapshot('Player,Position,Team,ADP\nPatrick Mahomes,QB,KC,12\n', index, {
      label: 'test ranking',
      source: 'test',
    });
    const { snapshot } = await new AdpRepo(db).save(adpResult);
    await leagues.setDraftSnapshot('tonys-draft', snapshot.id);

    const board = await new DraftBoardService(db).build('tonys-draft', { position: 'DEF' });
    expect(board.startablePositions).toContain('DEF');
    // The whole point: the position the ranking ignores is still on the board.
    expect(board.recommendations.map((r) => r.name).sort()).toEqual([
      'Kansas City Chiefs',
      'San Francisco 49ers',
    ]);
    /*
     * ...and it no longer apologises for them above the list.
     *
     * The board used to warn "no draft order covers DEF in this ranking, so
     * they are listed on news and roster need alone". That was accurate, and
     * what it described has been removed rather than explained: a defence is
     * ranked on the market alone now, so there is no news and no roster need to
     * disclose. The row still says it is thin, on the row, where it is about a
     * player rather than about a board.
     */
    expect(board.warnings.join(' ')).not.toContain('no draft order covers');
    for (const rec of board.recommendations) expect(rec.degraded).toBe(true);

    /*
     * A position the ranking covers keeps its unranked players too.
     *
     * This used to assert the opposite, and the opposite was the bug: the
     * published ADP file lists a couple of hundred players, so requiring an ADP
     * deleted every other active quarterback in the league from the draft
     * universe. The priced player still leads — the unpriced one is behind him,
     * carrying no ADP rather than an invented one.
     */
    const qbs = await new DraftBoardService(db).build('tonys-draft', { position: 'QB' });
    expect(qbs.recommendations.map((r) => r.name)).toEqual(['Patrick Mahomes', 'Unranked Passer']);

    const unpriced = qbs.recommendations.find((r) => r.name === 'Unranked Passer')!;
    expect(unpriced.adp, 'no ADP is null, never a sentinel').toBeNull();
    expect(unpriced.adpValue, 'and no value is computed from one').toBeNull();
    expect(unpriced.degraded, 'the row says it is thinner than the others').toBe(true);
    expect(unpriced.score, 'and his Score is unknown, not the centre of the curve').toBeNull();

    /*
     * A player with no NFL team and no price from either market is not on the
     * board at all.
     *
     * This is the other half of the same rule, and the reason `Unranked Passer`
     * had to be given a club: on a roster he is a deep sleeper worth listing,
     * and off one with nobody willing to price him he is Chris Carson.
     */
    expect(qbs.recommendations.map((r) => r.name)).not.toContain('Retired Passer');
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
