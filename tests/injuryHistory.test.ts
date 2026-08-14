import { describe, expect, it } from 'vitest';

import {
  assessHistory,
  deriveEpisodes,
  historyNote,
  normalizeBodyPart,
  outlookAlreadySaysIt,
  summarizeSeason,
  type HistoryRow,
} from '../src/core/injury/history.ts';

/**
 * A week of the season file. Defaults are the boring case — practising fully,
 * nothing filed — so each test states only the thing it is about.
 */
function week(n: number, over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    week: n,
    reportStatus: null,
    primaryInjury: null,
    secondaryInjury: null,
    practiceStatus: 'Full Participation in Practice',
    ...over,
  };
}

/** A run of weeks all describing the same thing. */
function weeks(from: number, to: number, over: Partial<HistoryRow>): HistoryRow[] {
  return Array.from({ length: to - from + 1 }, (_, i) => week(from + i, over));
}

const OUT_HAMSTRING = { reportStatus: 'Out', primaryInjury: 'Hamstring', practiceStatus: 'Did Not Participate In Practice' };
const Q_HAMSTRING = { reportStatus: 'Questionable', primaryInjury: 'Hamstring', practiceStatus: 'Limited Participation in Practice' };

describe('folding weekly rows into episodes', () => {
  it('treats one continuous run of a body part as a single episode', () => {
    const episodes = deriveEpisodes(weeks(4, 8, OUT_HAMSTRING));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ bodyPart: 'hamstring', firstWeek: 4, lastWeek: 8, gamesMissed: 5, peak: 'out' });
  });

  /** A bye or an unfiled week is not a recovery, so it must not split a run. */
  it('does not split an episode across a single missing week', () => {
    const episodes = deriveEpisodes([...weeks(4, 5, OUT_HAMSTRING), ...weeks(7, 8, OUT_HAMSTRING)]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.gamesMissed).toBe(4);
  });

  it('splits when he came back and it happened again', () => {
    const episodes = deriveEpisodes([...weeks(1, 2, OUT_HAMSTRING), ...weeks(12, 13, OUT_HAMSTRING)]);
    expect(episodes).toHaveLength(2);
    expect(episodes.map((e) => e.firstWeek)).toEqual([1, 12]);
  });

  it('keeps unrelated injuries apart', () => {
    const episodes = deriveEpisodes([
      ...weeks(3, 4, OUT_HAMSTRING),
      ...weeks(3, 4, { reportStatus: 'Out', primaryInjury: 'Ankle' }),
    ]);
    expect(episodes.map((e) => e.bodyPart).sort()).toEqual(['ankle', 'hamstring']);
  });

  /** Row order must not decide the outcome. */
  it('takes the worst report filed in a week, whatever order it arrives in', () => {
    const forwards = deriveEpisodes([week(5, Q_HAMSTRING), week(5, OUT_HAMSTRING)]);
    const backwards = deriveEpisodes([week(5, OUT_HAMSTRING), week(5, Q_HAMSTRING)]);
    expect(forwards[0]!.gamesMissed).toBe(1);
    expect(backwards[0]!.gamesMissed).toBe(1);
  });

  /**
   * The file marks rest and personal matters explicitly. Counting a rested
   * starter as injured would put a note on the best players in the league.
   */
  it('ignores the descriptors the file says are not injuries', () => {
    expect(normalizeBodyPart('Not injury related - resting player')).toBeNull();
    expect(normalizeBodyPart('Not injury related - personal matter')).toBeNull();
    expect(deriveEpisodes(weeks(1, 6, { reportStatus: 'Out', primaryInjury: 'Not injury related - resting player' }))).toEqual([]);
  });
});

describe('what counts as significant', () => {
  it('calls a multi-week hamstring absence significant', () => {
    const { significance, note } = summarizeSeason('2025', weeks(4, 8, OUT_HAMSTRING));
    expect(significance).toBe('strong');
    expect(note).toBe('2025: missed 5 games with a hamstring injury');
  });

  it('says nothing about a single Questionable week', () => {
    const { significance, note } = summarizeSeason('2025', [week(6, Q_HAMSTRING)]);
    expect(significance).toBe('none');
    expect(note).toBeNull();
  });

  /** The most common shape in the real file, and the one that must stay quiet. */
  it('says nothing about weeks of limited practice that cost no games', () => {
    const { significance, note } = summarizeSeason('2025', weeks(2, 9, Q_HAMSTRING));
    expect(significance).toBe('none');
    expect(note).toBeNull();
  });

  it('says nothing when one game was missed and nothing else happened', () => {
    expect(summarizeSeason('2025', [week(5, OUT_HAMSTRING)]).note).toBeNull();
  });

  it('treats a part that ends seasons as strong even for one game', () => {
    const { significance, note } = summarizeSeason('2025', [week(9, { reportStatus: 'Out', primaryInjury: 'Achilles', practiceStatus: 'Did Not Participate In Practice' })]);
    expect(significance).toBe('strong');
    expect(note).toBe('2025: missed 1 game with an Achilles injury');
  });

  it('mentions a concussion that cost a game', () => {
    expect(summarizeSeason('2025', [week(3, { reportStatus: 'Out', primaryInjury: 'Concussion', practiceStatus: 'Did Not Participate In Practice' })]).note).toBe(
      '2025: missed 1 game with a concussion',
    );
  });

  it('attributes an illness rather than calling it an injury', () => {
    expect(summarizeSeason('2025', weeks(3, 4, { reportStatus: 'Out', primaryInjury: 'Illness' })).note).toBe(
      '2025: missed 2 games through illness',
    );
  });
});

