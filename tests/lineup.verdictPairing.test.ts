/**
 * "Start X instead" is a sentence about the row it is printed on.
 *
 * Measured on this league on 16 September 2026, after the borrowed-ranking fix
 * had shipped and the optimiser had stopped getting the lineup wrong:
 *
 *     Sleeper   QB Burrow · RB Stevenson · RB Robinson · … · FLEX Reed · FLEX Walker · DEF TB
 *     app       QB Burrow · RB Robinson  · RB Stevenson · … · DEF —    · FLEX Walker · FLEX Harvey
 *     swaps     out Jayden Reed, in RJ Harvey, +1.37
 *
 * `buildLineupVerdicts` consumed each label's bucket in order, so Sleeper's
 * first FLEX paired with the app's first FLEX. Reed's row drew Walker (not a
 * suggested swap, so `keep`) and Walker's row drew Harvey — putting
 * `→ Start RJ Harvey instead · 7.2` on **Kenneth Walker's** row, which advises
 * benching a 16.4 for a 7.2, while the change the app actually wanted was never
 * shown to anybody.
 *
 * The same crossing ran silently through the two RB rows. Both said `keep`, so
 * nothing looked wrong, and each carried the other man's projection: the row
 * headed Rhamondre Stevenson printed Bijan Robinson's 18.98.
 *
 * Two failures, one cause, and neither is about ranking: the optimiser had
 * already decided correctly. This is the screen mis-reporting the decision.
 */

import { describe, expect, it } from 'vitest';
import { buildLineupVerdicts, type RecommendedSlot } from '../src/core/startsit/sleeperLineup.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN'];

const POSITION_OF: Record<string, string> = {
  burrow: 'QB', stevenson: 'RB', robinson: 'RB', collins: 'WR', wilson: 'WR',
  egbuka: 'WR', laporta: 'TE', reed: 'WR', walker: 'RB', harvey: 'RB', tb: 'DEF',
};
const positionOf = (id: string) => POSITION_OF[id] ?? null;

/** Sleeper's own slot order, exactly as production served it. */
const SLEEPER = [
  'burrow', 'stevenson', 'robinson', 'collins', 'wilson',
  'egbuka', 'laporta', 'reed', 'walker', 'tb',
];

const FLEX_ACCEPTS = ['RB', 'WR', 'TE'];

function slot(label: string, playerId: string | null, name: string | null, projection: number | null): RecommendedSlot {
  return {
    slot: label,
    accepts: label === 'FLEX' ? FLEX_ACCEPTS : [label],
    playerId,
    name,
    projection,
    projectionSource: projection == null ? null : 'market',
  };
}

/** The app's recommended slots, in the app's own order, as production served them. */
const APP_SLOTS: RecommendedSlot[] = [
  slot('QB', 'burrow', 'Joe Burrow', 22.07),
  slot('RB', 'robinson', 'Bijan Robinson', 18.98),
  slot('RB', 'stevenson', 'Rhamondre Stevenson', 10.89),
  slot('WR', 'collins', 'Nico Collins', 14.66),
  slot('WR', 'wilson', 'Garrett Wilson', 13.4),
  slot('WR', 'egbuka', 'Emeka Egbuka', 10.94),
  slot('TE', 'laporta', 'Sam LaPorta', 11.27),
  slot('DEF', null, null, null),
  slot('FLEX', 'walker', 'Kenneth Walker', 16.4),
  slot('FLEX', 'harvey', 'RJ Harvey', 7.16),
];

const SWAPS = [{ outPlayerId: 'reed', inPlayerId: 'harvey' }];

function rows(over: { suggestedSwaps?: readonly { outPlayerId: string; inPlayerId: string }[] } = {}) {
  return buildLineupVerdicts({
    rosterPositions: POSITIONS,
    starterSlotIds: SLEEPER,
    starterIds: SLEEPER,
    slots: APP_SLOTS,
    suggestedSwaps: over.suggestedSwaps ?? SWAPS,
    positionOf,
  });
}

