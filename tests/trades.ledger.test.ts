/**
 * The trade board read off a real evidence ledger.
 *
 * `trades.test.ts` works in `TradeWindows` because that is where the formulas
 * live. This file exists because the defect it corrects was not in the
 * formulas' arithmetic — it was in what the engine believed `items30` meant.
 *
 * The ledger holds two kinds of row, both correct and both deliberate:
 *
 *   - a **weekly** row, bounded to ±1/±2 by the tally protocol, one per player
 *     per issue (`core/newsletter/aiTally.ts`);
 *   - a **backfilled** row, unbounded, carrying a running tally that covers
 *     several earlier issues as one item, because fabricating it into N items
 *     nobody ever saw would be a lie (`core/newsletter/tally.ts`).
 *
 * So a row count is a fact about which importer ran, not about how strong or
 * how well supported a player's case is. The engine used to read it as both.
 * These tests build the two shapes out of real `EvidenceItem`s, aggregate them
 * the way the app does, and assert the board that comes out the other end.
 */

import { describe, expect, it } from 'vitest';
import { aggregatePlayerSignal } from '../src/core/evidence/aggregate.ts';
import type { EvidenceItem } from '../src/core/evidence/types.ts';
import { groupByVerdict, rankTrades, type TradeCandidate } from '../src/core/trades/engine.ts';
import { player } from './helpers/players.ts';

const NOW = '2026-08-13T12:00:00.000Z';

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

let seq = 0;

/** One weekly tally row: bounded magnitude, its own issue. */
function weekly(playerId: string, score: number, ageDays: number): EvidenceItem {
  return row(playerId, score, ageDays, 'ai-tally-import', `issue-${ageDays}`);
}

/** One backfilled row: a running tally over several issues, carried as one item. */
function backfill(playerId: string, score: number, ageDays: number): EvidenceItem {
  return row(playerId, score, ageDays, 'tally-backfill', 'backfill');
}

function row(
  playerId: string,
  score: number,
  ageDays: number,
  ruleId: string,
  messageId: string,
): EvidenceItem {
  const id = `e${++seq}`;
  return {
    id,
    playerId,
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: messageId,
    sourceDate: daysAgo(ageDays),
    excerpt: 'excerpt',
    contextSummary: null,
    category: 'role',
    polarity: score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral',
    magnitude: Math.abs(score),
    confidence: 'medium',
    confidenceScore: 0.6,
    ruleId,
    reviewStatus: 'auto_applied',
    userOverride: null,
    dedupeKey: id,
    createdAt: NOW,
  } as EvidenceItem;
}

function board(ledger: Record<string, EvidenceItem[]>, ownership: 'mine' | 'other' | 'free' = 'other') {
  const candidates: TradeCandidate[] = Object.entries(ledger).map(([id, items]) => ({
    player: player({ id, fullName: id, position: 'WR' }),
    signal: aggregatePlayerSignal(id, items, { now: NOW }),
    ownership,
  }));
  return rankTrades(candidates);
}

/**
 * The pair from the report, rebuilt from the ledger rows that produced them.
 *
 * Gibbs was scored in two separate weekly issues. Puka's whole record arrived
 * as one backfilled row. Both players' entire history sits inside the 30-day
 * window, so `30d` and `Life` agree for each of them — which is what made the
 * split between them impossible to read off the card.
 */
describe('Gibbs and Puka, from the ledger up', () => {
  const ledger = {
    gibbs: [weekly('gibbs', 2, 20), weekly('gibbs', 2, 9)].map((e) => ({ ...e, magnitude: 5 })),
    puka: [backfill('puka', 13, 12)],
  };

  it('produces the windows the card showed', () => {
    const gibbs = aggregatePlayerSignal('gibbs', ledger.gibbs, { now: NOW });
    const puka = aggregatePlayerSignal('puka', ledger.puka, { now: NOW });

    expect([gibbs.last30.net, gibbs.raw.net, gibbs.last30.items]).toEqual([10, 10, 2]);
    expect([puka.last30.net, puka.raw.net, puka.last30.items]).toEqual([13, 13, 1]);
    // Neither has anything in the last week, which is the fact that decides
    // both buckets and which the card never showed.
    expect([gibbs.last7.net, puka.last7.net]).toEqual([0, 0]);
  });

  it('files both as trade targets and puts the bigger 30-day signal on top', () => {
    const ranked = board(ledger);
    expect(ranked.map((s) => s.verdict)).toEqual(['trade_target', 'trade_target']);
    expect(ranked.map((s) => s.playerId)).toEqual(['puka', 'gibbs']);
  });

  it('reports the single-row player as the less well evidenced of the two', () => {
    const by = new Map(board(ledger).map((s) => [s.playerId, s]));
    expect(by.get('puka')!.confidence).toBe('low');
    expect(by.get('gibbs')!.confidence).toBe('medium');
  });

  /** The separation, stated as the board states it. */
  it('lets the least well evidenced row be the most attractive one', () => {
    const by = new Map(board(ledger).map((s) => [s.playerId, s]));
    expect(by.get('puka')!.urgency).toBeGreaterThan(by.get('gibbs')!.urgency);
    expect(by.get('puka')!.confidence).toBe('low');
  });
});

