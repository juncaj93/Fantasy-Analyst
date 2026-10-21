/**
 * Outcome-shape pills, and the one thing they may do: break a close call.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { compareStartSit, evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { LINEUP_PREFERENCE_TOLERANCE, recommendLineup } from '../src/core/startsit/lineup.ts';
import { pillFor } from '../src/core/startsit/pills.ts';
import { PILL_TIEBREAK_BAND, postureFrom, tiebreakFavours, tiebreakSentence } from '../src/core/startsit/tiebreak.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const LEAGUE = buildScoringProfile({ rec: 0.5, pass_td: 6, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

function prop(market: PlayerProp['market'], line: number | null, p: number | null = null): PlayerProp {
  return {
    playerId: 'x',
    sourcePlayerName: 'x',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: p,
  };
}

const pill = (position: string, props: PlayerProp[]) => pillFor(position, props, buildExpectation(position, props, LEAGUE))?.pill ?? null;

/* Three receivers with nearly the same week and three different shapes. */
const DEEP = [prop('receiving_yards', 68.5), prop('receptions', 4.5), prop('anytime_td', null, 0.3)];
const SLOT = [prop('receiving_yards', 58.5), prop('receptions', 6.5), prop('anytime_td', null, 0.28)];
const BOOM = [prop('receiving_yards', 52.5), prop('receptions', 3.5), prop('anytime_td', null, 0.3)];
const PLAIN = [prop('receiving_yards', 48.5), prop('receptions', 4.5), prop('anytime_td', null, 0.3)];

describe('reading a pill off the lines', () => {
  it('names three shapes and leaves an ordinary week alone', () => {
    expect(pill('WR', DEEP)).toBe('explosive');
    expect(pill('WR', SLOT)).toBe('steady');
    expect(pill('WR', BOOM)).toBe('wide_range');
    expect(pill('WR', PLAIN)).toBeNull();
  });

  it('calls a goal-line week wide range, whatever else it looks like', () => {
    expect(pill('RB', [prop('rush_yards', 42.5), prop('receiving_yards', 4.5), prop('receptions', 0.5), prop('anytime_td', null, 0.7)])).toBe('wide_range');
  });

  it('leaves a depth player alone, whatever his lines look like', () => {
    // Under eight points this is not a start/sit decision, and the audit found
    // that tiny lines made nearly every such player look touchdown-reliant.
    expect(pill('RB', [prop('rush_yards', 22.5), prop('receiving_yards', 4.5), prop('receptions', 0.5), prop('anytime_td', null, 0.5)])).toBeNull();
  });

  it('reads backs and quarterbacks on their own markets', () => {
    expect(pill('RB', [prop('rush_yards', 72.5), prop('receiving_yards', 24.5), prop('receptions', 3.5), prop('anytime_td', null, 0.6)])).toBe('explosive');
    expect(pill('RB', [prop('rush_yards', 64.5), prop('receiving_yards', 18.5), prop('receptions', 3.5), prop('anytime_td', null, 0.38)])).toBe('steady');
    expect(pill('QB', [prop('pass_yards', 215.5), prop('pass_tds', 1.5), prop('rush_yards', 38.5)])).toBe('explosive');
    expect(pill('QB', [prop('pass_yards', 262.5), prop('pass_tds', 1.5), prop('rush_yards', 8.5)])).toBe('steady');
  });

  it('needs a market to say anything', () => {
    expect(pillFor('WR', [], buildExpectation('WR', [], LEAGUE))).toBeNull();
  });

  it('never moves the score', () => {
    const input = (props: PlayerProp[]): StartSitInput => ({ player: player({ id: 'p', fullName: 'P', position: 'WR', team: 'NE' }), props, signal: null });
    const withPill = evaluatePlayer(input(DEEP), LEAGUE);
    expect(withPill.pill?.pill).toBe('explosive');
    const vegas = withPill.components.find((c) => c.key === 'vegas')!.value;
    expect(withPill.score).toBeCloseTo(vegas + withPill.components.filter((c) => c.key !== 'vegas' && !c.unknown).reduce((a, c) => a + c.value, 0), 6);
    expect(withPill.components.some((c) => /pill|explosive role/i.test(c.label) && c.value !== 0)).toBe(false);
  });
});

