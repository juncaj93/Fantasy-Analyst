/**
 * The Trades ideas check reuses the inputs the board already read (item T5).
 *
 * Speed only: the verdicts must be exactly what the check produced when it
 * read every player itself, and it must read fewer rows doing it.
 */

import { describe, expect, it } from 'vitest';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import { TradeValueService } from '../src/server/services/tradeValueService.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { LEAGUE, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';

describe('Check a trade for the board’s ideas', () => {
  it('gives the same verdicts from the board’s inputs as from its own reads', async () => {
    const db = await createTestDb();
    await seed(db);
    const { client } = forbiddenSleeper();
    const rosters = await new LeagueRepo(db).listRosters(LEAGUE);
    const mine = rosters.find((r) => r.isMine)!;
    const ideas = rosters
      .filter((r) => !r.isMine && r.playerIds.length > 0)
      .flatMap((partner) =>
        mine.playerIds.slice(0, 3).flatMap((give, i) =>
          partner.playerIds.slice(0, 2).map((get, j) => ({
            id: `${partner.rosterId}-${i}-${j}`,
            partnerRosterId: partner.rosterId,
            give: [give],
            get: [get],
          })),
        ),
      );
    expect(ideas.length).toBeGreaterThan(3);

    const { board, inputs } = await new SmartTradeService(db).buildWithInputs({ limit: 5 });
    expect(await new SmartTradeService(db).build({ limit: 5 })).toEqual(board);
    expect(inputs.length).toBeGreaterThan(0);

    const own = countingDb(db);
    const shared = countingDb(db);
    const before = await new TradeValueService(own.db, client).checkIdeas(LEAGUE, ideas);
    const after = await new TradeValueService(shared.db, client).checkIdeas(LEAGUE, ideas, inputs);

    expect(before.size).toBeGreaterThan(0);
    expect(JSON.stringify([...after])).toBe(JSON.stringify([...before]));

    const rows = (c: ReturnType<typeof countingDb>): number => c.tallies().reduce((a, t) => a + t.rows, 0);
    expect(rows(shared)).toBeLessThan(rows(own));
  });
});
