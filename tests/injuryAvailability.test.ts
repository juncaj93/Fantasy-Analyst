/**
 * Games played, games missed, and the difference between them.
 *
 * The suite exists for one production defect, and the fixture at the bottom of
 * this file is the real thing rather than an illustration of it: Joe Burrow's
 * four actual nflverse rows from the published 2025 season file, beside the 8
 * games Sleeper actually credits him with. Read separately, each source is
 * telling the truth. Read as if they measured the same quantity, they produced
 * a card that said `8 GP` and `missed 2 games` one line apart.
 *
 * The invariants near the end are the regression guard. Everything else is the
 * wording, which matters here more than usual — the whole failure was a
 * sentence claiming more than its evidence.
 */

import { describe, expect, it } from 'vitest';
import { deriveEpisodes, type HistoryRow } from '../src/core/injury/history.ts';
import {
  fullSeasonSlate,
  readMissedGamesClaim,
  reconcileHistoricalAvailability,
  SLATE_MIN_PLAYERS,
  type HistoricalAvailability,
} from '../src/core/injury/availability.ts';

// ------------------------------------------------------------------ fixtures

function row(week: number, partial: Partial<HistoryRow> = {}): HistoryRow {
  return {
    week,
    reportStatus: null,
    primaryInjury: null,
    secondaryInjury: null,
    practiceStatus: null,
    ...partial,
  };
}

/** `Out` with a named body part, for the weeks a player was ruled out. */
function out(week: number, part: string): HistoryRow {
  return row(week, { reportStatus: 'Out', primaryInjury: part, practiceStatus: 'Did Not Participate In Practice' });
}

function outRange(from: number, to: number, part: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let w = from; w <= to; w++) rows.push(out(w, part));
  return rows;
}

function reconcile(opts: {
  rows: HistoryRow[];
  gamesPlayed: number | null;
  gamesAvailable: number | null;
  outlook?: string | null;
  season?: string;
}): HistoricalAvailability {
  return reconcileHistoricalAvailability({
    season: opts.season ?? '2025',
    participation: { gamesPlayed: opts.gamesPlayed, gamesAvailable: opts.gamesAvailable },
    evidence: { episodes: deriveEpisodes(opts.rows), corroboration: opts.outlook ?? null },
  });
}

// -------------------------------------------------------------- the denominator

describe('how long a season was, derived rather than assumed', () => {
  /**
   * The real 2025 shape. 687 players managed 17 games and exactly two managed
   * 18 — which is not an error: a player who changes teams mid-season can be
   * on one roster for its bye and another for theirs, and appear in every week
   * of the year. It is one player's schedule, not the league's.
   */
  it('takes the slate a crowd played, not the one an outlier did', () => {
    const slate = fullSeasonSlate([
      { games: 16, players: 199 },
      { games: 17, players: 687 },
      { games: 18, players: 2 },
    ]);
    expect(slate).toBe(17);
  });

  it('needs a real population before it believes a value', () => {
    expect(fullSeasonSlate([{ games: 17, players: SLATE_MIN_PLAYERS - 1 }])).toBeNull();
    expect(fullSeasonSlate([{ games: 17, players: SLATE_MIN_PLAYERS }])).toBe(17);
  });

  /**
   * The `17 - GP` guard, stated as data. Six weeks into a season the largest
   * slate anybody has played is six, so a player who has appeared in all six
   * has missed nothing — and cannot be reported as having missed eleven.
   */
  it('reports a season in progress at the games actually played so far', () => {
    const slate = fullSeasonSlate([
      { games: 4, players: 90 },
      { games: 5, players: 210 },
      { games: 6, players: 640 },
    ]);
    expect(slate).toBe(6);

    const everyGame = reconcile({ rows: outRange(2, 3, 'Ankle'), gamesPlayed: 6, gamesAvailable: slate });
    expect(everyGame.gamesMissedTotal).not.toBe(11);
  });

  it('has no answer for a season nothing was played in', () => {
    expect(fullSeasonSlate([])).toBeNull();
    expect(fullSeasonSlate([{ games: 0, players: 900 }])).toBeNull();
  });
});

// ------------------------------------------------------------- corroboration

describe('a missed-game count stated in supported prose', () => {
  it('reads the number a provider wrote, in words or figures', () => {
    expect(readMissedGamesClaim('he missed nine games last year, Weeks 3-12, with turf toe')).toBe(9);
    expect(readMissedGamesClaim('missed 4 games with a hamstring')).toBe(4);
    expect(readMissedGamesClaim('missed six regular-season games')).toBe(6);
  });

  it('declines everything that is not an explicit count', () => {
    expect(readMissedGamesClaim('he missed time with a toe injury')).toBeNull();
    expect(readMissedGamesClaim('a healthy season with no absences')).toBeNull();
    expect(readMissedGamesClaim(null)).toBeNull();
  });
});

