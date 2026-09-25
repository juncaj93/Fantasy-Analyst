/**
 * A player the room drafted early is not cut in September.
 *
 * The durable-value pass shipped for exactly this and did not fire for the two
 * players reported on 16 September 2026. Asked of production, the reason was
 * not that it was weighted too lightly — it was that this league's preseason
 * capture has 154 rows and neither man is in it:
 *
 *     Mark Andrews          draftRank 122.2   preseason NONE
 *     Rhamondre Stevenson   draftRank  76.4   preseason NONE
 *
 * So `durableValue` fell through to in-season production, one game had been
 * played, and a bench player's standing worth was one bad afternoon again.
 *
 * The capture is the better evidence where it exists and will never cover
 * everybody. The draft ranking covers the board, and "preseason ADP *or*
 * projection should carry real weight early" always had two halves.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRosterSimulation,
  eligibleDrops,
  rankDropsFor,
  EARLY_PICK_RANK,
  EARLY_PICK_WEEKS,
} from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, at, roster, wire } from './helpers/waiverPlanner.ts';

/**
 * The reported roster shape: a well-drafted back having a quiet week, sitting
 * on the bench beside an ordinary scrub.
 */
function rosterWithEarlyPick() {
  return [...roster().filter((p) => p.player.id !== 'benchWr'), at('earlyPick', 'Rhamondre Stevenson', 'RB', 0.6)];
}

/** He went 76th. `benchRb` went undrafted. */
const RANKS = new Map([
  ['earlyPick', 76.4],
  ['benchRb', 210],
]);

function simulation(over: { draftRankOf?: ReadonlyMap<string, number>; week?: number } = {}) {
  const rosterInputs = rosterWithEarlyPick();
  const wireInputs = wire();
  return buildRosterSimulation({
    pool: [...rosterInputs, ...wireInputs],
    rosterIds: rosterInputs.map((r) => r.player.id),
    wireIds: wireInputs.map((r) => r.player.id),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    week: 2,
    ...over,
  });
}

describe('the draft still speaks in September', () => {
  it('was the first name offered before the ranking was read', () => {
    /* The defect, pinned: with no ranking he is the cheapest cut on the board. */
    const drops = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' }));
    expect(drops[0]?.playerId).toBe('earlyPick');
  });

  it('is not on offer at all once the ranking is read', () => {
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: RANKS }),
      addPlayerId: 'wireWr',
    });
    const him = drops.find((d) => d.playerId === 'earlyPick')!;

    expect(him.protection).toBe('market_hold');
    expect(eligibleDrops(drops).map((d) => d.playerId)).not.toContain('earlyPick');
  });

  it('offers the undrafted scrub instead', () => {
    const drops = eligibleDrops(
      rankDropsFor({ simulation: simulation({ draftRankOf: RANKS }), addPlayerId: 'wireWr' }),
    );
    expect(drops[0]?.playerId).toBe('benchRb');
  });

  it('says why, in a code rather than in prose', () => {
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: RANKS }),
      addPlayerId: 'wireWr',
    });
    const him = drops.find((d) => d.playerId === 'earlyPick')!;
    expect(him.reasons.map((r) => r.code)).toContain('protected_early_pick');
  });
});

describe('what it deliberately does not cover', () => {
  it('has no opinion about a player the ranking put late', () => {
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: new Map([['earlyPick', EARLY_PICK_RANK + 1]]) }),
      addPlayerId: 'wireWr',
    });
    expect(drops.find((d) => d.playerId === 'earlyPick')?.protection).toBeNull();
  });

  it('expires once the season is its own evidence', () => {
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: RANKS, week: EARLY_PICK_WEEKS + 1 }),
      addPlayerId: 'wireWr',
    });
    expect(drops.find((d) => d.playerId === 'earlyPick')?.protection).toBeNull();
  });

  it('changes nothing for a league that has imported no ranking', () => {
    const without = rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' });
    const empty = rankDropsFor({
      simulation: simulation({ draftRankOf: new Map() }),
      addPlayerId: 'wireWr',
    });
    expect(empty.map((d) => [d.playerId, d.protection])).toEqual(
      without.map((d) => [d.playerId, d.protection]),
    );
  });
});

