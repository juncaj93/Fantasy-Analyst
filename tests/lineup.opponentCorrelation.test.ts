/**
 * The half of the shape argument that is about the other manager.
 *
 * `core/startsit/correlation.ts` was written, bounded and tested and then had
 * no caller: the lineup's Floor/Ceiling pass counted this lineup's own
 * concentration — my quarterback with my receiver, my starters piled into one
 * fixture — and knew nothing whatever about the lineup it is being played
 * against. In head-to-head that is half the question. A game the opponent owns
 * both ends of is the game that beats a lead if it goes off, and the game worth
 * being in if you are chasing one.
 *
 * What these hold is not "the feature works" but the two properties that make
 * it safe to let into a lineup at all: it may not outrank player quality, and
 * it may not speak when nobody asked it to.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { CORRELATION, opponentExposure } from '../src/core/startsit/correlation.ts';
import { player } from './helpers/players.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

/**
 * A priced candidate in a named fixture.
 *
 * The market matters: the preference pass refuses to move a player no book has
 * quoted, so an unpriced fixture would test the guard rather than this.
 */
function candidate(
  id: string,
  name: string,
  position: string,
  points: number,
  game: { team: string; opponent: string },
): StartSitInput {
  const market = position === 'QB' ? 'pass_yards' : 'receiving_yards';
  const line = position === 'QB' ? points / 0.04 : points * 10;
  const props: PlayerProp[] = [
    {
      playerId: id,
      sourcePlayerName: name,
      market,
      line,
      overPrice: -110,
      underPrice: -110,
      bookCount: 3,
      consensusMethod: 'median',
      books: ['a', 'b', 'c'],
      impliedProbability: null,
    },
  ];
  return {
    player: player({ id, fullName: name, position, team: game.team }),
    props,
    signal: null,
    injuryStatus: null,
    opponent: game.opponent,
    propsStale: false,
  };
}

/** The opponent stacked into one high-total game, in the shape the map takes. */
function stackedOn(gameId: string, total: number | null = 52) {
  return opponentExposure(
    [
      { playerId: 'o1', name: 'Their Passer', gameId },
      { playerId: 'o2', name: 'Their Catcher', gameId },
    ],
    total == null ? new Map() : new Map([[gameId, total]]),
  );
}

/** A roster where one flex-eligible pair is a genuine coin flip. */
function roster(): StartSitInput[] {
  return [
    candidate('qb1', 'Passer One', 'QB', 20, { team: 'NE', opponent: 'NYJ' }),
    candidate('rb1', 'Runner One', 'RB', 15, { team: 'NE', opponent: 'NYJ' }),
    candidate('rb2', 'Runner Two', 'RB', 12, { team: 'CHI', opponent: 'GB' }),
    candidate('wr1', 'Catcher One', 'WR', 14, { team: 'CHI', opponent: 'GB' }),
    candidate('wr2', 'Catcher Two', 'WR', 10, { team: 'CHI', opponent: 'GB' }),
    candidate('te1', 'End One', 'TE', 8, { team: 'CHI', opponent: 'GB' }),
    // The pair the tie turns on: within the tolerance of each other, in two
    // different games, and the only two the flex can choose between.
    candidate('flexIn', 'Shootout Flex', 'WR', 9.5, { team: 'KC', opponent: 'BUF' }),
    candidate('flexOut', 'Quiet Flex', 'WR', 9.6, { team: 'SEA', opponent: 'ARI' }),
  ];
}

function flexName(result: ReturnType<typeof recommendLineup>): string | null {
  return result.slots.find((s) => s.slot === 'FLEX')?.name ?? null;
}

