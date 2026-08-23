/**
 * The board has to contain the draft.
 *
 * The bug these tests exist to prevent had two halves, and each half on its own
 * looked reasonable. The screen asked for forty rows, because forty rows is
 * what a person reads. The server kept only players carrying a published ADP,
 * because a ranked board should be ranked. Together they meant that by the
 * middle of a draft the board ended somewhere around ADP 78 — and ended
 * silently, looking exactly like the end of the player universe rather than the
 * end of a page.
 *
 * A draft assistant that cannot show you the eleventh round is no use in the
 * eleventh round, so the invariant is: everything eligible is a candidate, and
 * the only thing that bounds the board is the one cap that exists for a reason.
 */

import { describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { DraftQueueRepo } from '../src/server/repos/draftQueue.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { DraftBoardService, MAX_CANDIDATES } from '../src/server/services/draftBoard.ts';
import type { Database } from '../src/server/db.ts';

/**
 * A pool the size of a real one.
 *
 * 245 priced players spread from ADP 1 to 245, plus 60 active players the ADP
 * file has never heard of — which is the real shape of it: the published file
 * lists a couple of hundred names and the league contains far more.
 */
const PRICED = 245;
const UNPRICED = 60;

interface Fixture {
  db: Database;
  names: { priced: string[]; unpriced: string[] };
}

function positionFor(i: number): string {
  // Roughly the distribution of a fantasy pool: more receivers than anything.
  const cycle = i % 10;
  if (cycle < 1) return 'QB';
  if (cycle < 4) return 'RB';
  if (cycle < 8) return 'WR';
  return 'TE';
}

async function fixture(): Promise<Fixture> {
  const db = await createTestDb();
  const players = new PlayerRepo(db);
  const leagues = new LeagueRepo(db);

  const priced: string[] = [];
  const unpriced: string[] = [];
  const rows: ReturnType<typeof player>[] = [];

  for (let i = 0; i < PRICED; i++) {
    const name = `Priced Player${String(i).padStart(3, '0')}`;
    priced.push(name);
    rows.push(player({ id: `p${i}`, fullName: name, position: positionFor(i), team: 'KC', searchRank: i + 1 }));
  }
  for (let i = 0; i < UNPRICED; i++) {
    const name = `Unpriced Player${String(i).padStart(3, '0')}`;
    unpriced.push(name);
    rows.push(
      player({
        id: `u${i}`,
        fullName: name,
        position: positionFor(i),
        team: 'SF',
        // Sleeper knows who they are; the ADP file simply does not list them.
        searchRank: 400 + i,
      }),
    );
  }
  await players.upsertMany(rows);

  await leagues.upsertLeague({
    id: 'deep',
    sleeperLeagueId: 'deep',
    name: 'Deep',
    season: '2026',
    totalRosters: 12,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'],
    leagueSettings: {},
    draftId: 'deep-draft',
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.selectLeague('deep');
  await leagues.upsertDraft({
    id: 'deep-draft',
    sleeperDraftId: 'deep-draft',
    leagueId: 'deep',
    status: 'pre_draft',
    type: 'snake',
    season: '2026',
    rounds: 16,
    teams: 12,
    slotToRosterId: {},
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });

  // Every priced player, ADP 1 through 245 — deliberately far past 78.
  const csv = [
    'Player,Position,Team,ADP',
    ...priced.map((name, i) => `${name},${positionFor(i)},KC,${i + 1}`),
  ].join('\n');
  const index = await players.buildIndex();
  const result = importAdpSnapshot(csv, index, { label: 'deep ranking', source: 'test' });
  const { snapshot } = await new AdpRepo(db).save(result);
  await leagues.setDraftSnapshot('deep-draft', snapshot.id);

  return { db, names: { priced, unpriced } };
}

describe('the draft pool is the whole draft', () => {
  it('scores every eligible player up to the one cap that exists', async () => {
    const { db } = await fixture();
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });

    // 245 priced + 60 unpriced = 305, bounded by MAX_CANDIDATES rather than by
    // anything accidental.
    expect(board.recommendations.length).toBe(Math.min(PRICED + UNPRICED, MAX_CANDIDATES));
    expect(board.recommendations.length).toBeGreaterThanOrEqual(200);
  });

  /** The exact symptom: a board that stopped somewhere around ADP 78. */
  it('goes far past ADP 78', async () => {
    const { db } = await fixture();
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    const adps = board.recommendations.map((r) => r.adp).filter((a): a is number => a != null);

    expect(Math.max(...adps)).toBeGreaterThan(200);
    for (const depth of [100, 125, 150, 175, 200, 225]) {
      expect(adps.some((a) => a >= depth), `an ADP of at least ${depth} is on the board`).toBe(true);
    }
  });

  it('keeps players the ADP file has never heard of', async () => {
    const { db, names } = await fixture();
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    const shown = new Set(board.recommendations.map((r) => r.name));
    const kept = names.unpriced.filter((n) => shown.has(n));

    expect(kept.length).toBeGreaterThan(0);
    for (const rec of board.recommendations.filter((r) => names.unpriced.includes(r.name))) {
      expect(rec.adp, 'no ADP is null, never a sentinel').toBeNull();
      expect(rec.adpValue, 'and no value is invented from one').toBeNull();
      expect(rec.degraded, 'the row admits it is thinner').toBe(true);
      expect(Number.isFinite(rec.total)).toBe(true);
    }
  });

  /**
   * Conservative ordering, which is the point of admitting them at all.
   *
   * An unpriced player must not leapfrog the market. The check is on the
   * board's own order rather than on any one score, because that is what a
   * drafter actually reads.
   */
  it('ranks unpriced players behind the priced ones', async () => {
    const { db, names } = await fixture();
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    const unpricedSet = new Set(names.unpriced);

    const firstUnpriced = board.recommendations.findIndex((r) => unpricedSet.has(r.name));
    const lastPriced = board.recommendations.map((r) => unpricedSet.has(r.name)).lastIndexOf(false);

    expect(firstUnpriced, 'some unpriced players made the board').toBeGreaterThan(-1);
    expect(firstUnpriced, 'and none of them are above a priced player').toBeGreaterThan(lastPriced);
  });

  it('drafting fifty players removes about fifty, not hundreds', async () => {
    const { db } = await fixture();
    const service = new DraftBoardService(db);
    const before = await service.build('deep-draft', { limit: 400 });

    const leagues = new LeagueRepo(db);
    await leagues.upsertPicks(
      Array.from({ length: 50 }, (_, i) => ({
        draftId: 'deep-draft',
        pickNo: i + 1,
        round: Math.floor(i / 12) + 1,
        rosterId: (i % 12) + 1,
        playerId: `p${i}`,
        pickedBy: null,
        isKeeper: false,
        pickInRound: (i % 12) + 1,
        draftSlot: (i % 12) + 1,
        sleeperPlayerId: `p${i}`,
        raw: '{}',
      })),
    );

    const after = await service.build('deep-draft', { limit: 400 });
    const gone = new Set(before.recommendations.map((r) => r.name));
    for (const rec of after.recommendations) gone.delete(rec.name);

    // The cap refills from below, so the board stays deep and only the drafted
    // players actually disappear from the universe.
    expect([...gone].every((name) => name.startsWith('Priced Player'))).toBe(true);
    expect(after.recommendations.length).toBeGreaterThanOrEqual(200);
  });

  it('exposes the full depth of a single position', async () => {
    const { db } = await fixture();
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      const board = await new DraftBoardService(db).build('deep-draft', { limit: 400, position });
      expect(board.recommendations.length, `${position} is not capped at ten`).toBeGreaterThan(10);
      for (const rec of board.recommendations) expect(rec.position).toBe(position);
    }
  });

  it('keeps a queued deep player reachable', async () => {
    const { db, names } = await fixture();
    const deepName = names.unpriced[10]!;
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    const deep = board.recommendations.find((r) => r.name === deepName)!;

    await new DraftQueueRepo(db).setQueued('deep-draft', deep.playerId, true);
    const queued = await new DraftBoardService(db).build('deep-draft', { limit: 400, queuedOnly: true });

    expect(queued.recommendations.map((r) => r.name)).toContain(deepName);
  });
});

