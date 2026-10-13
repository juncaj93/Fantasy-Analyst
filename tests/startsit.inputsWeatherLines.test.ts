/**
 * What `startSitInputsFor` hands the engine for weather and line age.
 *
 * Two additions in October 2026, both from rows already read:
 *  - the stadium table answers "dome" for a fixture row whose roof is blank,
 *    and never overrides a roof the fixture list stated;
 *  - each weekly quote carries its snapshot's time and game line, so a prop
 *    older than the latest line can be told apart.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { player } from './helpers/players.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { buildStartSitContext } from '../src/server/services/startSitInputs.ts';
import { createTestDb } from './helpers/db.ts';

function row(team: string, opponent: string, home: boolean, roof: string | null): ScheduleTeamWeek {
  return { season: '2026', week: 6, team, opponent, home, kickoff: '2026-10-11T17:00:00.000Z', roof };
}

describe('the stadium table behind the fixture list', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 6 });
  });

  it('knows which fixture rows stated a roof, so the table only fills blanks', async () => {
    await new NflScheduleRepo(db).save(
      [row('DET', 'GB', true, null), row('GB', 'DET', false, null), row('BUF', 'MIA', true, 'outdoors'), row('MIA', 'BUF', false, 'outdoors')],
      '2026-10-01T00:00:00.000Z',
    );
    const context = await buildStartSitContext(db);
    expect(context.roofKnown?.has('BUF')).toBe(true);
    expect(context.roofKnown?.has('DET')).toBe(false);
    expect(context.home.get('GB')).toBe(false);
  });
});

describe('a quote remembers the line it was read under', () => {
  it('carries the snapshot time and game line on the weekly read', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([player({ id: 'p1', fullName: 'P One', position: 'WR', team: 'KC' })]);
    const repo = new PropsRepo(db);
    const fetchedAt = '2026-10-10T15:00:00.000Z';
    await repo.put({
      provider: 'mock',
      eventId: 'e1',
      gameStart: '2026-10-11T17:00:00.000Z',
      fetchedAt,
      raw: {
        provider: 'mock',
        eventId: 'e1',
        gameStart: '2026-10-11T17:00:00.000Z',
        fetchedAt,
        quotes: [],
        gameLines: { total: 47.5, spread: -3.5, spreadTeam: 'KC' },
        raw: null,
      },
    });
    const id = (await repo.snapshotId('mock', 'e1', fetchedAt))!;
    await repo.saveConsensus(id, [
      {
        playerId: 'p1',
        sourcePlayerName: 'P One',
        market: 'receiving_yards',
        line: 60.5,
        overPrice: -115,
        underPrice: -105,
        bookCount: 2,
        consensusMethod: 'median',
        books: ['a', 'b'],
        impliedProbability: null,
      },
    ]);
    const props = (await repo.latestForPlayers(['p1'])).get('p1')!;
    expect(props[0]!.snapshot).toEqual({ fetchedAt, total: 47.5, spread: -3.5, spreadTeam: 'KC' });
  });
});