describe('what the ledger shape does and does not decide', () => {
  it('does not care whether a month arrived as one row or as four', () => {
    const ranked = board({
      one: [backfill('one', 8, 12)],
      four: [weekly('four', 2, 25), weekly('four', 2, 18), weekly('four', 2, 12), weekly('four', 2, 9)],
    });
    // Same 30-day net, so the same verdict and near-identical urgency: the row
    // count is worth only the bounded volume nudge, not a change of bucket.
    expect(ranked.every((s) => s.verdict === 'trade_target')).toBe(true);
    expect(Math.abs(ranked[0]!.urgency - ranked[1]!.urgency)).toBeLessThanOrEqual(0.5);
  });

  it('still lets the row count decide how well evidenced the call is', () => {
    const by = new Map(
      board({
        one: [backfill('one', 8, 12)],
        four: [weekly('four', 2, 25), weekly('four', 2, 18), weekly('four', 2, 12), weekly('four', 2, 9)],
      }).map((s) => [s.playerId, s]),
    );
    expect(by.get('one')!.confidence).toBe('low');
    expect(by.get('four')!.confidence).toBe('high');
  });

  /** A ±2 is one strong item, never two items. */
  it('counts a doubled magnitude as one item, not as two', () => {
    const signal = aggregatePlayerSignal('p', [weekly('p', 2, 3)], { now: NOW });
    expect(signal.last30.items).toBe(1);
    expect(signal.last30.net).toBe(2);
  });

  it('excludes pending, rejected and ignored rows from the board', () => {
    const items = [
      weekly('p', 2, 3),
      { ...weekly('p', 2, 4), reviewStatus: 'pending' as const },
      { ...weekly('p', 2, 5), reviewStatus: 'rejected' as const },
      { ...weekly('p', 2, 6), reviewStatus: 'ignored' as const },
    ];
    const signal = aggregatePlayerSignal('p', items, { now: NOW });
    expect(signal.last30.items).toBe(1);
    expect(signal.pendingCount).toBe(1);

    // One counted item against one still awaiting review is not conviction.
    const ranked = rankTrades([
      { player: player({ id: 'p', fullName: 'P' }), signal, ownership: 'other' },
    ]);
    expect(ranked[0]!.confidence).toBe('low');
  });
});

describe('emerging, from the ledger up', () => {
  it('separates a case that is new this week from one that merely continued', () => {
    const ranked = board({
      // Quiet for three weeks, then scored twice in the last few days.
      surging: [weekly('surging', 2, 4), weekly('surging', 2, 2)],
      // Scored steadily all month, including this week.
      steady: [weekly('steady', 2, 26), weekly('steady', 2, 19), weekly('steady', 2, 11), weekly('steady', 2, 3)],
    });
    const by = new Map(ranked.map((s) => [s.playerId, s]));
    expect(by.get('surging')!.verdict).toBe('emerging_target');
    expect(by.get('steady')!.verdict).toBe('trade_target');
  });

  it('explains an emerging call with both halves of the window', () => {
    const ranked = board({ surging: [weekly('surging', 2, 4), weekly('surging', 2, 2)] });
    expect(ranked[0]!.reasons.join(' ')).toContain('new this week — +4 in 7 days against 0 over the 23 before');
  });

  it('keeps the sections in the order the screen expects', () => {
    const sections = groupByVerdict(
      board({
        steady: [weekly('steady', 2, 26), weekly('steady', 2, 19), weekly('steady', 2, 11), weekly('steady', 2, 3)],
        surging: [weekly('surging', 2, 4), weekly('surging', 2, 2)],
      }),
    );
    expect(sections.map((s) => s.verdict)).toEqual(['trade_target', 'emerging_target']);
  });
});

describe('the sell side, from the ledger up', () => {
  it('flags a deteriorating player on your roster and ranks the worse one first', () => {
    const ranked = board(
      {
        sinking: [weekly('sinking', -2, 20), weekly('sinking', -2, 12), weekly('sinking', -2, 3)],
        slipping: [weekly('slipping', -2, 10)],
      },
      'mine',
    );
    expect(ranked.every((s) => s.verdict === 'trade_away')).toBe(true);
    expect(ranked[0]!.playerId).toBe('sinking');
  });

  it('calls it a sell high only when the lifetime record says there is something to sell', () => {
    const wellRegarded = [
      backfill('star', 12, 200),
      weekly('star', -2, 14),
      weekly('star', -2, 6),
      weekly('star', -2, 2),
    ];
    const ranked = board({ star: wellRegarded }, 'mine');
    expect(ranked[0]!.verdict).toBe('sell_high');
    expect(ranked[0]!.counterpoints.join(' ')).toContain('no market price');
  });
});
