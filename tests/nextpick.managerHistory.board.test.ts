/**
 * The boundary, proved through the real board service rather than argued.
 *
 * The claim the brief makes is narrow and absolute: historical manager
 * behaviour may change the probability a player is taken before your next pick,
 * and may not change anything about how good he is. A reading of the code
 * supports that — the prior reaches one multiplier table inside the simulator —
 * but a reading of the code is what everybody has before a regression, so the
 * same board is built twice here, once with history and once without, and every
 * number except `Next%` is required to come back **identical**.
 *
 * Identical, not close. `Score`, `ADP`, `DOG`, `Val` and `PTS` are not
 * downstream of a simulation and must not acquire a dependency on one; a
 * tolerance would hide exactly the bug this exists to catch.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { ManagerProfileRepo } from '../src/server/repos/managerProfiles.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { clearNextPickCache } from '../src/core/draft/nextpick/index.ts';
import { readManagerTendencies } from '../src/core/managers/managerTendencies.ts';
import type { HistoricalPick } from '../src/core/managers/draftProfile.ts';
import type { DraftPickRecord } from '../src/core/sleeper/types.ts';
import type { Database } from '../src/server/db.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const TEAMS = 12;
const ROUNDS = 15;
const MY_SLOT = 5;
const POOL = 220;
const POSITIONS = ['WR', 'RB', 'WR', 'RB', 'TE', 'WR', 'RB', 'QB'];
const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN'];

/** Roster id for a draft slot, and the user who owns it. */
const rosterOf = (slot: number) => 100 + slot;
const userOf = (slot: number) => `user-${slot}`;

async function seed(db: Database): Promise<void> {
  const players = new PlayerRepo(db);
  await players.upsertMany(
    Array.from({ length: POOL }, (_, i) =>
      player({
        id: `p${i + 1}`,
        fullName: `Player ${String(i + 1).padStart(3, '0')}`,
        position: POSITIONS[i % POSITIONS.length]!,
        team: 'KC',
        searchRank: i + 1,
      }),
    ),
  );

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'lg',
    sleeperLeagueId: 'lg',
    name: 'History League',
    season: '2026',
    totalRosters: TEAMS,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ROSTER,
    leagueSettings: {},
    draftId: 'dr',
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.selectLeague('lg');
  await leagues.upsertDraft({
    id: 'dr',
    sleeperDraftId: 'dr',
    leagueId: 'lg',
    status: 'drafting',
    type: 'snake',
    season: '2026',
    rounds: ROUNDS,
    teams: TEAMS,
    slotToRosterId: Object.fromEntries(Array.from({ length: TEAMS }, (_, i) => [String(i + 1), rosterOf(i + 1)])),
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });

  /*
   * Every seat, not just the user's.
   *
   * The prior is looked up slot -> roster -> owner, so a fixture that stores
   * only the user's roster would find no owner for anybody picking ahead and
   * would pass this file's equality tests for entirely the wrong reason.
   */
  await leagues.replaceRosters(
    'lg',
    Array.from({ length: TEAMS }, (_, i) => ({
      leagueId: 'lg',
      rosterId: rosterOf(i + 1),
      ownerId: userOf(i + 1),
      ownerName: `Manager ${i + 1}`,
      playerIds: [],
      starterIds: [],
      reserveIds: [],
      isMine: i + 1 === MY_SLOT,
    })),
  );

  const index = await players.buildIndex();
  const csv = ['Player,Position,Team,ADP']
    .concat(
      Array.from(
        { length: POOL },
        (_, i) => `Player ${String(i + 1).padStart(3, '0')},${POSITIONS[i % POSITIONS.length]},KC,${i + 1}`,
      ),
    )
    .join('\n');
  const { snapshot } = await new AdpRepo(db).save(
    importAdpSnapshot(`${csv}\n`, index, { label: 'test', source: 'test' }),
  );
  await leagues.setDraftSnapshot('dr', snapshot.id);
}

