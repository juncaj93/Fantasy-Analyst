/**
 * Proving the diff actually notices, and explaining a result that looked wrong.
 *
 * A controlled experiment against the real 2025 file flipped twenty players from
 * Questionable to Out and the pipeline reported `changed=0`. That is either the
 * most important bug in this app — an injury pipeline that does not notice
 * injuries — or a property of what "current state" means. It cannot be left
 * ambiguous, so this file settles it from both ends: the four kinds of change
 * that must be detected, and the one kind that must not be.
 *
 * The answer, established below: the current-state diff compares each player's
 * **latest** reported week, because that is what "is he playing on Sunday" is a
 * question about. The experiment edited rows spread across weeks 1-12, almost
 * none of which were any player's latest week — so there was genuinely nothing
 * to notice. Editing the latest week is detected every time.
 */

import { describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { InjuryRepo, InjurySourceRepo } from '../src/server/repos/injury.ts';
import { InjuryService } from '../src/server/services/injuryService.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2026';
const HEADER =
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,' +
  'practice_secondary_injury,practice_status';

interface Row {
  name: string;
  week: number;
  status: string;
  injury: string;
  practice: string;
}

function csv(rows: Row[]): string {
  return [
    HEADER,
    ...rows.map((r) => {
      const [first = '', ...rest] = r.name.split(' ');
      return (
        `${SEASON},REG,REG,KC,${r.week},,WR,${r.name},${first},${rest.join(' ')},` +
        `${r.injury},,${r.status},${r.injury},,${r.practice}`
      );
    }),
  ].join('\n');
}

const DNP = 'Did Not Participate In Practice';
const LP = 'Limited Participation in Practice';

/** Three players, three weeks each. Week 5 is everyone's latest. */
function baseline(): Row[] {
  const rows: Row[] = [];
  for (const name of ['Ann Ash', 'Bob Birch', 'Cal Cedar']) {
    for (const week of [3, 4, 5]) {
      rows.push({ name, week, status: 'Questionable', injury: 'Hamstring', practice: DNP });
    }
  }
  return rows;
}

async function setup(): Promise<{ db: Database; run: (rows: Row[]) => Promise<string[]> }> {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([
    player({ id: 'p-ann', fullName: 'Ann Ash' }),
    player({ id: 'p-bob', fullName: 'Bob Birch' }),
    player({ id: 'p-cal', fullName: 'Cal Cedar' }),
  ]);

  let body = csv(baseline());
  let version = 0;
  const service = new InjuryService(db, {
    log: () => {},
    // A new validator every time, so the source always looks republished and the
    // diff is the only thing that can decide whether anything changed.
    fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
  });

  const run = async (rows: Row[]): Promise<string[]> => {
    body = csv(rows);
    const result = await service.refresh(SEASON);
    return result.changedPlayerIds ?? [];
  };

  // Establish the baseline; everything is new, so everyone changes once.
  await run(baseline());
  return { db, run };
}

describe('what the current-state diff notices', () => {
  it('A — a designation change in the latest week', async () => {
    const { run } = await setup();
    const rows = baseline().map((r) =>
      r.name === 'Ann Ash' && r.week === 5 ? { ...r, status: 'Out' } : r,
    );
    expect(await run(rows)).toEqual(['p-ann']);
  });

  it('B — a practice change in the latest week', async () => {
    const { run } = await setup();
    const rows = baseline().map((r) =>
      r.name === 'Bob Birch' && r.week === 5 ? { ...r, practice: LP } : r,
    );
    expect(await run(rows)).toEqual(['p-bob']);
  });

  it('C — a body-part change in the latest week', async () => {
    const { run } = await setup();
    const rows = baseline().map((r) =>
      r.name === 'Cal Cedar' && r.week === 5 ? { ...r, injury: 'Ankle' } : r,
    );
    expect(await run(rows)).toEqual(['p-cal']);
  });

  /**
   * D — the case that produced `changed=0`, and why it is correct.
   *
   * Rewriting week 3 while week 5 stands says nothing about whether the player
   * is available on Sunday, which is the only question this state answers. The
   * row is still stored — the historical layer reads those weeks — but no
   * current decision changed, so nothing is recomputed and nothing is written
   * to a card. This is the intended behaviour, not an oversight.
   */
  it('D — an older-week-only edit changes no current state', async () => {
    const { run } = await setup();
    const rows = baseline().map((r) =>
      r.name === 'Ann Ash' && r.week === 3 ? { ...r, status: 'Out', practice: LP, injury: 'Ankle' } : r,
    );
    expect(await run(rows)).toEqual([]);
  });

  /** And the same edit, reproduced at the scale that first raised the question. */
  it('D at scale — the twenty-player experiment, explained', async () => {
    const { run } = await setup();
    // Every earlier week rewritten for every player; no latest week touched.
    const rows = baseline().map((r) => (r.week < 5 ? { ...r, status: 'Out', practice: LP } : r));
    expect(await run(rows), 'no latest week moved, so no current state moved').toEqual([]);

    // Move one latest week and the same pipeline notices immediately.
    const moved = rows.map((r) => (r.name === 'Bob Birch' && r.week === 5 ? { ...r, status: 'Out' } : r));
    expect(await run(moved)).toEqual(['p-bob']);
  });

  it('notices nothing when the file is republished unchanged', async () => {
    const { db, run } = await setup();
    const day = new Date().toISOString().slice(0, 10);
    const before = await new InjurySourceRepo(db).writesToday(day);

    expect(await run(baseline())).toEqual([]);
    expect(await new InjurySourceRepo(db).writesToday(day), 'and writes nothing').toBe(before);
  });

  it('notices nothing when only the row order changes', async () => {
    const { run } = await setup();
    expect(await run([...baseline()].reverse())).toEqual([]);
  });

  it('stores the latest week it was given', async () => {
    const { db, run } = await setup();
    await run(baseline());
    const stored = await new InjuryRepo(db).latestFor(['p-ann'], SEASON);
    expect(stored.get('p-ann')!.week).toBe(5);
  });
});

describe('the steady-state window', () => {
  it('parses one week, not three', async () => {
    const { RECENT_WEEKS, parseInjuryReport } = await import('../src/core/injury/nflverse.ts');

    /*
     * Pinned deliberately. Widening this is the kind of change that looks free
     * -- it is only two more weeks -- and costs a third more CPU on every
     * republish, 288 times a day, to re-read weeks that have already settled
     * and produce a diff that finds nothing.
     */
    expect(RECENT_WEEKS).toBe(1);

    const rows: Row[] = [];
    for (const week of [3, 4, 5]) {
      rows.push({ name: 'Ann Ash', week, status: 'Questionable', injury: 'Hamstring', practice: DNP });
    }
    const parsed = parseInjuryReport(csv(rows), { recentWeeks: RECENT_WEEKS });

    expect(parsed.rows.map((r) => r.week)).toEqual([5]);
    expect(parsed.latestWeek).toBe(5);
  });

  /**
   * And the trend still works, because it is read back from the database rather
   * than from the parse. This is what makes the narrow window safe: each ingest
   * stores the week it saw, and the weeks accumulate.
   */
  it('still knows a practice trend from accumulated weeks', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([player({ id: 'p-ann', fullName: 'Ann Ash' })]);

    let body = '';
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });

    // Three separate ingests, a week apart, each seeing only its own week.
    for (const [week, practice] of [
      [3, DNP],
      [4, LP],
      [5, 'Full Participation in Practice'],
    ] as const) {
      body = csv([{ name: 'Ann Ash', week, status: 'Questionable', injury: 'Hamstring', practice }]);
      await service.refresh(SEASON);
    }

    const weeks = await new InjuryRepo(db).weeksFor('p-ann', SEASON);
    expect(weeks.map((w) => w.week), 'all three weeks are stored').toEqual([3, 4, 5]);
    expect(weeks.map((w) => w.practiceStatus)).toEqual(['dnp', 'limited', 'full']);

    const state = await service.stateFor('p-ann', 'Questionable', { season: SEASON });
    expect(state.practice.trend, 'and the trend is visible across them').toBe('improving');
  });
});
