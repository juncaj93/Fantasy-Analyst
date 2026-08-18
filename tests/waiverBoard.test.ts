/**
 * The waiver board view model, and the line it will not cross.
 *
 * Two things are being defended here. The first is the shape: the engine
 * answers per slot and a reader decides per player, so the board has to turn
 * one into the other without losing the fact that a flex-eligible player fits
 * in two places.
 *
 * The second is the more important one, and it is the whole reason this file
 * exists rather than the numbers being formatted at the point of use: **the
 * board must never invent a league fact.** Expected cost, likely competition
 * and multi-week value belong to the league-intelligence pass. Until it lands
 * they are null, and a null must survive all the way to the screen as "not
 * known" rather than being helpfully turned into a plausible bid.
 */

import { describe, expect, it } from 'vitest';
import {
  SOLID_MULTIPLE,
  STRONG_MULTIPLE,
  buildWaiverBoard,
  offeredPositions,
  rowMatches,
  strengthOf,
  type WaiverAdviceLike,
  type WaiverCandidateLike,
} from '../src/core/waivers/board.ts';

function candidate(overrides: Partial<WaiverCandidateLike> = {}): WaiverCandidateLike {
  return {
    playerId: '2001',
    name: 'Trey Halloran',
    position: 'WR',
    team: 'DET',
    score: 12.4,
    gain: 3.1,
    reasons: ['role rising for three weeks', 'soft matchup'],
    statusFlag: null,
    ...overrides,
  };
}

function advice(overrides: Partial<WaiverAdviceLike> = {}): WaiverAdviceLike {
  return {
    upgrades: [
      {
        slot: 'WR2',
        accepts: ['WR'],
        need: 'upgrade',
        currentPlayerId: '1005',
        currentName: 'Dane Whitlock',
        currentScore: 9.3,
        bar: 2.5,
        candidates: [candidate()],
      },
    ],
    headline: null,
    notes: [],
    considered: 48,
    ...overrides,
  };
}

describe('one row per player', () => {
  it('turns slot-shaped advice into a decision per player', () => {
    const board = buildWaiverBoard(advice());
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.name).toBe('Trey Halloran');
    expect(board.rows[0]!.fit.label).toBe('Upgrades WR2');
    expect(board.rows[0]!.shortTerm.over).toBe('Dane Whitlock');
    expect(board.rows[0]!.why).toBe('role rising for three weeks');
  });

  /**
   * The same receiver clears the bar at WR2 and at FLEX, because both are true.
   * To a reader that is one decision, and the slot he is worth the most in is
   * the one that leads.
   */
  it('collapses a player who fits two slots, keeping the better one', () => {
    const board = buildWaiverBoard(
      advice({
        upgrades: [
          {
            slot: 'FLEX',
            accepts: ['RB', 'WR', 'TE'],
            need: 'upgrade',
            currentPlayerId: '1006',
            currentName: 'Ollie Reyes',
            currentScore: 10.8,
            bar: 2.5,
            candidates: [candidate({ gain: 1.6 })],
          },
          {
            slot: 'WR2',
            accepts: ['WR'],
            need: 'upgrade',
            currentPlayerId: '1005',
            currentName: 'Dane Whitlock',
            currentScore: 9.3,
            bar: 2.5,
            candidates: [candidate({ gain: 3.1 })],
          },
        ],
      }),
    );
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.fit.slot).toBe('WR2');
    expect(board.rows[0]!.fit.alsoFits).toEqual(['FLEX']);
    expect(board.rows[0]!.shortTerm.gain).toBe(3.1);
  });

  it('ranks by the size of the improvement until the league ranks it itself', () => {
    const board = buildWaiverBoard(
      advice({
        upgrades: [
          {
            ...advice().upgrades[0]!,
            candidates: [
              candidate({ playerId: '2001', name: 'Small Gain', gain: 2.6 }),
              candidate({ playerId: '2002', name: 'Big Gain', gain: 7.4 }),
            ],
          },
        ],
      }),
    );
    expect(board.rows.map((r) => r.name)).toEqual(['Big Gain', 'Small Gain']);
  });

  it('defers to the league ranking when there is one', () => {
    const board = buildWaiverBoard(
      advice({
        upgrades: [
          {
            ...advice().upgrades[0]!,
            candidates: [
              candidate({ playerId: '2001', name: 'Bigger Week', gain: 7.4, leagueRank: 2 }),
              candidate({ playerId: '2002', name: 'League Says First', gain: 2.6, leagueRank: 1 }),
            ],
          },
        ],
      }),
    );
    expect(board.rows.map((r) => r.name)).toEqual(['League Says First', 'Bigger Week']);
  });
});

describe('how strongly it is put', () => {
  it('scales against the engine’s own bar rather than a new opinion', () => {
    expect(strengthOf(2.5 * STRONG_MULTIPLE, 2.5, 'upgrade')).toBe('strong');
    expect(strengthOf(2.5 * SOLID_MULTIPLE, 2.5, 'upgrade')).toBe('solid');
    expect(strengthOf(2.6, 2.5, 'upgrade')).toBe('speculative');
  });

  /** Anybody legal beats nobody, so an empty starting slot is not a judgement call. */
  it('calls filling an empty slot strong', () => {
    expect(strengthOf(0.1, 99, 'unfilled')).toBe('strong');
  });
});

