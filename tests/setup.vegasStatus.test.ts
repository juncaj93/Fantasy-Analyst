/**
 * What Setup says about the odds provider.
 *
 * This screen's whole job is to be believed, so the states it has to tell apart
 * are asserted one at a time. The state that motivated the suite is "a real
 * provider is selected but its key never reached the deployment": the summary
 * used to be derived from the provider's name alone, so that deployment
 * announced that live betting lines were connected while it was fetching
 * nothing at all.
 */

import { describe, expect, it } from 'vitest';
import { describeVegas } from '../src/server/services/setupService.ts';

const FRESH = new Date(Date.now() - 2 * 3_600_000).toISOString();
const OLD = new Date(Date.now() - 5 * 86_400_000).toISOString();

function vegas(over: Partial<Parameters<typeof describeVegas>[0]> = {}) {
  return describeVegas({
    provider: 'sportsgameodds',
    configured: true,
    events: 8,
    fetchedAt: FRESH,
    budgetState: 'healthy',
    ...over,
  });
}

describe('the Vegas step tells the truth about the provider', () => {
  it('says practice data when the provider is the mock', () => {
    const s = vegas({ provider: 'mock', configured: true, events: 0, fetchedAt: null });
    expect(s.state).toBe('off');
    expect(s.summary).toMatch(/practice data/i);
    expect(s.note).not.toMatch(/connected/i);
  });

  it('names a missing key instead of claiming a connection', () => {
    const s = vegas({ configured: false, events: 0, fetchedAt: null });
    expect(s.state).toBe('warn');
    expect(s.summary).toMatch(/key is missing/i);
    expect(s.action).toMatch(/key/i);
    // The specific regression: this must never read as a working connection.
    expect(s.note).not.toMatch(/lines are connected/i);
  });

  it('separates "connected but nothing stored" from "connected and fed"', () => {
    const empty = vegas({ events: 0, fetchedAt: null });
    expect(empty.state).toBe('warn');
    expect(empty.summary).toMatch(/no lines stored yet/i);

    const fed = vegas();
    expect(fed.state).toBe('ok');
    expect(fed.summary).toMatch(/8 game\(s\) stored/);
  });

  it('calls an old snapshot stale rather than current', () => {
    const s = vegas({ fetchedAt: OLD });
    expect(s.state).toBe('warn');
    expect(s.note).toMatch(/stale/i);
    expect(s.summary).toMatch(/day\(s\) ago/);
  });

  it('says the allowance is spent, and that it is not an error', () => {
    const s = vegas({ budgetState: 'exhausted' });
    expect(s.state).toBe('warn');
    expect(s.summary).toMatch(/allowance is used up/i);
    // Exhaustion is a wait, not a repair: it must not send anyone hunting.
    expect(s.action).toMatch(/nothing to do/i);
  });

  it('never describes an absent market as a value', () => {
    /*
     * Every state has to leave "no market" meaning unknown. Asserted on what a
     * note may *claim* rather than on whether the word zero appears: the
     * healthy note says "never as a zero", which is the promise itself, and a
     * test that banned the word would be arguing with the sentence it wants.
     */
    for (const s of [
      vegas(),
      vegas({ configured: false }),
      vegas({ events: 0, fetchedAt: null }),
      vegas({ provider: 'mock' }),
      vegas({ budgetState: 'exhausted' }),
      vegas({ fetchedAt: OLD }),
    ]) {
      expect(s.note).not.toMatch(/\b(?:shown|treated|counts?|scored)\s+as\s+(?:a\s+)?(?:0|zero)\b/i);
      expect(s.note).not.toMatch(/\bdefaults?\s+to\s+(?:0|zero)\b/i);
    }
  });

  it('says what happens to a player with no market, in every connected state', () => {
    for (const s of [vegas(), vegas({ events: 0, fetchedAt: null }), vegas({ configured: false })]) {
      expect(s.note).toMatch(/unknown|no betting lines|nothing is shown/i);
    }
  });
});
