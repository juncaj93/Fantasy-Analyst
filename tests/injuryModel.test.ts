/**
 * One interpretation of "can he play", shared by every screen.
 *
 * Before this each surface read the raw strings for itself, which is how a
 * player ends up Questionable on the draft board and fine in Start/Sit. These
 * are the rules that stop that: what the words mean, which source wins, what
 * counts as a disagreement, and — the one this project cares about most — the
 * difference between "he is healthy" and "nobody has said".
 */

import { describe, expect, it } from 'vitest';
import {
  DESIGNATION_SEVERITY,
  confidenceOf,
  freshnessOf,
  injuryLine,
  isRuledOut,
  normalizeDesignation,
  normalizePractice,
  practiceTrend,
  provenanceLine,
  resolveInjury,
  type InjuryObservation,
} from '../src/core/injury/model.ts';

const NOW = new Date('2026-11-15T16:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('normalizing what a source called it', () => {
  it('reads the designations both sources publish', () => {
    for (const [raw, expected] of [
      ['Questionable', 'questionable'],
      ['QUESTIONABLE', 'questionable'],
      ['Doubtful', 'doubtful'],
      ['Out', 'out'],
      ['IR', 'ir'],
      ['Injured Reserve', 'ir'],
      ['PUP', 'pup'],
      ['Suspended', 'suspended'],
    ] as const) {
      expect(normalizeDesignation(raw).designation, raw).toBe(expected);
    }
  });

  /**
   * The distinction the rest of this file depends on. A source that looked and
   * found nothing wrong is evidence; a field nobody filled in is not.
   */
  it('separates "no designation" from "nobody said"', () => {
    expect(normalizeDesignation('Active').designation).toBe('healthy');
    expect(normalizeDesignation(null).designation).toBe('unknown');
    expect(normalizeDesignation('').designation).toBe('unknown');
  });

  it('refuses to invent a severity for a string it does not know', () => {
    expect(normalizeDesignation('DNR').designation).toBe('unknown');
    expect(normalizeDesignation('COV').designation).toBe('unknown');
    // …and keeps what was actually said, so a surprise can be traced.
    expect(normalizeDesignation('DNR').raw).toBe('DNR');
  });

  it('knows which designations mean he is not playing', () => {
    expect(isRuledOut('out')).toBe(true);
    expect(isRuledOut('ir')).toBe(true);
    expect(isRuledOut('suspended')).toBe(true);
    expect(isRuledOut('doubtful')).toBe(false);
    expect(isRuledOut('questionable')).toBe(false);
  });

  it('orders severity the way a lineup decision does', () => {
    expect(DESIGNATION_SEVERITY.questionable).toBeLessThan(DESIGNATION_SEVERITY.doubtful);
    expect(DESIGNATION_SEVERITY.doubtful).toBeLessThan(DESIGNATION_SEVERITY.out);
    expect(DESIGNATION_SEVERITY.healthy).toBe(DESIGNATION_SEVERITY.unknown);
  });
});

describe('practice participation', () => {
  it('reads the three states, however the source spells them', () => {
    expect(normalizePractice('Did Not Participate In Practice')).toBe('dnp');
    expect(normalizePractice('Limited Participation in Practice')).toBe('limited');
    expect(normalizePractice('Full Participation in Practice')).toBe('full');
    expect(normalizePractice('DNP')).toBe('dnp');
    expect(normalizePractice('')).toBe('unknown');
    expect(normalizePractice(null)).toBe('unknown');
  });

  it('calls an improving run improving, and names it', () => {
    const reading = practiceTrend(['dnp', 'limited', 'full']);
    expect(reading.trend).toBe('improving');
    expect(reading.latest).toBe('full');
    expect(reading.label).toBe('DNP → limited → full');
  });

  it('calls a deteriorating run worsening', () => {
    expect(practiceTrend(['full', 'limited', 'dnp']).trend).toBe('worsening');
  });

  it('separates a full participant from a limited one', () => {
    expect(practiceTrend(['full', 'full']).trend).toBe('full_participant');
    expect(practiceTrend(['limited', 'limited']).trend).toBe('stable_limited');
    expect(practiceTrend(['dnp', 'dnp']).trend).toBe('not_practising');
  });

  /** One reading is a state. Calling it a direction would be inventing one. */
  it('does not read a trend into a single report', () => {
    const one = practiceTrend(['limited']);
    expect(one.trend).toBe('stable_limited');
    expect(one.label).toBe('limited in practice');
  });

  it('says nothing when nothing was reported', () => {
    expect(practiceTrend([]).trend).toBe('unknown');
    expect(practiceTrend([null, undefined, 'unknown']).label).toBeNull();
  });
});

