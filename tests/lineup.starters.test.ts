/**
 * Who the app says to start, slot by slot.
 *
 * The Team screen tints the recommended starter's card and leaves the backup
 * neutral, so every claim it makes visually is a claim this optimiser made
 * first. These are the fixtures from the brief: two quarterbacks for one slot,
 * flex slots that must not double-assign, an injured starter, a player with no
 * game this week, and a slot nothing can fill.
 *
 * The rule underneath all of them: **the lineup is the best legal combination,
 * not the top N at each position independently.**
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

const ONE_QB = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);
const TWO_FLEX = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'BN', 'BN']);

/** Everyone actually in the recommended lineup, by slot. */
function assigned(slots: { slot: string; name: string | null }[]): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {};
  for (const s of slots) (out[s.slot] ??= []).push(s.name);
  return out;
}

describe('one starting quarterback, two quarterbacks owned', () => {
  const roster = [
    candidate('qb1', 'Passer One', 'QB', 22),
    candidate('qb2', 'Passer Two', 'QB', 16),
    candidate('rb1', 'Runner One', 'RB', 14),
    candidate('rb2', 'Runner Two', 'RB', 12),
    candidate('wr1', 'Catcher One', 'WR', 13),
    candidate('wr2', 'Catcher Two', 'WR', 11),
    candidate('te1', 'End One', 'TE', 9),
    candidate('rb3', 'Runner Three', 'RB', 10),
  ];

  it('starts the higher-ranked one and benches the other', () => {
    const result = recommendLineup(roster, ONE_QB, HALF_PPR);
    const qb = result.slots.filter((s) => s.slot === 'QB');
    expect(qb).toHaveLength(1);
    expect(qb[0]!.name).toBe('Passer One');

    // The backup is on the bench list, not in a slot — which is what the Team
    // screen reads to decide that his card stays neutral.
    expect(result.bench.map((b) => b.name)).toContain('Passer Two');
    expect(result.slots.map((s) => s.name)).not.toContain('Passer Two');
  });

  it('follows the ranking rather than a fixed order', () => {
    // Same two quarterbacks, opinions reversed.
    const flipped = [candidate('qb1', 'Passer One', 'QB', 12), ...roster.slice(1)];
    const result = recommendLineup(flipped, ONE_QB, HALF_PPR);
    expect(result.slots.find((s) => s.slot === 'QB')!.name).toBe('Passer Two');
    expect(result.bench.map((b) => b.name)).toContain('Passer One');
  });
});

describe('flex slots', () => {
  it('assigns the best legal remaining player, and never the same one twice', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 18),
        candidate('rb2', 'Runner Two', 'RB', 15),
        candidate('rb3', 'Runner Three', 'RB', 14),
        candidate('wr1', 'Catcher One', 'WR', 17),
        candidate('wr2', 'Catcher Two', 'WR', 13),
        candidate('te1', 'End One', 'TE', 8),
      ],
      ONE_QB,
      HALF_PPR,
    );

    const names = result.slots.map((s) => s.name).filter((n): n is string => n != null);
    expect(new Set(names).size, 'a player was assigned to two slots').toBe(names.length);
    // RB1/RB2 take the running-back slots, so the third back is the flex.
    expect(assigned(result.slots)['FLEX']).toEqual(['Runner Three']);
  });

  it('fills two flex slots with the top two eligible players left over', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 18),
        candidate('rb2', 'Runner Two', 'RB', 15),
        candidate('rb3', 'Runner Three', 'RB', 14),
        candidate('wr1', 'Catcher One', 'WR', 17),
        candidate('wr2', 'Catcher Two', 'WR', 16),
        candidate('wr3', 'Catcher Three', 'WR', 13),
        candidate('wr4', 'Catcher Four', 'WR', 12.5),
        candidate('te1', 'End One', 'TE', 9),
        candidate('te2', 'End Two', 'TE', 7),
      ],
      TWO_FLEX,
      HALF_PPR,
    );

    const flex = assigned(result.slots)['FLEX']!;
    expect(flex).toHaveLength(2);
    // WR1-3 fill the three receiver slots and RB1-2 the two back slots, so the
    // best two left are the third back and the fourth receiver.
    expect([...flex].sort()).toEqual(['Catcher Four', 'Runner Three']);

    const names = result.slots.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    // A quarterback never reaches a normal flex, however thin the bench is.
    expect(flex).not.toContain('Passer One');
  });

  it('keeps a quarterback out of a normal flex even when he is the best player left', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 24),
        candidate('qb2', 'Passer Two', 'QB', 23),
        candidate('rb1', 'Runner One', 'RB', 10),
        candidate('rb2', 'Runner Two', 'RB', 9),
        candidate('rb3', 'Runner Three', 'RB', 5),
        candidate('wr1', 'Catcher One', 'WR', 8),
        candidate('wr2', 'Catcher Two', 'WR', 7),
        candidate('te1', 'End One', 'TE', 6),
      ],
      ONE_QB,
      HALF_PPR,
    );
    expect(assigned(result.slots)['FLEX']).toEqual(['Runner Three']);
    expect(result.bench.map((b) => b.name)).toContain('Passer Two');
  });
});

