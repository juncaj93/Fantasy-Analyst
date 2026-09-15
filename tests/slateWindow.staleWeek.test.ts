/**
 * The Tuesday that looked like Sunday night.
 *
 * Reported by Alex on 15 September 2026 as four broken screens and proved by
 * `scripts/probe-stale-week.mjs` to be one defect. Production said, in the
 * same breath:
 *
 *   nfl-state              regular week 2        (refreshed 9h ago)
 *   vegas                  2026-09-13T15:00:52Z  (2.1 days ago — week 1's Sunday)
 *   lineup                 9 of 10 starters `src=market`, 9 of 10 locked
 *   matchup                phases={final: 9}, both totals 0.00, no forecast
 *   trades                 107 scored, 0 viable, every rejection "gain 0.0 pts"
 *
 * `prop_snapshots` has no season column and no week column. Its only temporal
 * anchor is `game_start`, and `latestForPlayers` is "the newest snapshot per
 * event" — so a week 1 event's snapshot stays the newest snapshot of that
 * event for ever. The companion read on the same request,
 * `VegasEventsRepo.between`, had been windowed since the day it was written.
 * One half of the pair therefore said "this player has no game this week"
 * while the other half handed over last Sunday's line for it.
 *
 * The damage is not the stale number. A stale number is not *missing*, so
 * `marketProjection` returned a figure, and the Rotowire fallback below it —
 * holding the correct week, refreshed nine hours earlier — never got a turn.
 * And the stale kickoff locked every starter, which is why no trade could
 * improve a lineup: a locked player cannot be moved, so the gain is exactly
 * 0.0 by construction.
 *
 * Every test here fails on the code as it was.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { slateWindow, SLATE_LOOKBACK_HOURS } from '../src/core/nfl/slateWindow.ts';
import { player } from './helpers/players.ts';
import { seedDemoData } from '../src/devserver/seed.ts';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import type { Database } from '../src/server/db.ts';

/** The real Tuesday. Sleeper has turned the week over; the odds cron has not run. */
const TUESDAY = new Date('2026-09-15T18:00:00.000Z');
/** Week 1's Sunday afternoon — the last time a book was asked anything. */
const LAST_SUNDAY_KICKOFF = '2026-09-13T17:00:00.000Z';
/** Week 2's Sunday, which no book has been asked about yet. */
const THIS_SUNDAY_KICKOFF = '2026-09-20T17:00:00.000Z';

const QB = 'qb1';

async function seed(opts: { weekTwoPriced?: boolean; fixtures?: boolean } = {}): Promise<Database> {
  const db = await createTestDb();

  await new PlayerRepo(db).upsertMany([
    player({ id: QB, fullName: 'Joe Burrow', team: 'CIN', position: 'QB' }),
  ]);
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: '2026',
    seasonType: 'regular',
    week: 2,
    fetchedAt: TUESDAY.toISOString(),
  });

  if (opts.fixtures !== false) {
    await new NflScheduleRepo(db).save(
      [
        { season: '2026', week: 2, team: 'CIN', opponent: 'BAL', home: true, kickoff: THIS_SUNDAY_KICKOFF, roof: 'outdoors' },
        { season: '2026', week: 2, team: 'BAL', opponent: 'CIN', home: false, kickoff: THIS_SUNDAY_KICKOFF, roof: 'outdoors' },
      ],
      TUESDAY.toISOString(),
    );
  }

  // Week 1's line, stored on Sunday and never superseded.
  await storeProps(db, 'cin-week1', LAST_SUNDAY_KICKOFF, '2026-09-13T15:00:52.000Z', 280.5);
  if (opts.weekTwoPriced) {
    await storeProps(db, 'cin-week2', THIS_SUNDAY_KICKOFF, TUESDAY.toISOString(), 245.5);
  }
  return db;
}

