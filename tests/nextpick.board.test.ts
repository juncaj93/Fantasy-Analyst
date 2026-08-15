/**
 * `Next` through the real board service.
 *
 * The unit tests pin the model. These pin the things that can only go wrong
 * where the model meets the app: which pick it is asked about, and what it is
 * allowed to see. Both failure modes are silent — a board that measures against
 * the wrong pick still returns plausible percentages, and a board that has let
 * the user's own preferences into the room's behaviour still returns plausible
 * percentages. Only a test that changes one input and demands the number hold
 * still can tell.
 */

import { describe, expect, it } from 'vitest';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerFlagsRepo } from '../src/server/repos/playerFlags.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SeasonMarketsRepo } from '../src/server/repos/seasonMarkets.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import { seasonFor } from '../src/server/services/seasonMarketService.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { clearNextPickCache } from '../src/core/draft/nextpick/index.ts';
import type { DraftPickRecord } from '../src/core/sleeper/types.ts';
import type { Database } from '../src/server/db.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const TEAMS = 12;
const ROUNDS = 15;
const MY_SLOT = 5;
/** Deep enough that the last round still has a board to pick from. */
const POOL = 220;
const POSITIONS = ['WR', 'RB', 'WR', 'RB', 'TE', 'WR', 'RB', 'QB'];

interface BoardOptions {
  picksMade: number;
  /** Star a player before the board is built. */
  myGuy?: { playerId: string; level: 1 | 2 | 3 };
  /**
   * Store season-long betting lines before the board is built.
   *
   * Several, not one: a player's season expectation is scored against the other
   * players at his position, so a single quoted receiver has nobody to be
   * compared with and the component correctly reports itself as unknown. To
   * prove Next ignores the betting market, the betting market first has to be
   * doing something.
   */
  vegas?: { playerId: string; line: number }[];
  limit?: number;
}

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
    name: 'Sim League',
    season: '2026',
    totalRosters: TEAMS,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN'],
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
    slotToRosterId: Object.fromEntries(Array.from({ length: TEAMS }, (_, i) => [String(i + 1), 100 + i + 1])),
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.replaceRosters('lg', [
    {
      leagueId: 'lg',
      rosterId: 100 + MY_SLOT,
      ownerId: 'me',
      ownerName: 'Me',
      playerIds: [],
      starterIds: [],
      reserveIds: [],
      isMine: true,
    },
  ]);

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

/** Picks 1..n taken straight off the top of the board. */
async function makePicks(db: Database, picksMade: number): Promise<void> {
  if (picksMade === 0) return;
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
      rosterId: 100 + slot,
      pickedBy: slot === MY_SLOT ? 'me' : `other-${slot}`,
      raw: '{}',
    });
  }
  await new LeagueRepo(db).upsertPicks(picks);
}

async function board(opts: BoardOptions) {
  // The cache is keyed by draft state and these fixtures share one, so a stale
  // entry would let one test's answer leak into the next.
  clearNextPickCache();
  const db = await createTestDb();
  await seed(db);
  await makePicks(db, opts.picksMade);
  if (opts.myGuy) await new PlayerFlagsRepo(db).setLevel(opts.myGuy.playerId, opts.myGuy.level);
  if (opts.vegas) {
    await new SeasonMarketsRepo(db).saveSnapshot(
      { provider: 'test', season: seasonFor(), fetchedAt: new Date().toISOString(), quotes: [], note: null, raw: null },
      opts.vegas.map((row) => ({
        playerId: row.playerId,
        sourcePlayerName: row.playerId,
        market: 'season_receiving_yards' as const,
        line: row.line,
        book: 'test',
        bookCount: 1,
      })),
    );
  }
  return new DraftBoardService(db).build('dr', { limit: opts.limit ?? 40 });
}