// ------------------------------------------------------------ the reconciler

describe('reconciling participation against injury evidence', () => {
  /** §25 — fully reconciled. Every missed game has a row saying why. */
  it('states the whole season when every absence is accounted for', () => {
    const a = reconcile({ rows: outRange(9, 17, 'Knee'), gamesPlayed: 8, gamesAvailable: 17 });
    expect(a.gamesMissedTotal).toBe(9);
    expect(a.injuryAttributedMisses).toBe(9);
    expect(a.unresolvedMisses).toBe(0);
    expect(a.confidence).toBe('complete');
    expect(a.displaySummary).toBe('2025: missed 9 games with a knee injury');
  });

  /** §25 — partial attribution. The half that is proven is stated as a floor. */
  it('never presents part of the missed time as all of it', () => {
    const a = reconcile({ rows: outRange(11, 12, 'Toe'), gamesPlayed: 8, gamesAvailable: 17 });
    expect(a.gamesMissedTotal).toBe(9);
    expect(a.injuryAttributedMisses).toBe(2);
    expect(a.unresolvedMisses).toBe(7);
    expect(a.confidence).toBe('partial');
    expect(a.displaySummary).toBe('2025: played 8 of 17 games; at least 2 absences tied to a toe injury');
    // The exact sentence production shipped, which claimed a season total.
    expect(a.displaySummary).not.toBe('2025: missed 2 games with a toe injury');
  });

  /** §25 — no injury attribution. Absence is not evidence of a cause. */
  it('says nothing about a cause it has no evidence for', () => {
    const a = reconcile({
      rows: [row(6, { reportStatus: 'Questionable', primaryInjury: 'Ankle', practiceStatus: 'Full Participation in Practice' })],
      gamesPlayed: 12,
      gamesAvailable: 17,
    });
    expect(a.confidence).toBe('unattributed');
    expect(a.injuryAttributedMisses).toBe(0);
    /*
     * The card prints `12 GP` directly above this, so there is nothing left to
     * add — and the one thing that must not be added is a reason.
     */
    expect(a.displaySummary).toBeNull();
  });

  /** §10 — three injuries stop fitting as clauses, so the total is stated once. */
  it('states one total when too many injuries to itemise', () => {
    const a = reconcile({
      rows: [...outRange(2, 4, 'Toe'), ...outRange(8, 9, 'Wrist'), ...outRange(14, 15, 'Knee')],
      gamesPlayed: 10,
      gamesAvailable: 17,
    });
    expect(a.confidence).toBe('complete');
    // Most costly first, ties broken alphabetically, so the line is stable.
    expect(a.displaySummary).toBe('2025: missed 7 games with toe, knee and wrist injuries');
  });

  /** §10, §25 — two injuries are two injuries. */
  it('keeps separate injuries separate rather than compressing them', () => {
    const a = reconcile({
      rows: [...outRange(3, 8, 'Toe'), ...outRange(13, 15, 'Wrist')],
      gamesPlayed: 8,
      gamesAvailable: 17,
    });
    expect(a.gamesMissedTotal).toBe(9);
    expect(a.parts.map((p) => p.part)).toEqual(['toe', 'wrist']);
    expect(a.confidence).toBe('complete');
    expect(a.displaySummary).toBe('2025: missed 6 games with a toe injury and 3 with a wrist injury');
  });

  it('qualifies a multi-injury season it cannot fully account for', () => {
    const a = reconcile({
      rows: [...outRange(3, 5, 'Toe'), ...outRange(13, 14, 'Wrist')],
      gamesPlayed: 8,
      gamesAvailable: 17,
    });
    expect(a.confidence).toBe('partial');
    expect(a.displaySummary).toBe('2025: played 8 of 17 games; missed time included toe and wrist injuries');
  });

  /** §10 — a recurrence of one part is its own signal, and keeps its count. */
  it('counts two absences of the same part as two', () => {
    const a = reconcile({
      rows: [...outRange(2, 4, 'Hamstring'), ...outRange(10, 12, 'Hamstring')],
      gamesPlayed: 11,
      gamesAvailable: 17,
    });
    expect(a.parts[0]).toMatchObject({ part: 'hamstring', games: 6, episodes: 2 });
    expect(a.displaySummary).toBe('2025: missed 6 games across two separate hamstring absences');
  });

  /**
   * §6 — a week is a game, however many things were wrong that week. A player
   * listed with a knee and an ankle over the same four Sundays missed four
   * games, not eight.
   */
  it('counts a week once even when two injuries name it', () => {
    const rows: HistoryRow[] = [];
    for (let w = 5; w <= 8; w++) {
      rows.push(out(w, 'Knee'));
      rows.push(row(w, { reportStatus: 'Out', practiceStatus: 'Did Not Participate In Practice', practiceInjury: 'Ankle' }));
    }
    const a = reconcile({ rows, gamesPlayed: 13, gamesAvailable: 17 });
    expect(a.injuryAttributedMisses).toBe(4);
    expect(a.parts.reduce((n, p) => n + p.games, 0)).toBe(4);
  });

  /**
   * §20 — a bye is not a missed game, and it never has to be subtracted: the
   * denominator counts games a full season *played*, which a bye is not.
   */
  it('never counts a bye week as a missed game', () => {
    const a = reconcile({ rows: outRange(4, 6, 'Calf'), gamesPlayed: 14, gamesAvailable: 17 });
    expect(a.gamesMissedTotal).toBe(3);
    expect(a.confidence).toBe('complete');
  });

  /**
   * §19 — a traded player can exceed the league's slate. His opportunity is
   * not the one being subtracted from, so the subtraction is dropped rather
   * than forced to fit.
   */
  it('refuses a denominator that a player has already played past', () => {
    const a = reconcile({ rows: outRange(3, 4, 'Groin'), gamesPlayed: 18, gamesAvailable: 17 });
    expect(a.gamesMissedTotal).toBeNull();
    expect(a.gamesAvailable).toBeNull();
    expect(a.confidence).toBe('unmeasured');
    expect(a.displaySummary).toBe('2025: at least 2 games missed with a groin injury');
  });

  /** §17 — proven absences outnumbering the total means the total is not his. */
  it('drops a total that its own evidence contradicts', () => {
    const a = reconcile({ rows: outRange(3, 9, 'Foot'), gamesPlayed: 15, gamesAvailable: 17 });
    expect(a.gamesMissedTotal).toBeNull();
    expect(a.confidence).toBe('unmeasured');
    expect(a.displaySummary).toMatch(/^2025: at least 7 games missed/);
  });

  /** §17 — no denominator, so counts are floors and say so. */
  it('states a lower bound when there is no denominator at all', () => {
    const a = reconcile({ rows: outRange(4, 6, 'Shoulder'), gamesPlayed: 8, gamesAvailable: null });
    expect(a.gamesMissedTotal).toBeNull();
    expect(a.displaySummary).toBe('2025: at least 3 games missed with a shoulder injury');
    expect(a.displaySummary).not.toMatch(/of \d+ games/);
  });

  it('says nothing at all when a season cost no games', () => {
    const a = reconcile({
      rows: [row(6, { reportStatus: 'Questionable', primaryInjury: 'Ankle' })],
      gamesPlayed: 17,
      gamesAvailable: 17,
    });
    expect(a.displaySummary).toBeNull();
  });

  /** Body parts that are conditions do not take "injury". */
  it('names conditions the way English does', () => {
    expect(reconcile({ rows: outRange(3, 5, 'Concussion'), gamesPlayed: 14, gamesAvailable: 17 }).displaySummary).toBe(
      '2025: missed 3 games with a concussion',
    );
    expect(reconcile({ rows: outRange(3, 4, 'Illness'), gamesPlayed: 15, gamesAvailable: 17 }).displaySummary).toBe(
      '2025: missed 2 games through illness',
    );
    expect(reconcile({ rows: outRange(3, 6, 'Achilles'), gamesPlayed: 13, gamesAvailable: 17 }).displaySummary).toBe(
      '2025: missed 4 games with an Achilles injury',
    );
  });
});

