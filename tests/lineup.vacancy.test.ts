/**
 * The row that said "can't be scored this week" with a number beside it, twice.
 *
 * Alex reported it on 15 September from the live app: Jacksonville at `6.6`
 * with `can't be scored this week, no game line for this defense` underneath.
 * #271 fixed the case it was reported in — a defence with Rotowire's figure on
 * its own vacancy — by softening the sentence wherever that figure existed.
 *
 * It did not fix the sentence appearing beside a figure that came from
 * somewhere else, and there are two ways for that to happen. Both are here,
 * because both produce the identical screen and only one of them was shut.
 *
 *   1. **The figure is the row's own, from a different tier.** The row draws
 *      `weeklyProjection` — this app's market number first, Rotowire's only
 *      where no book has priced him — while the guard read the vacancy's
 *      borrowed figure. A row holding the first with none of the second
 *      printed the denial anyway.
 *
 *   2. **The reason belongs to a different player.** `vacancy` lists every
 *      rostered player a slot could have used, and a league with two FLEX
 *      slots hands both empty flexes the same list. Both rows took entry zero,
 *      so one of them was reading somebody else's sentence — and if that
 *      somebody had no figure while the row's own subject did, the denial came
 *      back on a row showing a number.
 *
 * The assertions are through `recommendLineup` rather than the screen, for the
 * reason the rest of this suite gives: the Team screen is one reader of this
 * shape and the Matchup screen and the support snapshot are others, so a fix
 * asserted at the component would not be a fix for the shape.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate } from './helpers/startsit.ts';

/** A league with two interchangeable flexes, which is the shape that breaks. */
const POSITIONS = ['QB', 'RB', 'WR', 'FLEX', 'FLEX', 'BN'];
const SHAPE = buildRosterShape(POSITIONS);
const PROFILE = buildScoringProfile({ rec: 0.5 }, POSITIONS);

/** Three priced players, so the only unsettled slots are the two flexes. */
function field() {
  return [
    candidate('qb1', 'Quarterback One', 'QB', 19),
    candidate('rb1', 'Back One', 'RB', 15),
    candidate('wr1', 'Receiver One', 'WR', 14),
  ];
}

const STARTERS = ['qb1', 'rb1', 'wr1', 'wr_a', 'wr_z'];

describe('a vacancy names the player it is about', () => {
  /**
   * Two unpriced flex players, one of whom has a borrowed figure.
   *
   * Ordered so the one *without* a figure sorts first by name, which is
   * exactly the arrangement that put Aaron's sentence on Zach's row.
   */
  const roster = () => [
    ...field(),
    candidate('wr_a', 'Aaron Unpriced', 'WR', null),
    candidate('wr_z', 'Zach Unpriced', 'WR', null),
  ];

  const lineup = () =>
    recommendLineup(roster(), SHAPE, PROFILE, {
      currentStarterIds: STARTERS,
      published: new Map([['wr_z', 9.4]]),
    });

  it('carries every eligible player, so a row can find its own', () => {
    const flex = lineup().slots.filter((s) => s.slot.toUpperCase().startsWith('FLEX'));
    expect(flex).toHaveLength(2);

    /*
     * The list itself is per-slot and identical across the two, which is
     * correct and is not the defect: a reader of this shape must pick the
     * entry matching the row's subject rather than the first one. What this
     * asserts is that picking it is *possible* — that both men are present on
     * both slots, so the screen has something to match against.
     */
    for (const slot of flex) {
      const ids = slot.vacancy.map((v) => v.playerId).sort();
      expect(ids, 'both flex candidates must be findable from either slot').toEqual(['wr_a', 'wr_z']);
    }
  });

  it('gives the man with a borrowed figure a sentence that names it', () => {
    const slot = lineup().slots.find((s) => s.slot.toUpperCase().startsWith('FLEX'));
    const zach = slot?.vacancy.find((v) => v.playerId === 'wr_z');

    expect(zach?.publishedProjection).toBe(9.4);
    // The #271 sentence, on the man it is actually about.
    expect(zach?.reason).toContain('Rotowire');
    expect(zach?.reason).not.toContain('scored this week');
  });

  it('leaves the man with no figure at all saying so', () => {
    const slot = lineup().slots.find((s) => s.slot.toUpperCase().startsWith('FLEX'));
    const aaron = slot?.vacancy.find((v) => v.playerId === 'wr_a');

    expect(aaron?.publishedProjection).toBeNull();
    expect(aaron?.reason).toContain('scored this week');
  });
});

describe('a vacancy says which kind of gap it is', () => {
  /*
   * The discriminator the screen suppresses on. It exists because the first
   * attempt used the borrowed figure as a proxy for "is this a denial", and a
   * proxy is what let the denial out through the other tier.
   */
  it('marks a player nobody has priced as unscorable', () => {
    const lineup = recommendLineup([...field(), candidate('wr_a', 'Aaron Unpriced', 'WR', null)], SHAPE, PROFILE, {
      currentStarterIds: ['qb1', 'rb1', 'wr1', 'wr_a'],
    });
    const vacancy = lineup.slots
      .filter((s) => s.slot.toUpperCase().startsWith('FLEX'))
      .flatMap((s) => s.vacancy)
      .find((v) => v.playerId === 'wr_a');

    expect(vacancy?.kind).toBe('unscorable');
  });

  it('marks a player who is out as unavailable, which a figure does not contradict', () => {
    /*
     * The distinction the whole discriminator exists for. "He is on injured
     * reserve" beside a projection is two true things that agree — the app
     * knows what he would be worth and knows he cannot play — so this one must
     * survive next to a number, and a rule that suppressed on the presence of
     * a figure alone would delete it.
     */
    const lineup = recommendLineup(
      [...field(), candidate('wr_ir', 'Injured One', 'WR', 12, { status: 'IR' })],
      SHAPE,
      PROFILE,
      { currentStarterIds: ['qb1', 'rb1', 'wr1', 'wr_ir'] },
    );
    const vacancy = lineup.slots
      .filter((s) => s.slot.toUpperCase().startsWith('FLEX'))
      .flatMap((s) => s.vacancy)
      .find((v) => v.playerId === 'wr_ir');

    expect(vacancy?.kind).toBe('unavailable');
    expect(vacancy?.reason).toContain('injured reserve');
  });
});