describe('the opponent’s stacked game reaches the lineup', () => {
  it('prefers the shootout the opponent is stacked in, when chasing points', () => {
    const exposure = stackedOn('BUF@KC');

    const without = recommendLineup(roster(), SHAPE, HALF_PPR, { mode: 'ceiling' });
    const with_ = recommendLineup(roster(), SHAPE, HALF_PPR, { mode: 'ceiling', opponentExposure: exposure });

    // Without the map the better player takes the flex, as he should.
    expect(flexName(without)).toBe('Quiet Flex');
    expect(flexName(with_)).toBe('Shootout Flex');
  });

  it('avoids that same game when protecting a lead', () => {
    // Floor is the mirror: the 0.2 the shootout player gives up is worth paying
    // to keep the week independent of the opponent's best fixture. With the
    // roles reversed, the incumbent is the one in the shootout.
    const players = roster().map((input) =>
      input.player.id === 'flexIn'
        ? candidate('flexIn', 'Shootout Flex', 'WR', 9.6, { team: 'KC', opponent: 'BUF' })
        : input.player.id === 'flexOut'
          ? candidate('flexOut', 'Quiet Flex', 'WR', 9.5, { team: 'SEA', opponent: 'ARI' })
          : input,
    );

    const without = recommendLineup(players, SHAPE, HALF_PPR, { mode: 'floor' });
    const with_ = recommendLineup(players, SHAPE, HALF_PPR, {
      mode: 'floor',
      opponentExposure: stackedOn('BUF@KC'),
    });

    expect(flexName(without)).toBe('Shootout Flex');
    expect(flexName(with_)).toBe('Quiet Flex');
  });

  it('says which reasoning moved the player, in the note', () => {
    const result = recommendLineup(roster(), SHAPE, HALF_PPR, {
      mode: 'ceiling',
      opponentExposure: stackedOn('BUF@KC'),
    });
    const note = result.notes.find((n) => n.includes('Shootout Flex'));

    expect(note, 'a lineup that reorders itself silently is the defect this repo has fixed once').toBeDefined();
    expect(note).toContain('Their Passer');
  });
});

describe('and it cannot outrank the player', () => {
  it('leaves a clearly better player in the slot, however stacked the game', () => {
    // Two and a half points apart is not a coin flip, and no amount of
    // correlation makes it one. The tolerance gate refuses the comparison
    // before the correlation points are ever read.
    const players = roster().map((input) =>
      input.player.id === 'flexIn'
        ? candidate('flexIn', 'Shootout Flex', 'WR', 7, { team: 'KC', opponent: 'BUF' })
        : input,
    );

    const result = recommendLineup(players, SHAPE, HALF_PPR, {
      mode: 'ceiling',
      opponentExposure: stackedOn('BUF@KC'),
    });

    expect(flexName(result)).toBe('Quiet Flex');
  });

  it('never moves a lineup by more than the module’s own bound', () => {
    // Both ends of the swap are assessed, so the most correlation can ever be
    // worth is twice the per-player maximum — and the tolerance is smaller than
    // that, which is what actually keeps it honest.
    expect(CORRELATION.maxPoints * 2).toBeLessThan(1);
  });

  it('takes no view at all in Balanced', () => {
    const balanced = recommendLineup(roster(), SHAPE, HALF_PPR, {
      mode: 'balanced',
      opponentExposure: stackedOn('BUF@KC'),
    });
    const plain = recommendLineup(roster(), SHAPE, HALF_PPR, { mode: 'balanced' });

    expect(flexName(balanced)).toBe(flexName(plain));
    expect(flexName(balanced)).toBe('Quiet Flex');
  });

  it('changes nothing when the opponent is not stacked anywhere', () => {
    // One opposing starter in a game is a coincidence; `opponentExposure` drops
    // it, and an empty map is the same lineup as no map at all.
    const lonely = opponentExposure([{ playerId: 'o1', name: 'Their Catcher', gameId: 'BUF@KC' }], new Map());
    expect(lonely.size).toBe(0);

    const with_ = recommendLineup(roster(), SHAPE, HALF_PPR, { mode: 'ceiling', opponentExposure: lonely });
    const without = recommendLineup(roster(), SHAPE, HALF_PPR, { mode: 'ceiling' });

    expect(flexName(with_)).toBe(flexName(without));
  });
});
