/**
 * The card, assembled, must not disagree with itself.
 *
 * The unit tests next door prove the arithmetic. This one proves the wiring: it
 * builds a database with the production schema, puts Joe Burrow's real 2025
 * rows and his real games-played figure into it, and asks the service for the
 * same view the expanded card renders. The defect was only ever visible at this
 * level — two correct sources, one screen, one contradiction.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PlayerDetailService } from '../src/server/services/playerDetailService.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { player } from './helpers/players.ts';
import { createTestDb } from './helpers/db.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2025';
/** August 2026: the draft looks back at 2025. */
const NOW = new Date('2026-08-15T12:00:00Z');
const BURROW = '6770';

const OUTLOOK_BODY =
  "For the second time in three years, Burrow's season was cut short because of injury as he missed nine games last " +
  'year, Weeks 3-12, with turf toe. He returned to throw 15 TD passes in the last six games, averaging about 37 ' +
  'attempts per game.';

/** Burrow's four rows, exactly as `injuries_2025.csv` publishes them. */
const BURROW_ROWS: [number, string | null, string | null, string][] = [
  [11, 'Out', 'Toe', 'Limited Participation in Practice'],
  [12, 'Out', 'Toe', 'Limited Participation in Practice'],
  [13, null, null, 'Full Participation in Practice'],
  [16, null, null, 'Full Participation in Practice'],
];

async function seed(db: Database, opts: { gamesPlayed: number | null; outlook: boolean }): Promise<void> {
  await new PlayerRepo(db).upsertMany([player({ id: BURROW, fullName: 'Joe Burrow', team: 'CIN', position: 'QB' })]);

  await db
    .prepare(
      `INSERT INTO player_season_stats (player_id, season, games_played, points_half_ppr,
         position_rank_half_ppr, provider_position_rank, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(BURROW, SEASON, opts.gamesPlayed, 139.46, 29, 29, 'QB', NOW.toISOString())
    .run();

  /*
   * The rest of the league, which is how the season's length is known at all.
   * Nothing hardcodes 17; it is read back off the crowd who played a full one.
   */
  for (let i = 0; i < 40; i++) {
    await db
      .prepare(
        `INSERT INTO player_season_stats (player_id, season, games_played, points_half_ppr,
           position_rank_half_ppr, provider_position_rank, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`filler-${i}`, SEASON, 17, 200 - i, i + 1, i + 1, 'WR', NOW.toISOString())
      .run();
  }

  for (const [week, status, injury, practice] of BURROW_ROWS) {
    await db
      .prepare(
        `INSERT INTO player_injury_reports (player_id, season, week, team, report_status,
           primary_injury, secondary_injury, practice_status, practice_raw, gsis_id, source, published_at, fetched_at)
         VALUES (?, ?, ?, 'CIN', ?, ?, NULL, ?, ?, NULL, 'nflverse', NULL, ?)`,
      )
      .bind(BURROW, SEASON, week, status, injury, practice, practice, NOW.toISOString())
      .run();
  }

  if (opts.outlook) {
    await db
      .prepare(
        `INSERT INTO player_outlooks (player_id, season, title, body, source, fetched_at)
         VALUES (?, '2026', '2026 Season Outlook', ?, 'rotowire', ?)`,
      )
      .bind(BURROW, OUTLOOK_BODY, NOW.toISOString())
      .run();
  }
}

/** The card must never reach the network for this. A call here is a failure. */
const noFetch = async () => {
  throw new Error('the card fetched an outlook it should have had cached');
};

function service(db: Database): PlayerDetailService {
  return new PlayerDetailService(db, { now: () => NOW, fetch: noFetch });
}

describe('the expanded card, end to end', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('keeps Sleeper games played exactly as Sleeper stated it', async () => {
    await seed(db, { gamesPlayed: 8, outlook: true });
    const view = await service(db).forPlayer(BURROW);
    expect(view.lastSeason?.gamesPlayed).toBe(8);
    expect(view.lastSeason?.positionRank).toBe('QB29');
  });

  /**
   * The production defect, at the level it appeared. `8 GP` above
   * `missed 2 games` are two claims about one season that cannot both be a
   * total, and the card is no longer able to make them together.
   */
  it('never prints an injury total that contradicts games played', async () => {
    await seed(db, { gamesPlayed: 8, outlook: true });
    const view = await service(db).forPlayer(BURROW);
    expect(view.injuryContext).not.toBe('2025: missed 2 games with a toe injury');
    expect(view.injuryContext).toBe('2025: missed 9 games with a toe injury');
  });

  it('qualifies instead of guessing when no outlook is cached', async () => {
    await seed(db, { gamesPlayed: 8, outlook: false });
    const view = await service(db).forPlayer(BURROW);
    expect(view.injuryContext).toBe('2025: played 8 of 17 games; at least 2 absences tied to a toe injury');
  });

  /** No games-played figure is no denominator, and counts become floors. */
  it('states a lower bound when participation was never ingested', async () => {
    await seed(db, { gamesPlayed: null, outlook: false });
    const view = await service(db).forPlayer(BURROW);
    expect(view.injuryContext).toBe('2025: at least 2 games missed with a toe injury');
  });

  it('says nothing about a player the report never mentioned', async () => {
    await seed(db, { gamesPlayed: 8, outlook: true });
    await new PlayerRepo(db).upsertMany([player({ id: 'nobody', fullName: 'Quiet Season', team: 'CIN', position: 'WR' })]);
    const view = await service(db).forPlayer('nobody');
    expect(view.injuryContext).toBeNull();
  });
});
