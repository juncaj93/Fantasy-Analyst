/**
 * An imported preseason snapshot, read by the path Draft already uses.
 *
 * No new ranking path and no weight change: the question is only whether the
 * existing `player_props(scope='season') -> seasonBaseline -> marketExpectationScore`
 * chain reads hand-imported lines the same way it would read fetched ones, and
 * whether the invariants that chain already has still hold when it does.
 *
 * The invariant that matters most is the one the whole feature is bounded by: a
 * player with no market must neither gain nor lose for the absence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { marketExpectationScore, seasonBaseline } from '../src/core/vegas/season.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SeasonMarketsRepo } from '../src/server/repos/seasonMarkets.ts';
import { PreseasonImportService } from '../src/server/services/preseasonImportService.ts';
import { createTestDb } from './helpers/db.ts';
import { player, TEST_PLAYERS } from './helpers/players.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';

let db: NodeSqliteDatabase;
let service: PreseasonImportService;

/*
 * Half-PPR, built by the app's own reader rather than hand-written.
 *
 * A hand-made profile object is a second definition of what a scoring profile
 * is, and this test would then be asserting against the shape the test author
 * imagined instead of the one the ranking uses.
 */
const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

const REQ = { season: '2026', source: 'Win With Odds', capturedAt: '2026-08-20' };

/*
 * A fourth back, added here rather than to the shared roster.
 *
 * `marketExpectationScore` needs MIN_COMPARABLE_PEERS priced peers *besides*
 * the player being rated, so a standing at running back needs four priced
 * backs. The shared fixture carries three, and widening it for every other
 * suite to satisfy this one would be the wrong direction of change.
 */
const ROSTER = [...TEST_PLAYERS, player({ id: '12', fullName: 'Kyren Walker', team: 'LAR', position: 'RB' })];

beforeEach(async () => {
  db = await createTestDb();
  await new PlayerRepo(db).upsertMany(ROSTER);
  service = new PreseasonImportService(db);
});

/** Enough priced peers that a standing has something to stand against. */
const POOL = `player,team,position,market,line
Bijan Robinson,ATL,RB,Rushing Yards,1250.5
Bijan Robinson,ATL,RB,Receptions,58.5
Bijan Robinson,ATL,RB,Receiving Yards,430.5
Chris Johnson,KC,RB,Rushing Yards,900.5
Chris Johnson,KC,RB,Receptions,30.5
Chris Johnson,KC,RB,Receiving Yards,220.5
D'Andre Swift,CHI,RB,Rushing Yards,780.5
D'Andre Swift,CHI,RB,Receptions,44.5
D'Andre Swift,CHI,RB,Receiving Yards,330.5
Kyren Walker,LAR,RB,Rushing Yards,640.5
Kyren Walker,LAR,RB,Receptions,26.5
Kyren Walker,LAR,RB,Receiving Yards,190.5`;

async function marketsFor(ids: string[]) {
  return new SeasonMarketsRepo(db).latestForPlayers('2026', ids);
}

describe('Draft reads what was imported', () => {
  it('turns imported lines into a baseline in this league\'s points', async () => {
    await service.apply({ ...REQ, content: POOL });
    const markets = await marketsFor(['10']); // Bijan Robinson
    const baseline = seasonBaseline('RB', markets.get('10') ?? [], PROFILE);

    expect(baseline.points).toBeGreaterThan(0);
    expect(baseline.contributions.length).toBe(3);
    // The explanation carries the lines it was built from, so a card can show
    // the arithmetic rather than assert the total.
    expect(baseline.contributions.every((c) => c.line != null)).toBe(true);
  });

  it('rates a priced player against comparable peers', async () => {
    await service.apply({ ...REQ, content: POOL });
    const markets = await marketsFor(['10', '1', '3', '12']);
    const baselines = ['10', '1', '3', '12'].map((id) =>
      seasonBaseline('RB', markets.get(id) ?? [], PROFILE),
    );
    const score = marketExpectationScore(baselines[0]!, baselines);
    // The best-priced back of the three should stand above the middle.
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });
});