// ------------------------------------------------------- corroborated totals

describe('supported prose closing a gap the report left open', () => {
  const OUTLOOK =
    "For the second time in three years, Burrow's season was cut short because of injury as he missed nine games " +
    'last year, Weeks 3-12, with turf toe.';

  /**
   * §8, §15 — the IR case. Two sources that cannot see each other agree on the
   * count and on the cause, so the weeks nflverse never filed a row for are
   * explained rather than guessed.
   */
  it('completes attribution when prose states the same total', () => {
    const a = reconcile({ rows: outRange(11, 12, 'Toe'), gamesPlayed: 8, gamesAvailable: 17, outlook: OUTLOOK });
    expect(a.corroborated).toBe(true);
    expect(a.injuryAttributedMisses).toBe(9);
    expect(a.unresolvedMisses).toBe(0);
    expect(a.displaySummary).toBe('2025: missed 9 games with a toe injury');
  });

  it('ignores prose that disagrees with games played', () => {
    const a = reconcile({
      rows: outRange(11, 12, 'Toe'),
      gamesPlayed: 8,
      gamesAvailable: 17,
      outlook: 'He missed four games with turf toe.',
    });
    expect(a.corroborated).toBe(false);
    expect(a.injuryAttributedMisses).toBe(2);
    expect(a.displaySummary).toBe('2025: played 8 of 17 games; at least 2 absences tied to a toe injury');
  });

  /**
   * A single-cause claim cannot be laid over a two-cause season. Raising one
   * part to the whole total would leave the parts summing past the games
   * actually missed, so the qualified wording stands.
   */
  it('will not absorb a one-injury claim into a two-injury season', () => {
    const a = reconcile({
      rows: [...outRange(3, 5, 'Wrist'), ...outRange(9, 10, 'Toe')],
      gamesPlayed: 8,
      gamesAvailable: 17,
      outlook: 'He missed nine games last year with a wrist injury.',
    });
    expect(a.corroborated).toBe(false);
    expect(a.injuryAttributedMisses).toBe(5);
    expect(a.parts.reduce((n, p) => n + p.games, 0)).toBeLessThanOrEqual(a.gamesMissedTotal!);
    expect(a.displaySummary).toBe('2025: played 8 of 17 games; missed time included wrist and toe injuries');
  });

  it('ignores prose that names a different injury', () => {
    const a = reconcile({
      rows: outRange(11, 12, 'Toe'),
      gamesPlayed: 8,
      gamesAvailable: 17,
      outlook: 'He missed nine games with a shoulder problem.',
    });
    expect(a.corroborated).toBe(false);
    expect(a.confidence).toBe('partial');
  });

  /** Free text may agree with a total. It may never create one. */
  it('cannot invent a total where participation has none', () => {
    const a = reconcile({ rows: outRange(11, 12, 'Toe'), gamesPlayed: null, gamesAvailable: null, outlook: OUTLOOK });
    expect(a.corroborated).toBe(false);
    expect(a.gamesMissedTotal).toBeNull();
    expect(a.injuryAttributedMisses).toBe(2);
  });
});

