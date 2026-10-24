/**
 * What an injury is worth, in the two places that answer it differently.
 *
 * Start/Sit asks whether he can play on Sunday. Trades ask whether he is worth
 * what he costs for the rest of the season. Collapsing those into one number is
 * how a one-week hamstring becomes a sell recommendation, and keeping them
 * apart is most of what these tests are defending.
 */

import { describe, expect, it } from 'vitest';
import { AVAILABILITY, availabilityPenalty } from '../src/core/injury/startsit.ts';
import { TRADE_INJURY, tradeInjuryContext } from '../src/core/injury/trades.ts';
import { NO_INJURY_INFORMATION, resolveInjury, type InjuryObservation, type InjuryState } from '../src/core/injury/model.ts';

const NOW = new Date('2026-11-15T16:00:00Z');
const recently = new Date(NOW.getTime() - 4 * 3_600_000).toISOString();
const longAgo = new Date(NOW.getTime() - 400 * 3_600_000).toISOString();

function state(
  designation: InjuryObservation['designation'],
  extra: Partial<InjuryObservation> = {},
  second?: Partial<InjuryObservation>,
): InjuryState {
  const observations: InjuryObservation[] = [
    { source: 'sleeper', designation, raw: designation, observedAt: recently, ...extra },
  ];
  if (second) {
    observations.push({
      source: 'nflverse',
      designation,
      raw: designation,
      observedAt: recently,
      ...second,
    });
  }
  return resolveInjury(observations, NOW);
}

describe('availability, for a lineup', () => {
  it('costs nothing at all when there is no designation', () => {
    expect(availabilityPenalty(NO_INJURY_INFORMATION).points).toBe(0);
    expect(availabilityPenalty(state('healthy')).points).toBe(0);
    expect(availabilityPenalty(state('healthy')).gate).toBe(false);
  });

  /** Out is a fact, not a risk, and no amount of upside outweighs a fact. */
  it('gates a player who is ruled out', () => {
    for (const designation of ['out', 'ir', 'pup', 'suspended'] as const) {
      const assessment = availabilityPenalty(state(designation));
      expect(assessment.gate, designation).toBe(true);
      expect(assessment.points, designation).toBe(AVAILABILITY.ruledOut);
      expect(assessment.note, designation).toContain('not a playable starter');
    }
  });

  it('penalises Doubtful heavily without gating it', () => {
    const assessment = availabilityPenalty(state('doubtful'));
    expect(assessment.points).toBe(AVAILABILITY.doubtful);
    expect(assessment.gate).toBe(false);
    expect(assessment.points).toBeLessThan(AVAILABILITY.questionable);
    expect(AVAILABILITY.questionable).toBe(0);
  });

  /**
   * Questionable is shown, not scored (owner's call, 13 October 2026). It used
   * to cost 0.5 to 2.7 points by practice week; now it costs nothing, and the
   * Compare card and Best move carry it as a warning. The practice week still
   * decides what the note says.
   */
  describe('Questionable, which is a warning', () => {
    it('costs nothing, whatever the practice week', () => {
      for (const practice of [[], ['full', 'full'], ['dnp', 'dnp'], ['dnp', 'limited'], ['limited', 'dnp']] as const) {
        const assessment = availabilityPenalty(state('questionable', {}, { practice: [...practice] }));
        expect(assessment.points, practice.join(',')).toBe(0);
        expect(assessment.gate).toBe(false);
        expect(assessment.display).toMatch(/^Questionable/);
      }
    });

    it('still says what the practice week said', () => {
      expect(availabilityPenalty(state('questionable', {}, { practice: ['full', 'full'] })).note).toContain('practiced fully');
      expect(availabilityPenalty(state('questionable', {}, { practice: ['dnp', 'dnp'] })).note).toContain('has not practiced');
    });

    it('says when the report is out of date', () => {
      const stale = resolveInjury(
        [
          { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: longAgo },
          { source: 'nflverse', designation: 'questionable', raw: 'Questionable', observedAt: longAgo, practice: ['full', 'full'] },
        ],
        NOW,
      );
      expect(availabilityPenalty(stale).points).toBe(0);
      expect(availabilityPenalty(stale).note).toContain('out of date');
    });

    it('says so when the sources disagree, rather than picking a side quietly', () => {
      // A three-day-old Out against a current Questionable: the newer word stands, and the note says they disagree.
      const conflicted = resolveInjury(
        [
          { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: recently },
          { source: 'nflverse', designation: 'out', raw: 'Out', observedAt: new Date(NOW.getTime() - 72 * 3_600_000).toISOString() },
        ],
        NOW,
      );
      expect(availabilityPenalty(conflicted).note).toContain('disagree');
    });

    it('names the body part when the report has one', () => {
      const assessment = availabilityPenalty(state('questionable', {}, { bodyPart: 'Hamstring', practice: ['full'] }));
      expect(assessment.display).toContain('hamstring');
    });
  });
});