describe('players who cannot play', () => {
  it('replaces an Out starter with the best legal alternative', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 24, { status: 'Out' }),
        candidate('qb2', 'Passer Two', 'QB', 15),
        candidate('rb1', 'Runner One', 'RB', 14),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 13),
        candidate('wr2', 'Catcher Two', 'WR', 11),
        candidate('te1', 'End One', 'TE', 9),
        candidate('rb3', 'Runner Three', 'RB', 10),
      ],
      ONE_QB,
      HALF_PPR,
      { currentStarterIds: ['qb1'] },
    );

    expect(result.slots.find((s) => s.slot === 'QB')!.name).toBe('Passer Two');
    // ...and it says why, rather than silently dropping him off the screen.
    expect(result.warnings.join(' ')).toMatch(/Passer One is out/i);
    expect(result.bench.map((b) => b.name)).toContain('Passer One');
  });

  /**
   * A bye week reaches the app as an absence rather than a flag: no game means
   * no market, and a player with no market cannot be scored. He is held out of
   * the lineup and listed as unrankable — never quietly benched as if he had
   * been measured and found wanting.
   */
  it('starts somebody with a game over somebody with none', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', null),
        candidate('qb2', 'Passer Two', 'QB', 15),
        candidate('rb1', 'Runner One', 'RB', 14),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 13),
        candidate('wr2', 'Catcher Two', 'WR', 11),
        candidate('te1', 'End One', 'TE', 9),
        candidate('rb3', 'Runner Three', 'RB', 10),
      ],
      ONE_QB,
      HALF_PPR,
    );
    expect(result.slots.find((s) => s.slot === 'QB')!.name).toBe('Passer Two');
    expect(result.undecidable.map((u) => u.name)).toContain('Passer One');
  });

  it('shows an unfilled slot honestly rather than starting somebody illegal', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 24, { status: 'IR' }),
        candidate('rb1', 'Runner One', 'RB', 14),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 13),
        candidate('wr2', 'Catcher Two', 'WR', 11),
        candidate('te1', 'End One', 'TE', 9),
        candidate('rb3', 'Runner Three', 'RB', 10),
      ],
      ONE_QB,
      HALF_PPR,
    );

    const qb = result.slots.find((s) => s.slot === 'QB')!;
    expect(qb.playerId).toBeNull();
    expect(qb.name).toBeNull();
    expect(result.warnings.join(' ')).toContain('no scorable player available for: QB');
    // The other slots are still filled — one hole does not collapse the lineup.
    expect(result.slots.filter((s) => s.playerId != null)).toHaveLength(6);
  });
});