describe('the invariants still hold', () => {
  it('a player with no market has no baseline at all', async () => {
    await service.apply({ ...REQ, content: POOL });
    const markets = await marketsFor(['9']); // Jordan Love, unpriced here
    const baseline = seasonBaseline('QB', markets.get('9') ?? [], PROFILE);

    // Not zero points — no points. Absence is not a quantity.
    expect(baseline.points).toBeNull();
    expect(baseline.note).toMatch(/no season market/);
  });

  it('an unpriced player scores unknown rather than a penalty', async () => {
    await service.apply({ ...REQ, content: POOL });
    const markets = await marketsFor(['10', '1', '3', '12', '9']);
    const pool = ['10', '1', '3', '12'].map((id) => seasonBaseline('RB', markets.get(id) ?? [], PROFILE));
    const unpriced = seasonBaseline('QB', markets.get('9') ?? [], PROFILE);

    // Null, which the engine reports as `unknown` — not a low score.
    expect(marketExpectationScore(unpriced, pool)).toBeNull();
  });

  it('bounds a player priced on one market out of several', async () => {
    await service.apply({
      ...REQ,
      content: `${POOL}
Tyler Boyd,TEN,WR,Receiving Yards,700.5`,
    });
    const markets = await marketsFor(['7']);
    const baseline = seasonBaseline('WR', markets.get('7') ?? [], PROFILE);

    // Partial coverage is stated as partial, and the missing markets are named
    // rather than silently treated as zero.
    expect(baseline.coverage).toBeLessThan(1);
    expect(baseline.missing.length).toBeGreaterThan(0);
    expect(baseline.note).toMatch(/^partial/);
  });

  it('will not build a standing from too few comparable peers', async () => {
    await service.apply({ ...REQ, content: `player,team,position,market,line\nBijan Robinson,ATL,RB,Rushing Yards,1250.5` });
    const markets = await marketsFor(['10']);
    const only = seasonBaseline('RB', markets.get('10') ?? [], PROFILE);
    // One priced player is not a market to be rated against.
    expect(marketExpectationScore(only, [only])).toBeNull();
  });

  it('an unresolved name contributes nothing to the board', async () => {
    await service.apply({
      ...REQ,
      content: `${POOL}
Some Unknown Rookie,SEA,WR,Receiving Yards,1100.5`,
    });
    // Stored, in Review, and absent from every player's markets — because it
    // belongs to no player yet.
    const stored = await db
      .prepare("SELECT COUNT(*) AS n FROM player_props WHERE scope='season' AND player_id IS NULL")
      .first<{ n: number }>();
    expect(Number(stored?.n)).toBe(1);

    const markets = await marketsFor(ROSTER.map((p) => p.id));
    expect([...markets.values()].flat().some((m) => m.line === 1100.5)).toBe(false);
  });
});

describe('coverage survives a second capture', () => {
  it('a narrow later capture does not cost the others their lines', async () => {
    await service.apply({ ...REQ, content: POOL });
    // A week later, only one player is re-priced.
    await service.apply({
      ...REQ,
      capturedAt: '2026-08-28',
      content: `player,team,position,market,line\nBijan Robinson,ATL,RB,Rushing Yards,1310.5`,
    });

    const markets = await marketsFor(['10', '1', '3']);
    // All three still priced...
    expect(markets.get('1')?.length).toBe(3);
    expect(markets.get('3')?.length).toBe(3);
    // ...and the re-priced line moved, while his other markets survived from
    // the earlier capture.
    const bijan = markets.get('10') ?? [];
    expect(bijan.find((m) => m.market === 'season_rush_yards')?.line).toBe(1310.5);
    expect(bijan).toHaveLength(3);
  });

  it('lets a named primary source outrank a newer secondary', async () => {
    await service.apply({ ...REQ, content: POOL });
    await service.apply({
      ...REQ,
      source: 'Another Book',
      capturedAt: '2026-08-28',
      content: `player,team,position,market,line\nBijan Robinson,ATL,RB,Rushing Yards,1400.5`,
    });

    const primary = await new SeasonMarketsRepo(db).latestForPlayers('2026', ['10'], {
      primarySource: 'Win With Odds',
    });
    expect(primary.get('10')?.find((m) => m.market === 'season_rush_yards')?.line).toBe(1250.5);
  });
});