describe('recurrence', () => {
  it('names two separate absences of the same part', () => {
    const rows = [...weeks(2, 2, OUT_HAMSTRING), ...weeks(11, 11, OUT_HAMSTRING)];
    const { note, significance } = summarizeSeason('2025', rows);
    expect(significance).toBe('moderate');
    expect(note).toBe('2025: two separate hamstring absences');
  });

  /** Losing the count to say "two separate" would throw away the useful half. */
  it('keeps the games-missed count when the absences were also long', () => {
    const rows = [...weeks(1, 3, OUT_HAMSTRING), ...weeks(10, 12, OUT_HAMSTRING)];
    expect(summarizeSeason('2025', rows).note).toBe('2025: missed 6 games across two separate hamstring absences');
  });

  it('does not call it a recurrence when the second spell cost nothing', () => {
    const rows = [...weeks(1, 2, OUT_HAMSTRING), ...weeks(11, 12, Q_HAMSTRING)];
    const { note } = summarizeSeason('2025', rows);
    expect(note).toBe('2025: missed 2 games with a hamstring injury');
  });
});

describe('the line it produces', () => {
  it('is one short line or nothing at all', () => {
    const rows = weeks(4, 8, OUT_HAMSTRING);
    const note = summarizeSeason('2025', rows).note!;
    expect(note.split('\n')).toHaveLength(1);
    expect(note.length).toBeLessThan(70);
  });

  /*
   * The source vocabulary is body parts. It never says ACL, surgery, tear or
   * fracture, so neither may the app -- a knee is as specific as the file gets.
   */
  it('never invents a diagnosis the source does not carry', () => {
    const notes = [
      summarizeSeason('2025', weeks(1, 9, { reportStatus: 'Out', primaryInjury: 'Knee', practiceStatus: 'Did Not Participate In Practice' })).note,
      summarizeSeason('2025', weeks(1, 9, { reportStatus: 'Out', primaryInjury: 'Achilles' })).note,
    ];
    for (const note of notes) {
      expect(note).not.toMatch(/ACL|surgery|tear|torn|fracture|season-ending|injury-prone/i);
    }
  });

  it('never labels a player injury-prone', () => {
    const rows = [...weeks(1, 2, OUT_HAMSTRING), ...weeks(6, 7, OUT_HAMSTRING), ...weeks(12, 13, OUT_HAMSTRING)];
    expect(summarizeSeason('2025', rows).note).not.toMatch(/prone|fragile|always/i);
  });
});

describe('not saying it twice', () => {
  it('spots the outlook already naming the same injury', () => {
    const note = '2025: missed 5 games with a hamstring injury';
    expect(outlookAlreadySaysIt(note, 'He missed time with a hamstring strain and returned in December.')).toBe(true);
  });

  it('leaves the note alone when the outlook is about something else', () => {
    const note = '2025: missed 5 games with a hamstring injury';
    expect(outlookAlreadySaysIt(note, 'A change of offensive coordinator should raise his target share.')).toBe(false);
  });

  it('is nothing to decide when there is no note or no outlook', () => {
    expect(outlookAlreadySaysIt(null, 'anything')).toBe(false);
    expect(outlookAlreadySaysIt('2025: missed 5 games with a hamstring injury', null)).toBe(false);
  });
});

describe('assessment arithmetic', () => {
  it('reports games missed across every episode, not just the leading one', () => {
    const rows = [...weeks(1, 2, OUT_HAMSTRING), ...weeks(10, 12, { reportStatus: 'Out', primaryInjury: 'Ankle' })];
    const assessment = assessHistory(deriveEpisodes(rows));
    expect(assessment.totalGamesMissed).toBe(5);
    expect(assessment.leading!.bodyPart).toBe('ankle');
    expect(assessment.partGamesMissed).toBe(3);
  });

  it('has nothing to lead with when no game was missed', () => {
    const assessment = assessHistory(deriveEpisodes(weeks(1, 8, Q_HAMSTRING)));
    expect(assessment.leading).toBeNull();
    expect(historyNote('2025', assessment)).toBeNull();
  });
});