describe('what the board refuses to invent', () => {
  /**
   * The central test of this file.
   *
   * There is no arithmetic anywhere that turns points into a bid, so a board
   * built from engine output alone reports cost, competition and multi-week
   * value as unknown — and says once, at the top level, which ones they are.
   */
  it('reports cost, competition and multi-week value as unknown', () => {
    const board = buildWaiverBoard(advice());
    const row = board.rows[0]!;
    expect(row.faab).toBeNull();
    expect(row.competition).toBeNull();
    expect(row.multiWeek).toBeNull();
    expect(board.pending).toEqual(['expected cost', 'likely competition', 'multi-week value']);
    // Nothing that could be read as a number of dollars or a percentage.
    expect(JSON.stringify(row)).not.toMatch(/faab":\s*\{/i);
  });

  it('reads them straight through when the league pass provides them', () => {
    const board = buildWaiverBoard(
      advice({
        upgrades: [
          {
            ...advice().upgrades[0]!,
            candidates: [
              candidate({
                faab: { low: 12, high: 18, unit: 'percent', detail: 'three managers bid double digits last week' },
                competition: { level: 'high', label: 'Likely contested', detail: '4 teams need a receiver' },
                multiWeek: { level: 'multi_week', label: 'Holds value for weeks', detail: 'starter while Ives is out' },
              }),
            ],
          },
        ],
      }),
    );
    const row = board.rows[0]!;
    expect(row.faab).toEqual({
      low: 12,
      high: 18,
      unit: 'percent',
      detail: 'three managers bid double digits last week',
    });
    expect(row.competition?.level).toBe('high');
    expect(row.multiWeek?.label).toBe('Holds value for weeks');
    // Nothing is outstanding any more, so nothing is announced as outstanding.
    expect(board.pending).toEqual([]);
  });

  /**
   * The prices the league-intelligence pass produces are joined, not remade.
   *
   * Its own figures reach the row untouched, and the recommended maximum comes
   * with them as the detail — because "expected $17–22" and "bid at most $19"
   * are two different statements and the row shows the first.
   */
  it('joins the priced bids to the rows they price', () => {
    const board = buildWaiverBoard({
      ...advice(),
      faab: {
        bids: [
          {
            playerId: '2001',
            expected: { low: 17, high: 22 },
            recommended: 19,
            doNotExceed: 24,
            headline: 'Expected $17–22 · Recommended max $19',
            confidence: 'medium',
            withheld: null,
          },
        ],
      },
    });
    const row = board.rows[0]!;
    expect(row.faab).toEqual({ low: 17, high: 22, unit: 'dollar', detail: 'Recommended max $19' });
    expect(row.bid?.doNotExceed).toBe(24);
    // Priced, so it is no longer outstanding.
    expect(board.pending).not.toContain('expected cost');
  });

  /**
   * A bid that deliberately quotes no number leaves the cost unknown.
   *
   * A priority league, an unpublished budget or a spent wallet all mean there is
   * no honest figure, and the reason is carried into the row's reasons rather
   * than collapsed into a zero — which would read as "free".
   */
  it('keeps the cost unknown when the price is withheld, and says why', () => {
    const board = buildWaiverBoard({
      ...advice(),
      faab: {
        bids: [
          {
            playerId: '2001',
            expected: null,
            recommended: null,
            doNotExceed: null,
            headline: '',
            withheld: 'This league uses waiver priority, not FAAB.',
          },
        ],
      },
    });
    const row = board.rows[0]!;
    expect(row.faab).toBeNull();
    expect(row.reasons).toContain('This league uses waiver priority, not FAAB.');
    expect(board.pending).toContain('expected cost');
  });

  it('has nothing to say about a board with no rows', () => {
    const board = buildWaiverBoard({ upgrades: [], headline: 'Nothing available beats your roster.' });
    expect(board.rows).toEqual([]);
    expect(board.pending).toEqual([]);
    expect(board.headline).toBe('Nothing available beats your roster.');
  });
});

describe('the filters', () => {
  const rows = buildWaiverBoard(
    advice({
      upgrades: [
        {
          ...advice().upgrades[0]!,
          candidates: [
            candidate({ playerId: '2001', position: 'WR' }),
            candidate({ playerId: '2002', position: 'RB' }),
            candidate({ playerId: '2003', position: 'QB' }),
          ],
        },
      ],
    }),
  ).rows;

  it('offers only positions that are actually on the board', () => {
    expect(offeredPositions(rows)).toEqual(['QB', 'RB', 'WR', 'FLEX']);
    expect(offeredPositions(rows.filter((r) => r.position === 'QB'))).toEqual(['QB']);
  });

  it('drops the flex view when it would duplicate a position chip', () => {
    const onlyReceivers = rows.filter((r) => r.position === 'WR');
    expect(offeredPositions(onlyReceivers)).toEqual(['WR']);
  });

  it('matches rows the way the chips say they will', () => {
    const wr = rows.find((r) => r.position === 'WR')!;
    const qb = rows.find((r) => r.position === 'QB')!;
    expect(rowMatches(wr, 'ALL')).toBe(true);
    expect(rowMatches(wr, 'WR')).toBe(true);
    expect(rowMatches(wr, 'FLEX')).toBe(true);
    expect(rowMatches(qb, 'FLEX')).toBe(false);
    expect(rowMatches(qb, 'WR')).toBe(false);
  });
});