async function makePicks(db: Database, picksMade: number): Promise<void> {
  const picks: DraftPickRecord[] = [];
  for (let pickNo = 1; pickNo <= picksMade; pickNo++) {
    const round = Math.ceil(pickNo / TEAMS);
    const indexInRound = ((pickNo - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS - indexInRound + 1 : indexInRound;
    picks.push({
      draftId: 'dr',
      pickNo,
      round,
      pickInRound: indexInRound,
      draftSlot: slot,
      sleeperPlayerId: `p${pickNo}`,
      playerId: `p${pickNo}`,
      rosterId: rosterOf(slot),
      pickedBy: userOf(slot),
      raw: '{}',
    });
  }
  if (picks.length > 0) await new LeagueRepo(db).upsertPicks(picks);
}

/**
 * Two historical drafts in which the managers picking ahead are extreme.
 *
 * Everybody ahead of the user takes a quarterback in round one, both years, and
 * nobody else does. Real profiles are far milder than this — the measured
 * maximum against a live league is a third of a point — so an effect that fails
 * to appear here would fail to appear anywhere.
 */
function extremeHistory(): HistoricalPick[] {
  const out: HistoricalPick[] = [];
  const eager = new Set([6, 7, 8, 9, 10, 11, 12]);
  for (const [draftId, season] of [
    ['h1', '2024'],
    ['h2', '2025'],
  ] as const) {
    for (let round = 1; round <= ROUNDS; round++) {
      for (let seat = 1; seat <= TEAMS; seat++) {
        const indexInRound = round % 2 === 0 ? TEAMS - seat + 1 : seat;
        const pickNo = (round - 1) * TEAMS + seat;
        const wantsQbEarly = eager.has(indexInRound);
        out.push({
          season,
          draftId,
          pickNo,
          round,
          userId: userOf(indexInRound),
          rosterId: rosterOf(indexInRound),
          position:
            round === 1 && wantsQbEarly
              ? 'QB'
              : round === 10 && !wantsQbEarly
                ? 'QB'
                : pickNo % 2 === 0
                  ? 'RB'
                  : 'WR',
          marketRank: null,
          yearsExp: 3,
        });
      }
    }
  }
  return out;
}

async function storeHistory(db: Database): Promise<void> {
  const picks = extremeHistory();
  const tendencies = readManagerTendencies({
    picks,
    positions: ['QB', 'RB', 'WR', 'TE'],
    rounds: ROUNDS,
    latestSeason: '2025',
  });
  const profiles = new ManagerProfileRepo(db);
  for (let slot = 1; slot <= TEAMS; slot++) {
    const t = tendencies.get(userOf(slot));
    if (t) await profiles.saveTendencies('lg', rosterOf(slot), t);
  }
}

/** One board, with the league's draft history either stored or absent. */
async function board(opts: { picksMade: number; history: boolean }) {
  clearNextPickCache();
  const db = await createTestDb();
  await seed(db);
  await makePicks(db, opts.picksMade);
  if (opts.history) await storeHistory(db);
  return new DraftBoardService(db).build('dr', { limit: 60, position: null });
}

describe('the manager-history adjustment through the board service', () => {
  let withHistory: Awaited<ReturnType<typeof board>>;
  let without: Awaited<ReturnType<typeof board>>;

  beforeEach(async () => {
    // 52 picks made puts pick 53 on the clock — the user's — measured to 68.
    without = await board({ picksMade: 52, history: false });
    withHistory = await board({ picksMade: 52, history: true });
  });

  it('reads the stored profiles for the managers picking ahead', () => {
    const model = withHistory.nextPickModel.managerHistory;
    expect(model).not.toBeNull();
    expect(model!.managersWithHistory).toBeGreaterThan(0);
    // And says what it did, with the sample attached.
    expect(model!.entries[0]!.draftsObserved).toBe(2);
    expect(model!.notes.join(' ')).toContain('historical draft');
  });

  it('says nothing at all in a league whose history has never been synced', () => {
    expect(without.nextPickModel.managerHistory).toBeNull();
  });

  it('moves Next% for the position those managers historically want', () => {
    const qbBefore = survivalByPosition(without, 'QB');
    const qbAfter = survivalByPosition(withHistory, 'QB');
    const moved = [...qbAfter.entries()].filter(([id, p]) => qbBefore.get(id) !== p);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('never moves it past the hard ceiling', () => {
    const ceiling = withHistory.nextPickModel.managerHistory!.ceilingPoints / 100;
    for (const rec of withHistory.recommendations) {
      const detail = rec.nextPick;
      if (!detail || rec.survivalProbability == null) continue;
      const baseline = without.recommendations.find((r) => r.playerId === rec.playerId)?.survivalProbability;
      if (baseline == null) continue;
      expect(Math.abs(rec.survivalProbability - baseline)).toBeLessThanOrEqual(ceiling + 1e-9);
    }
    expect(withHistory.nextPickModel.managerHistory!.largestMovePoints).toBeLessThanOrEqual(
      withHistory.nextPickModel.managerHistory!.ceilingPoints + 1e-9,
    );
  });

  it('leaves Score, ADP, DOG, Val and PTS byte-identical', () => {
    /*
     * The boundary, stated as an equality over every row on the board.
     *
     * `Score` is the one people will look at, but it is not the only thing that
     * must not move: a market number that acquired a dependency on a simulation
     * would be just as wrong and much harder to notice.
     */
    const before = new Map(without.recommendations.map((r) => [r.playerId, r]));
    expect(withHistory.recommendations.length).toBe(without.recommendations.length);

    let compared = 0;
    for (const after of withHistory.recommendations) {
      const b = before.get(after.playerId);
      expect(b, `${after.playerId} left the board entirely`).toBeDefined();
      expect(after.score, `Score moved for ${after.playerId}`).toBe(b!.score);
      expect(after.total).toBe(b!.total);
      expect(after.adp).toBe(b!.adp);
      expect(after.dogAdp).toBe(b!.dogAdp);
      expect(after.adpValue).toBe(b!.adpValue);
      expect(after.preseasonPoints).toBe(b!.preseasonPoints);
      compared++;
    }
    // A vacuous pass is the failure mode this guards against.
    expect(compared).toBeGreaterThan(30);
  });

  it('leaves the ranking order itself unchanged', () => {
    /*
     * Stronger than the per-field equality and worth stating separately: even
     * if every component matched, a board that reordered would be a board whose
     * recommendation had changed.
     */
    expect(withHistory.recommendations.map((r) => r.playerId)).toEqual(
      without.recommendations.map((r) => r.playerId),
    );
  });

  it('keeps every scored component and the market baseline out of it', () => {
    for (const after of withHistory.recommendations) {
      const b = without.recommendations.find((r) => r.playerId === after.playerId)!;
      expect(after.marketBlend).toEqual(b.marketBlend);
      expect(after.components).toEqual(b.components);
    }
  });
});

function survivalByPosition(
  state: { recommendations: { playerId: string; position: string; survivalProbability: number | null }[] },
  position: string,
): Map<string, number | null> {
  return new Map(
    state.recommendations.filter((r) => r.position === position).map((r) => [r.playerId, r.survivalProbability]),
  );
}