const rowFor = (playerId: string) => rows().find((r) => r.currentPlayerId === playerId)!;

describe('the swap lands on the row it is about', () => {
  it('offers RJ Harvey on Jayden Reed’s row, who is the man he replaces', () => {
    const reed = rowFor('reed');
    expect(reed.verdict).toBe('swap');
    expect(reed.recommendedPlayerId).toBe('harvey');
    expect(reed.recommendedName).toBe('RJ Harvey');
  });

  it('does not offer him on Kenneth Walker’s row, which is what the screen did', () => {
    const walker = rowFor('walker');
    expect(walker.verdict).toBe('keep');
    expect(walker.recommendedPlayerId).toBe('walker');
  });

  it('names exactly one change, because the optimiser made exactly one', () => {
    const swaps = rows().filter((r) => r.verdict === 'swap');
    expect(swaps).toHaveLength(SWAPS.length);
    expect(swaps[0]!.currentPlayerId).toBe('reed');
  });

  it('never proposes a change the reader would be worse off making', () => {
    /*
     * The property behind the report, stated without naming anybody: a row that
     * says `swap` must put a higher projection in than the one it takes out.
     * On the reported screen Walker's row failed this by nine points.
     */
    const projectionOf = new Map(APP_SLOTS.map((s) => [s.playerId, s.projection]));
    /* Reed is benched by the app, so his figure comes from where he sits. */
    projectionOf.set('reed', 5.79);

    for (const row of rows().filter((r) => r.verdict === 'swap')) {
      const outgoing = projectionOf.get(row.currentPlayerId!) ?? 0;
      expect(row.projection ?? 0).toBeGreaterThan(outgoing);
    }
  });
});

describe('a kept row carries its own man’s numbers', () => {
  it('prints Stevenson’s projection on Stevenson’s row', () => {
    /* It printed Bijan Robinson's 18.98, because the RB bucket was crossed. */
    expect(rowFor('stevenson').projection).toBe(10.89);
    expect(rowFor('stevenson').recommendedName).toBe('Rhamondre Stevenson');
  });

  it('prints Robinson’s projection on Robinson’s row', () => {
    expect(rowFor('robinson').projection).toBe(18.98);
  });

  it('holds this for every row where both lineups agree', () => {
    const projectionOf = new Map(APP_SLOTS.map((s) => [s.playerId, s.projection]));
    for (const row of rows().filter((r) => r.verdict === 'keep')) {
      expect(row.recommendedPlayerId).toBe(row.currentPlayerId);
      expect(row.projection).toBe(projectionOf.get(row.currentPlayerId!));
    }
  });
});

describe('what the pairing did not disturb', () => {
  it('still draws one row per starting slot, in the league’s order', () => {
    expect(rows().map((r) => r.slot)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF',
    ]);
  });

  it('still says no_pick for the defence the app declined to fill', () => {
    const def = rowFor('tb');
    expect(def.verdict).toBe('no_pick');
    expect(def.recommendedPlayerId).toBeNull();
  });

  it('gives each row the slot’s own accepts, not the bound player’s', () => {
    const byLabel = rows().map((r) => [r.slot, r.accepts] as const);
    for (const [label, accepts] of byLabel) {
      expect(accepts).toEqual(label === 'FLEX' ? FLEX_ACCEPTS : [label]);
    }
  });

  it('reports every difference when no swap list is passed, as it always did', () => {
    const withoutList = buildLineupVerdicts({
      rosterPositions: POSITIONS,
      starterSlotIds: SLEEPER,
      starterIds: SLEEPER,
      slots: APP_SLOTS,
      positionOf,
    });
    const reed = withoutList.find((r) => r.currentPlayerId === 'reed')!;
    expect(reed.verdict).toBe('swap');
    expect(reed.recommendedPlayerId).toBe('harvey');
  });

  it('withholds the change when the optimiser withheld it', () => {
    const reed = rows({ suggestedSwaps: [] }).find((r) => r.currentPlayerId === 'reed')!;
    expect(reed.verdict).toBe('keep');
  });
});