/** One snapshot for one game, quoting one passing line for the quarterback. */
async function storeProps(db: Database, eventId: string, gameStart: string, fetchedAt: string, line: number) {
  await db
    .prepare(
      `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
       VALUES ('test', ?, ?, ?, '{}', 'week')`,
    )
    .bind(eventId, gameStart, fetchedAt)
    .run();
  const row = await db
    .prepare('SELECT id FROM prop_snapshots WHERE event_id = ? AND fetched_at = ?')
    .bind(eventId, fetchedAt)
    .first<{ id: number }>();
  await db
    .prepare(
      `INSERT INTO player_props
         (snapshot_id, player_id, source_player_name, market, line, over_price, under_price,
          book_count, books_json, consensus_method, implied_probability, raw_json, scope)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'week')`,
    )
    .bind(Number(row!.id), QB, 'Joe Burrow', 'pass_yards', line, -110, -110, 3, '[]', 'median', null, '{}')
    .run();
}

const inputFor = async (db: Database) => (await startSitInputsFor(db, [QB]))[0]!;

describe('a week that is over stops being this week', () => {
  it('refuses last Sunday’s line once Sleeper has turned the week over', async () => {
    const input = await inputFor(await seed());

    // The row is still in the table. It is simply not an answer to "what does
    // the market expect of him this week", which is the only question asked.
    expect(input.props).toEqual([]);
  });

  it('serves this week’s line the moment the book has been asked', async () => {
    const input = await inputFor(await seed({ weekTwoPriced: true }));

    expect(input.props).toHaveLength(1);
    expect(input.props[0]!.line).toBe(245.5);
    // And never both at once: two lines for one player would be two different
    // games' expectations added together.
    expect(input.props.map((p) => p.line)).not.toContain(280.5);
  });

  it('keeps a game that is in progress, which is the case that must not regress', async () => {
    /*
     * The obvious fix — drop any fixture that has already kicked off — would
     * blank the Sunday afternoon scoreboard this app exists to watch. The
     * window reaches back twelve hours precisely so a game in its fourth
     * quarter is still this week's game.
     */
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([player({ id: QB, fullName: 'Joe Burrow', team: 'CIN', position: 'QB' })]);
    const kickedOffThreeHoursAgo = new Date(TUESDAY.getTime() - 3 * 3_600_000).toISOString();
    await storeProps(db, 'live', kickedOffThreeHoursAgo, kickedOffThreeHoursAgo, 265.5);

    const input = await inputFor(db);
    expect(input.props).toHaveLength(1);
    expect(SLATE_LOOKBACK_HOURS).toBeGreaterThan(3);
  });

  it('draws the boundary from one function, so the two halves cannot drift again', () => {
    /*
     * The defect was not that either window was wrong. It was that the events
     * read had one and the props read had none, and nothing in the code said
     * they were the same fact. `startSitInputs.ts` now calls `slateWindow` for
     * both.
     */
    const at = new Date('2026-09-15T18:00:00.000Z');
    const w = slateWindow(at);
    expect(Date.parse(w.from)).toBe(at.getTime() - SLATE_LOOKBACK_HOURS * 3_600_000);
    expect(Date.parse(w.to)).toBeGreaterThan(at.getTime());

    const source = readFileSync(new URL('../src/server/services/startSitInputs.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/now\.getTime\(\) - 12 \* 3_600_000/);
    expect(source.match(/slateWindow\(/g) ?? []).toHaveLength(2);
  });
});

describe('a kickoff is a fact about the fixture list', () => {
  it('takes it from the schedule, so an unpriced game still has one', async () => {
    // No book has quoted week 2. The league published the fixture in April.
    const input = await inputFor(await seed());

    expect(input.kickoff).toBe(THIS_SUNDAY_KICKOFF);
    expect(input.opponent).toBe('BAL');
  });

  it('does not lock a player against a kickoff from a week that is over', async () => {
    /*
     * The one that cost the most. `kickoffsForPlayers` read the `game_start`
     * of the newest snapshot mentioning the player, unbounded — so on Tuesday
     * every starter was locked against last Sunday. A locked starter cannot be
     * moved by the optimiser and cannot be traded for, which is why the trade
     * board scored 107 candidates and rejected all of them at "your lineup
     * would gain 0.0 pts".
     */
    const input = await inputFor(await seed());
    const kickoff = Date.parse(input.kickoff!);

    expect(kickoff).toBeGreaterThan(TUESDAY.getTime());
    expect(Date.parse(LAST_SUNDAY_KICKOFF)).toBeLessThan(TUESDAY.getTime());
  });

  it('falls back to a priced game in this week’s window when the fixture list is empty', async () => {
    /*
     * `nfl_schedule` is an ingested table and can be empty — the demo fixture
     * has no rows in it at all, and that is how this was caught: taking the
     * kickoff *only* from the fixture list lost every kickoff the app held and
     * changed the lineup's own scores, which the "one engine, not two" e2e
     * correctly refused.
     *
     * So a game a book has quoted is still a kickoff. What it may never be
     * again is a game from a week that is over.
     */
    const db = await seed({ fixtures: false, weekTwoPriced: true });
    const input = await inputFor(db);

    expect(input.kickoff).toBe(THIS_SUNDAY_KICKOFF);
  });

  it('says it does not know rather than reaching back into a finished week', async () => {
    // No fixture list, and the only priced game is last Sunday's. Unknown is
    // never a lock; a kickoff from a week that is over silently is.
    const input = await inputFor(await seed({ fixtures: false }));

    expect(input.kickoff).toBeNull();
  });
});

describe('what it costs', () => {
  it('bounds the kickoff read rather than dropping it, at the same query count', async () => {
    /*
     * An earlier draft of this change deleted `kickoffsForPlayers` outright,
     * on the reasoning that the schedule is stored so inferring one from
     * betting data is redundant. It is not redundant when the schedule table
     * is empty, and the cost of finding that out was a red CI run: the demo
     * has no `nfl_schedule` rows, every kickoff went null, and the lineup's
     * scores moved while the comparison's did not.
     *
     * So the read stays and takes the window. Same number of queries as
     * before, each of them now answering about this week.
     */
    const inner = await seed();
    const counting = countingDb(inner);
    await startSitInputsFor(counting.db, [QB]);

    expect(counting.callsMatching('ps.game_start AS game_start')).toBe(1);
    expect(counting.callsMatching('FROM player_props')).toBeLessThanOrEqual(3);
  });

  it('never asks the kickoff question without a window', () => {
    /*
     * The parameter is required in the signature, which is the enforcement.
     * This asserts the call site has not quietly grown an overload: the two
     * props reads may legitimately go unbounded for `VegasRefreshService`, and
     * this one may not.
     */
    const source = readFileSync(new URL('../src/server/repos/props.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/kickoffsForPlayers\(playerIds: string\[\], window: SlateWindow\)/);
    expect(source).not.toMatch(/kickoffsForPlayers\(playerIds: string\[\], window\?/);
  });
});

describe('a lane that is switched off says so', () => {
  it('distinguishes "nothing to suggest" from "nobody imported the input"', async () => {
    /*
     * The probe of production on 15 September 2026 found zero preseason
     * snapshots under any scoring key, so the buy-low / sell-high lane had
     * been shipped switched off — returning a board indistinguishable from a
     * quiet market. Those are different states and the screen now says which.
     *
     * Asserted on the service rather than the screen because the sentence is
     * the product statement; the screen only decides where to put it.
     */
    const db = await createTestDb();
    await seedDemoData(db);
    const board = await new SmartTradeService(db).build();

    // A real league with real rosters and no snapshot imported. The board may
    // still carry upgrade offers; what it must not do is stay silent about
    // the half of itself that never ran.
    expect(board.arbitrageOff).toBeTruthy();
    expect(board.arbitrageOff).toMatch(/preseason projection/i);
    expect(board.arbitrageOff).toMatch(/Import one in Setup/i);
  });

  it('is optional on the wire, so an older worker’s body still renders', () => {
    const source = readFileSync(new URL('../src/web/api.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/arbitrageOff\?: string \| null;/);
  });
});
