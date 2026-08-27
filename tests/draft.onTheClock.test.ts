/**
 * What the board says while you are on the clock.
 *
 * The bug: "next pick %" was measured against the selection being made right
 * now. A player available now is available now, so every row on the board read
 * 100% — at the one moment the number exists to help choose between them. Worse
 * than useless, because 100% reads as "there is time".
 *
 * The same zero-length horizon fed positional scarcity ("nobody will be taken
 * before your next pick") and tier urgency, so three of the ranking's inputs
 * went flat together, and only while the clock was running.
 *
 * These tests build a real board through the real service, because the mistake
 * was not in the survival model — which was correct about what it was asked —
 * but in which pick it was asked about.
 */

import { describe, expect, it } from 'vitest';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import type { DraftPickRecord } from '../src/core/sleeper/types.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const TEAMS = 12;
const ROUNDS = 4;
/** Slot 3 in a 12-team snake picks at 3, 22, 27, 46. */
const MY_SLOT = 3;
const MY_ROSTER = 7;

/** Four positions, cycled, so every position has a real ladder to break. */
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
/** Comfortably more than the draft consumes, so the last round still has a board. */
const POOL = 70;
const NAMES = Array.from({ length: POOL }, (_, i) => `Player ${String(i + 1).padStart(2, '0')}`);

/**
 * A draft where the user's turn is `picksMade + 1`.
 *
 * Everything is ordinary: ADP tracks draft order, and the picks already made
 * took the top of the board, so the players left are spread either side of the
 * current pick the way a real board is.
 */
async function boardAt(picksMade: number) {
  const db = await createTestDb();
  const players = new PlayerRepo(db);
  await players.upsertMany(
    NAMES.map((fullName, i) =>
      player({ id: `p${i + 1}`, fullName, position: POSITIONS[i % POSITIONS.length]!, team: 'KC' }),
    ),
  );

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'lg',
    sleeperLeagueId: 'lg',
    name: 'Clock League',
    season: '2026',
    totalRosters: TEAMS,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
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
    slotToRosterId: { [String(MY_SLOT)]: MY_ROSTER },
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.replaceRosters('lg', [
    { leagueId: 'lg', rosterId: MY_ROSTER, ownerId: 'me', ownerName: 'Me', playerIds: [], starterIds: [], reserveIds: [], isMine: true },
  ]);

  // The picks already made, taking the board from the top.
  const picks: DraftPickRecord[] = [];
  for (let i = 0; i < picksMade; i++) {
    const pickNo = i + 1;
    const round = Math.ceil(pickNo / TEAMS);
    const positionInRound = round % 2 === 0 ? TEAMS - ((pickNo - 1) % TEAMS) : ((pickNo - 1) % TEAMS) + 1;
    picks.push({
      draftId: 'dr',
      pickNo,
      round,
      pickInRound: ((pickNo - 1) % TEAMS) + 1,
      draftSlot: positionInRound,
      sleeperPlayerId: `p${pickNo}`,
      playerId: `p${pickNo}`,
      rosterId: positionInRound === MY_SLOT ? MY_ROSTER : 100 + positionInRound,
      pickedBy: positionInRound === MY_SLOT ? 'me' : `other-${positionInRound}`,
      raw: '{}',
    });
  }
  if (picks.length > 0) await leagues.upsertPicks(picks);

  const index = await players.buildIndex();
  const csv = ['Player,Position,Team,ADP']
    .concat(NAMES.map((n, i) => `${n},${POSITIONS[i % POSITIONS.length]},KC,${i + 1}`))
    .join('\n');
  const { snapshot } = await new AdpRepo(db).save(
    importAdpSnapshot(`${csv}\n`, index, { label: 'test', source: 'test' }),
    '2026',
  );
  await leagues.setDraftSnapshot('dr', snapshot.id);

  return new DraftBoardService(db).build('dr', { limit: 30 });
}

describe('the board while the clock is running', () => {
  it('measures survival against the pick after this one, not this one', async () => {
    // 21 picks made puts pick 22 on the clock, which is the user's.
    const board = await boardAt(21);
    expect(board.currentPick).toBe(22);
    expect(board.onTheClock).toBe(true);
    expect(board.myNextPick, 'the header still says this pick is yours').toBe(22);

    const survivals = board.recommendations
      .map((r) => r.survivalProbability)
      .filter((p): p is number => p != null);
    expect(survivals.length).toBeGreaterThan(5);

    // The bug, stated as the thing that must not happen again.
    expect(survivals.every((p) => p === 1), 'every player read 100% on the clock').toBe(false);
    // And it is a real spread: the man at the top of the board is close to a
    // coin flip over five picks, the man twenty later is nearly safe.
    expect(Math.min(...survivals)).toBeLessThan(0.7);
    expect(Math.max(...survivals)).toBeGreaterThan(0.9);
    expect(new Set(survivals).size).toBeGreaterThan(3);
  });

  it('answers about pick 27, which is the next chance to take him', async () => {
    const board = await boardAt(21);
    const rec = board.recommendations.find((r) => r.survivalProbability != null)!;
    const survival = rec.components.find((c) => c.key === 'survival')!;
    expect(survival.display).toContain('pick 27');
    expect(survival.display).not.toContain('pick 22');
  });

  /**
   * Off the clock nothing changes: the horizon and the next turn are the same
   * pick, so this half of the behaviour must be exactly as it was.
   */
  it('is unchanged while somebody else is picking', async () => {
    const board = await boardAt(15);
    expect(board.currentPick).toBe(16);
    expect(board.onTheClock).toBe(false);
    expect(board.myNextPick).toBe(22);
    const rec = board.recommendations.find((r) => r.survivalProbability != null)!;
    expect(rec.components.find((c) => c.key === 'survival')!.display).toContain('pick 22');
  });

  /**
   * Scarcity and tier urgency read the same horizon, and went flat with it.
   * A board that says "nobody will be taken before your next pick" while you
   * are on the clock is describing a draft that has stopped.
   */
  it('does not tell you the board will be untouched before you pick again', async () => {
    const board = await boardAt(21);
    const scarcity = board.recommendations
      .map((r) => r.components.find((c) => c.key === 'scarcity')!)
      .filter((c) => !c.unknown);
    expect(scarcity.length).toBeGreaterThan(3);
    expect(scarcity.every((c) => c.score === scarcity[0]!.score), 'scarcity went flat on the clock').toBe(false);
  });

  /**
   * The last selection of the draft. There is no later pick, so there is
   * nothing to survive to — and saying "100%" there is not optimistic, it is
   * wrong in the other direction.
   */
  it('reports survival as unknown on your final pick', async () => {
    // Slot 3's last pick in a 4-round, 12-team snake is 46.
    const board = await boardAt(45);
    expect(board.currentPick).toBe(46);
    expect(board.onTheClock).toBe(true);
    for (const rec of board.recommendations) {
      expect(rec.survivalProbability).toBeNull();
    }
    const survival = board.recommendations[0]!.components.find((c) => c.key === 'survival')!;
    expect(survival.unknown).toBe(true);
    expect(survival.display).toContain('nothing for him to last until');
  });
});
