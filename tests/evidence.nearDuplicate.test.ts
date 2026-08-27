/**
 * The same fact, twice, in different words — and what a card does about it.
 *
 * Bijan Robinson's expanded card showed both of these under `Latest news`, from
 * the same day, one directly under the other:
 *
 *   > Elite receiving efficiency/target rate paired with an NFL-leading 2,298
 *   > scrimmage yards
 *   > Elite receiving efficiency/target rate and led the NFL with 2,298
 *   > scrimmage yards
 *
 * Two of the card's lines spent saying one thing. The fix is selection and only
 * selection, so this file asserts both halves of that: the reworded pair
 * collapses to its most recent telling, and the ledger behind it is untouched —
 * two genuinely different things from one day still take two lines, and every
 * row a card leaves out is still counted and still on his full profile.
 */

import { describe, expect, it } from 'vitest';
import {
  NEAR_DUPLICATE_THRESHOLD,
  distinctByFact,
  factSimilarity,
  isNearDuplicate,
} from '../src/core/evidence/nearDuplicate.ts';
import { selectLatestNews } from '../src/web/components/playerDetail.tsx';
import type { PlayerNewsItem } from '../src/web/components/playerDetail.tsx';

/** The reported pair, verbatim from the card that showed both. */
const PAIRED = 'Elite receiving efficiency/target rate paired with an NFL-leading 2,298 scrimmage yards';
const LED = 'Elite receiving efficiency/target rate and led the NFL with 2,298 scrimmage yards';

/** A different thing entirely, from the same day as the pair above. */
const ANKLE = 'Limited in Wednesday practice with an ankle issue, no designation yet';

const item = (over: Partial<PlayerNewsItem> & { id: string; sourceDate: string; excerpt: string }): PlayerNewsItem => ({
  sourceName: 'Demo FF Newsletter',
  contextSummary: null,
  ruleId: 'perf.usage',
  polarity: 'positive',
  userOverride: null,
  ...over,
});

describe('telling one fact from two', () => {
  it('reads the reported pair as the same claim reworded', () => {
    expect(isNearDuplicate(PAIRED, LED)).toBe(true);
    // Stated as a number as well as a boolean, so the margin over the
    // threshold is visible when either is next argued about.
    expect(factSimilarity(PAIRED, LED)).toBeGreaterThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it('keeps two genuinely different things from the same day apart', () => {
    expect(isNearDuplicate(PAIRED, ANKLE)).toBe(false);
    expect(isNearDuplicate(LED, ANKLE)).toBe(false);
  });

  /**
   * The rule that does most of the work of not over-collapsing: two weeks of
   * the same statistic share nearly every word and are two separate facts.
   */
  it('treats different numbers as different facts, however alike they read', () => {
    const week1 = 'Handled 14 carries and 5 targets in Week 1';
    const week2 = 'Handled 18 carries and 7 targets in Week 2';
    expect(factSimilarity(week1, week2)).toBeGreaterThan(NEAR_DUPLICATE_THRESHOLD);
    expect(isNearDuplicate(week1, week2)).toBe(false);
  });

  it('still catches the identical line reaching the ledger twice', () => {
    expect(isNearDuplicate(LED, `“${LED.toUpperCase()}.”`)).toBe(true);
  });

  it('does not merge two short lines on a couple of shared words', () => {
    expect(isNearDuplicate('Full practice Wednesday', 'Full practice Thursday')).toBe(false);
  });

  it('keeps the most recent telling and leaves the order alone', () => {
    const rows = [
      { id: 'c', text: ANKLE, sourceDate: '2026-08-21' },
      { id: 'a', text: PAIRED, sourceDate: '2026-08-20' },
      { id: 'b', text: LED, sourceDate: '2026-08-18' },
    ];
    const kept = distinctByFact(rows, (r) => r);
    expect(kept.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('promotes the newer telling into the older one’s place', () => {
    const rows = [
      { id: 'older', text: PAIRED, sourceDate: '2026-08-14' },
      { id: 'newer', text: LED, sourceDate: '2026-08-20' },
    ];
    expect(distinctByFact(rows, (r) => r).map((r) => r.id)).toEqual(['newer']);
  });
});

describe('what Latest news shows', () => {
  const paired = item({ id: 'e-paired', sourceDate: '2026-08-20', excerpt: PAIRED });
  const led = item({ id: 'e-led', sourceDate: '2026-08-20', excerpt: LED });
  const ankle = item({ id: 'e-ankle', sourceDate: '2026-08-20', excerpt: ANKLE, polarity: 'negative' });
  /** Newest first, which is the order the ledger endpoint returns. */
  const ledger = [led, paired, ankle];

  it('collapses the reworded pair to one line and spends the other on real news', () => {
    const { shown } = selectLatestNews(ledger, { quotedEvidenceIds: [], limit: 2 });
    expect(shown.map((i) => i.id)).toEqual(['e-led', 'e-ankle']);
  });

  it('shows both of two genuinely distinct items from the same day', () => {
    const { shown } = selectLatestNews([led, ankle], { quotedEvidenceIds: [], limit: 2 });
    expect(shown.map((i) => i.id)).toEqual(['e-led', 'e-ankle']);
  });

  /**
   * The collapsed row is withheld, not forgotten: it is the older half of its
   * pair, it is still on his full profile, and the card says how many rows it
   * is not showing.
   */
  it('counts the suppressed rewording among the rows left for the full profile', () => {
    const { withheld } = selectLatestNews(ledger, { quotedEvidenceIds: [], limit: 1 });
    expect(withheld).toBe(2);
  });

  it('does not repeat the takeaway’s fact in the reader’s own words', () => {
    // The takeaway was built from `e-led`, so `e-led` is excluded by id — and
    // `e-paired` says the same thing in different words, which is the defect.
    const { shown } = selectLatestNews(ledger, {
      quotedEvidenceIds: ['e-led'],
      quotedText: LED,
      limit: 3,
    });
    expect(shown.map((i) => i.id)).toEqual(['e-ankle']);
  });

  it('leaves a ledger with nothing to collapse exactly as it was', () => {
    const distinctLedger = [
      ankle,
      item({ id: 'e-role', sourceDate: '2026-08-19', excerpt: 'Named the three-down back, taking first-team reps' }),
      item({ id: 'e-snaps', sourceDate: '2026-08-12', excerpt: 'Played 88% of the snaps in the second preseason game' }),
    ];
    const { shown, withheld } = selectLatestNews(distinctLedger, { quotedEvidenceIds: [], limit: 3 });
    expect(shown.map((i) => i.id)).toEqual(['e-ankle', 'e-role', 'e-snaps']);
    expect(withheld).toBe(0);
  });

  /**
   * The ledger the card was given is the ledger it hands back. Selection reads;
   * it does not edit, reorder or drop anything from the array it was passed —
   * which is what the full evidence timeline goes on to render in full.
   */
  it('never mutates the ledger it selects from', () => {
    const before = ledger.map((i) => i.id);
    selectLatestNews(ledger, { quotedEvidenceIds: ['e-led'], quotedText: LED, limit: 1 });
    expect(ledger.map((i) => i.id)).toEqual(before);
    expect(ledger).toHaveLength(3);
  });
});
