/**
 * What the board says about a position you have finished with.
 *
 * The reported defect, in one sentence: a quarterback taken in round two, and
 * by round seven the top of the recommendation list was quarterbacks again — in
 * a league that starts one. The roster shape reaching the engine was correct
 * (`tests/mock.rosterShape.test.ts` holds that half); what was wrong is that
 * the four components which all answer "how thin is this position" were paid at
 * full volume for a position that could no longer reach the reader's lineup,
 * while `need` — the one component that knew the slot was closed — was worth
 * about a hundredth of a pick of ADP against them.
 *
 * So these are tests about *volume*, not about direction. Nothing here claims a
 * filled position should score badly; the claim is that "there is nothing left
 * like him at quarterback" may not outweigh two empty running-back slots.
 */

import { describe, expect, it } from 'vitest';
import {
  POSITIONAL_STRUCTURE,
  capPositionalStructure,
  rankAvailablePlayers,
  structureVoice,
  type AvailablePlayerInput,
  type ComponentScore,
} from '../src/core/draft/engine.ts';
import { DEMAND } from '../src/core/draft/nextpick/demand.ts';
import { computeNeed } from '../src/core/draft/need.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { player } from './helpers/players.ts';

/** Tony's Pizza Fantasy: 1 QB / 2 RB / 3 WR / 2 FLX, half PPR. */
const SHAPE = buildRosterShape([
  'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
]);
const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

const voiceFor = (position: string, counts: Record<string, number>): number =>
  structureVoice(computeNeed(SHAPE, counts)[position], SHAPE, position);

describe('how loudly positional structure may speak', () => {
  it('is undiminished while the position can still reach the lineup', () => {
    // Nothing drafted: every slot is open, so every position speaks in full.
    expect(voiceFor('QB', {})).toBe(1);
    expect(voiceFor('RB', {})).toBe(1);
    expect(voiceFor('WR', {})).toBe(1);
    // A tight end this league has no dedicated slot for still has two flexes.
    expect(voiceFor('TE', {})).toBe(1);
  });

  it('is undiminished for a position whose own slots are full but a flex is open', () => {
    // Three receivers fill the three WR slots; both flexes are still empty, so
    // a fourth receiver would start on Sunday and the board may say so loudly.
    expect(voiceFor('WR', { WR: 3 })).toBe(1);
    expect(voiceFor('RB', { RB: 2 })).toBe(1);
  });

  it('drops to the room model’s own discount once a single-slot position is closed', () => {
    // One quarterback, one quarterback slot, and no flex that accepts him.
    expect(voiceFor('QB', { QB: 1 })).toBe(DEMAND.singleFilled);
    expect(voiceFor('QB', { QB: 2 })).toBe(DEMAND.singleFilled);
  });

  it('drops only a little for a depth position with everything full', () => {
    /*
     * Backs and receivers keep being drafted all afternoon — for the bench, for
     * the byes, because they are the positions that get hurt — so a full one is
     * quieter, not silent. Same distinction `demand.ts` draws for the room.
     */
    const full = { QB: 1, RB: 2, WR: 3, TE: 2 };
    expect(voiceFor('RB', full)).toBe(DEMAND.depthFilled);
    expect(voiceFor('WR', full)).toBe(DEMAND.depthFilled);
  });

  it('says nothing about a position the need model has no entry for', () => {
    expect(structureVoice(undefined, SHAPE, 'DEF')).toBe(1);
  });
});