describe('the tie-break', () => {
  it('uses the lineup’s own close-call band', () => {
    expect(PILL_TIEBREAK_BAND).toBe(LINEUP_PREFERENCE_TOLERANCE);
  });

  it('reads posture off the projected margin, and nothing when it is unknown', () => {
    expect(postureFrom(-6.2)).toBe('underdog');
    expect(postureFrom(3)).toBe('favourite');
    expect(postureFrom(null)).toBeNull();
    expect(postureFrom(0)).toBeNull();
  });

  it('lets the wanted pill win only inside the band', () => {
    const holder = { points: 10.4, pill: null };
    const explosive = { points: 10.0, pill: { pill: 'explosive' as const } };
    expect(tiebreakFavours(holder, explosive, 'underdog')?.pill).toBe('explosive');
    expect(tiebreakFavours(holder, explosive, 'favourite')).toBeNull();
    expect(tiebreakFavours({ points: 10.7, pill: null }, explosive, 'underdog')).toBeNull();
    expect(tiebreakFavours(holder, explosive, null)).toBeNull();
  });

  it('says why in one line', () => {
    expect(tiebreakSentence('underdog')).toBe("Close call. You're the underdog, so the higher ceiling gets the nod.");
    expect(tiebreakSentence('favourite')).toMatch(/favorite, so the safer floor/);
  });
});

describe('the tie-break in a comparison and in the lineup', () => {
  /* Steady slot receiver a few tenths ahead of the deep threat. */
  const steady = (): StartSitInput => ({ player: player({ id: 'slot', fullName: 'Slot Guy', position: 'WR', team: 'NE' }), props: SLOT, signal: null });
  const deep = (): StartSitInput => ({
    player: player({ id: 'deep', fullName: 'Deep Guy', position: 'WR', team: 'BUF' }),
    props: [prop('receiving_yards', 63.5), prop('receptions', 4.5), prop('anytime_td', null, 0.27)],
    signal: null,
  });

  it('sets the scene: the steady one is ahead, inside the band', () => {
    const a = evaluatePlayer(steady(), LEAGUE);
    const b = evaluatePlayer(deep(), LEAGUE);
    expect(a.pill?.pill).toBe('steady');
    expect(b.pill?.pill).toBe('explosive');
    expect(a.score! - b.score!).toBeGreaterThan(0);
    expect(a.score! - b.score!).toBeLessThanOrEqual(PILL_TIEBREAK_BAND);
  });

  it('gives the underdog the higher ceiling, and says so', () => {
    const out = compareStartSit([steady(), deep()], LEAGUE, { posture: 'underdog' });
    expect(out.recommendedPlayerId).toBe('deep');
    expect(out.tiebreak?.sentence).toBe(tiebreakSentence('underdog'));
    expect(out.reasons[0]).toBe(tiebreakSentence('underdog'));
  });

  it('leaves the favourite on the numbers, which already agree with Steady', () => {
    const out = compareStartSit([steady(), deep()], LEAGUE, { posture: 'favourite' });
    expect(out.recommendedPlayerId).toBe('slot');
    expect(out.tiebreak).toBeUndefined();
  });

  it('makes the same call in the lineup, and names it as a tie-break swap', () => {
    const shape = buildRosterShape(['WR', 'BN']);
    const out = recommendLineup([steady(), deep()], shape, LEAGUE, { currentStarterIds: ['slot'], posture: 'underdog' });
    expect(out.slots[0]!.playerId).toBe('deep');
    const swap = out.swaps[0]!;
    expect(swap.inPlayerId).toBe('deep');
    expect(swap.tiebreak?.pill).toBe('explosive');
    expect(swap.gain).toBeLessThan(0);
    expect(swap.reason).toBe(tiebreakSentence('underdog'));

    const none = recommendLineup([steady(), deep()], shape, LEAGUE, { currentStarterIds: ['slot'] });
    expect(none.slots[0]!.playerId).toBe('slot');
    expect(none.swaps).toEqual([]);
  });
});