describe('freshness', () => {
  it('is fresh inside a day, recent inside the week, then stale', () => {
    expect(freshnessOf(hoursAgo(2), NOW)).toBe('fresh');
    expect(freshnessOf(hoursAgo(29), NOW)).toBe('fresh');
    expect(freshnessOf(hoursAgo(48), NOW)).toBe('recent');
    expect(freshnessOf(hoursAgo(200), NOW)).toBe('stale');
  });

  it('is unknown rather than fresh when there is no timestamp', () => {
    expect(freshnessOf(null, NOW)).toBe('unknown');
    expect(freshnessOf('not a date', NOW)).toBe('unknown');
  });

  /** A clock disagreement should not read as prophecy. */
  it('does not treat the future as current', () => {
    expect(freshnessOf(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe('unknown');
  });
});

describe('resolving several sources into one state', () => {
  const sleeper = (designation: string, at: string | null = hoursAgo(3)): InjuryObservation => ({
    source: 'sleeper',
    ...normalizeDesignation(designation),
    observedAt: at,
  });
  const report = (
    designation: string | null,
    extra: Partial<InjuryObservation> = {},
    at: string | null = hoursAgo(20),
  ): InjuryObservation => ({
    source: 'nflverse',
    ...normalizeDesignation(designation),
    observedAt: at,
    ...extra,
  });

  it('says nothing at all when nobody said anything', () => {
    const state = resolveInjury([], NOW);
    expect(state.designation).toBe('unknown');
    expect(state.confidence).toBe('unknown');
    expect(injuryLine(state)).toBeNull();
  });

  /**
   * Sleeper is the league host: it is what governs the user's own lineup, and a
   * Friday practice report is better at describing the week than Sunday.
   */
  it('takes the designation from Sleeper when both have one', () => {
    const state = resolveInjury([report('Questionable'), sleeper('Out')], NOW);
    expect(state.designation).toBe('out');
    expect(state.designationSource).toBe('sleeper');
  });

  /** …and the body part from whoever publishes one, which is only the report. */
  it('takes the body part and the practice week from the report', () => {
    const state = resolveInjury(
      [sleeper('Questionable'), report('Questionable', { bodyPart: 'Hamstring', practice: ['limited', 'full'] })],
      NOW,
    );
    expect(state.bodyPart).toBe('Hamstring');
    expect(state.bodyPartSource).toBe('nflverse');
    expect(state.practice.trend).toBe('improving');
    expect(injuryLine(state)).toBe('Q · hamstring · limited → full');
  });

  it('falls back to the report alone when Sleeper says nothing', () => {
    const state = resolveInjury([report('Doubtful', { bodyPart: 'Ankle' })], NOW);
    expect(state.designation).toBe('doubtful');
    expect(state.designationSource).toBe('nflverse');
  });

  /**
   * The case the brief singles out. Sleeper saying Questionable while the
   * report says he practised fully is not a contradiction — it is the most
   * useful thing either of them said.
   */
  it('does not call practice participation a conflict', () => {
    const state = resolveInjury(
      [sleeper('Questionable'), report('Questionable', { practice: ['full', 'full'] })],
      NOW,
    );
    expect(state.conflict).toBe(false);
    expect(state.confidence).toBe('high');
    expect(injuryLine(state)).toBe('Q · practised fully');
  });

  it('flags two sources that disagree about severity, and says who said what', () => {
    const state = resolveInjury([sleeper('Out'), report('Questionable')], NOW);
    expect(state.conflict).toBe(true);
    expect(state.conflictNote).toContain('sleeper: Out');
    expect(state.conflictNote).toContain('nflverse: Questionable');
    // Surfaced, never averaged into something in between.
    expect(state.designation).toBe('out');
    expect(state.confidence).toBe('low');
  });

  /**
   * Freshness follows the designation, not the newest thing in the pile. A
   * current practice note does not make a week-old designation current.
   */
  it('measures freshness against the observation the designation came from', () => {
    const state = resolveInjury(
      [sleeper('Questionable', hoursAgo(300)), report(null, { practice: ['full'] }, hoursAgo(1))],
      NOW,
    );
    expect(state.freshness).toBe('stale');
    expect(state.confidence).toBe('low');
  });

  it('keeps every observation, newest and oldest alike', () => {
    const state = resolveInjury([sleeper('Questionable'), report('Questionable', { bodyPart: 'Knee' })], NOW);
    expect(state.observations).toHaveLength(2);
    expect(state.observations.map((o) => o.source)).toEqual(['sleeper', 'nflverse']);
  });
});

describe('confidence', () => {
  it('is high only when a fresh designation is corroborated', () => {
    expect(confidenceOf({ freshness: 'fresh', conflict: false, corroborated: true, designation: 'questionable' })).toBe(
      'high',
    );
    expect(confidenceOf({ freshness: 'fresh', conflict: false, corroborated: false, designation: 'questionable' })).toBe(
      'moderate',
    );
  });

  it('drops to low on a conflict or on stale data', () => {
    expect(confidenceOf({ freshness: 'fresh', conflict: true, corroborated: true, designation: 'out' })).toBe('low');
    expect(confidenceOf({ freshness: 'stale', conflict: false, corroborated: true, designation: 'out' })).toBe('low');
  });

  it('is unknown when there is no designation to be confident about', () => {
    expect(confidenceOf({ freshness: 'fresh', conflict: false, corroborated: true, designation: 'unknown' })).toBe(
      'unknown',
    );
  });
});

describe('what a card prints', () => {
  it('says nothing about a healthy player', () => {
    const state = resolveInjury([{ source: 'sleeper', designation: 'healthy', raw: 'Active', observedAt: null }], NOW);
    expect(injuryLine(state)).toBeNull();
  });

  it('names the source and the age, so freshness can be judged', () => {
    const state = resolveInjury(
      [
        { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: hoursAgo(2) },
        { source: 'nflverse', designation: 'questionable', raw: 'Questionable', observedAt: hoursAgo(20), practice: ['limited'] },
      ],
      NOW,
    );
    expect(provenanceLine(state)).toBe('sleeper status · practice via nflverse · current');
  });

  it('admits when what it is showing is out of date', () => {
    const state = resolveInjury(
      [{ source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: hoursAgo(400) }],
      NOW,
    );
    expect(provenanceLine(state)).toContain('out of date');
  });
});
