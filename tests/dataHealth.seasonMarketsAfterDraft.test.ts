/**
 * Season-long lines after the draft.
 *
 * The refresh stops on purpose once the draft is complete, so the stored
 * snapshot only gets older. Until October 2026 Data health called that stale,
 * and Setup said "1 input needs attention" every day from the draft onward.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { SeasonMarketsRepo } from '../src/server/repos/seasonMarkets.ts';
import { needsAttention } from '../src/core/health/model.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { player } from './helpers/players.ts';

const NOW = new Date('2026-10-08T12:00:00.000Z');

async function seeded(draftStatus: 'complete' | 'pre_draft'): Promise<NodeSqliteDatabase> {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([player({ id: 'wr1', fullName: 'W R', position: 'WR', team: 'KC' })]);
  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'tony',
    sleeperLeagueId: 'tony',
    name: 'Tony',
    season: '2026',
    totalRosters: 10,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
    leagueSettings: {},
    draftId: 'tony-draft',
    lastSyncedAt: NOW.toISOString(),
  });
  await leagues.selectLeague('tony');
  await leagues.upsertDraft({
    id: 'tony-draft',
    sleeperDraftId: 'tony-draft',
    leagueId: 'tony',
    status: draftStatus,
    type: 'snake',
    season: '2026',
    rounds: 16,
    teams: 10,
    slotToRosterId: {},
    settings: {},
    lastSyncedAt: NOW.toISOString(),
  });
  // The last snapshot, taken the week of the draft: weeks old by now.
  await new SeasonMarketsRepo(db).saveSnapshot(
    { provider: 'mock', season: '2026', quotes: [], note: null, raw: {}, fetchedAt: '2026-08-30T00:00:00.000Z' },
    [{ playerId: 'wr1', sourcePlayerName: 'W R', market: 'season_receiving_yards', line: 1000, book: 'mock', bookCount: 1 }],
  );
  return db;
}

async function row(db: NodeSqliteDatabase) {
  const view = await new DataHealthService(db, { now: () => NOW, releaseSha: 'test' }).view();
  return { view, source: view.sources.find((s) => s.id === 'season-markets')! };
}

describe('season-long lines once the draft is done', () => {
  it('reads as deferred on purpose, and needs nobody', async () => {
    const { view, source } = await row(await seeded('complete'));
    expect(source.state).toBe('deferred');
    expect(needsAttention(source)).toBe(false);
    expect(source.note).toMatch(/after the draft/);
    expect(view.overall.headline).not.toMatch(/Season market/);
  });

  it('is still stale before the draft, when the board prices against it', async () => {
    const { source } = await row(await seeded('pre_draft'));
    expect(source.state).toBe('stale');
    expect(needsAttention(source)).toBe(true);
  });
});