describe('a protection that could cover the whole roster yields', () => {
  it('still names a cut when every drop on the board was drafted early', () => {
    /*
     * A room that drafted well has a board full of early picks, and a waiver
     * lane that goes silent with no cause a reader can see is a worse failure
     * than the one this prevents. The point was never "never cut a good
     * player" — it was "do not cut a good player *ahead of a worse one*".
     */
    const everybodyEarly = new Map(
      rosterWithEarlyPick().map((p, i) => [p.player.id, i + 1] as const),
    );
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: everybodyEarly }),
      addPlayerId: 'wireWr',
    });

    const eligible = eligibleDrops(drops);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible[0]!.reasons.map((r) => r.code)).not.toContain('protected_early_pick');
  });

  it('releases exactly one, and keeps the rest protected', () => {
    const everybodyEarly = new Map(
      rosterWithEarlyPick().map((p, i) => [p.player.id, i + 1] as const),
    );
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: everybodyEarly }),
      addPlayerId: 'wireWr',
    });
    expect(eligibleDrops(drops)).toHaveLength(1);
  });

  it('never yields a man in the lineup, whatever else is protected', () => {
    const everybodyEarly = new Map(
      rosterWithEarlyPick().map((p, i) => [p.player.id, i + 1] as const),
    );
    const drops = rankDropsFor({
      simulation: simulation({ draftRankOf: everybodyEarly }),
      addPlayerId: 'wireWr',
    });
    for (const starter of ['rb1', 'wr1', 'qb1']) {
      expect(drops.find((d) => d.playerId === starter)?.protection).toBe('in_lineup');
    }
  });
});

/*
 * 25 September 2026: RJ Harvey, ADP 81.6, sat at the bottom of the bench as
 * the cheapest cut on the board. The fixed line of 80 missed him by under two
 * picks. The line is now the league's own starter pool — teams × starting
 * slots, 100 in a ten-team league starting ten — and trending adds are the
 * second condition of the same protection rather than a system of their own.
 */
describe('one market hold, two conditions', () => {
  const harvey = new Map([['earlyPick', 81.6]]);

  it('missed an ADP-82 back on the old fixed line', () => {
    const drops = rankDropsFor({ simulation: simulation({ draftRankOf: harvey }), addPlayerId: 'wireWr' });
    expect(drops.find((d) => d.playerId === 'earlyPick')?.protection).toBeNull();
  });

  it('holds him once the line is the league starter pool', () => {
    const drops = rankDropsFor({
      simulation: buildRosterSimulationWith({ draftRankOf: harvey, draftCapitalRank: 100 }),
      addPlayerId: 'wireWr',
    });
    const him = drops.find((d) => d.playerId === 'earlyPick')!;
    expect(him.protection).toBe('market_hold');
    expect(him.reasons).toContainEqual(expect.objectContaining({ code: 'protected_early_pick', value: 81.6 }));
  });

  it('holds an undrafted back the whole of Sleeper is adding, through the same protection', () => {
    const drops = rankDropsFor({
      simulation: buildRosterSimulationWith({ roomIsAdding: new Map([['benchRb', 1]]) }),
      addPlayerId: 'wireWr',
    });
    const him = drops.find((d) => d.playerId === 'benchRb')!;
    expect(him.protection).toBe('market_hold');
    expect(him.reasons).toContainEqual(expect.objectContaining({ code: 'protected_room_is_adding', value: 1 }));
  });

  it('describes a player who qualifies both ways by his draft capital', () => {
    const drops = rankDropsFor({
      simulation: buildRosterSimulationWith({ draftRankOf: RANKS, roomIsAdding: new Map([['earlyPick', 3]]) }),
      addPlayerId: 'wireWr',
    });
    const codes = drops.find((d) => d.playerId === 'earlyPick')!.reasons.map((r) => r.code);
    expect(codes).toContain('protected_early_pick');
    expect(codes).not.toContain('protected_room_is_adding');
  });
});

function buildRosterSimulationWith(over: {
  draftRankOf?: ReadonlyMap<string, number>;
  draftCapitalRank?: number;
  roomIsAdding?: ReadonlyMap<string, number>;
}) {
  const rosterInputs = rosterWithEarlyPick();
  const wireInputs = wire();
  return buildRosterSimulation({
    pool: [...rosterInputs, ...wireInputs],
    rosterIds: rosterInputs.map((r) => r.player.id),
    wireIds: wireInputs.map((r) => r.player.id),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    week: 2,
    ...over,
  });
}