describe('which pick Next is about', () => {
  it('targets the following owned pick while the user is on the clock', async () => {
    // 52 picks made puts pick 53 on the clock, which belongs to slot 5.
    const state = await board({ picksMade: 52 });
    expect(state.currentPick).toBe(53);
    expect(state.onTheClock).toBe(true);
    expect(state.myNextPick, 'the header still says this pick is yours').toBe(53);

    // The brief's canonical example: measured to 68, simulating 54 through 67.
    expect(state.waitHorizonPick).toBe(68);
    expect(state.nextPickModel.targetPick).toBe(68);
    expect(state.nextPickModel.picksSimulated).toBe(14);

    const survivals = state.recommendations.map((r) => r.survivalProbability).filter((p): p is number => p != null);
    expect(survivals.length).toBeGreaterThan(10);
    // The failure this replaces: a board that answers "is he available now"
    // returns 100% for everybody at the one moment it is being used to choose.
    expect(survivals.every((p) => p === 1)).toBe(false);
    expect(Math.min(...survivals)).toBeLessThan(0.6);
    expect(Math.max(...survivals)).toBeGreaterThan(0.9);
  });

  it('targets the user’s own next pick when somebody else is on the clock', async () => {
    // 48 picks made puts pick 49 on the clock — slot 1, not the user.
    const state = await board({ picksMade: 48 });
    expect(state.currentPick).toBe(49);
    expect(state.onTheClock).toBe(false);
    expect(state.nextPickModel.targetPick).toBe(53);
    // Picks 49 to 52 are four opposing selections; 53 is the user's own and is
    // never counted as one.
    expect(state.nextPickModel.picksSimulated).toBe(4);
    expect(state.nextPickModel.slotsAhead).toEqual([1, 2, 3, 4]);
  });

  it('says nothing rather than 100% on the final pick of the draft', async () => {
    // Slot 5's last selection in a 15-round snake is pick 173.
    const state = await board({ picksMade: 172 });
    expect(state.currentPick).toBe(173);
    expect(state.waitHorizonPick).toBeNull();
    expect(state.nextPickModel.targetPick).toBeNull();
    expect(state.recommendations.every((r) => r.survivalProbability == null)).toBe(true);
  });
});

describe('what Next is not allowed to see', () => {
  /**
   * Every player's Next, so a whole board can be compared in one assertion.
   *
   * Comparing the whole board matters: a leak that moved one starred player
   * would be caught by checking that player, but a leak that reordered the pool
   * — and so changed which players the simulation reached — would not.
   */
  const survivalsOf = (state: Awaited<ReturnType<typeof board>>) =>
    Object.fromEntries(state.recommendations.map((r) => [r.playerId, r.survivalProbability]));

  it('does not move when the user stars a player', async () => {
    const plain = await board({ picksMade: 52 });
    const starred = await board({ picksMade: 52, myGuy: { playerId: 'p60', level: 3 } });

    // The star did reach the ranking — otherwise this proves nothing.
    const before = plain.recommendations.find((r) => r.playerId === 'p60')!;
    const after = starred.recommendations.find((r) => r.playerId === 'p60')!;
    expect(after.myGuy.level).toBe(3);
    expect(after.total).toBeGreaterThan(before.total);

    // And Next did not notice, for him or for anybody else. My Guy is what you
    // want; Next is what eleven other managers will do.
    expect(survivalsOf(starred)).toEqual(survivalsOf(plain));
  });

  it('does not move when the betting market changes', async () => {
    // Receiving yards are only scored against other receivers, and receivers
    // sit where `(n - 1) % 8` is 0, 2 or 5 — p57, p59, p62, p65 and p67 are the
    // ones just past the clock.
    const peers = [
      { playerId: 'p59', line: 850 },
      { playerId: 'p62', line: 900 },
      { playerId: 'p65', line: 780 },
      { playerId: 'p67', line: 820 },
    ];
    const plain = await board({ picksMade: 52 });
    const priced = await board({ picksMade: 52, vegas: [...peers, { playerId: 'p57', line: 1500 }] });

    /*
     * The premise has to be checked, or this test proves only that a number
     * nobody read did not change anything.
     */
    const before = plain.recommendations.find((r) => r.playerId === 'p57')!;
    const after = priced.recommendations.find((r) => r.playerId === 'p57')!;
    expect(after.marketBaseline?.points, 'the line reached the board').toBeGreaterThan(0);
    expect(after.components.find((c) => c.key === 'market_expectation')!.unknown).toBe(false);
    expect(after.total, 'and it moved the recommendation').not.toBe(before.total);

    // What the market thinks of a player is a good reason to want him and no
    // reason at all to think somebody else will take him. Next does not read it.
    expect(survivalsOf(priced)).toEqual(survivalsOf(plain));
  });
});

