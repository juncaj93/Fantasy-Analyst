/**
 * Round 18 (11 November 2026): trust the pick.
 *
 * A pick that rests on a number with no Vegas line needs a 3.5-point lead,
 * not 2.0 (`UNPRICED_TOSSUP_POINTS` in `startsit/tossup.ts`, measured in
 * `docs/backtest/ROUND18_UNPRICED.md`). Alex's real case on Wednesday
 * 11 November: Team said "Start Ladd McConkey over Omar Cooper Jr. at FLEX,
 * 10.3 vs 7.3". McConkey had no lines and was Questionable (Sleeper's number
 * minus 1); Cooper's 7.3 came from Vegas. On the old code that was a firm
 * Best move; now it is a toss-up, on Team and Compare alike.
 */
import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { TOSSUP_POINTS, UNPRICED_TOSSUP_POINTS, isTossUp } from '../src/core/startsit/tossup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const FLEX = buildRosterShape(['FLEX', 'BN', 'BN']);

const pointsOf = (r: ReturnType<typeof recommendLineup>, id: string) =>
  [...r.starters, ...r.bench].find((e) => e.playerId === id)!.decision!;

/** Cooper priced at 7.3; McConkey Sleeper-only and Questionable, his number set so he ranks 3.0 higher. */
function mcconkeyVsCooper(rankedLead = 3.0) {
  const cooper = pricedCandidate('cooper', 'Omar Cooper Jr.', 'WR', 7.3);
  const alone = recommendLineup([cooper], FLEX, PROFILE, { currentStarterIds: ['cooper'] });
  const cooperPoints = pointsOf(alone, 'cooper').points;
  /* Sleeper's number for McConkey: his ranking number (minus 1) leads Cooper by `rankedLead`. */
  const published = new Map([['ladd', cooperPoints + rankedLead + 1]]);
  const ladd = candidate('ladd', 'Ladd McConkey', 'WR', 3, { status: 'Questionable', team: 'LAC' });
  return { cooper, ladd, published, cooperPoints };
}

describe('the measured bar', () => {
  it('is wider than 2.0 for an unpriced number, one shared constant', () => {
    expect(TOSSUP_POINTS).toBe(2);
    expect(UNPRICED_TOSSUP_POINTS).toBe(3.5);
  });

  it('McConkey 10.3 (unpriced, minus 1 already in) over Cooper 7.3 (priced) is a toss-up', () => {
    /* 11.3 is Sleeper's number; ranked it is 10.3. The old bar (2.0) made this a firm pick. */
    expect(isTossUp({ points: 11.3, borrowed: true }, { points: 7.3 })).toBe(true);
  });
});

describe('Team: Best move on Alex’s real FLEX call', () => {
  it('a 3.0 unpriced lead is a toss-up, the lineup keeps Cooper', () => {
    const { cooper, ladd, published } = mcconkeyVsCooper(3.0);
    const r = recommendLineup([cooper, ladd], FLEX, PROFILE, { currentStarterIds: ['cooper'], published });
    expect(r.swaps).toEqual([]);
    expect(r.tossUps?.map((t) => [t.inPlayerId, t.outPlayerId, t.reason])).toEqual([['ladd', 'cooper', 'Toss-up']]);
  });

  it('a 4.0 unpriced lead is still a firm pick', () => {
    const { cooper, ladd, published } = mcconkeyVsCooper(4.0);
    const r = recommendLineup([cooper, ladd], FLEX, PROFILE, { currentStarterIds: ['cooper'], published });
    expect(r.swaps.map((s) => [s.inPlayerId, s.outPlayerId])).toEqual([['ladd', 'cooper']]);
  });

  it('a real hole still wins: Cooper Out, McConkey starts whatever the gap', () => {
    const cooper = pricedCandidate('cooper', 'Omar Cooper Jr.', 'WR', 7.3, { status: 'Out' });
    const ladd = candidate('ladd', 'Ladd McConkey', 'WR', 3, { status: 'Questionable', team: 'LAC' });
    const r = recommendLineup([cooper, ladd], FLEX, PROFILE, { currentStarterIds: ['cooper'], published: new Map([['ladd', 5]]) });
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['ladd']);
    expect(r.tossUps).toEqual([]);
  });
});

describe('Compare agrees with Team', () => {
  it('McConkey over Cooper by 3.0 ranked: no Start, a lean', () => {
    const { cooper, ladd, published } = mcconkeyVsCooper(3.0);
    const c = compareStartSit([ladd, cooper], PROFILE, { published });
    expect(c.recommendedPlayerId).toBeNull();
    expect(c.tossUp?.leanPlayerId).toBe('ladd');
  });

  it('a priced 2.5 lead over an unpriced player is still a Start (the 2.0 bar)', () => {
    const { cooper, ladd } = mcconkeyVsCooper();
    const c = compareStartSit([pricedCandidate('cooper', 'Omar Cooper Jr.', 'WR', 9.8), ladd], PROFILE, {
      published: new Map([['ladd', 8.3]]),
    });
    void cooper;
    expect(c.recommendedPlayerId).toBe('cooper');
    expect(c.tossUp ?? null).toBeNull();
  });
});