// -------------------------------------------------------- the Burrow fixture

/**
 * The production case, from the published sources rather than from memory.
 *
 * These four rows are every mention of Joe Burrow in `injuries_2025.csv`. He
 * spent weeks 3 to 10 on injured reserve, and a player on IR is not on the
 * weekly injury report at all — which is why an absence of nine games leaves
 * two `Out` rows behind it.
 */
const BURROW_2025: HistoryRow[] = [
  row(11, { reportStatus: 'Out', primaryInjury: 'Toe', practiceStatus: 'Limited Participation in Practice', practiceInjury: 'Toe' }),
  row(12, { reportStatus: 'Out', primaryInjury: 'Toe', practiceStatus: 'Limited Participation in Practice', practiceInjury: 'Toe' }),
  row(13, { reportStatus: '', primaryInjury: '', practiceStatus: 'Full Participation in Practice', practiceInjury: 'Toe' }),
  row(16, { reportStatus: '', primaryInjury: '', practiceStatus: 'Full Participation in Practice', practiceInjury: 'Knee' }),
];

const BURROW_OUTLOOK =
  "For the second time in three years, Burrow's season was cut short because of injury as he missed nine games last " +
  'year, Weeks 3-12, with turf toe. He returned to throw 15 TD passes in the last six games (2nd in the league in ' +
  'that span), averaging about 37 attempts per game, a 630-attempt pace over 17 games.';

describe('Joe Burrow 2025, the case this was built for', () => {
  it('does not contradict the 8 GP the card prints above it', () => {
    const a = reconcile({ rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17 });
    expect(a.gamesPlayed).toBe(8);
    expect(a.gamesMissedTotal).toBe(9);
    expect(a.displaySummary).not.toBe('2025: missed 2 games with a toe injury');
    expect(a.displaySummary).not.toMatch(/^2025: missed [0-8] games/);
  });

  it('reads the whole season once the outlook corroborates the total', () => {
    const a = reconcile({ rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17, outlook: BURROW_OUTLOOK });
    expect(a.displaySummary).toBe('2025: missed 9 games with a toe injury');
    expect(a.unresolvedMisses).toBe(0);
  });

  it('qualifies rather than guesses when no outlook is cached', () => {
    const a = reconcile({ rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17 });
    expect(a.displaySummary).toBe('2025: played 8 of 17 games; at least 2 absences tied to a toe injury');
  });

  /** The week-16 knee is a full practice. It never cost a game and never says it did. */
  it('does not turn a full practice into an absence', () => {
    const a = reconcile({ rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17 });
    expect(a.parts.map((p) => p.part)).toEqual(['toe']);
  });
});

