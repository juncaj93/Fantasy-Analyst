/**
 * What resolving the week's posture costs, in rows.
 *
 * The Team screen used to send `?mode=` and the server answered under whatever
 * the reader had tapped. It resolves the posture itself now, which means the
 * lineup request has to know something it never needed before: who the reader
 * is playing this week, and roughly what that roster is worth.
 *
 * The honest way to get the pairing is to ask Sleeper, and that is a request
 * per Team load on one of the most-opened screens in the app. The cheap way is
 * the one taken: `matchup_forecasts` already carries `opponent_roster_id` for
 * this league, season and week, on a row keyed exactly that way. So the whole
 * of the new cost is meant to be *one row from a primary-key lookup*, and the
 * opponent's projections ride along inside the published read that was already
 * happening.
 *
 * These assert the plan and the read count rather than the answer, for the
 * reason `startSitReadCost.test.ts` gives: an assertion about the resolved mode
 * would pass just as happily if this walked the whole table to find it.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { MatchupRepo } from '../src/server/repos/matchup.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { gatherOpponentExposure } from '../src/server/services/decisionInputs.ts';
import { player as testPlayer } from './helpers/players.ts';
import type { Database } from '../src/server/db.ts';

const LATEST_SQL =
  'SELECT latest_fingerprint AS fingerprint, latest_win_probability AS win, latest_forecast_at AS at, ' +
  'opponent_roster_id AS opponent FROM matchup_forecasts ' +
  'WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ?';

async function planOf(db: Database, sql: string): Promise<string> {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

/** A season of forecasts for a twelve-team league, so a scan would be visible. */
async function seasonOfForecasts(): Promise<Database> {
  const db = await createTestDb();
  const repo = new MatchupRepo(db);
  for (let week = 1; week <= 14; week += 1) {
    for (let rosterId = 1; rosterId <= 12; rosterId += 1) {
      await repo.record({
        leagueId: 'l1',
        season: '2026',
        week,
        rosterId,
        matchupId: Math.ceil(rosterId / 2),
        opponentRosterId: rosterId % 2 === 1 ? rosterId + 1 : rosterId - 1,
        modelVersion: 'matchup-1.0.0',
        at: `2026-09-${String(week).padStart(2, '0')}T15:00:00Z`,
        phase: 'pregame',
        winProbability: 0.5,
        projectedFinal: 100,
        actual: 0,
        confidence: 'medium',
        fingerprint: `f-${week}-${rosterId}`,
      });
    }
  }
  return db;
}

describe('finding out who the reader is playing', () => {
  it('goes straight to the row by its primary key, without scanning the season', async () => {
    const db = await seasonOfForecasts();
    const plan = await planOf(db, LATEST_SQL);

    expect(plan, `a scan of matchup_forecasts would cost a season of rows: ${plan}`).not.toMatch(/SCAN/);
    expect(plan).toMatch(/SEARCH/);
  });

  it('reads exactly one row, out of a season of them', async () => {
    const counted = countingDb(await seasonOfForecasts());
    counted.reset();

    await new MatchupRepo(counted.db).latest({ leagueId: 'l1', season: '2026', week: 3, rosterId: 5 });

    // 168 rows are stored. The pairing must cost one of them.
    expect(counted.rowsMatching('FROM matchup_forecasts')).toBe(1);
    expect(counted.callsMatching('FROM matchup_forecasts')).toBe(1);
  });

  it('carries the opponent on the row it was already reading', async () => {
    // The point of the column, rather than a second query for it: this is the
    // same statement the fingerprint and win probability come from.
    const db = await seasonOfForecasts();
    const row = await new MatchupRepo(db).latest({ leagueId: 'l1', season: '2026', week: 3, rosterId: 5 });

    expect(row?.opponentRosterId).toBe(6);
    expect(row?.fingerprint).toBe('f-3-5');
  });

  it('says nothing rather than guessing, for a week nobody has forecast', async () => {
    // Before the Matchup screen has been opened this week there is no row, and
    // the posture falls back to Balanced with `auto: false` — see
    // `suggestLineupMode`. It must not throw and must not invent an opponent.
    const db = await seasonOfForecasts();
    expect(await new MatchupRepo(db).latest({ leagueId: 'l1', season: '2026', week: 15, rosterId: 5 })).toBeNull();
  });
});

