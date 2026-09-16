/**
 * A player is not a cheap drop because he is hurt this week.
 *
 * Production, 16 September 2026. Ladd McConkey — taken 39.8th overall, listed
 * Questionable for week 2 — was the named drop in three of the four suggested
 * claims, and the defence planner separately offered to cut him to stream
 * Atlanta. He projected near zero for that one Sunday, and every horizon field
 * on the roster was holding that same one-Sunday number, so the model read a
 * temporary absence as a permanent loss of value.
 *
 * This walks the whole drop ranking rather than the valuation alone, because
 * the valuation being right is not the point — the point is that the cut
 * ranking changes.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterSimulation, eligibleDrops, rankDropsFor } from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, at, roster, wire } from './helpers/waiverPlanner.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';

/**
 * The same roster, with the bench filler swapped for a notable early pick who
 * cannot play this week.
 *
 * `0.4` is what the engine gives a player the lineup has ruled out, and it is
 * deliberately below the ordinary scrub beside him: the whole failure was that
 * this ordering alone decided the cut.
 */
function rosterWithHurtPick() {
  return [...roster().filter((p) => p.player.id !== 'benchWr'), at('hurtPick', 'Notable Early Pick', 'WR', 0.4)];
}

/** An August capture that says he is a starter: 160 points over a season. */
const CAPTURE = new Map([['hurtPick', 160]]);

function simulation(preseasonPoints?: ReadonlyMap<string, number>) {
  const rosterInputs = rosterWithHurtPick();
  const wireInputs = wire();
  return buildRosterSimulation({
    pool: [...rosterInputs, ...wireInputs],
    rosterIds: rosterInputs.map((r) => r.player.id),
    wireIds: wireInputs.map((r) => r.player.id),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    ...(preseasonPoints ? { preseasonPoints } : {}),
  });
}

describe('a hurt early pick is not the cheapest cut on the roster', () => {
  it('was the first name offered before the capture was read', () => {
    /*
     * The defect, pinned so it cannot come back quietly. With no durable
     * reading available the engine falls back to the week projection — which is
     * exactly the old behaviour — and the hurt pick sorts to the front.
     */
    const drops = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' }));
    expect(drops[0]?.playerId).toBe('hurtPick');
  });

  it('is no longer the first name once the league’s own capture is read', () => {
    const drops = eligibleDrops(
      rankDropsFor({ simulation: simulation(CAPTURE), addPlayerId: 'wireWr' }),
    );
    expect(drops[0]?.playerId).not.toBe('hurtPick');
    expect(drops[0]?.playerId).toBe('benchRb');
  });

  it('carries a standing worth that reflects the season rather than the Sunday', () => {
    const withCapture = simulation(CAPTURE);
    const standing = withCapture.slotValueOf.get('hurtPick') ?? 0;

    expect(standing).toBeGreaterThan(160 / EXPECTED_GAMES / 2);
    expect(withCapture.slotValueOf.get('hurtPick')!).toBeGreaterThan(
      simulation().slotValueOf.get('hurtPick')!,
    );
  });

  it('still costs the lineup nothing this week, because that part was never wrong', () => {
    /*
     * The separation the fix rests on. What the lineup loses this Sunday is a
     * question about this Sunday and the week projection answers it correctly.
     * What the roster loses by cutting him is a different question, and it is
     * the only one that changed.
     */
    const drops = rankDropsFor({ simulation: simulation(CAPTURE), addPlayerId: 'wireWr' });
    const hurt = drops.find((d) => d.playerId === 'hurtPick')!;
    expect(hurt.lineupCost).toBe(0);
  });

  it('does not make him uncuttable — he is protected by cost, not by a list', () => {
    const drops = eligibleDrops(rankDropsFor({ simulation: simulation(CAPTURE), addPlayerId: 'wireWr' }));
    expect(drops.map((d) => d.playerId)).toContain('hurtPick');
  });

  it('leaves an ordinary scrub exactly where he was', () => {
    const before = simulation().slotValueOf.get('benchRb');
    const after = simulation(CAPTURE).slotValueOf.get('benchRb');
    expect(after).toBe(before);
  });
});
