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

/* ------------------------------------------------------- waiting on lines */

import { waitsOnLine } from '../src/core/startsit/tossup.ts';
import { NO_LINE_YET, noLineYet, rowNote, rowFigure } from '../src/web/rowFigure.ts';

describe('waiting on lines', () => {
  it('the McConkey toss-up is waiting on a line: the gap clears 2.0, only the missing line holds it back', () => {
    expect(waitsOnLine({ points: 11.3, borrowed: true }, { points: 7.3 })).toBe(true);
    /* A plain 1.5 toss-up between priced players is not waiting on anything. */
    expect(waitsOnLine({ points: 11.5 }, { points: 10 })).toBe(false);
    /* An unpriced 1.5 lead is a toss-up anyway: the line is not the only reason. */
    expect(waitsOnLine({ points: 12.5, borrowed: true }, { points: 10 })).toBe(false);
  });

  it('Team and Compare both mark Alex’s FLEX call as waiting on a line', () => {
    const { cooper, ladd, published } = mcconkeyVsCooper(3.0);
    const r = recommendLineup([cooper, ladd], FLEX, PROFILE, { currentStarterIds: ['cooper'], published });
    expect(r.tossUps?.[0]?.waitingOnLine).toBe(true);
    const c = compareStartSit([ladd, cooper], PROFILE, { published });
    expect(c.tossUp?.waitingOnLine).toBe(true);
  });

  it('a row on Sleeper’s week says "No line yet" before kickoff, and nothing once his game starts', () => {
    const before = { decision: { basis: 'published' }, lock: { locked: false, kickoff: '2026-11-15T21:25:00Z' } };
    const now = Date.parse('2026-11-12T15:00:00Z');
    expect(NO_LINE_YET).toBe('No line yet');
    expect(noLineYet(before, now)).toBe(true);
    expect(rowNote(rowFigure(10.3, before), before, now)).toBe('No line yet');
    expect(noLineYet({ ...before, lock: { locked: true, kickoff: before.lock.kickoff } }, now)).toBe(false);
    /* A priced number says nothing. */
    expect(rowNote(rowFigure(7.3, { decision: { basis: 'market' } }), { decision: { basis: 'market' } }, now)).toBeNull();
  });
});

/* ------------------------------------------------------------ dash cells */

describe('a dash always says why', () => {
  it('Bye only from the fixture list; a missing number is "No projection"', () => {
    expect(rowNote(rowFigure(null, { onBye: true }), { onBye: true })).toBe('Bye');
    expect(rowNote(rowFigure(null, { onReserve: true }), { onReserve: true })).toBe('On IR');
    expect(rowNote(rowFigure(null, { decision: { basis: 'unpriced' } }), { decision: { basis: 'unpriced' } })).toBe('No projection');
    expect(rowNote(rowFigure(null, null), null)).toBe('No projection');
  });

  it('the evaluation carries the schedule’s bye, and only the schedule’s', async () => {
    const { evaluatePlayer } = await import('../src/core/startsit/engine.ts');
    const resting = { ...candidate('kw', 'Kenneth Walker III', 'RB', null), onBye: true };
    expect(evaluatePlayer(resting, PROFILE).onBye).toBe(true);
    /* No number at all, but his club plays: not a bye. */
    expect(evaluatePlayer(candidate('jc', 'Jonah Coleman', 'RB', null), PROFILE).onBye).toBeUndefined();
  });
});

/* -------------------------------------------------------------- bye rule */

import { byeReader } from '../src/core/nfl/schedule.ts';
import { readFileSync } from 'node:fs';