/**
 * …and what reading the opponent's stacked games costs on top of it.
 *
 * The Floor/Ceiling pass now reads `core/startsit/correlation.ts`, which needs
 * one fact per opposing starter: which NFL game he is in. That fact is a
 * primary-key lookup in `players` plus the fixture list the assembly has
 * already built for the reader's own roster — so the whole of the new cost is
 * meant to be *one statement over nine ids*, and nothing else.
 *
 * The thing it must never become is `startSitInputsFor` over a second roster.
 * That buys props, injuries, usage weeks and evidence for twelve more players,
 * which is the spend the owner declined on 9 September 2026 and the reason the
 * opponent's side of the Matchup screen is unpriced. These assert the shape of
 * the read rather than the exposure map it produces, for the reason the tests
 * above give.
 */
describe('reading which games the opponent is stacked in', () => {
  const EMPTY_CONTEXT = {
    schedule: new Map([
      ['KC', { opponent: 'BUF', spread: -2.5, total: 52, kickoff: null }],
      ['BUF', { opponent: 'KC', spread: 2.5, total: 52, kickoff: null }],
    ]),
    defense: new Map(),
    home: new Map(),
    indoor: new Map(),
    opponentForm: new Map(),
  };

  async function withPlayers(): Promise<Database> {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany(
      Array.from({ length: 9 }, (_, i) =>
        testPlayer({ id: `o${i}`, fullName: `Their Player ${i}`, team: i < 3 ? 'KC' : 'BUF', position: 'WR' }),
      ),
    );
    return db;
  }

  const starterIds = Array.from({ length: 9 }, (_, i) => `o${i}`);

  it('costs one statement, over the ids it was given', async () => {
    const counted = countingDb(await withPlayers());
    counted.reset();

    await gatherOpponentExposure(counted.db, { mode: 'ceiling', starterIds, context: EMPTY_CONTEXT });

    expect(counted.callsMatching('FROM players')).toBe(1);
    expect(counted.rowsMatching('FROM players')).toBe(9);
  });

  it('never touches the reads that price a roster', async () => {
    const counted = countingDb(await withPlayers());
    counted.reset();

    await gatherOpponentExposure(counted.db, { mode: 'floor', starterIds, context: EMPTY_CONTEXT });

    // The declined spend, named one table at a time so a regression says which.
    for (const table of ['FROM player_props', 'FROM usage_weeks', 'FROM evidence', 'FROM injuries']) {
      expect(counted.callsMatching(table), `${table} is the opponent-pricing spend that was declined`).toBe(0);
    }
  });

  it('reads nothing at all in a Balanced week', async () => {
    // `assessCorrelation` returns zero points in Balanced, so a map fetched
    // here would be multiplied by nothing. Skipped rather than fetched-and-
    // discarded, which is the same rule `opponentForm` keeps in the context.
    const counted = countingDb(await withPlayers());
    counted.reset();

    const exposure = await gatherOpponentExposure(counted.db, {
      mode: 'balanced',
      starterIds,
      context: EMPTY_CONTEXT,
    });

    expect(exposure.size).toBe(0);
    expect(counted.tallies()).toHaveLength(0);
  });

  it('reads nothing for a roster on a bye, or a week with no pairing', async () => {
    const counted = countingDb(await withPlayers());
    counted.reset();

    await gatherOpponentExposure(counted.db, { mode: 'ceiling', starterIds: [], context: EMPTY_CONTEXT });

    expect(counted.tallies()).toHaveLength(0);
  });

  it('keys the exposure on the same game string the lineup counts with', async () => {
    // Both teams, sorted, joined — see `lineup.ts`'s `gameKey`. Two spellings
    // of one fixture would make the two halves of the shape argument silently
    // disagree about which game anybody is in.
    const exposure = await gatherOpponentExposure(await withPlayers(), {
      mode: 'ceiling',
      starterIds,
      context: EMPTY_CONTEXT,
    });

    expect([...exposure.keys()]).toEqual(['BUF@KC']);
    expect(exposure.get('BUF@KC')?.total).toBe(52);
  });
});
