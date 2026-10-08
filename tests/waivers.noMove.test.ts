/**
 * What Waivers and Team say when there is no move, and why an unscored row has
 * no number.
 *
 * October 2026 audit, the live week-5 board: `Recommended move` drew a heading
 * over nothing, a note said every option below "beats someone on your bench on
 * paper" above three rows that were not scored at all, and `Proj. Not scored`
 * never said why. The fix is data first (the engine reports the closest near
 * miss and a reason per unscored player) and then wording, both tested here.
 * Nothing here may move a bar, a gain or a claim, and one test holds that.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendWaiverUpgrades } from '../src/core/startsit/waivers.ts';
import { buildWaiverBoard, unscoredSentence } from '../src/core/waivers/board.ts';
import { nearestLine, noMoveSummary, unscoredNotes } from '../src/core/waivers/noMove.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';
import { signalWithNet } from './helpers/startsit.ts';

/** This league: half PPR, six-point passing touchdowns, minus two per interception. */
const PROFILE = buildScoringProfile(
  { rec: 0.5, pass_td: 6, pass_int: -2, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6, fum_lost: -2 },
  [],
);
const SHAPE = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

/** A news tally on everybody, as on a real roster, so every player is scorable and only the yardstick decides. */
function input(id: string, position: string, team = 'NE', props: PlayerProp[] = []): StartSitInput {
  return { player: player({ id, fullName: id, position, team }), props, signal: signalWithNet(1), injuryStatus: null, propsStale: false };
}

const ROSTER = [input('qb1', 'QB'), input('rb1', 'RB'), input('wr1', 'WR'), input('te1', 'TE'), input('rb2', 'RB'), input('rb3', 'RB'), input('wr3', 'WR')];
const STARTERS = ['qb1', 'rb1', 'wr1', 'te1', 'rb2'];
const PUBLISHED = new Map<string, number>([
  ['qb1', 20], ['rb1', 12], ['wr1', 12], ['te1', 9], ['rb2', 10], ['rb3', 5], ['wr3', 6],
  ['fa1', 5.4],
]);
const partial: PlayerProp = {
  playerId: 'fa4', sourcePlayerName: 'fa4', market: 'receptions', line: 3.5, overPrice: -110, underPrice: -110,
  bookCount: 1, consensusMethod: 'single', books: ['a'], impliedProbability: null,
};
const CANDIDATES = [
  input('fa1', 'WR'),
  input('fa2', 'QB', 'HOU'),
  input('fa3', 'RB', ''),
  input('fa4', 'WR', 'NE', [partial]),
  input('fa5', 'TE'),
];

function advise() {
  return recommendWaiverUpgrades({
    roster: ROSTER,
    candidates: CANDIDATES,
    shape: SHAPE,
    profile: PROFILE,
    rosteredPlayerIds: ROSTER.map((i) => i.player.id),
    currentStarterIds: STARTERS,
    published: PUBLISHED,
    openSpots: 0,
    refusedPositions: ['QB'],
    now: new Date('2026-10-07T18:00:00Z'),
  });
}

describe('the engine reports the closest call and why the rest were unread', () => {
  it('names the free agent who came closest without clearing the bar', () => {
    const advice = advise();
    expect(advice.valueAdds).toHaveLength(0);
    expect(advice.upgrades).toHaveLength(0);
    expect(advice.nearestMiss).toMatchObject({ name: 'fa1', overName: 'rb3', kind: 'bench', basis: 'sleeper' });
    expect(advice.nearestMiss!.gap).toBeCloseTo(0.4, 5);
    expect(advice.nearestMiss!.bar).toBe(1);
  });

  it('says why each unread free agent had nothing to read', () => {
    const why = new Map(advise().unknowns.map((u) => [u.playerId, u.why]));
    expect(why.get('fa2')).toBe('scoring');
    expect(why.get('fa3')).toBe('no_team');
    expect(why.get('fa4')).toBe('partial_market');
    expect(why.get('fa5')).toBe('no_data');
  });

  it('moves no bar and admits nobody: a clearing free agent still clears, and is not a near miss', () => {
    const published = new Map(PUBLISHED).set('fa1', 6.2);
    const advice = recommendWaiverUpgrades({
      roster: ROSTER,
      candidates: CANDIDATES,
      shape: SHAPE,
      profile: PROFILE,
      rosteredPlayerIds: ROSTER.map((i) => i.player.id),
      currentStarterIds: STARTERS,
      published,
      openSpots: 0,
      now: new Date('2026-10-07T18:00:00Z'),
    });
    expect(advice.valueAdds.map((a) => a.playerId)).toEqual(['fa1']);
    expect(advice.nearestMiss?.playerId).not.toBe('fa1');
  });
});

describe('the words', () => {
  it('says the decision, how much was compared, and who came closest', () => {
    const advice = advise();
    const summary = noMoveSummary(advice);
    expect(summary.headline).toBe('No move this week');
    expect(summary.detail).toMatch(/^None of the \d+ free agents? this app could compare beats your roster/);
    expect(summary.nearest).toBe('Closest: fa1, 0.4 pts more than rb3 on your bench, on Sleeper’s projection. Replacing a bench player needs 1.0 on Sleeper’s projection, 0.5 on betting lines.');
  });

  it('says so when nothing could be compared at all', () => {
    expect(noMoveSummary({ considered: 12, skipped: 12 }).detail).toBe(
      'No free agent has a betting line or a projection to compare yet.',
    );
    expect(noMoveSummary({}).detail).toBeNull();
  });

  it('prints a near miss only when it is one', () => {
    const base = { playerId: 'x', name: 'X', position: 'WR', overName: 'Y', slot: null, basis: 'market' as const };
    expect(nearestLine({ ...base, kind: 'bench', gap: 0, bar: 0.5 })).toBeNull();
    expect(nearestLine({ ...base, kind: 'bench', gap: 0.6, bar: 0.5 })).toBeNull();
    expect(nearestLine({ ...base, kind: 'starter', slot: 'FLEX', gap: 1.2, bar: 2.5 })).toBe(
      'Closest: X, 1.2 pts more than Y at FLEX, on betting lines. Replacing a starter needs 3.0 on Sleeper’s projection, 2.5 on betting lines.',
    );
    expect(nearestLine(null)).toBeNull();
  });

  it('groups unscored rows by reason, in a fixed order, with the right pronoun', () => {
    const notes = unscoredNotes([
      { name: 'Aaron Rodgers', position: 'QB', unscored: 'scoring' },
      { name: 'C.J. Stroud', position: 'QB', unscored: 'scoring' },
      { name: 'Joe Mixon', position: 'RB', unscored: 'no_team' },
    ]);
    expect(notes).toEqual([
      'Aaron Rodgers and C.J. Stroud: Sleeper’s quarterback projection assumes different passing scoring from this league’s, so it is not used, and no full betting line is posted for them yet.',
      'Joe Mixon: not on an NFL team, so there is no game to project.',
    ]);
    expect(unscoredNotes([{ name: 'Old Row', position: 'WR', unscored: null }])).toEqual(['Old Row: no betting line and no projection yet.']);
  });

  it('carries the reason onto the board row and its detail sentence', () => {
    const board = buildWaiverBoard({
      upgrades: [],
      unknowns: [{ playerId: 'fa2', name: 'fa2', position: 'QB', team: 'HOU', leagueRank: 18, why: 'scoring' }],
    });
    const row = board.rows.find((r) => r.playerId === 'fa2')!;
    expect(row.unscored).toBe('scoring');
    expect(row.reasons).toContain(unscoredSentence('scoring'));
    expect(row.shortTerm.label).toBe('Not scored');
  });
});