describe('bye comes from the real schedule only', () => {
  const row = (team: string, week: number, opponent: string | null) =>
    ({ season: '2026', week, team, opponent, home: true, kickoff: null, roof: null }) as never;

  it('a club with games in other weeks and none this week is on a bye', () => {
    const bye = byeReader([row('KC', 10, 'DEN'), row('KC', 12, 'LV'), row('DEN', 11, 'LV')]);
    expect(bye('KC', 11)).toBe(true);
    expect(bye('KC', 10)).toBe(false);
  });

  it('a club the list never mentions is unknown, never a bye (Waivers reads only some clubs)', () => {
    const bye = byeReader([row('DEN', 11, 'LV'), row('LV', 11, 'DEN')]);
    expect(bye('LAC', 11)).toBeNull();
  });

  it('a week nobody has a row in is unknown, never a bye', () => {
    const bye = byeReader([row('KC', 10, 'DEN')]);
    expect(bye('KC', 11)).toBeNull();
  });

  it('the Rams are one club under LA and LAR', () => {
    const bye = byeReader([row('LA', 11, 'SEA'), row('LA', 10, 'SF')]);
    expect(bye('LAR', 11)).toBe(false);
  });

  it('Waivers no longer decides a bye from a bare team set (the old code did, twice)', () => {
    const src = readFileSync(new URL('../src/core/waivers/assemble.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/!playing\.has\(/);
    expect(src).not.toMatch(/!set\.has\(team/);
    expect(src).toMatch(/byeReader\(fixtures\)/);
    const dst = readFileSync(new URL('../src/core/dst/assemble.ts', import.meta.url), 'utf8');
    expect(dst).not.toMatch(/thisWeekFixtures\.length > 0/);
  });
});

/* -------------------------------------------------------- plain English */

import { assessReplacement } from '../src/core/startsit/replacement.ts';
import { assessLateSwap } from '../src/core/startsit/decisions.ts';

const JARGON = /\b(lock|locks|locked|committed|slot logic|resolver|cascade|status is known|late-swap)\b/i;
const words = (s: string) => s.trim().split(/\s+/).length;

describe('plain English on Team, Matchup and Compare', () => {
  const SUN_1 = '2026-11-15T18:00:00Z';
  const SUN_4 = '2026-11-15T21:25:00Z';
  const NOW = '2026-11-12T15:00:00Z';

  it('McConkey’s note says what to do and what to watch, in 12 words or fewer', () => {
    const r = assessReplacement({
      player: { name: 'Ladd McConkey', kickoff: SUN_4, score: 10.3, availability: 'uncertain' },
      alternatives: [{ playerId: 'kw', name: 'Kenneth Walker III', kickoff: SUN_1, score: 9 }],
      now: NOW,
    });
    expect(r.display).toBe('Walker plays first. Decide before then; his news may come later.');
    expect(r.driver).toBe('Risky · Walker is his only cover and plays first');
    for (const s of [r.display, r.driver!]) {
      expect(s).not.toMatch(JARGON);
      expect(words(s)).toBeLessThanOrEqual(12);
    }
  });

  it('every note the cover check and the timing check can print is plain and short', () => {
    const outputs: string[] = [];
    for (const availability of ['uncertain', 'doubtful_like'] as never[]) {
      for (const alternatives of [
        [],
        [{ playerId: 'a', name: 'Kenneth Walker III', kickoff: SUN_4, score: 9 }],
        [{ playerId: 'a', name: 'Kenneth Walker III', kickoff: SUN_1, score: 9 }],
        [{ playerId: 'a', name: 'Kenneth Walker III', kickoff: null, score: 9 }],
      ]) {
        const r = assessReplacement({ player: { name: 'Ladd McConkey', kickoff: SUN_4, score: 10.3, availability }, alternatives, now: NOW });
        if (r.display) outputs.push(r.display);
        if (r.driver) outputs.push(r.driver);
      }
    }
    for (const [pScore, aScore, aKick, now] of [
      [11.8, 11.1, SUN_1, NOW],
      [18, 11.1, SUN_1, NOW],
      [12, 11, SUN_4, NOW],
      [11.8, 11.1, SUN_1, '2026-11-15T19:00:00Z'],
      [null, null, SUN_1, NOW],
    ] as const) {
      const r = assessLateSwap(
        {
          preferred: { name: 'Ladd McConkey', kickoff: SUN_4, status: 'Questionable', score: pScore },
          alternative: { name: 'Kenneth Walker III', kickoff: aKick, status: null, score: aScore },
        },
        now,
      );
      outputs.push(r.detail, r.label);
    }
    expect(outputs.length).toBeGreaterThan(8);
    for (const s of outputs) {
      expect(s, s).not.toMatch(JARGON);
      expect(s, s).not.toMatch(/—/);
      expect(words(s), s).toBeLessThanOrEqual(12);
    }
  });

  it('the Team row tag and the no-change line are plain', () => {
    const team = readFileSync(new URL('../src/web/screens/TeamScreen.tsx', import.meta.url), 'utf8');
    expect(team).toContain("'Keep your lineup as is'");
    expect(team).not.toContain('No swap clears the bar');
    expect(team).not.toMatch(/>\s*Locked\s*</);
  });
});

import { benchSummary } from '../src/web/benchSummary.ts';

describe('Round 18 small words', () => {
  it('an IR or Out row with no evaluation still says why, from the roster status', () => {
    expect(rowNote(rowFigure(null, null), null, Date.now(), 'IR')).toBe('On IR');
    expect(rowNote(rowFigure(null, null), null, Date.now(), 'Out')).toBe('Out');
  });

  it('the folded bench says "No line yet" when Best move does', () => {
    expect(benchSummary({ found: true, swaps: [], fills: [], tossUps: [{ waitingOnLine: true }] })).toBe('No line yet');
    expect(benchSummary({ found: true, swaps: [], fills: [], tossUps: [{}] })).toBe('Toss-up');
  });
});
