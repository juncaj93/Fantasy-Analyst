/**
 * What the durable-value read costs, measured rather than assumed.
 *
 * The repo's standing rule: *measure query cost, don't assume something is
 * cheap; this repo has been burned repeatedly by unmeasured assumptions.* Two
 * things got more expensive this round and both are asserted here as reads
 * rather than as answers.
 *
 *   1. The waiver gathering now reads this league's preseason capture, so a
 *      bench slot can be valued over a horizon instead of over one Sunday.
 *   2. The free-agent scan now takes every defence instead of the first twelve
 *      by name, which is roughly twenty more ids through the same statements.
 *
 * The claim being defended is that (1) is two indexed statements scoped to the
 * roster, and that (2) buys more *rows in an IN list* and not more *statements*
 * — the distinction that decides whether a page load costs 80 rows or 800.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { preseasonPointsFor } from '../src/server/services/decisionInputs.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { projectionScoringFrom, scoringKey } from '../src/core/startWho/scoring.ts';
import type { Database } from '../src/server/db.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 });
const KEY = scoringKey(projectionScoringFrom(PROFILE));
const SEASON = '2026';

/** Three captures of six hundred players, so a query that walks them shows up. */
async function captured(): Promise<Database> {
  const db = await createTestDb();
  /* `preseason_projections.player_id` is a foreign key onto the player table. */
  await new PlayerRepo(db).upsertMany(
    Array.from({ length: 600 }, (_, i) => player({ id: `p${i}`, fullName: `Player ${i}` })),
  );
  for (const [i, key] of [KEY, 'other-scoring-a', 'other-scoring-b'].entries()) {
    await db
      .prepare(
        `INSERT INTO preseason_projection_snapshots
           (season, source, captured_at, scoring_key, scoring_json, scoring_label,
            imported_at, capture_label, last_updated, raw_input)
         VALUES (?,'StartWho',?,?,'{}','Half PPR','x','lab',NULL,'raw')`,
      )
      .bind(SEASON, `2026-08-0${i + 1}`, key)
      .run();
  }
  const { results } = await db.prepare('SELECT id FROM preseason_projection_snapshots ORDER BY id').all<{ id: number }>();
  for (const { id } of results) {
    for (let i = 0; i < 600; i += 1) {
      await db
        .prepare(
          `INSERT INTO preseason_projections (snapshot_id, player_id, source_player_name, points, raw_json)
           VALUES (?,?,?,?,'{}')`,
        )
        .bind(id, `p${i}`, `Player ${i}`, 100 + i)
        .run();
    }
  }
  return db;
}

/** A roster, at the size a real one is. */
const ROSTER = Array.from({ length: 16 }, (_, i) => `p${i}`);

describe('the preseason read the waiver board now makes', () => {
  it('costs two statements and one row per player asked about', async () => {
    const counted = countingDb(await captured());
    const points = await preseasonPointsFor(counted.db, SEASON, PROFILE, ROSTER);

    expect(points.size).toBe(ROSTER.length);
    expect(counted.tallies()).toHaveLength(2);
    /* One row to find the capture, sixteen to read it. Not 1,800. */
    expect(counted.tallies().reduce((n, t) => n + t.rows, 0)).toBe(ROSTER.length + 1);
  });

  it('never reaches `list()`, which counts every projection row in the season', async () => {
    const counted = countingDb(await captured());
    await preseasonPointsFor(counted.db, SEASON, PROFILE, ROSTER);

    expect(counted.callsMatching('COUNT(')).toBe(0);
    expect(counted.callsMatching('GROUP BY')).toBe(0);
    expect(counted.callsMatching('LEFT JOIN')).toBe(0);
  });

  it('asks nothing at all when there is nobody to ask about', async () => {
    const counted = countingDb(await captured());
    const points = await preseasonPointsFor(counted.db, SEASON, PROFILE, []);

    expect(points.size).toBe(0);
    expect(counted.tallies()).toHaveLength(0);
  });

  it('stops after the first statement when this league has no matching capture', async () => {
    const counted = countingDb(await captured());
    const other = buildScoringProfile({ rec: 1, pass_td: 4 });
    const points = await preseasonPointsFor(counted.db, SEASON, other, ROSTER);

    expect(points.size).toBe(0);
    expect(counted.tallies()).toHaveLength(1);
    expect(counted.tallies()[0]!.rows).toBe(0);
  });

  it('is an empty map rather than a thrown request when the table is not there', async () => {
    const bare = await createTestDb();
    await bare.prepare('DROP TABLE preseason_projection_snapshots').run();

    await expect(preseasonPointsFor(bare, SEASON, PROFILE, ROSTER)).resolves.toEqual(new Map());
  });
});

describe('scanning every defence buys rows, not statements', () => {
  async function withDefences(count: number): Promise<{ db: Database; ids: string[] }> {
    const db = await createTestDb();
    const teams = Array.from({ length: count }, (_, i) => `T${String(i).padStart(2, '0')}`);
    await new PlayerRepo(db).upsertMany(
      teams.map((team) => player({ id: team, fullName: `${team} Defense`, team, position: 'DEF' })),
    );
    return { db, ids: teams };
  }

  it('issues the same statements for thirty-two defences as for twelve', async () => {
    const twelve = await withDefences(12);
    const all = await withDefences(32);

    const a = countingDb(twelve.db);
    await startSitInputsFor(a.db, twelve.ids);
    const b = countingDb(all.db);
    await startSitInputsFor(b.db, all.ids);

    /*
     * The number that matters. Every read in the assembly is batched by an
     * `IN` list, so twenty more defences is twenty more rows through the same
     * queries — and a regression that made any of them per-player would show
     * up here as a statement count that moved with the pool.
     */
    expect(b.tallies().length).toBe(a.tallies().length);
  });
});
