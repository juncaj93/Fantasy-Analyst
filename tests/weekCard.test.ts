/**
 * The concise weekly card, and the things it refuses to do.
 *
 * The card exists because the full evaluation is too much to read on a Sunday
 * morning, so the tests that matter are the negative ones: it must not grow a
 * line for something nobody knows, it must not restate the same fact twice, and
 * it must not reach its own verdict about who starts.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_WEEKLY_DRIVERS,
  MAX_WEEKLY_PROPS,
  buildWeeklyCard,
  type WeeklyEvaluationLike,
} from '../src/core/startsit/weekCard.ts';

function evaluation(overrides: Partial<WeeklyEvaluationLike> = {}): WeeklyEvaluationLike {
  return {
    playerId: '1001',
    name: 'Marcus Vance',
    position: 'WR',
    team: 'CHI',
    score: 14.2,
    confidence: 'high',
    statusFlag: null,
    ruledOut: false,
    opponent: 'GB',
    expectation: {
      points: 13.8,
      coverage: 0.8,
      contributions: [
        { market: 'rec yards', line: 62.5, points: 6.25, detail: '62.5 yards' },
        { market: 'receptions', line: 5.5, points: 5.5, detail: '5.5 catches' },
        { market: 'rec tds', line: 0.5, points: 3, detail: '0.5 touchdowns' },
        { market: 'rush yards', line: 2.5, points: 0.25, detail: '2.5 yards' },
      ],
    },
    role: { trend: 'rising_high', label: 'Role rising — high confidence', detail: 'targets up 38%', games: 6 },
    usage: { display: '8.4 targets a game', unknown: false },
    matchup: { display: 'soft against slot receivers', unknown: false, rating: 'favourable' },
    drivers: ['market expectation 13.8', 'role rising', 'matchup favourable', 'news +2'],
    conflicts: [],
    ...overrides,
  };
}

describe('the conclusion', () => {
  /**
   * The card reports the lineup's decision. It does not make one.
   *
   * Same player, same numbers, two contexts, two headlines — because the
   * optimiser saw the rest of the roster and this card did not, and a card that
   * disagreed with the row that opened it would be the worse kind of bug: one
   * where both screens look right.
   */
  it('states where the lineup put him, not what his own score implies', () => {
    const starting = buildWeeklyCard(evaluation(), { starting: true, slot: 'WR2' });
    expect(starting.headline.verdict).toBe('start');
    expect(starting.headline.label).toBe('Start at WR2');

    const benched = buildWeeklyCard(evaluation(), { starting: false });
    expect(benched.headline.verdict).toBe('bench');
    expect(benched.headline.label).toBe('Bench this week');
  });

  it('says when Sleeper does not agree yet', () => {
    const card = buildWeeklyCard(evaluation(), { starting: true, slot: 'FLEX', alreadyStarting: false });
    expect(card.headline.detail).toContain('Sleeper');
  });

  it('says when the decision is already gone', () => {
    const card = buildWeeklyCard(evaluation(), { starting: true, slot: 'WR1', locked: true });
    expect(card.headline.detail).toContain('kicked off');
  });

  /** A player who is Out is a fact, not a start/sit question. */
  it('never calls a ruled-out player a bench decision', () => {
    const card = buildWeeklyCard(
      evaluation({ ruledOut: true, statusFlag: 'Out · hamstring' }),
      { starting: false },
    );
    expect(card.headline.verdict).toBe('not_playable');
    expect(card.headline.tone).toBe('warn');
    expect(card.headline.detail).toBe('Out · hamstring');
  });

  it('says so plainly when he could not be scored', () => {
    const card = buildWeeklyCard(evaluation({ score: null }), { starting: false });
    expect(card.headline.verdict).toBe('unknown');
    expect(card.headline.label).toContain('Not enough data');
  });
});