describe('the model behind the number', () => {
  it('reports its own workings alongside the board', async () => {
    const state = await board({ picksMade: 52 });
    expect(state.nextPickModel.simulations).toBeGreaterThanOrEqual(1000);
    expect(state.nextPickModel.slotsAhead).not.toContain(MY_SLOT);
    expect(state.nextPickModel.slotsAhead.length).toBe(7);
    expect(state.nextPickModel.roomSample).toBe(52);
    // A room this large has been read: dispersion is a measurement, not a
    // default.
    expect(state.nextPickModel.dispersion).toBeGreaterThan(0);
  });

  it('explains each player with drivers the model actually used', async () => {
    const state = await board({ picksMade: 52 });
    const rec = state.recommendations.find((r) => r.nextPick?.probability != null)!;
    expect(rec.nextPick!.drivers.length).toBeGreaterThan(0);
    expect(rec.nextPick!.drivers[0]).toContain('pick 68');

    // Any claim about how many teams need the position must match the count the
    // simulator made from the real rosters.
    for (const driver of rec.nextPick!.drivers) {
      const match = /^(\d+) of the (\d+) teams? ahead/.exec(driver);
      if (!match) continue;
      expect(Number(match[1])).toBe(state.nextPickModel.needAhead[rec.position]);
      expect(Number(match[2])).toBe(state.nextPickModel.slotsAhead.length);
    }
  });

  it('carries the drivers into the card’s existing breakdown', async () => {
    const state = await board({ picksMade: 52 });
    const rec = state.recommendations.find((r) => r.survivalProbability != null)!;
    const component = rec.components.find((c) => c.key === 'survival')!;
    expect(component.display).toContain('pick 68');
    expect(component.display).not.toContain('pick 53');
  });

  it('differs from the ADP-only baseline, because it knows more', async () => {
    const state = await board({ picksMade: 52 });
    const rows = state.recommendations.filter(
      (r) => r.nextPick?.probability != null && r.nextPick.marketBaseline != null,
    );
    expect(rows.length).toBeGreaterThan(10);
    // Not a different number for every player — the market is still the largest
    // input, so most land near it — but the model is doing something.
    const moved = rows.filter((r) => Math.abs(r.nextPick!.probability! - r.nextPick!.marketBaseline!) > 0.05);
    expect(moved.length).toBeGreaterThan(0);
  });
});

describe('stability', () => {
  it('returns the same board twice when nothing has happened', async () => {
    const first = await board({ picksMade: 52 });
    const second = await board({ picksMade: 52 });
    expect(second.recommendations.map((r) => r.survivalProbability)).toEqual(
      first.recommendations.map((r) => r.survivalProbability),
    );
  });

  it('moves when a pick lands', async () => {
    const before = await board({ picksMade: 52 });
    const after = await board({ picksMade: 55 });
    expect(after.nextPickModel.picksSimulated).toBeLessThan(before.nextPickModel.picksSimulated);

    // Somebody still on the board after three more picks should be safer than
    // they were, because three of the managers in the way have now picked.
    const survived = after.recommendations.find(
      (r) => r.survivalProbability != null && before.recommendations.some((b) => b.playerId === r.playerId),
    )!;
    const previously = before.recommendations.find((b) => b.playerId === survived.playerId)!;
    expect(survived.survivalProbability).not.toBe(previously.survivalProbability);
  });
});