// ----------------------------------------------------------------- invariants

/**
 * §26. Whatever the inputs, these three have to hold — they are the properties
 * that make a card internally consistent, and the defect was a violation of the
 * third one.
 */
describe('invariants that hold for every input', () => {
  const CASES: { rows: HistoryRow[]; gamesPlayed: number | null; gamesAvailable: number | null; outlook?: string }[] = [
    { rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17 },
    { rows: BURROW_2025, gamesPlayed: 8, gamesAvailable: 17, outlook: BURROW_OUTLOOK },
    { rows: outRange(1, 17, 'Knee'), gamesPlayed: 0, gamesAvailable: 17 },
    { rows: outRange(3, 4, 'Toe'), gamesPlayed: 15, gamesAvailable: 17 },
    { rows: outRange(3, 4, 'Toe'), gamesPlayed: 17, gamesAvailable: 17 },
    { rows: outRange(3, 4, 'Toe'), gamesPlayed: 6, gamesAvailable: 6 },
    { rows: outRange(3, 9, 'Foot'), gamesPlayed: 15, gamesAvailable: 17 },
    { rows: [...outRange(2, 4, 'Toe'), ...outRange(9, 11, 'Wrist')], gamesPlayed: 11, gamesAvailable: 17 },
    { rows: [], gamesPlayed: 12, gamesAvailable: 17 },
    { rows: [...outRange(2, 4, 'Toe'), ...outRange(8, 9, 'Wrist'), ...outRange(14, 15, 'Knee')], gamesPlayed: 10, gamesAvailable: 17 },
    {
      rows: [...outRange(3, 5, 'Wrist'), ...outRange(9, 10, 'Toe')],
      gamesPlayed: 8,
      gamesAvailable: 17,
      outlook: 'He missed nine games last year with a wrist injury.',
    },
    { rows: outRange(4, 6, 'Calf'), gamesPlayed: null, gamesAvailable: 17 },
    { rows: outRange(4, 6, 'Calf'), gamesPlayed: 8, gamesAvailable: null },
  ];

  const all = CASES.map((c) => ({ input: c, result: reconcile(c) }));

  it('derives total missed from participation and nothing else', () => {
    for (const { result } of all) {
      if (result.gamesAvailable == null || result.gamesPlayed == null) {
        expect(result.gamesMissedTotal).toBeNull();
        continue;
      }
      expect(result.gamesMissedTotal).toBe(result.gamesAvailable - result.gamesPlayed);
    }
  });

  it('never attributes more games to injury than were missed', () => {
    for (const { result } of all) {
      if (result.gamesMissedTotal == null) continue;
      expect(result.injuryAttributedMisses).toBeLessThanOrEqual(result.gamesMissedTotal);
      expect(result.unresolvedMisses).toBe(result.gamesMissedTotal - result.injuryAttributedMisses);
      expect(result.unresolvedMisses).toBeGreaterThanOrEqual(0);
      // The per-injury breakdown is the same games, split up — never more.
      expect(result.parts.reduce((n, p) => n + p.games, 0)).toBeLessThanOrEqual(result.gamesMissedTotal);
    }
  });

  /**
   * The regression guard. When an injury explains only some of the missed time,
   * the sentence must not read as a season total — which means it either states
   * the participation outright, or states its count as a floor.
   */
  it('never presents a partial count as a complete one', () => {
    for (const { result } of all) {
      const line = result.displaySummary;
      if (!line) continue;
      if (result.unresolvedMisses != null && result.unresolvedMisses > 0) {
        expect(line).not.toMatch(/^\d{4}: missed \d+ games? with/);
        expect(line).toMatch(/played \d+ of \d+ games|at least/);
      }
      if (/^\d{4}: missed \d+ games? with/.test(line)) {
        expect(result.confidence).toBe('complete');
        /*
         * Every count the sentence states has to add up to the season's total —
         * including a two-injury line, which splits the same total across two
         * clauses rather than naming it once.
         */
        const stated = [...line.matchAll(/(?:missed |and )(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
        expect(stated).toBe(result.gamesMissedTotal);
      }
    }
  });

  it('keeps every line short enough for a card', () => {
    for (const { result } of all) {
      if (result.displaySummary) expect(result.displaySummary.length).toBeLessThanOrEqual(80);
    }
  });
});