describe('the joint ceiling', () => {
  const family = (contributions: number[]): ComponentScore[] =>
    POSITIONAL_STRUCTURE.keys.map((key, i) => ({
      key,
      label: key,
      display: '',
      score: 1,
      weight: contributions[i] ?? 0,
      contribution: contributions[i] ?? 0,
      unknown: false,
    }));

  it('is the documented cap at full voice', () => {
    const components = family([0.3, 0.3, 0.3, 0.3]);
    capPositionalStructure(components);
    const total = components.reduce((a, c) => a + c.contribution, 0);
    expect(total).toBeCloseTo(POSITIONAL_STRUCTURE.cap, 3);
  });

  it('is that cap’s share of it at reduced voice', () => {
    const components = family([0.3, 0.3, 0.3, 0.3]);
    capPositionalStructure(components, DEMAND.singleFilled);
    const total = components.reduce((a, c) => a + c.contribution, 0);
    // Two places: each weight is rounded to three before the contributions are
    // re-derived, so four of them can carry a thousandth apiece.
    expect(total).toBeCloseTo(POSITIONAL_STRUCTURE.cap * DEMAND.singleFilled, 2);
  });

  it('scales the weight, so score × weight still checks out on the card', () => {
    const components = family([0.3, 0.3, 0.3, 0.3]);
    capPositionalStructure(components, DEMAND.singleFilled);
    for (const c of components) {
      expect(c.score, 'the sub-model’s own measurement is untouched').toBe(1);
      expect(c.contribution).toBeCloseTo(c.score * c.weight, 3);
    }
  });

  it('leaves a family already under the lowered ceiling alone', () => {
    const components = family([0.02, 0.02, 0.01, 0.01]);
    capPositionalStructure(components, DEMAND.singleFilled);
    expect(components.map((c) => c.contribution)).toEqual([0.02, 0.02, 0.01, 0.01]);
  });

  it('never raises anything: the ceiling only ever falls', () => {
    const atFull = family([0.3, 0.3, 0.3, 0.3]);
    capPositionalStructure(atFull);
    const quieter = family([0.3, 0.3, 0.3, 0.3]);
    capPositionalStructure(quieter, DEMAND.singleFilled);
    for (let i = 0; i < atFull.length; i++) {
      expect(quieter[i]!.contribution).toBeLessThanOrEqual(atFull[i]!.contribution);
    }
  });
});

// ------------------------------------------------------------- on a board

/**
 * A board shaped like the one the complaint came from: quarterbacks that thin
 * out fast, backs and receivers that do not.
 */
function board(): AvailablePlayerInput[] {
  const at = (id: string, position: string, adp: number): AvailablePlayerInput => ({
    player: player({ id, fullName: `Player ${id}`, position, team: `T${adp % 20}` }),
    adp,
    adpRank: adp,
    signal: null,
  });
  return [
    at('qb1', 'QB', 66),
    at('qb2', 'QB', 92),
    at('qb3', 'QB', 128),
    ...Array.from({ length: 14 }, (_, i) => at(`rb${i}`, 'RB', 68 + i * 4)),
    ...Array.from({ length: 14 }, (_, i) => at(`wr${i}`, 'WR', 70 + i * 4),
    ),
  ];
}

const ctxFor = (rosterCounts: Record<string, number>) => ({
  currentPick: 70,
  nextPick: 75,
  shape: SHAPE,
  profile: HALF_PPR,
  rosterCounts,
  totalPicks: 180,
});

const structureOf = (rec: { components: { key: string; contribution: number }[] }): number =>
  rec.components
    .filter((c) => (POSITIONAL_STRUCTURE.keys as readonly string[]).includes(c.key))
    .reduce((a, c) => a + c.contribution, 0);

const find = <T extends { playerId: string }>(ranked: T[], id: string): T =>
  ranked.find((r) => r.playerId === id)!;

describe('a quarterback the reader can no longer start', () => {
  it('is held to the lowered ceiling, while an open position is not', () => {
    const held = rankAvailablePlayers(board(), ctxFor({ QB: 1, RB: 2, WR: 2 }));
    const qb = find(held, 'qb1');
    expect(structureOf(qb)).toBeLessThanOrEqual(
      POSITIONAL_STRUCTURE.cap * DEMAND.singleFilled + 0.002,
    );

    // The receiver slot is still open, so nothing about him is turned down.
    const open = rankAvailablePlayers(board(), ctxFor({}));
    expect(structureOf(find(open, 'qb1'))).toBeGreaterThan(structureOf(qb));
  });

  it('loses ground to the positions still missing a starter', () => {
    const before = rankAvailablePlayers(board(), ctxFor({ RB: 2, WR: 2 }));
    const after = rankAvailablePlayers(board(), ctxFor({ QB: 1, RB: 2, WR: 2 }));
    const gapBefore = find(before, 'qb1').total - find(before, 'wr0').total;
    const gapAfter = find(after, 'qb1').total - find(after, 'wr0').total;
    expect(gapAfter, 'taking the quarterback moves him toward the field, not away from it')
      .toBeLessThan(gapBefore);
  });

  it('is not driven off the board — depth is still worth something', () => {
    const ranked = rankAvailablePlayers(board(), ctxFor({ QB: 1, RB: 2, WR: 2 }));
    const qb = find(ranked, 'qb1');
    expect(qb.score).not.toBeNull();
    expect(qb.score!).toBeGreaterThan(0);
    // He is still on the board, still scored, still comparable: this is a
    // volume control, not an exclusion.
    expect(ranked.map((r) => r.playerId)).toContain('qb1');
  });
});
