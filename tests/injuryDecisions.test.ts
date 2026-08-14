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
  });

  /**
   * The whole reason this module exists. "Questionable" is the only designation
   * that is genuinely a question, and the week's practice is the best free
   * answer to it — so it must not cost every player the same 1.5 points.
   */
  describe('Questionable, which is contextual', () => {
    it('costs much less when he practised fully all week', () => {
      const full = availabilityPenalty(state('questionable', {}, { practice: ['full', 'full'] }));
      const plain = availabilityPenalty(state('questionable'));
      expect(full.points).toBeGreaterThan(plain.points); // less negative
      expect(Math.abs(full.points)).toBeLessThan(Math.abs(plain.points) * 0.8);
      expect(full.note).toContain('practised fully');
    });

    it('costs more when he has not practised', () => {
      const none = availabilityPenalty(state('questionable', {}, { practice: ['dnp', 'dnp'] }));
      const plain = availabilityPenalty(state('questionable'));
      expect(none.points).toBeLessThan(plain.points);
      expect(none.note).toContain('has not practised');
    });

    it('reads the direction, not only the latest day', () => {
      const improving = availabilityPenalty(state('questionable', {}, { practice: ['dnp', 'limited'] }));
      const worsening = availabilityPenalty(state('questionable', {}, { practice: ['limited', 'dnp'] }));
      expect(improving.points).toBeGreaterThan(worsening.points);
    });

    /** Never a clearance. The designation still stands and still costs. */
    it('never removes the penalty entirely, however good the week looked', () => {
      const best = availabilityPenalty(state('questionable', {}, { practice: ['full', 'full'] }));
      expect(best.points).toBeLessThan(0);
      expect(best.gate).toBe(false);
    });

    /**
     * Bad data should make the app less sure, not more cautious — "less sure"
     * is what is actually true. So a stale or contradicted report gets less of
     * a say and the answer moves back toward the plain designation.
     */
    it('trusts a stale practice report less, in both directions', () => {
      const stale = resolveInjury(
        [
          { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: longAgo },
          { source: 'nflverse', designation: 'questionable', raw: 'Questionable', observedAt: longAgo, practice: ['full', 'full'] },
        ],
        NOW,
      );
      const fresh = state('questionable', {}, { practice: ['full', 'full'] });
      // The fresh full-participation report earns more relief than the stale one.
      expect(availabilityPenalty(stale).points).toBeLessThan(availabilityPenalty(fresh).points);
      expect(availabilityPenalty(stale).note).toContain('out of date');
    });

    it('says so when the sources disagree, rather than picking a side quietly', () => {
      const conflicted = resolveInjury(
        [
          { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: recently },
          { source: 'nflverse', designation: 'out', raw: 'Out', observedAt: recently },
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
  it('answers the same Questionable differently from Start/Sit', () => {
    const questionable = state('questionable', {}, { practice: ['dnp'] });
    expect(availabilityPenalty(questionable).points).toBeLessThan(-1);
    expect(Math.abs(tradeInjuryContext(questionable).urgencyDelta)).toBeLessThanOrEqual(0.25);
  });
});
