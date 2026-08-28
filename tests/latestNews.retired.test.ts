/**
 * `Latest news` shows what this app currently says, not what it used to say.
 *
 * Re-importing a revised tally retires each superseded row rather than deleting
 * it: the row keeps its date, stops counting, and stays on the provenance
 * timeline where the history belongs. `Latest news` did not ask about review
 * state, so it drew the retired sentence and its replacement as two separate
 * pieces of news on the same card.
 *
 * Both repro cases below are real. Puka Nacua and Jonathan Taylor were reported
 * from their live cards after the tally was rewritten in plain English: the
 * Insight box at the top read correctly, and the second line of `Latest news`
 * underneath it was the pre-rewrite `R1-R3 …` sentence the import had already
 * retired.
 *
 * The reason recency cannot catch this is the point of the file: **the retired
 * row and the row that replaced it carry the same source date.** A window, a
 * cutoff, or a sort by date puts them side by side no matter how it is tuned.
 * Only the review state separates them.
 */

import { describe, expect, it } from 'vitest';
import { selectLatestNews, type PlayerNewsItem } from '../src/web/components/playerDetail.tsx';
import { countsTowardTally } from '../src/core/evidence/aggregate.ts';

/** The date both halves of a superseded pair carry. */
const IMPORTED = '2026-08-12';

const row = (over: Partial<PlayerNewsItem> & { id: string; excerpt: string }): PlayerNewsItem => ({
  sourceName: 'FF Newsletter tally (issues 1-4)',
  sourceDate: IMPORTED,
  contextSummary: null,
  ruleId: 'tally-backfill',
  polarity: 'positive',
  reviewStatus: 'auto_applied',
  userOverride: null,
  ...over,
});

/** Puka Nacua's card, exactly as the ledger holds it after the re-import. */
const PUKA_RETIRED =
  'R1-R3 breakout/coverage dominance. R4: #1 in FPG excluding injury weeks (24.6), #1 in YPRR vs. two-high coverage (3.40)';
const PUKA_LIVE =
  '#1 in fantasy points per game excluding injury weeks (24.6) and #1 in yards per route run against two-high coverage (3.40)';

/** Jonathan Taylor's, the second confirmed repro. */
const TAYLOR_RETIRED =
  'R2/R3 EPA/rush + opportunity share. R4: top-3 in 10+TD odds, FP-over-expectation, and expected FP/game';
const TAYLOR_LIVE =
  'Top-3 in 10+ TD odds, fantasy points over expectation, and expected points per game; top-5 all-time in rushing yards per game';

describe('the review states that count', () => {
  it('counts the three the tally counts, and nothing else', () => {
    for (const live of ['auto_applied', 'accepted', 'corrected']) {
      expect(countsTowardTally(live), `${live} stopped counting`).toBe(true);
    }
    for (const retired of ['ignored', 'rejected', 'pending']) {
      expect(countsTowardTally(retired), `${retired} started counting`).toBe(false);
    }
  });
});

describe('Latest news leaves out rows that are no longer in force', () => {
  it('drops the retired R-label row from Puka Nacua’s card', () => {
    const { shown } = selectLatestNews(
      [
        row({ id: 'puka-live', excerpt: PUKA_LIVE }),
        row({ id: 'puka-retired', excerpt: PUKA_RETIRED, reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown.map((i) => i.id)).toEqual(['puka-live']);
    expect(shown.some((i) => /\bR[1-4]\b/.test(i.excerpt)), 'a retired sentence is still on the card').toBe(false);
  });

  it('drops the retired R-label row from Jonathan Taylor’s card', () => {
    const { shown } = selectLatestNews(
      [
        row({ id: 'jt-live', excerpt: TAYLOR_LIVE }),
        row({ id: 'jt-retired', excerpt: TAYLOR_RETIRED, reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown.map((i) => i.id)).toEqual(['jt-live']);
  });

  /**
   * The reason the 30-day collapse could not have fixed this, stated directly:
   * the pair is one day old and still must not appear together.
   */
  it('drops it even though it is exactly as recent as the row that replaced it', () => {
    const retired = row({ id: 'retired', excerpt: PUKA_RETIRED, reviewStatus: 'ignored' });
    const live = row({ id: 'live', excerpt: PUKA_LIVE });
    expect(retired.sourceDate).toBe(live.sourceDate);
    const { shown } = selectLatestNews([live, retired], { quotedEvidenceIds: [], limit: 5 });
    expect(shown.map((i) => i.id)).toEqual(['live']);
  });

  it('leaves out rejected and pending rows for the same reason', () => {
    const { shown } = selectLatestNews(
      [
        row({ id: 'live', excerpt: PUKA_LIVE }),
        row({ id: 'rejected', excerpt: 'A reading somebody threw out.', reviewStatus: 'rejected' }),
        row({ id: 'pending', excerpt: 'A reading nobody has ruled on yet.', reviewStatus: 'pending' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown.map((i) => i.id)).toEqual(['live']);
  });

  /** A row a human corrected is in force, and must survive the filter. */
  it('keeps accepted and corrected rows, which are current readings', () => {
    const { shown } = selectLatestNews(
      [
        row({ id: 'accepted', excerpt: 'Named the starter for Sunday.', reviewStatus: 'accepted' }),
        row({ id: 'corrected', excerpt: 'Played 88% of snaps in week 1.', reviewStatus: 'corrected' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown.map((i) => i.id)).toEqual(['accepted', 'corrected']);
  });

  /**
   * A retired row is not a row this section is holding back — it is one it can
   * no longer say. Counting it as "1 older item on his full profile" would
   * offer the reader a retracted sentence.
   */
  it('does not count retired rows among the items left for the full profile', () => {
    const { shown, withheld } = selectLatestNews(
      [
        row({ id: 'live', excerpt: PUKA_LIVE }),
        row({ id: 'retired', excerpt: PUKA_RETIRED, reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown).toHaveLength(1);
    expect(withheld).toBe(0);
  });

  /** Genuine overflow is still reported, so the filter did not silence the count. */
  it('still counts live rows it had no room for', () => {
    const { shown, withheld } = selectLatestNews(
      [
        row({ id: 'a', excerpt: 'Led the team in routes run on Sunday.' }),
        row({ id: 'b', excerpt: 'Took every first-team rep in Wednesday practice.' }),
        row({ id: 'c', excerpt: PUKA_RETIRED, reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 1 },
    );
    expect(shown.map((i) => i.id)).toEqual(['a']);
    // `b` is held back and counted; `c` is retired and is not.
    expect(withheld).toBe(1);
  });

  /** An empty answer is a real answer: a player whose every row was retired. */
  it('shows nothing when every row has been retired', () => {
    const { shown, withheld } = selectLatestNews(
      [
        row({ id: 'r1', excerpt: PUKA_RETIRED, reviewStatus: 'ignored' }),
        row({ id: 'r2', excerpt: TAYLOR_RETIRED, reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(shown).toEqual([]);
    expect(withheld).toBe(0);
  });

  /**
   * The source line is printed only when it varies, and that reading is taken
   * across the live rows. A retired row from a second source must not turn it
   * on for a list drawn entirely from one newsletter.
   */
  it('does not let a retired row from another source turn the source line on', () => {
    const { varies } = selectLatestNews(
      [
        row({ id: 'live', excerpt: PUKA_LIVE }),
        row({ id: 'retired', excerpt: 'Something else entirely.', sourceName: 'Some Other Feed', reviewStatus: 'ignored' }),
      ],
      { quotedEvidenceIds: [], limit: 5 },
    );
    expect(varies).toBe(false);
  });
});