describe('the board reports what it dropped', () => {
  it('counts every stage that can lose a player', async () => {
    const { db } = await fixture();
    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    const health = board.poolHealth;

    expect(health.activeEligible).toBe(PRICED + UNPRICED);
    expect(health.drafted).toBe(0);
    expect(health.scored).toBe(Math.min(PRICED + UNPRICED, MAX_CANDIDATES));
    expect(health.returned).toBe(board.recommendations.length);
    expect(health.withAdp + health.withoutAdp).toBe(health.returned);
    expect(health.deepestAdp).toBeGreaterThan(200);
    expect(health.cap).toBe(MAX_CANDIDATES);
    // Every startable position is represented rather than one drowning the rest.
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      expect(health.byPosition[position], `${position} is on the board`).toBeGreaterThan(0);
    }
  });

  it('counts the drafted players as drafted', async () => {
    const { db } = await fixture();
    await new LeagueRepo(db).upsertPicks(
      Array.from({ length: 12 }, (_, i) => ({
        draftId: 'deep-draft',
        pickNo: i + 1,
        round: 1,
        rosterId: i + 1,
        playerId: `p${i}`,
        pickedBy: null,
        isKeeper: false,
        pickInRound: i + 1,
        draftSlot: i + 1,
        sleeperPlayerId: `p${i}`,
        raw: '{}',
      })),
    );

    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    expect(board.poolHealth.drafted).toBe(12);
    expect(board.poolHealth.activeEligible).toBe(PRICED + UNPRICED - 12);
  });

  /* The floor a twelve-team, sixteen-round draft actually needs. */
  it('stays above two hundred once fifty players are gone', async () => {
    const { db } = await fixture();
    await new LeagueRepo(db).upsertPicks(
      Array.from({ length: 50 }, (_, i) => ({
        draftId: 'deep-draft',
        pickNo: i + 1,
        round: Math.floor(i / 12) + 1,
        rosterId: (i % 12) + 1,
        playerId: `p${i}`,
        pickedBy: null,
        isKeeper: false,
        pickInRound: (i % 12) + 1,
        draftSlot: (i % 12) + 1,
        sleeperPlayerId: `p${i}`,
        raw: '{}',
      })),
    );

    const board = await new DraftBoardService(db).build('deep-draft', { limit: 400 });
    expect(board.poolHealth.returned).toBeGreaterThanOrEqual(200);
  });
});
