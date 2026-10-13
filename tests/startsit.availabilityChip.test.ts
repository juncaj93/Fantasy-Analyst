/**
 * Questionable is shown, not scored (13 October 2026): a chip on the Compare
 * card, and one line on Best move when the player to start carries it.
 */
import { describe, expect, it } from 'vitest';
import { availabilityChip, availabilityWarning } from '../src/core/startsit/availabilityChip.ts';

describe('the availability chip', () => {
  it('warns on Questionable, with the designation alone', () => {
    expect(availabilityChip({ statusFlag: 'Questionable · hamstring · limited → full', ruledOut: false })).toEqual({ label: 'Questionable', tone: 'warn' });
  });

  it('marks Out and Doubtful in the stronger tone', () => {
    expect(availabilityChip({ statusFlag: 'Out · knee', ruledOut: true })).toEqual({ label: 'Out', tone: 'out' });
    expect(availabilityChip({ statusFlag: 'On IR', ruledOut: true })).toEqual({ label: 'On IR', tone: 'out' });
    expect(availabilityChip({ statusFlag: 'Doubtful · ankle', ruledOut: false })).toEqual({ label: 'Doubtful', tone: 'out' });
    expect(availabilityChip({ statusFlag: null, ruledOut: true })).toEqual({ label: 'Out', tone: 'out' });
  });

  it('says nothing for a healthy player', () => {
    expect(availabilityChip({ statusFlag: null, ruledOut: false })).toBeNull();
    expect(availabilityChip(null)).toBeNull();
  });

  it('warns on any other status that is not Out, Doubtful or a bye', () => {
    expect(availabilityChip({ statusFlag: 'Designated', ruledOut: false })).toEqual({ label: 'Designated', tone: 'warn' });
  });
});

describe('the Best move line', () => {
  it('names a questionable starter by surname, in one line', () => {
    expect(availabilityWarning('Ladd McConkey', { statusFlag: 'Questionable · hamstring', ruledOut: false })).toBe(
      'McConkey is questionable and may not play',
    );
    expect(availabilityWarning('Marvin Harrison Jr.', { statusFlag: 'Questionable', ruledOut: false })).toBe(
      'Harrison is questionable and may not play',
    );
  });

  it('stays quiet for a healthy, doubtful or out player: the score already says those', () => {
    expect(availabilityWarning('A B', { statusFlag: null })).toBeNull();
    expect(availabilityWarning('A B', { statusFlag: 'Doubtful' })).toBeNull();
    expect(availabilityWarning('A B', { statusFlag: 'Out', ruledOut: true })).toBeNull();
  });
});