describe('availability, for a trade', () => {
  /* §25 — the overreaction the brief specifically rules out. */
  it('barely touches a player who is Questionable for one week', () => {
    const context = tradeInjuryContext(state('questionable', {}, { bodyPart: 'Hamstring' }));
    expect(context.category).toBe('temporary');
    expect(Math.abs(context.urgencyDelta)).toBeLessThanOrEqual(0.25);
    expect(context.line).toContain('appears short-term');
    // And it does not editorialise about it on every card.
    expect(context.note).toBeNull();
  });

  it('treats being ruled out as a cost to the season, bounded', () => {
    const context = tradeInjuryContext(state('ir'));
    expect(context.category).toBe('multi_week');
    expect(context.urgencyDelta).toBe(TRADE_INJURY.multiWeek);
    expect(context.line).toContain('multi-week');
  });

  /**
   * A structural injury is only ever claimed where a supported source names
   * one. "Missed time" is not an ACL, and inferring one is the fabrication this
   * project keeps refusing.
   */
  it('calls it a major recovery only when the source names the injury', () => {
    const named = tradeInjuryContext(state('out'), {
      outlook: 'He tore his ACL in Week 11 and spent the rest of the season on injured reserve.',
    });
    expect(named.category).toBe('major_recovery');
    expect(named.line).toContain('ACL');

    const vague = tradeInjuryContext(state('out'), {
      outlook: 'He missed time last season and was limited through camp.',
    });
    expect(vague.category).toBe('multi_week');
    expect(vague.line).not.toContain('ACL');
  });

  /** History is context on a card. It is not a standing discount. */
  it('stops penalising a player who has recovered', () => {
    const recovered = tradeInjuryContext(state('healthy'), {
      outlook: 'Back from the Achilles that ended his 2025, he took every camp rep.',
    });
    expect(recovered.category).toBe('major_recovery');
    expect(recovered.line).toContain('Healthy now');
    // Noted and priced, not avoided — a fraction of what being out costs.
    expect(Math.abs(recovered.urgencyDelta)).toBeLessThan(Math.abs(TRADE_INJURY.multiWeek));
  });

  it('says nothing at all about a healthy player with no history', () => {
    const context = tradeInjuryContext(state('healthy'));
    expect(context.category).toBe('healthy');
    expect(context.urgencyDelta).toBe(0);
    expect(context.line).toBeNull();
  });

  it('knows nothing rather than assuming health', () => {
    expect(tradeInjuryContext(NO_INJURY_INFORMATION).category).toBe('healthy');
    expect(tradeInjuryContext(NO_INJURY_INFORMATION).line).toBeNull();
  });

  /**
   * The two answers, side by side. The same player is a hard problem for one
   * screen and barely a footnote on the other, and that is correct.
   */
  it('treats a Questionable as a footnote on both screens', () => {
    const questionable = state('questionable', {}, { practice: ['dnp'] });
    expect(availabilityPenalty(questionable).points).toBe(0);
    expect(Math.abs(tradeInjuryContext(questionable).urgencyDelta)).toBeLessThanOrEqual(0.25);
  });
});