describe('what earns a line', () => {
  it('keeps the card short', () => {
    const card = buildWeeklyCard(evaluation(), { starting: true, slot: 'WR2' });
    // Role, what the role is made of, the matchup and the market — and nothing
    // else, because nothing else changes a decision for a healthy player with
    // no advanced numbers yet.
    expect(card.lines.length).toBeLessThanOrEqual(5);
    expect(card.lines.map((l) => l.key)).toEqual(['role', 'usage', 'matchup', 'market']);
  });

  /**
   * Unknown is absent, not printed.
   *
   * A card whose empty state is five rows reading "unknown" is longer than the
   * card it replaced and says less. What is missing is named once, at the
   * bottom, in one sentence.
   */
  it('drops what is not known and names it once instead', () => {
    const card = buildWeeklyCard(
      evaluation({
        role: { trend: 'insufficient_data', label: 'Role not classified', detail: '', games: 1 },
        usage: { display: 'no usage data', unknown: true },
        matchup: { display: 'no opponent tendency data', unknown: true, rating: 'insufficient_data' },
        opponent: null,
        expectation: { points: null, coverage: 0, contributions: [] },
      }),
      { starting: false },
    );
    expect(card.lines).toHaveLength(0);
    expect(card.pending).toEqual(['role trend', 'opponent tendency', 'Vegas expectation', 'expected points']);
    expect(JSON.stringify(card.lines)).not.toContain('unknown');
  });

  it('says nothing about availability for a healthy player', () => {
    const card = buildWeeklyCard(evaluation(), { starting: true, slot: 'WR2' });
    expect(card.lines.some((l) => l.key === 'availability')).toBe(false);
  });

  it('says the useful half of a designation when there is one', () => {
    const card = buildWeeklyCard(
      evaluation({
        statusFlag: 'Questionable · hamstring',
        availability: { label: 'Questionable', detail: 'practised fully on Friday', risky: false },
      }),
      { starting: true, slot: 'WR2' },
    );
    const line = card.lines.find((l) => l.key === 'availability');
    expect(line?.value).toBe('Questionable');
    expect(line?.detail).toBe('practised fully on Friday');
  });

  /** The same fact in two rows is the repetition this card exists to remove. */
  it('does not print the usage twice when the trend already said it', () => {
    const card = buildWeeklyCard(
      evaluation({
        role: { trend: 'rising_high', label: 'Role rising', detail: '8.4 targets a game', games: 6 },
        usage: { display: '8.4 targets a game', unknown: false },
      }),
      { starting: false },
    );
    expect(card.lines.filter((l) => l.key === 'usage')).toHaveLength(0);
  });

  it('caps the props and leads with the biggest', () => {
    const card = buildWeeklyCard(evaluation(), { starting: true, slot: 'WR2' });
    expect(card.props).toHaveLength(MAX_WEEKLY_PROPS);
    expect(card.props[0]!.label).toBe('rec yards');
    // A market with no line is not a prop; it is a gap.
    expect(card.props.every((p) => p.value !== '')).toBe(true);
  });

  it('caps the drivers', () => {
    const card = buildWeeklyCard(evaluation(), { starting: false });
    expect(card.drivers).toHaveLength(MAX_WEEKLY_DRIVERS);
  });

  it('states a disagreement rather than averaging it away', () => {
    const card = buildWeeklyCard(
      evaluation({ injury: { conflictNote: 'Sleeper says Questionable, the report says Doubtful' } }),
      { starting: false },
    );
    expect(card.conflicts[0]).toContain('Sleeper says Questionable');
  });
});

describe('the slots the intelligence passes will fill', () => {
  /**
   * Expected points and points over expectation arrive on the evaluation. This
   * card prints them and computes neither — quoting a number we invented would
   * be worse than leaving the row out.
   */
  it('prints advanced numbers when they are there', () => {
    const card = buildWeeklyCard(
      evaluation({ advanced: [{ key: 'xfp', label: 'xFP', value: '15.1', detail: 'expected, from opportunity' }] }),
      { starting: true, slot: 'WR2' },
    );
    const line = card.lines.find((l) => l.key === 'xfp');
    expect(line?.value).toBe('15.1');
    expect(card.pending).not.toContain('expected points');
  });

  it('is silent about what would change the recommendation until it is told', () => {
    expect(buildWeeklyCard(evaluation(), { starting: false }).changes).toEqual([]);
    const card = buildWeeklyCard(
      evaluation({ whatWouldChange: ['If Okafor is ruled out, he moves into the slot.'] }),
      { starting: false },
    );
    expect(card.changes).toHaveLength(1);
  });
});
